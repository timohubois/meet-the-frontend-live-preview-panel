import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { withChromiumPage } from './helpers/chromium.mjs';
import { sourceForVm, previewSourceForVm } from './helpers/modules.mjs';
import { browserEditorExtensionsSource } from './helpers/editor-extensions.mjs';

async function browserFixture(editorSource, nativeSource, extensionSource) {
    const createEditorExtensions = new Function(`return (${extensionSource})(() => { throw new Error('ACF is disabled.'); });`)();
    const realJQuery = window.jQuery;
    window.BroadcastChannel = undefined;
    Object.defineProperty(navigator, 'locks', { value: { request: (name, options, run) => run({}) } });
    let cleanup;
    window.setupSave = async ({ cancel = 'native-submit', pending = false, validating = false } = {}) => {
        cleanup?.();
        const form = document.createElement('form');
        form.id = 'post';
        form.innerHTML = '<input id="title" name="post_title"><input id="wp-preview" value="" type="hidden"><button id="publish" type="submit">Update fixture post</button><button id="unrelated" type="button">Unrelated</button>';
        document.body.append(form);
        const listeners = [];
        window.jQuery = realJQuery || ((target) => ({
            on(events, callback) {
                for (const name of events.split(' ')) {
                    const type = name.split('.')[0];
                    const listener = (event) => {
                        const result = callback({ type, target: event.target, originalEvent: event,
                            isDefaultPrevented: () => event.defaultPrevented,
                            preventDefault: () => event.preventDefault() });
                        if (result === false) { event.preventDefault(); event.stopPropagation(); }
                    };
                    target.addEventListener(type, listener);
                    listeners.push({ target, type, listener });
                }
                return this;
            },
            off() { return this; },
        }));
        let native, options, finish;
        const reports = [], events = [];
        const response = () => ({ ok: false, json: async () => ({ message: 'Transient fixture failure' }) });
        window.fetch = () => pending ? new Promise((resolve) => { finish = () => resolve(response()); }) : Promise.resolve(response());
        const view = {
            visible: true, report: (text, state) => reports.push(state), setTitle() {},
            setVisible(value) { this.visible = value; }, clearPreview() {}, returnToEditor() {},
        };
        const config = { available: true, endpoint: '/preview', base: 'base', strings: {} };
        native = new Function(`${nativeSource}\nreturn createNativeEditor;`)()(config, form);
        const initPreview = new Function('imports', `${editorSource}\nreturn initLivePreview;`)({
            './editor-extensions.js': { createEditorExtensions },
            '../panel/window.js': { createPreviewPanel: (strings, callbacks) => { options = callbacks; return view; } },
            '../preview/scroll.js': { createPreviewScroll: () => ({ remember() {} }) },
        });
        initPreview(config, native);
        for (let i = 0; i < 40; i++) await Promise.resolve();
        native.isValidating = () => validating;
        const type = cancel.endsWith('click') ? 'click' : 'submit';
        const target = type === 'click' ? form.querySelector('#publish') : form;
        const reject = (event) => {
            events.push({ type, trusted: event.isTrusted ?? event.originalEvent?.isTrusted });
            event.preventDefault();
            if (cancel === 'jquery-click') return false; // Also cover cancellation that stops bubbling.
        };
        if (cancel.startsWith('jquery')) window.jQuery(target).on(`${type}.validation`, reject);
        else if (cancel !== 'none') target.addEventListener(type, reject);
        // Accepted saves target an inert document rather than navigating this fixture.
        const destination = document.createElement('iframe');
        destination.name = 'native-save-target';
        destination.hidden = true;
        document.body.append(destination);
        form.target = destination.name;
        window.saveState = () => ({ saving: native.saving, stale: reports.filter((state) => state === 'stale').length, events });
        window.editAfterSave = () => form.querySelector('#title').dispatchEvent(new Event('input', { bubbles: true }));
        window.finishSaveWrite = () => { finish(); pending = false; };
        window.failSaveValidation = () => native.onSaveCancelled();
        window.acceptNewerSave = () => {
            target.click();
            target.removeEventListener(type, reject);
            window.jQuery(target).off('.validation');
            form.requestSubmit(form.querySelector('#publish'));
        };
        cleanup = () => {
            options.onClose();
            native.destroy();
            window.jQuery(document).off('.mtflpp');
            window.jQuery(form).off('.mtflpp .validation');
            window.jQuery(target).off('.validation');
            for (const { target, type, listener } of listeners) target.removeEventListener(type, listener);
            form.remove(); destination.remove();
        };
    };
}

const editorSource = await previewSourceForVm(new URL('../src/screens/classic-editor.js', import.meta.url));
const nativeSource = await sourceForVm(new URL('../src/screens/classic-native-editor.js', import.meta.url));
const jquery = process.env.WORDPRESS_ROOT
    ? await readFile(join(process.env.WORDPRESS_ROOT, 'wp-includes/js/jquery/jquery.js'), 'utf8') : '';
