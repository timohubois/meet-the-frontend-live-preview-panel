import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { sourceForVm, previewSourceForVm } from './helpers/modules.mjs';
import { previewInputImports } from './helpers/preview-inputs.mjs';

const source = await previewSourceForVm(new URL('../src/screens/classic-editor.js', import.meta.url));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

async function fixture({ visible = true, pending = true } = {}) {
    const listeners = [], timers = new Map();
    let options, finishRequest, clears = 0, continued = 0, requests = 0, nextTimer = 0;
    const form = {
        addEventListener: (type, callback) => listeners.push({ type, callback }),
        querySelector: () => ({ value: '' }),
        requestSubmit() { continued++; },
    };
    const view = {
        visible, report() {}, setTitle() {}, setVisible(value) { this.visible = value; },
        clearPreview() { clears++; }, returnToEditor() {},
    };
    const nativeEditor = { idle: Promise.resolve(), saving: false, deferredSaves: new WeakSet() };
    const context = {
        console, performance, URLSearchParams,
        document: { getElementById: (id) => id === 'post' ? form : null },
        window: { isSecureContext: true, jQuery: () => ({ on() {} }), addEventListener() {} },
        navigator: { locks: { request: (name, options, callback) => callback({}) } },
        setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: (id) => timers.delete(id),
        FormData: class { *[Symbol.iterator]() { yield ['post_title', 'Unsaved title']; } },
        fetch: () => { requests++; return new Promise((resolve) => { finishRequest = resolve; }); },
    };
    context.imports = {
        ...previewInputImports(context),
        '../panel/window.js': { createPreviewPanel: (strings, callbacks) => { options = callbacks; return view; } },
        '../preview/scroll.js': { createPreviewScroll: () => ({ remember() {} }) },
    };
    const initPreview = vm.runInNewContext(`${source}\ninitLivePreview`, context);
    initPreview({ available: true, base: 'base', endpoint: '/preview', strings: {} }, nativeEditor);
    const finish = async () => {
        finishRequest({ ok: false, json: async () => ({ code: 'mtflpp_preview_failed', message: 'Transient failure' }) });
        await flush();
    };
    await flush();
    if (visible && !pending) await finish();
    return {
        view, nativeEditor,
        get clears() { return clears; }, get continued() { return continued; }, get requests() { return requests; },
        click({ disabled = false, disabledClass = false, cancelled = false } = {}) {
            const control = {
                disabled, classList: { contains: (name) => disabledClass && name === 'disabled' },
                click() { continued++; },
            };
            const event = {
                target: { closest: () => control }, defaultPrevented: cancelled,
                preventDefault() { this.prevented = true; this.defaultPrevented = true; }, stopImmediatePropagation() {},
            };
            for (const { type, callback } of listeners) if (type === 'click') callback(event);
            return event;
        },
        submit() {
            const event = { preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
            for (const { type, callback } of listeners) if (type === 'submit') callback(event);
            return event;
        },
        edit() {
            for (const { type, callback } of listeners) if (type === 'input') callback({ target: { name: 'post_title' } });
        },
        async runTimers() {
            for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
            await flush();
        },
        finish,
        async close() { options.onClose(); await flush(); },
    };
}

for (const control of [{ disabledClass: true }, { disabled: true }]) {
    test(`disabled native Save (${Object.keys(control)[0]}) does not close the panel or queue a later save`, async () => {
        const h = await fixture();
        const event = h.click(control);
        assert.equal(event.prevented, undefined, 'leave the disabled action to native controls');
        assert.equal(h.view.visible, true);
        assert.equal(h.clears, 0);
        await h.finish();
        assert.equal(h.continued, 0, 'an ignored click must not turn into a save after autosave finishes');
        await h.close();
    });
}

for (const action of ['click', 'submit']) {
    test(`native Save ${action} drains once without hiding or clearing the preview`, async () => {
        const h = await fixture();
        const event = h[action]();
        assert.equal(event.prevented, true);
        assert.equal(h.nativeEditor.deferredSaves.has(event), true, 'our drain is not a validation rejection');
        assert.equal(h.view.visible, true);
        assert.equal(h.clears, 0);
        assert.equal(h.continued, 0);
        const repeated = h[action]();
        assert.equal(repeated.prevented, true, 'repeated actions cannot bypass a pending live write');
        assert.equal(h.nativeEditor.deferredSaves.has(repeated), true, 'blocked repeats are also our own interception');
        h.edit();
        await h.runTimers();
        assert.equal(h.requests, 1, 'no new live writes while saving');
        await h.finish();
        assert.equal(h.continued, 1);
        assert.equal(h.view.visible, true);
        assert.equal(h.clears, 0);
        h.nativeEditor.onSaveCancelled();
        h.edit();
        await h.runTimers();
        assert.equal(h.requests, 2, 'a rejected native save resumes live editing without reopening');
        await h.finish();
        await h.close();
    });
}

test('an already-cancelled Save is never intercepted or replayed', async () => {
    const h = await fixture();
    const event = h.click({ cancelled: true });
    assert.equal(event.prevented, undefined);
    assert.equal(h.nativeEditor.saving, false);
    assert.equal(h.nativeEditor.deferredSaves.has(event), false);
    await h.finish();
    assert.equal(h.continued, 0);
    await h.close();
});

test('an idle native Save preserves the frame and pauses writes until cancellation or navigation', async () => {
    const h = await fixture({ pending: false });
    assert.equal(h.click().prevented, undefined, 'nothing to drain');
    assert.equal(h.view.visible, true);
    assert.equal(h.clears, 0);
    h.edit();
    await h.runTimers();
    assert.equal(h.requests, 1);
    h.nativeEditor.onSaveCancelled();
    await h.runTimers();
    assert.equal(h.requests, 2);
    await h.finish();
    await h.close();
});

test('native Save does not open an explicitly closed preview', async () => {
    const h = await fixture({ visible: false });
    assert.equal(h.click().prevented, undefined);
    assert.equal(h.view.visible, false);
    assert.equal(h.requests, 0);
    h.nativeEditor.onSaveCancelled();
    await h.runTimers();
    assert.equal(h.view.visible, false);
    assert.equal(h.requests, 0);
});

test('a cancelled drain never replays its obsolete native Save', async () => {
    const h = await fixture();
    h.click();
    h.nativeEditor.onSaveCancelled();
    await h.finish();
    assert.equal(h.continued, 0);
    assert.equal(h.view.visible, true);
    await h.close();
});

test('ACF validation rejection is scoped to this form and reads the native validation state', async () => {
    const source = await sourceForVm(new URL('../src/compatibility/acf-fields.js', import.meta.url));
    const actions = new Map();
    let cancelled = 0, validating = true;
    const form = { classList: { contains: (name) => name === 'is-validating' && validating } };
    const initAcf = vm.runInNewContext(`${source}\ninitAcf`, {
        window: { acf: { addAction: (name, callback) => actions.set(name, callback) }, jQuery: () => ({ on() {} }) },
    });
    const adapter = initAcf(form, () => {}, () => {}, () => cancelled++);
    actions.get('validation_failure')([{}]);
    assert.equal(cancelled, 0);
    assert.equal(adapter.isValidating(), true);
    validating = false;
    actions.get('validation_failure')([form]);
    assert.equal(cancelled, 1);
    assert.equal(adapter.isValidating(), false);
});
