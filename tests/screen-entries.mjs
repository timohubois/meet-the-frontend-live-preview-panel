import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runChromiumTests } from './helpers/chromium.mjs';
import { sourceForVm } from './helpers/modules.mjs';

const editorSource = await sourceForVm(new URL('../src/classic-editor.js', import.meta.url));
const termSource = await sourceForVm(new URL('../src/term-editor.js', import.meta.url));
const revisionsSource = await sourceForVm(new URL('../src/revision-browser.js', import.meta.url));
const failureSource = await sourceForVm(new URL('../src/panel/startup-error.js', import.meta.url));

function fixture(screen, { configured = true, formAvailable = true, modelAvailable = true, headerAvailable = true, fail = false } = {}) {
    const calls = [], removed = [], notices = [], errors = [];
    const model = { get() {}, on() {}, off() {} };
    const launcher = {}, backLink = { after: (node) => notices.push(node) }, setupAcfTermEditor = () => {};
    const launcherId = { editor: 'mtflpp-publish-preview', term: 'mtflpp-term-preview' }[screen];
    const form = { querySelector: (selector) => selector === `#${launcherId} button` ? launcher : null };
    const native = { destroy: () => calls.push('destroy') };
    const config = { strings: { bootFailed: 'Unavailable' } };
    const pluginIds = ['mtflpp-panel', 'mtflpp-toggle'];
    if (launcherId) pluginIds.push(launcherId);
    const formId = screen === 'term' ? 'edittag' : 'post';
    const nodes = new Map(pluginIds.map((id) => [id, { remove: () => removed.push(id) }]));
    const context = {
        window: {
            jQuery: (ready) => ready(),
            meetTheFrontendLivePreviewPanel: configured ? config : null,
            wp: modelAvailable ? { revisions: { view: { frame: { model } } } } : {},
        },
        document: {
            querySelector: (selector) => selector === '#wpbody-content > .wrap > h1.long-header ~ a' && headerAvailable ? backLink : null,
            getElementById: (id) => id === formId ? (formAvailable ? form : null)
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
        './compatibility/acf-term-editor.js': { setupAcfTermEditor },
        './screens/term-editor.js': { initTermPreview(received, target, setup, button) {
            assert.equal(received, config);
            assert.equal(target, form);
            assert.equal(setup, setupAcfTermEditor);
            assert.equal(button, launcher);
            calls.push('term');
            if (fail) throw new Error('Fixture startup failure');
        } },
        './screens/revision-browser.js': { initRevisionPreview(received, selection, adjacentLink) {
            assert.equal(received, config);
            assert.equal(selection, model);
            assert.equal(adjacentLink, backLink);
            calls.push('revisions');
            if (fail) throw new Error('Fixture startup failure');
        } },
        './panel/startup-error.js': { showStartupError },
    };
    vm.runInNewContext({ editor: editorSource, term: termSource, revisions: revisionsSource }[screen], context);
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

test('term preview uses the button inside the native edit form', () => {
    const h = fixture('term');
    assert.deepEqual(h.calls, ['term']);
    assert.equal(h.errors.length, 0);
});

test('term preview startup failure removes its button and panel without touching the native form', () => {
    const h = fixture('term', { fail: true });
    assert.deepEqual(h.calls, ['term']);
    assert.deepEqual(h.removed, ['mtflpp-panel', 'mtflpp-toggle', 'mtflpp-term-preview']);
    assert.equal(h.notices[0].children[0].textContent, 'Unavailable');
});

test('the revision entry uses the existing native selection without editor observers', () => {
    const h = fixture('revisions');
    assert.deepEqual(h.calls, ['revisions']);
    assert.equal(h.errors.length, 0);
});

for (const options of [{ modelAvailable: false }, { headerAvailable: false }, { fail: true }]) {
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

function browserRevisionHeaderTests(entry, startupError) {
    const results = [];
    const showStartupError = new Function(`${startupError}\nreturn showStartupError;`)();
    const run = new Function('imports', entry);
    for (const modelAvailable of [true, false]) {
        const name = modelAvailable ? 'a native notice before the return link does not block startup'
            : 'a startup error appears below the return link, before the native comparison';
        try {
            const content = document.createElement('div');
            content.id = 'wpbody-content';
            // Core moves admin notices after the heading when the page has no .wp-header-end.
            content.innerHTML = `<div class="wrap">
                <h1 class="long-header">Compare revisions</h1>
                <div class="notice"><p><a href="/help">Native notice</a></p></div>
                <a id="return-link" href="post.php">Go to editor</a>
                <div id="native-comparison"></div>
            </div><div id="mtflpp-panel"></div>`;
            document.body.append(content);
            const backLink = content.querySelector('#return-link');
            const comparison = content.querySelector('#native-comparison');
            const model = { get() {}, on() {}, off() {} };
            window.jQuery = (ready) => ready();
            window.wp = modelAvailable ? { revisions: { view: { frame: { model } } } } : {};
            window.meetTheFrontendLivePreviewPanel = { strings: { bootFailed: 'Unavailable' } };
            let initialized = false;
            run({
                './panel/startup-error.js': { showStartupError },
                './screens/revision-browser.js': { initRevisionPreview(config, selection, anchor) {
                    initialized = selection === model && anchor === backLink;
                } },
            });
            const notice = content.querySelector('[role="alert"]');
            if (modelAvailable) {
                if (!initialized || notice) throw new Error('Expected startup with the native return link and no error.');
            } else if (!notice || backLink.nextElementSibling !== notice || notice.nextElementSibling !== comparison) {
                throw new Error('Expected the error between the return link and comparison.');
            }
            results.push({ name });
        } catch (error) {
            results.push({ name, error: error.message });
        } finally {
            document.getElementById('wpbody-content')?.remove();
        }
    }
    return results;
}

test('classic revision header with WordPress admin notices', (t) => runChromiumTests(t, {
    script: `(${browserRevisionHeaderTests})(${JSON.stringify(revisionsSource)}, ${JSON.stringify(failureSource)})`,
    count: 2,
}));
