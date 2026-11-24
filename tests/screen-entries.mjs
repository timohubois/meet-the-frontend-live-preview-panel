import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { sourceForVm } from './helpers/modules.mjs';

const editorSource = await sourceForVm(new URL('../src/classic-editor.js', import.meta.url));
const revisionsSource = await sourceForVm(new URL('../src/revision-browser.js', import.meta.url));
const failureSource = await sourceForVm(new URL('../src/panel/startup-error.js', import.meta.url));

function fixture(screen, { configured = true, formAvailable = true, modelAvailable = true, fail = false } = {}) {
    const calls = [], removed = [], notices = [], errors = [];
    const model = { get() {}, on() {}, off() {} };
    const launcher = {};
    const form = { querySelector: (selector) => selector === '#mtflpp-publish-preview button' ? launcher : null };
    const native = { destroy: () => calls.push('destroy') };
    const config = { strings: { bootFailed: 'Unavailable' } };
    const pluginIds = ['mtflpp-panel', 'mtflpp-toggle'];
    if (screen === 'editor') pluginIds.push('mtflpp-publish-preview');
    const nodes = new Map(pluginIds.map((id) => [id, { remove: () => removed.push(id) }]));
    const context = {
        window: {
            jQuery: (ready) => ready(),
            meetTheFrontendLivePreviewPanel: configured ? config : null,
            wp: modelAvailable ? { revisions: { view: { frame: { model } } } } : {},
        },
        document: {
            getElementById: (id) => id === 'post' ? (formAvailable ? form : null)
                : id === 'wpbody-content' ? { prepend: (node) => notices.push(node) } : nodes.get(id),
            createElement: () => ({ children: [], setAttribute() {}, append(node) { this.children.push(node); } }),
        },
        console: { error: (...args) => errors.push(args) },
    };
    const showStartupError = vm.runInNewContext(`(() => { ${failureSource}\nreturn showStartupError; })()`, context);
    context.imports = {
        './screens/classic-native-editor.js': { createNativeEditor(received, target) {
            assert.equal(received, config);
            assert.equal(target, form);
            calls.push('observe');
            return native;
        } },
        './screens/classic-editor.js': { initLivePreview(received, observer, button) {
            assert.equal(received, config);
            assert.equal(observer, native);
            assert.equal(button, launcher);
            calls.push('editor');
            if (fail) throw new Error('Fixture startup failure');
        } },
        './screens/revision-browser.js': { initRevisionPreview(received, selection) {
            assert.equal(received, config);
            assert.equal(selection, model);
            calls.push('revisions');
            if (fail) throw new Error('Fixture startup failure');
        } },
        './panel/startup-error.js': { showStartupError },
    };
    vm.runInNewContext(screen === 'editor' ? editorSource : revisionsSource, context);
    return { calls, removed, notices, errors };
}

test('the editor observes native operations and initializes synchronously without module loading gaps', () => {
    const h = fixture('editor');
    assert.deepEqual(h.calls, ['observe', 'editor']);
    assert.equal(h.errors.length, 0);
});

test('editor initialization failure detaches native observers and removes only plugin UI', () => {
    const h = fixture('editor', { fail: true });
    assert.deepEqual(h.calls, ['observe', 'editor', 'destroy']);
    assert.deepEqual(h.removed, ['mtflpp-panel', 'mtflpp-toggle', 'mtflpp-publish-preview']);
    assert.equal(h.notices[0].children[0].textContent, 'Unavailable');
    assert.equal(h.errors.length, 1);
});

for (const options of [{ configured: false }, { formAvailable: false }]) {
    test(`the editor entry is inert with ${JSON.stringify(options)}`, () => {
        const h = fixture('editor', options);
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.removed, []);
    });
}

test('the revision entry uses the existing native selection without editor observers', () => {
    const h = fixture('revisions');
    assert.deepEqual(h.calls, ['revisions']);
    assert.equal(h.errors.length, 0);
});

for (const options of [{ modelAvailable: false }, { fail: true }]) {
    test(`revision startup failure preserves native comparison and restore with ${JSON.stringify(options)}`, () => {
        const h = fixture('revisions', options);
        assert.deepEqual(h.removed, ['mtflpp-panel', 'mtflpp-toggle']);
        assert.equal(h.notices.length, 1);
        assert.equal(h.errors.length, 1);
        assert.ok(!h.calls.includes('observe'));
    });
}

test('the revision entry is inert without screen configuration', () => {
    const h = fixture('revisions', { configured: false });
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.removed, []);
});
