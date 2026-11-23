import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { sourceForVm, previewSourceForVm } from './helpers/modules.mjs';
import { editorExtensionsFixture } from './helpers/editor-extensions.mjs';
import test from 'node:test';
import vm from 'node:vm';

const source = await sourceForVm(new URL('../src/screens/classic-native-editor.js', import.meta.url));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

// Model core's click continuation; real native POST, cookie and panel behavior is covered by WordPress browser QA.
async function fixture(pending) {
    const listeners = [];
    const heartbeat = new Map();
    const fields = [];
    const cookies = new Map();
    const cookieWrites = [];
    const timers = new Map();
    const outcomes = [];
    let nativeEditor, now = 0, nextTimer = 0, posts = 0, popups = 0;
    const form = {
        addEventListener: (type, callback) => listeners.push({ type, callback }),
        removeEventListener: (type, callback) => {
            const index = listeners.findIndex((entry) => entry.type === type && entry.callback === callback);
            if (index !== -1) listeners.splice(index, 1);
        },
        append: (field) => fields.push(field),
        querySelector: () => ({ value: '' }),
    };
    const document = {
        getElementById: (id) => id === 'post' ? form : null,
        createElement: () => {
            const field = { remove: () => fields.splice(fields.indexOf(field), 1) };
            return field;
        },
        get cookie() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; '); },
        set cookie(value) {
            cookieWrites.push(value);
            const [entry] = value.split(';');
            const at = entry.indexOf('=');
            const name = entry.slice(0, at);
            if (value.includes('Max-Age=0')) cookies.delete(name);
            else cookies.set(name, entry.slice(at + 1));
        },
    };
    const config = {
        base: 'a'.repeat(64), adminCookiePath: '/',
        strings: { nativePreviewFailed: 'Check the native Preview tab.' },
    };
    const preview = { target: 'wp-preview-42', classList: { contains: () => false }, click: () => click() };
    const click = (disabled = false) => {
        const event = {
            type: 'click', target: { closest: (selector) => selector === '#post-preview' ? preview : null },
            preventDefault() { this.prevented = true; },
            stopImmediatePropagation() { this.stopped = true; },
        };
        preview.classList.contains = () => disabled;
        for (const { type, callback } of listeners) {
            if (type === 'click') callback(event);
            if (event.stopped) break;
        }
        if (!event.prevented && !disabled) posts++;
        return event;
    };
    const context = {
        document, console, Date: { now: () => now },
        setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: (id) => timers.delete(id),
        window: {
            meetTheFrontendLivePreviewPanel: config, crypto: webcrypto,
            open: () => { popups++; },
            jQuery: () => ({
                on(events, callback) { for (const name of events.split(' ')) heartbeat.set(name.split('.')[0], callback); return this; },
                off() {},
            }),
        },

    };
    const createNativeEditor = vm.runInNewContext(`${source}\ncreateNativeEditor`, context);
    nativeEditor = createNativeEditor(config, form);
    nativeEditor.beforePreview = () => pending;
    nativeEditor.onPreview = (error) => outcomes.push(error);
    return {
        config, nativeEditor, fields, cookies, cookieWrites, outcomes, click,
        get posts() { return posts; }, get popups() { return popups; },
        receipt(value) {
            const token = fields.find((field) => field.name === 'mtflpp_preview').value;
            assert.match(token, /^[a-f0-9]{32}$/);
            cookies.set(`mtflpp_preview_${token}`, value);
        },
        async tick(elapsed = 100) {
            now += elapsed;
            for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
            await flush();
        },
        fire: (name, data) => heartbeat.get(name)?.({ type: name }, data),
        submit(prevented, originalEvent) {
            if (originalEvent) {
                originalEvent.type = 'submit';
                for (const { type, callback } of listeners) if (type === 'submit') callback(originalEvent);
            }
            heartbeat.get('submit')({ type: 'submit', isDefaultPrevented: () => prevented, originalEvent });
            return flush().then(() => this.tick(0));
        },
        invalid() { for (const entry of listeners) if (entry.type === 'invalid') entry.callback(); },
    };
}

