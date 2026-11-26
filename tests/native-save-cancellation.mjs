import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withChromiumInput, withChromiumPage, testInChromium } from './helpers/chromium.mjs';
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

testInChromium('native save cancellation with trusted Chromium input', { timeout: 30000 }, async (t) => withChromiumPage(html, ({ args, url }) =>
    withChromiumInput(t, url, args, async ({ send, evaluate }) => {
        for (let i = 0; i < 100 && !(await evaluate('typeof window.setupSave === "function"')); i++) await delay(10);
        assert.equal(await evaluate('typeof window.setupSave'), 'function');
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
    })
));