const script = `(${browserFixture.toString()})(${JSON.stringify(editorSource)}, ${JSON.stringify(nativeSource)}, ${JSON.stringify(browserEditorExtensionsSource)});`;
const html = `<!doctype html><script src="data:text/javascript;base64,${Buffer.from(jquery).toString('base64')}"></script><body><script>${script.replace(/<\/script/gi, '<\\/script')}</script></body>`;

test('native save cancellation with trusted Chromium input', { timeout: 30000 }, async (t) => withChromiumPage(html, async ({ args, url }) => {
    const pending = new Map();
    let chrome, sessionId, nextId = 0, buffer = '', stderr = '';
    const rejectPending = (error) => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    };
    const abort = () => { rejectPending(t.signal.reason); chrome?.kill(); };
    t.signal.addEventListener('abort', abort, { once: true });
    try {
        // dump-dom and element.click() cannot reproduce microtask checkpoints between trusted listeners.
        // A local DevTools pipe supplies actual input without another browser dependency or server.
        chrome = spawn(process.env.CHROMIUM_BIN || 'chromium', [...args, '--remote-debugging-pipe'],
            { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
        chrome.stderr.on('data', (data) => { stderr += data; });
        chrome.on('error', rejectPending);
        chrome.on('exit', (code) => rejectPending(new Error(`Chromium exited (${code}).\n${stderr}`)));
        chrome.stdio[3].on('error', rejectPending);
        chrome.stdio[4].setEncoding('utf8');
        chrome.stdio[4].on('data', (data) => {
            buffer += data;
            let end;
            while ((end = buffer.indexOf('\0')) !== -1) {
                const message = JSON.parse(buffer.slice(0, end));
                buffer = buffer.slice(end + 1);
                const entry = pending.get(message.id);
                if (!entry) continue;
                pending.delete(message.id);
                if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
                else entry.resolve(message.result);
            }
        });
        const send = (method, params = {}, targetSession = sessionId) => new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId: targetSession })}\0`);
        });
        const { targetId } = await send('Target.createTarget', { url });
        ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
        const evaluate = async (expression) => {
            const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        for (let i = 0; i < 100 && !(await evaluate('typeof window.setupSave === "function"')); i++) await delay(10);
        assert.equal(await evaluate('typeof window.setupSave'), 'function', stderr);
        const tap = async (selector = '#publish') => {
            const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
            await evaluate('new Promise(resolve => setTimeout(resolve, 10))');
        };
        for (const cancel of ['native-submit', 'jquery-submit', 'native-click', 'jquery-click']) {
            await t.test(`${cancel} cancellation resumes field tracking`, async () => {
                await evaluate(`setupSave(${JSON.stringify({ cancel })})`);
                await tap();
                const before = await evaluate('saveState()');
                assert.deepEqual(before.events, [{ type: cancel.endsWith('click') ? 'click' : 'submit', trusted: true }]);
                assert.equal(before.saving, false);
                await evaluate('editAfterSave()');
                assert.equal((await evaluate('saveState()')).stale, before.stale + 1);
            });
        }
        await t.test('clicks intercepted while draining do not cancel the queued save', async () => {
            await evaluate('setupSave({pending:true})');
            await tap(); await tap();
            assert.equal((await evaluate('saveState()')).saving, true);
            assert.deepEqual((await evaluate('saveState()')).events, []);
            await evaluate('finishSaveWrite()');
            await evaluate('new Promise(resolve => setTimeout(resolve, 10))');
            const result = await evaluate('saveState()');
            assert.equal(result.saving, false, 'a rejected replay resumes updates');
            assert.equal(result.events.length, 1, 'only one queued save reaches validation');
        });
        await t.test('an accepted queued save keeps live writes paused', async () => {
            await evaluate('setupSave({pending:true,cancel:"none"})');
            await tap();
            assert.equal((await evaluate('saveState()')).saving, true);
            await evaluate('finishSaveWrite()');
            await evaluate('new Promise(resolve => setTimeout(resolve, 10))');
            assert.equal((await evaluate('saveState()')).saving, true);
        });
        await t.test('a newer accepted submit supersedes a rejected button click', async () => {
            await evaluate('setupSave({cancel:"native-click"})');
            await evaluate('acceptNewerSave(); new Promise(resolve => setTimeout(resolve, 10))');
            assert.equal((await evaluate('saveState()')).saving, true);
        });
        await t.test('ACF validation keeps updates paused until its rejection callback', async () => {
            await evaluate('setupSave({validating:true})');
            await tap();
            assert.equal((await evaluate('saveState()')).saving, true);
            await evaluate('failSaveValidation()');
            assert.equal((await evaluate('saveState()')).saving, false);
        });
        await t.test('unrelated button clicks do not pause preview updates', async () => {
            await evaluate('setupSave()');
            await tap('#unrelated');
            assert.equal((await evaluate('saveState()')).saving, false);
        });
    } finally {
        t.signal.removeEventListener('abort', abort);
        if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
            await new Promise((resolve) => { chrome.once('exit', resolve); chrome.kill(); });
        }
    }
}));