test('idle native Preview is not treated as editor navigation and accepts exactly its receipt', async () => {
    const h = await fixture();
    h.cookies.set('mtflpp_preview_another_tab', `${h.config.base}.${'f'.repeat(64)}`);
    h.click();
    assert.equal(h.posts, 1);
    assert.equal(h.nativeEditor.saving, false);
    assert.equal(h.nativeEditor.previewing, true);
    assert.equal(h.fields.length, 2);
    await h.tick();
    assert.equal(h.nativeEditor.previewing, true, 'another request cannot complete this Preview');
    h.receipt(`${h.config.base}.${'b'.repeat(64)}`);
    await h.tick();
    await h.nativeEditor.idle;
    assert.equal(h.config.base, 'b'.repeat(64));
    assert.equal(h.nativeEditor.previewing, false);
    assert.deepEqual(h.outcomes, [undefined]);
    assert.equal(h.fields.length, 0);
    assert.equal(h.cookies.size, 1);
    assert.match(h.cookieWrites.at(-1), /Max-Age=0; Path=\/; SameSite=Strict$/);
    await h.tick();
    assert.equal(h.outcomes.length, 1);
});

for (const failed of [false, true]) {
    test(`native Preview reserves its tab and drains a ${failed ? 'failed' : 'successful'} outstanding write once`, async () => {
        const pending = deferred();
        const h = await fixture(pending.promise);
        h.click(); h.click();
        assert.equal(h.posts, 0);
        assert.equal(h.popups, 1);
        assert.equal(h.fields.length, 0);
        h.fire('heartbeat-tick', { mtflpp_base: 'c'.repeat(64) });
        if (failed) pending.reject(new Error('Live write failed'));
        else pending.resolve();
        await flush();
        assert.equal(h.posts, 1);
        assert.equal(h.popups, 1);
        assert.equal(h.fields.find((field) => field.name === 'mtflpp_base').value, 'c'.repeat(64));
        h.receipt(`${h.config.base}.${'d'.repeat(64)}`);
        await h.tick();
        assert.equal(h.config.base, 'd'.repeat(64));
    });
}

for (const value of ['conflict', 'malformed', `${'f'.repeat(64)}.${'b'.repeat(64)}`, `${'a'.repeat(64)}.short`]) {
    test(`unproven native Preview receipt ${value.slice(0, 12)} cannot rebase the editor`, async () => {
        const h = await fixture();
        h.click(); h.receipt(value); await h.tick();
        await h.nativeEditor.idle;
        assert.equal(h.config.base, 'a'.repeat(64));
        assert.equal(h.nativeEditor.previewing, false);
        assert.equal(h.outcomes[0].code, 'mtflpp_source_changed');
        assert.equal(h.fields.length, 0);
        assert.equal(h.cookies.size, 0);
        assert.equal(h.posts, 1);
    });
}

test('missing native acknowledgement expires without an infinite pause or another native POST', async () => {
    const h = await fixture();
    h.click(); await h.tick(30001); await h.nativeEditor.idle;
    assert.equal(h.nativeEditor.previewing, false);
    assert.equal(h.outcomes[0].code, 'mtflpp_source_changed');
    assert.equal(h.config.base, 'a'.repeat(64));
    assert.equal(h.fields.length, 0);
    assert.equal(h.posts, 1);
});

test('heartbeat uses a received Preview baseline and waits for both native operations', async () => {
    const h = await fixture();
    h.click();
    h.fire('before-autosave');
    let idle = false;
    h.nativeEditor.idle.then(() => { idle = true; });
    h.receipt(`${h.config.base}.${'b'.repeat(64)}`);
    const data = {};
    h.fire('heartbeat-send', data);
    await flush();
    assert.equal(data.mtflpp_base, 'b'.repeat(64));
    assert.equal(idle, false);
    h.fire('heartbeat-tick', { mtflpp_base: 'c'.repeat(64), rest_nonce: 'renewed' });
    await flush();
    assert.equal(idle, true);
    assert.equal(h.config.base, 'c'.repeat(64));
    assert.equal(h.config.nonce, 'renewed');
});

test('disabled native Preview is left to WordPress without pausing the panel', async () => {
    const h = await fixture();
    h.click(true);
    assert.equal(h.nativeEditor.previewing, false);
    assert.equal(h.fields.length, 0);
    assert.equal(h.posts, 0);
});

