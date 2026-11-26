import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runChromiumTests, testInChromium } from './helpers/chromium.mjs';
import { sourceForVm, previewSourceForVm } from './helpers/modules.mjs';
import { browserEditorExtensionsSource } from './helpers/editor-extensions.mjs';

async function browserTests(editorSource, initAcf, nativeSource, extensionSource) {
    const createEditorExtensions = new Function('initAcf', `return (${extensionSource})(initAcf);`)(initAcf);
    const realJQuery = window.jQuery;
    const results = [];
    const equal = (actual, expected) => {
        if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
    };
    if (window.QTags) equal(typeof realJQuery?.fn?.jquery, 'string');
    window.BroadcastChannel = undefined;
    Object.defineProperty(navigator, 'locks', { value: { request: (name, options, run) => run({}) } });

    async function fixture({ withAcf = false, withWordPress = false, withTinyMce = true } = {}) {
        const form = document.createElement('form');
        form.id = 'post';
        form.innerHTML = '<input id="title" name="post_title"><textarea name="content"></textarea><textarea name="excerpt"></textarea><input name="unrelated"><input name="_acf_nonce" value="nonce"><div class="acf-field"><input name="acf[field_text]" value="ACF text"><input name="_acf_fields[field_rows]" value="rows"><div class="widget"></div></div>';
        document.body.append(form);
        const reports = [];
        const titles = [];
        const timers = new Map();
        const actions = new Map();
        const requests = [];
        const editorEvents = new Map();
        const editor = { on: (events, callback) => {
            for (const event of events.split(' ')) editorEvents.set(event, callback);
        }, off: (events, callback) => {
            for (const event of events.split(' ')) if (editorEvents.get(event) === callback) editorEvents.delete(event);
        } };
        let addEditor;
        let options;
        let finishNative;
        const original = { setTimeout, clearTimeout, fetch };
        let nextTimer = 0;
        window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
        window.clearTimeout = (id) => timers.delete(id);
        window.fetch = (url, request) => { requests.push(request); return new Promise(() => {}); };
        const tinymce = {
            editors: [editor],
            on: (event, callback) => { addEditor = callback; }, off() {},
            triggerSave: () => {
                editorEvents.get('SetContent')?.();
                if (withWordPress) window.jQuery(form.querySelector('[name="content"]')).trigger('change');
            },
        };
        if (withTinyMce) window.tinymce = tinymce;
        else delete window.tinymce;
        const handlers = new Map();
        const jqueryListeners = [];
        const jqueryCalls = [];
        const jqueryMethods = realJQuery && { on: realJQuery.fn.on, off: realJQuery.fn.off };
        delete window.jQuery;
        if (withAcf) window.acf = {
            addAction: (name, callback) => actions.set(name, callback),
            removeAction: (name) => actions.delete(name),
        };
        if (withAcf || withWordPress) {
            // Observe the public subscription contract with real jQuery as well as the boundary mock.
            if (realJQuery) for (const method of ['on', 'off']) {
                realJQuery.fn[method] = function (...args) {
                    jqueryCalls.push({ method, target: this[0], args });
                    return jqueryMethods[method].apply(this, args);
                };
            }
            // Use real WordPress assets when supplied; otherwise model only the jQuery event boundary.
            window.jQuery = realJQuery || ((target) => ({
                on(events, callback) {
                    jqueryCalls.push({ method: 'on', target, args: [events, callback] });
                    if (!handlers.has(target)) handlers.set(target, []);
                    for (const event of events.split(' ')) {
                        const type = event.split('.')[0];
                        handlers.get(target).push({ type, callback });
                        const listener = (event) => callback({ type, target: event.target, originalEvent: event });
                        target.addEventListener(type, listener);
                        jqueryListeners.push({ target, type, listener });
                    }
                    return this;
                },
                trigger(type, args = []) {
                    for (let node = target; node; node = node.parentNode) {
                        for (const handler of handlers.get(node) || []) {
                            if (handler.type === type) handler.callback({ type, target }, ...args);
                        }
                    }
                    return this;
                },
                triggerHandler(type, args = []) {
                    for (const handler of handlers.get(target) || []) {
                        if (handler.type === type) handler.callback({ type, target }, ...args);
                    }
                },
                off(...args) { jqueryCalls.push({ method: 'off', target, args }); return this; },
            }));
        }
        const trigger = (type, target, args) => window.jQuery(target).trigger(type, args);
        let nativeEditor = { idle: new Promise((resolve) => { finishNative = resolve; }) };
        const view = {
            visible: true,
            report: (text, state, options) => reports.push({ state, ...options }),
            setTitle: (title) => titles.push(title),
            setVisible: (visible) => { view.visible = visible; },
            clearPreview() {},
            returnToEditor() {},
        };
        const config = { available: true, acfEnabled: withAcf, endpoint: '/preview', base: 'base', strings: {} };
        const createPanel = (strings, callbacks) => { options = callbacks; return view; };
        const createScroll = () => ({ remember() {} });
        const initPreview = new Function('imports', `${editorSource}\nreturn initLivePreview;`)({
            './editor-extensions.js': { createEditorExtensions },
            '../panel/window.js': { createPreviewPanel: createPanel },
            '../preview/scroll.js': { createPreviewScroll: createScroll },
        });
        if (withWordPress) {
            const idle = nativeEditor.idle;
            nativeEditor = new Function(`${nativeSource}\nreturn createNativeEditor;`)()(config, form);
            nativeEditor.idle = idle;
        }
        initPreview(config, nativeEditor);
        equal(reports.at(-1).state, 'loading');
        return {
            form, titles, timers, actions, editorEvents, trigger, nativeEditor, jqueryCalls,
            stale: () => reports.filter(({ state }) => state === 'stale').length,
            canRefresh: () => reports.at(-1).canRefresh,
            dispatch: (selector, type = 'input', bubbles = true) => form.querySelector(selector).dispatchEvent(new Event(type, { bubbles })),
            addEditor: (editor) => addEditor({ editor }),
            initializeEditor(initialized = editor) {
                window.tinymce = tinymce;
                window.jQuery(document).triggerHandler('tinymce-editor-init', [initialized]);
            },
            close: () => options.onClose(),
            async capture() { finishNative(); await Promise.resolve(); return requests[0].body; },
            async runTask() {
                for (const [id, timer] of [...timers]) if (timer.delay === 0) {
                    timers.delete(id);
                    await timer.callback();
                }
            },
            cleanup() {
                options.onClose();
                nativeEditor.destroy?.();
                if (window.jQuery) {
                    window.jQuery(document).off('.mtflpp');
                    window.jQuery(form).off('.mtflpp .mtflppAcf');
                }
                for (const { target, type, listener } of jqueryListeners) target.removeEventListener(type, listener);
                if (jqueryMethods) Object.assign(realJQuery.fn, jqueryMethods);
                Object.assign(window, original);
                form.remove();
            },
        };
    }
    async function check(name, run, options = {}) {
        let context;
        try {
            context = await fixture(options);
            await run(context);
            results.push({ name });
        } catch (error) { results.push({ name, error: error.message }); }
        finally { context?.cleanup(); }
    }

    await check('pending edits keep manual refresh disabled before and during a request', async (context) => {
        equal(context.canRefresh(), false);
        context.dispatch('[name="post_title"]');
        equal(context.canRefresh(), false);
        await context.capture();
        context.dispatch('[name="content"]');
        equal(context.canRefresh(), false);
        equal(context.timers.size, 1);
    });
    await check('core fields use native events without jQuery', (context) => {
        for (const name of ['post_title', 'content', 'excerpt']) {
            for (const type of ['input', 'change']) context.dispatch(`[name="${name}"]`, type);
        }
        equal(context.stale(), 6);
        equal(context.timers.size, 1);
        equal([...context.timers.values()][0].delay, 275);
    });
    await check('non-bubbling native core changes are captured, as emitted by Quicktags', (context) => {
        context.dispatch('[name="content"]', 'change', false);
        context.dispatch('[name="excerpt"]', 'change', false);
        equal(context.stale(), 2);
        equal(context.timers.size, 1);
    });
    await check('WordPress jQuery-only core edits refresh and synchronize the title', (context) => {
        context.form.querySelector('#title').value = 'Programmatic title';
        for (const name of ['post_title', 'content', 'excerpt']) {
            for (const type of ['input', 'change']) context.trigger(type, context.form.querySelector(`[name="${name}"]`));
        }
        equal(context.stale(), 6);
        equal(context.titles.at(-1), 'Programmatic title');
        context.trigger('change', context.form.querySelector('[name="unrelated"]'));
        context.trigger('change', context.form.querySelector('[name="_acf_nonce"]'));
        equal(context.stale(), 6);
        equal(context.timers.size, 1);
    }, { withWordPress: true });
    await check('WordPress and ACF bridges do not duplicate native core or ACF events', (context) => {
        context.dispatch('[name="content"]');
        context.dispatch('[name="content"]', 'change');
        context.dispatch('.acf-field input');
        context.dispatch('.acf-field input', 'change');
        equal(context.stale(), 4);
        equal(context.timers.size, 1);
    }, { withAcf: true, withWordPress: true });
    await check('the WordPress bridge leaves synthetic ACF edits to the ACF adapter', (context) => {
        context.trigger('change', context.form.querySelector('.acf-field input'));
        context.trigger('change', context.form.querySelector('.widget'));
        equal(context.stale(), 2);
    }, { withAcf: true, withWordPress: true });
    await check('jQuery-only titles still synchronize with the preview closed', (context) => {
        context.close();
        context.form.querySelector('#title').value = 'Closed preview title';
        context.trigger('change', context.form.querySelector('#title'));
        equal(context.titles.at(-1), 'Closed preview title');
        equal(context.stale(), 0);
        equal(context.timers.size, 0);
    }, { withWordPress: true });
    if (window.QTags) await check('real WordPress Quicktags insertion schedules a refresh', (context) => {
        const textarea = context.form.querySelector('[name="content"]');
        textarea.id = 'content';
        window.wpActiveEditor = 'content';
        QTags.insertContent('<img src="/example.jpg">');
        equal(textarea.value, '<img src="/example.jpg">');
        equal(context.stale(), 1);
        equal(context.timers.size, 1);
    }, { withWordPress: true });
    if (realJQuery) for (const native of [false, true]) {
        await check(`a later ${native ? 'native' : 'jQuery'} submit cancellation resumes preview change tracking`, async (context) => {
            context.nativeEditor.saving = true;
            const cancel = (event) => event.preventDefault();
            if (native) context.form.addEventListener('submit', cancel);
            else window.jQuery(context.form).on('submit.validation', cancel);
            try {
                const event = new Event('submit', { bubbles: true, cancelable: true });
                context.form.dispatchEvent(event);
                equal(event.defaultPrevented, true);
                await context.runTask();
                equal(context.nativeEditor.saving, false);
                equal(context.stale(), 1);
                context.dispatch('[name="content"]');
                equal(context.stale(), 2);
            } finally {
                if (native) context.form.removeEventListener('submit', cancel);
                else window.jQuery(context.form).off('.validation');
            }
        }, { withWordPress: true });
    }
    await check('unrelated controls and ACF fields without integration do not refresh', (context) => {
        context.dispatch('[name="unrelated"]');
        context.dispatch('[name="_acf_nonce"]', 'change');
        context.dispatch('.acf-field input');
        equal(context.stale(), 0);
        equal(context.timers.size, 0);
    });
    await check('dynamically added core fields are covered by delegation', (context) => {
        const field = document.createElement('textarea');
        field.name = 'excerpt';
        context.form.append(field);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        equal(context.stale(), 1);
    });
    await check('title still updates while preview is stopped without scheduling a refresh', (context) => {
        context.close();
        context.form.querySelector('#title').value = 'New title';
        context.dispatch('#title');
        equal(context.titles.at(-1), 'New title');
        equal(context.stale(), 0);
        equal(context.timers.size, 0);
    });
    await check('TinyMCE input, undo, redo and content changes retain their existing hooks', (context) => {
        for (const event of ['input', 'change', 'undo', 'redo', 'SetContent']) context.editorEvents.get(event)();
        equal(context.stale(), 5);
        let registrations = 0;
        const editor = { on: () => registrations++, off() {} };
        context.addEditor(editor);
        context.addEditor(editor);
        equal(registrations, 1);
    });
    await check('WordPress readiness attaches Visual-editor listeners when TinyMCE loads after the panel', (context) => {
        equal(window.tinymce, undefined);
        equal(context.editorEvents.size, 0);
        context.initializeEditor();
        for (const event of ['input', 'change', 'undo', 'redo', 'SetContent']) context.editorEvents.get(event)();
        equal(context.stale(), 5);
        equal(context.timers.size, 1);
    }, { withWordPress: true, withTinyMce: false });
    await check('WordPress, TinyMCE and ACF readiness do not duplicate editor listeners', (context) => {
        let registrations = 0;
        const editor = { on: () => registrations++, off() {} };
        context.addEditor(editor);
        context.initializeEditor(editor);
        context.initializeEditor(editor);
        context.actions.get('wysiwyg_tinymce_init')(editor);
        equal(registrations, 1);
    }, { withAcf: true, withWordPress: true });
    await check('late TinyMCE initialization preserves native Text-mode editing and capture', async (context) => {
        context.form.querySelector('[name="content"]').value = 'Text-mode content';
        context.dispatch('[name="content"]');
        const body = await context.capture();
        equal(window.tinymce, undefined);
        equal(body.get('content'), 'Text-mode content');
        equal(context.stale(), 1);
    }, { withWordPress: true, withTinyMce: false });
    await check('teardown unsubscribes the document readiness handler, detaches editors and ignores later readiness', (context) => {
        const event = 'tinymce-editor-init.mtflppClassicEditor';
        const subscription = context.jqueryCalls.find(({ method, target, args }) =>
            method === 'on' && target === document && args[0] === event);
        equal(!!subscription, true);
        const removals = () => context.jqueryCalls.filter(({ method, target, args }) =>
            method === 'off' && target === document && args[0] === event);
        equal(removals().length, 0);
        context.initializeEditor();
        equal(context.editorEvents.size, 5);
        context.nativeEditor.destroy();
        equal(context.editorEvents.size, 0);
        equal(removals().length, 1);
        equal(removals()[0].args[1] === subscription.args[1], true);
        context.nativeEditor.destroy();
        equal(removals().length, 1);
        let registrations = 0;
        context.initializeEditor({ on: () => registrations++, off() {} });
        equal(registrations, 0);
    }, { withWordPress: true, withTinyMce: false });
    await check('native ACF events refresh once, including dynamically added fields', (context) => {
        context.dispatch('.acf-field input');
        context.dispatch('.acf-field input', 'change');
        const field = document.createElement('input');
        field.name = 'acf[field_added]';
        context.form.querySelector('.acf-field').append(field);
        field.dispatchEvent(new Event('change', { bubbles: true }));
        equal(context.stale(), 3);
    }, { withAcf: true });
    await check('standalone ACF field and structural actions still request a preview', (context) => {
        const field = { get: () => 'field_text' };
        context.actions.get('change_field')(field);
        context.actions.get('append')();
        context.actions.get('remove')();
        context.actions.get('sortstop')();
        equal(context.stale(), 4);
    }, { withAcf: true });
    await check('ACF jQuery-only input and widget container changes retain their bridge', (context) => {
        context.trigger('input', context.form.querySelector('.acf-field input'));
        context.trigger('change', context.form.querySelector('.widget'));
        context.trigger('change', context.form.querySelector('.acf-field'));
        context.trigger('change', context.form.querySelector('[name="unrelated"]'));
        equal(context.stale(), 3);
        equal(context.timers.size, 1);
    }, { withAcf: true });
    await check('both native and jQuery-only ACF sorting events remain covered', (context) => {
        context.dispatch('.acf-field', 'sortupdate');
        context.trigger('sortupdate', context.form.querySelector('.acf-field'));
        equal(context.stale(), 2);
    }, { withAcf: true });
    await check('a Flexible Content drop contributes text and image hints without changing the request', async (context) => {
        const name = (row, field = 'acf_fc_layout') => `acf[field_layouts][${row}][${field}]`;
        const group = context.form.querySelector('.acf-field');
        group.insertAdjacentHTML('beforeend', `<div class="values">${['row-0', 'row-disabled', 'row-1', 'acfcloneindex'].map((row) =>
            `<div class="layout"><input type="hidden" name="${name(row)}" value="same_layout">
                <input type="hidden" name="${name(row, 'acf_fc_layout_disabled')}" value="${row === 'row-disabled' ? '1' : '0'}">
                <input type="text" name="${name(row, 'field_heading')}" value="Heading ${row}">
                <input type="text" name="${name(row, 'field_disabled')}" value="Not submitted" disabled>
                <textarea class="wp-editor-area" name="${name(row, 'field_body')}">Body ${row}</textarea>
                <div class="acf-field" data-type="image"><div class="acf-image-uploader has-value">
                    <input type="hidden" name="${name(row, 'field_image')}" value="123">
                    <div class="image-wrap"><img data-name="image" alt="Image ${row}"></div>
                </div></div>
                <input type="hidden" name="${name(row, 'field_untyped')}" value="123">
            </div>`).join('')}</div>`);
        const container = group.querySelector('.values');
        const row = container.firstElementChild;
        const posted = [];
        window.fetch = async (_url, { body }) => {
            posted.push(body);
            return new Response(JSON.stringify({ url: '/preview-frame' }));
        };
        const key = 'acf-layout-order:acf[field_layouts]';
        const capture = async () => (await context.nativeEditor.preparePreview()).comparisonValues;
        const oldValues = await capture();
        const before = oldValues[key];
        equal(before.type, 'row-order');
        equal(before.value, JSON.stringify([name('row-0'), name('row-1')]));
        equal(before.moved, undefined);
        container.insertBefore(row, container.lastElementChild);
        context.trigger('sortupdate', container, [{ item: [row] }]);
        const values = await capture(), after = values[key];
        equal(after.moved, name('row-0'));
        equal(after.value, JSON.stringify([name('row-1'), name('row-0')]));
        equal(after.members, before.members);
        for (const hint of [before, after]) {
            equal(JSON.stringify(Object.keys(hint.fieldsByRow).sort()), JSON.stringify([name('row-0'), name('row-1')]));
            for (const row of ['row-0', 'row-1']) equal(JSON.stringify(hint.fieldsByRow[name(row)]),
                JSON.stringify([name(row, 'field_heading'), name(row, 'field_body'), name(row, 'field_image')]));
        }
        for (const snapshot of [oldValues, values]) {
            equal(JSON.stringify(snapshot[name('row-0', 'field_image')]), JSON.stringify({ type: 'row-image', value: '123', alt: 'Image row-0' }));
            equal(snapshot[name('row-0', 'field_untyped')], undefined);
            equal(snapshot[name('row-disabled', 'field_image')], undefined);
            equal(snapshot[name('acfcloneindex', 'field_image')], undefined);
        }
        equal(posted[1].get(name('row-0', 'field_image')), '123');
        equal(posted[1].get(name('row-0', 'field_heading')), 'Heading row-0');
        equal(posted[1].has(name('row-0', 'field_disabled')), false);
        equal(posted[1].get(name('row-disabled')), 'same_layout');
        equal(posted[1].get(name('row-disabled', 'acf_fc_layout_disabled')), '1');
        equal(posted[1].has(key), false);
        equal(posted[1].has(name('acfcloneindex')), false);
        equal(context.stale(), 1);
    }, { withAcf: true });
    await check('a gallery order hint describes the exact submitted gallery occurrence', async (context) => {
        const name = (row) => row ? `acf[field_layouts][${row}][field_images]` : 'acf[field_standalone_gallery]';
        const group = context.form.querySelector('.acf-field');
        const gallery = (row, ids) => `<div class="acf-field" data-type="gallery"><div class="acf-gallery" id="gallery-${row}">
                    <input type="hidden" name="${name(row)}" value="">
                    <div class="acf-gallery-main"><div class="acf-gallery-attachments">${ids.map((id) =>
                        `<div class="acf-gallery-attachment"><input type="hidden" name="${name(row)}[]" value="${id}"></div>`).join('')}
                    </div></div></div></div>`;
        group.insertAdjacentHTML('beforeend', gallery('', []) + ['row-0', 'row-1', 'row-2', 'acfcloneindex'].map((row, index) =>
            `<div class="layout"><input type="hidden" name="acf[field_layouts][${row}][acf_fc_layout]" value="gallery">
                <input type="hidden" name="acf[field_layouts][${row}][acf_fc_layout_disabled]" value="${index === 2 ? 1 : 0}">
                ${gallery(row, index === 1 ? [] : [302, 103])}
            </div>`).join(''));
        let submitted;
        window.fetch = async (_url, { body }) => {
            submitted = body;
            return new Response(JSON.stringify({ url: '/preview-frame' }));
        };
        const key = `${name('row-0')}[]`;
        const first = (await context.nativeEditor.preparePreview()).comparisonValues;
        equal(JSON.stringify(first[key]), JSON.stringify({ type: 'gallery-order', value: '["302","103"]', members: '["103","302"]' }));
        equal(first[`${name('row-1')}[]`].value, '[]');
        equal(first[`${name('row-2')}[]`]?.type, 'order');
        equal(first[`${name('acfcloneindex')}[]`], undefined);
        const list = group.querySelector('#gallery-row-0 .acf-gallery-attachments');
        list.prepend(list.lastElementChild);
        context.trigger('sortupdate', list, [{ item: [list.firstElementChild] }]);
        const second = (await context.nativeEditor.preparePreview()).comparisonValues;
        equal(second[key].value, '["103","302"]');
        equal(second[key].members, first[key].members);
        equal(JSON.stringify(submitted.getAll(key)), second[key].value);
        equal(submitted.get(name('row-0')), '');
        group.querySelectorAll('.layout').forEach((item) => item.remove());
        const standalone = group.querySelector('#gallery- .acf-gallery-attachments');
        standalone.insertAdjacentHTML('beforeend', `<div class="acf-gallery-attachment"><input type="hidden" name="${name()}[]" value="123"></div>`);
        const added = (await context.nativeEditor.preparePreview()).comparisonValues;
        equal(first[`${name()}[]`].value, '[]');
        equal(added[`${name()}[]`].value, '["123"]');
        equal(added[`${name()}[]`].type, 'gallery-order');
    }, { withAcf: true });
    await check('ACF row lifecycle and WYSIWYG hooks remain in the adapter', (context) => {
        for (const action of ['append', 'remove', 'sortstop', 'change_field']) context.actions.get(action)();
        equal(context.stale(), 4);
        let registrations = 0;
        context.actions.get('wysiwyg_tinymce_init')({ on: () => registrations++, off() {} });
        equal(registrations, 1);
    }, { withAcf: true });
    await check('classic preview capture skips only ACF row templates and leaves native controls intact', async (context) => {
        context.form.querySelector('#title').value = 'Preview title';
        context.dispatch('#title');
        const fields = [
            ['acf[field_rows][acfcloneindex][field_text]', 'template'],
            ['acf[field_rows][row-0][field_children][acfcloneindex][field_text]', 'nested template'],
            ['_acf_fields[field_rows][acfcloneindex][]', 'template helper'],
            ['acf[field_rows][row-0][field_children][row-1][field_text]', ''],
            ['acf[field_rows][row-0][acf_reordered]', '1'],
            ['_acf_fields[field_rows][row-0][]', 'first'],
            ['_acf_fields[field_rows][row-0][]', 'second'],
            ['acf[field_acfcloneindex_text]', 'keep [acfcloneindex] in values'],
        ];
        for (const [name, value] of fields) {
            const input = document.createElement('input');
            Object.assign(input, { name, value, type: 'hidden' });
            context.form.querySelector('.acf-field').append(input);
        }
        const nativeForm = JSON.stringify([...new FormData(context.form)]);
        const data = await context.capture();
        for (const [name] of fields.slice(0, 3)) equal(data.has(name), false);
        for (const [name, value] of fields.slice(3)) equal(data.getAll(name).includes(value), true);
        equal(JSON.stringify(data.getAll('_acf_fields[field_rows][row-0][]')), '["first","second"]');
        equal(JSON.stringify([...new FormData(context.form)]), nativeForm);
        equal(data.get('post_title'), 'Preview title');
        equal(data.get('acf[field_text]'), 'ACF text');
        equal(data.get('_acf_fields[field_rows]'), 'rows');
        equal(data.get('_acf_nonce'), 'nonce');
        equal(data.get('base'), 'base');
        equal(data.has('unrelated'), false);
        equal(context.stale(), 1);
    }, { withAcf: true, withWordPress: true });
    return results;
}

testInChromium('native editor events and ACF compatibility boundaries', async (t) => {
    const editorSource = await previewSourceForVm(new URL('../src/screens/classic-editor.js', import.meta.url));
    const nativeSource = await sourceForVm(new URL('../src/screens/classic-native-editor.js', import.meta.url));
    const acfSource = await readFile(new URL('../src/compatibility/acf-fields.js', import.meta.url), 'utf8');
    const acfUrl = `data:text/javascript;base64,${Buffer.from(acfSource).toString('base64')}`;
    const wordpressScripts = process.env.WORDPRESS_ROOT ? await Promise.all([
        'wp-includes/js/jquery/jquery.js', 'wp-includes/js/quicktags.js',
    ].map(async (path) => {
        const source = await readFile(join(process.env.WORDPRESS_ROOT, path), 'utf8');
        return `<script src="data:text/javascript;base64,${Buffer.from(source).toString('base64')}"></script>`;
    })) : [];
    await runChromiumTests(t, {
        head: `<script>window.quicktagsL10n = new Proxy({}, { get: (target, key) => key });</script>${wordpressScripts.join('')}`,
        script: `(${browserTests.toString()})(${JSON.stringify(editorSource)}, (await import(${JSON.stringify(acfUrl)})).initAcf, ${JSON.stringify(nativeSource)}, ${JSON.stringify(browserEditorExtensionsSource)})`,
        count: process.env.WORDPRESS_ROOT ? 26 : 23,
    });
});