test('native observers can be removed without leaving Preview or validation interception behind', async () => {
    const h = await fixture();
    h.nativeEditor.destroy();
    h.click();
    assert.equal(h.posts, 1);
    assert.equal(h.fields.length, 0);
    h.nativeEditor.saving = true;
    h.invalid();
    assert.equal(h.nativeEditor.saving, true);
});

test('cancelled native submission resumes unless ACF is still validating', async () => {
    const h = await fixture();
    h.nativeEditor.saving = true;
    h.nativeEditor.isValidating = () => true;
    await h.submit(true);
    assert.equal(h.nativeEditor.saving, true, 'preventDefault during asynchronous ACF validation is not failure');
    h.nativeEditor.isValidating = () => false;
    await h.submit(true);
    assert.equal(h.nativeEditor.saving, false);
});

test('later native submit cancellation resumes despite an unchanged jQuery wrapper', async () => {
    const h = await fixture();
    h.nativeEditor.saving = true;
    await h.submit(false, { defaultPrevented: true });
    assert.equal(h.nativeEditor.saving, false);
});

test('native submit cancellation still respects ACF validation and newer accepted submissions', async () => {
    const h = await fixture();
    h.nativeEditor.saving = true;
    h.nativeEditor.isValidating = () => true;
    await h.submit(false, { defaultPrevented: true });
    assert.equal(h.nativeEditor.saving, true, 'asynchronous validation is not a rejected save');
    h.nativeEditor.isValidating = () => false;
    h.submit(false, { defaultPrevented: true });
    await h.submit(false, { defaultPrevented: false });
    assert.equal(h.nativeEditor.saving, true, 'a newer accepted submission must keep live writes paused');
});

test('an accepted resubmission supersedes an earlier cancelled validation submit', async () => {
    const h = await fixture();
    h.nativeEditor.saving = true;
    h.submit(true);
    await h.submit(false);
    assert.equal(h.nativeEditor.saving, true, 'do not resume live writes during an accepted native save');
});

test('browser constraint validation resumes a rejected native Save', async () => {
    const h = await fixture();
    h.nativeEditor.saving = true;
    h.invalid();
    assert.equal(h.nativeEditor.saving, false);
});

const editorSource = await previewSourceForVm(new URL('../src/screens/classic-editor.js', import.meta.url));

for (const [saved, structural, blocked] of [[true, true, true], [false, true, false], [true, false, false]]) {
    test(`saved=${saved}, structural ACF changes=${structural}: ${blocked ? 'retain reload protection on reopen' : 'allow live preview'}`, async () => {
        const reports = [];
        let callbacks, requests = 0;
        const view = {
            visible: false, setVisible(value) { this.visible = value; },
            report: (text, state, detail) => reports.push({ text, state, ...detail }),
            clearPreview() {}, returnToEditor() {},
        };
        const native = { idle: Promise.resolve() };
        const context = {
            console, setTimeout, clearTimeout,
            document: { getElementById: (id) => id === 'post' ? { addEventListener() {} } : null },
            window: { isSecureContext: true, jQuery: () => ({ on() {} }), addEventListener() {},
                acf: { addAction() {}, removeAction() {} } },
            navigator: { locks: { request: () => { requests++; return new Promise(() => {}); } } },
        };
        context.imports = {
            './editor-extensions.js': editorExtensionsFixture(context, {
                initAcf: () => ({ hasStructuralPaginationChanges: () => structural, destroy() {} }),
            }),
            '../panel/window.js': { createPreviewPanel: (strings, options) => { callbacks = options; return view; } },
            '../preview/scroll.js': { createPreviewScroll: () => ({ remember() {} }) },
        };
        const initPreview = vm.runInNewContext(`${editorSource}\ninitLivePreview`, context);
        initPreview({
            available: true, acfEnabled: true, strings: { nativePreviewAcf: 'Copy later edits and reload.' },
        }, native);
        native.onPreview(undefined, saved);
        callbacks.onOpen();
        await flush();
        if (blocked) {
            assert.equal(requests, 0);
            assert.equal(reports.at(-1).reason, 'reload');
            assert.equal(reports.at(-1).canRetry, false);
            callbacks.onClose(); callbacks.onOpen();
            await flush();
            assert.equal(requests, 0, 'closing and reopening must not apply stale structural deltas');
            assert.equal(reports.at(-1).reason, 'reload');
        } else assert.equal(requests, 1);
    });
}
