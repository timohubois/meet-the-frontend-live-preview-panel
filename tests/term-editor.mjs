import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { sourceForVm } from './helpers/modules.mjs';

const source = await sourceForVm(new URL('../src/screens/term-editor.js', import.meta.url));
const acfSource = await sourceForVm(new URL('../src/compatibility/acf-term-editor.js', import.meta.url));

test('term preview follows native fields even when a plugin duplicates or replaces a control', async () => {
    const nameSelector = '.term-name-wrap input[name="name"]';
    const descriptionSelector = '.term-description-wrap textarea[name="description"]';
    const field = (value, selector) => ({ value, matches: (candidate) => candidate === selector });
    const name = field('Saved name', nameSelector), slug = field('new-slug', '#slug');
    const duplicate = field('Not the term description', '#description');
    const config = { endpoint: 'http://wp.test/?rest_route=/mtflpp/terms/42/preview', nonce: 'rest-nonce', strings: {} };
    const handlers = new Map();
    const fields = {
        [nameSelector]: name,
        [descriptionSelector]: field('Saved description', descriptionSelector),
        '[name="description"]': duplicate,
        '#description': duplicate,
    };
    const form = {
        // A duplicate ID/name makes namedItem('description') return a RadioNodeList with an empty value.
        elements: { namedItem: (field) => ({ name, description: { value: '' }, slug })[field] },
        querySelector: (selector) => fields[selector] ?? null,
        addEventListener: (type, callback) => handlers.set(type, callback),
    };
    const events = [], requests = [];
    let adapter;
    const preview = { start: () => events.push('started'), changed: () => events.push('changed'),
        setTitle: (value) => events.push(value) };
    const context = {
        URLSearchParams,
        window: { addEventListener() {} },
        imports: { '../preview/live-preview.js': { createLivePreview(received, editor) {
            assert.equal(received, config);
            assert.equal(editor.title, 'Saved name');
            adapter = editor;
            return preview;
        } } },
        fetch: async (url, options) => {
            requests.push({ url, ...options });
            return { ok: true, json: async () => ({ url: 'http://wp.test/?cat=42&mtflpp_token=token' }) };
        },
        config, form,
    };
    vm.runInNewContext(`${source}\ninitTermPreview(config, form);`, context);
    assert.deepEqual([...handlers.keys()], ['input', 'change']);
    name.value = "Changed O'Reilly";
    // A startup script re-renders the native row after we bind the form listeners.
    const description = field('Edited term description', descriptionSelector);
    fields[descriptionSelector] = description;
    handlers.get('input')({ target: name });
    handlers.get('change')({ target: description });
    handlers.get('input')({ target: slug });
    handlers.get('input')({ target: duplicate });
    assert.deepEqual(events, ['started', name.value, 'changed', 'changed']);

    const pending = adapter.preparePreview();
    description.value = '';
    const result = await pending;
    const request = requests[0];
    assert.equal(request.url, config.endpoint);
    assert.equal(request.method, 'POST');
    assert.equal(request.credentials, 'same-origin');
    assert.equal(request.headers['X-WP-Nonce'], config.nonce);
    assert.deepEqual(Object.fromEntries(request.body), { name: name.value, description: 'Edited term description' });
    assert.equal(result.comparisonValues.name.value, name.value);
    assert.equal(result.comparisonValues.description.value, 'Edited term description');
    assert.equal(result.url, 'http://wp.test/?cat=42&mtflpp_token=token');
    assert.equal((await adapter.preparePreview()).comparisonValues.description.value, '');
    assert.equal(requests[1].body.get('description'), '');
});

test('term preview observes the late Visual description editor and keeps Text mode native', async () => {
    const name = { value: 'Saved name' }, textarea = { value: 'Saved description' };
    const document = {};
    const form = {
        ownerDocument: document,
        querySelector: (selector) => selector.startsWith('.term-name-wrap') ? name : textarea,
        contains: (element) => element === textarea,
        addEventListener() {},
    };
    let adapter, initialized, onInput, pagehide, events, unbound;
    let refreshes = 0, hidden = false;
    const namespace = 'tinymce-editor-init.mtflppTermEditor';
    const editor = {
        id: 'description', getElement: () => textarea, getBody: () => ({}),
        isHidden: () => hidden, getContent: () => '<p>Unsaved <strong>Visual</strong> edit</p>',
        on(types, callback) { events = types; onInput = callback; },
        off(types, callback) { assert.equal(types, events); assert.equal(callback, onInput); onInput = undefined; },
    };
    vm.runInNewContext(`${source}\ninitTermPreview({ strings: {} }, form);`, {
        form, URLSearchParams,
        window: {
            jQuery: (target) => {
                assert.equal(target, document);
                return { on(type, callback) { assert.equal(type, namespace); initialized = callback; },
                    off(type) { unbound = type; } };
            },
            addEventListener: (type, callback) => { assert.equal(type, 'pagehide'); pagehide = callback; },
        },
        imports: { '../preview/live-preview.js': { createLivePreview(config, native) {
            adapter = native;
            return { start() {}, changed() { refreshes++; } };
        } } },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
    });
    initialized(null, { ...editor, id: 'acf-another-editor' });
    assert.equal(onInput, undefined, 'Leave unrelated ACF editors alone');
    initialized(null, editor);
    assert.equal(events, 'input change undo redo SetContent');
    onInput();
    assert.equal(refreshes, 2, 'Both editor initialization and input request a refresh');
    const description = async () => (await adapter.preparePreview()).comparisonValues.description.value;
    assert.equal(await description(), '<p>Unsaved <strong>Visual</strong> edit</p>');
    assert.equal(textarea.value, 'Saved description', 'Reading Visual content does not save it to the form');
    hidden = true;
    textarea.value = 'Unsaved Text edit';
    assert.equal(await description(), 'Unsaved Text edit');
    pagehide({ persisted: false });
    assert.equal(onInput, undefined);
    assert.equal(unbound, namespace);
});

test('term editor sends structured integration values as JSON and removes the observer on permanent pagehide', async () => {
    const input = { value: 'Core value' }, payload = { acf: { field_example: { 'row-2': { field_nested: '' } } } };
    const requests = [];
    let adapter, hide, destroyed = 0;
    const form = { addEventListener() {}, querySelector: () => input };
    const context = {
        form, setup: () => ({ capture: () => payload, destroy: () => { destroyed++; } }),
        window: { addEventListener(type, callback) { assert.equal(type, 'pagehide'); hide = callback; } },
        imports: { '../preview/live-preview.js': { createLivePreview(config, editor) {
            adapter = editor;
            return { changed() {}, start() {} };
        } } },
        fetch: async (url, options) => {
            requests.push(options);
            return { ok: true, json: async () => ({ url: 'https://preview.test' }) };
        },
    };
    vm.runInNewContext(`${source}\ninitTermPreview({ strings: {}, nonce: 'rest' }, form, setup);`, context);
    assert.equal((await adapter.preparePreview()).url, 'https://preview.test');
    assert.equal(requests[0].headers['X-WP-Nonce'], 'rest');
    assert.equal(requests[0].headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(requests[0].body), { ...payload, name: input.value, description: input.value });
    hide({ persisted: true });
    assert.equal(destroyed, 0);
    hide({ persisted: false });
    assert.equal(destroyed, 1);
});

test('ACF term capture uses the active field editor, then restores the native form untouched', () => {
    const document = {}, handlers = new Map(), action = 'tinymce-editor-init.mtflppAcfTerm';
    const textarea = { name: 'acf[field_example]', value: 'Saved textarea' };
    const form = {
        ownerDocument: document, contains: (node) => node === textarea,
        querySelector: (selector) => selector === '[name="_acf_nonce"]' ? {} : null,
        addEventListener(type, callback) { handlers.set(type, callback); },
        removeEventListener(type, callback) { assert.equal(callback, handlers.get(type)); handlers.delete(type); },
    };
    let editorInit, watch, changes = 0, hidden = false, destroyed = false, throwWhenSerializing = false;
    const changed = () => { changes++; };
    const editor = {
        getElement: () => textarea, getContent: () => '<strong>Draft Visual</strong>', getBody: () => true,
        isHidden: () => hidden,
        on(type, callback) { handlers.set(type, callback); },
        off(type, callback) { assert.equal(callback, handlers.get(type)); handlers.delete(type); },
    };
    const config = { acfTermEnabled: true, strings: {} };
    const setup = vm.runInNewContext(`${acfSource}\nsetupAcfTermEditor;`, {
        window: {
            acf: {
                addAction() {}, removeAction() {},
                serialize(target) {
                    assert.equal(target, form);
                    if (throwWhenSerializing) throw new Error('serialization failed');
                    return { acf: { field_example: textarea.value }, _acf_nonce: 'taxonomy nonce' };
                },
            },
            jQuery: (target) => target === document ? {
                on(type, callback) { assert.equal(type, action); editorInit = callback; },
                off(type) { assert.equal(type, action); editorInit = undefined; },
            } : target,
        },
        imports: { './acf-fields.js': { initAcf(target, notify, watchEditor) {
            assert.equal(target, form);
            assert.equal(notify, changed);
            watch = watchEditor;
            return { isField: (element) => element === textarea, destroy() { destroyed = true; } };
        } } },
    });
    assert.equal(setup({ acfTermEnabled: false }, form, changed), undefined);
    const field = setup(config, form, changed);
    editorInit(null, editor);
    watch(editor); // Both native and ACF notifications may report the same instance.
    handlers.get('input change undo redo SetContent')();
    handlers.get('input')({ target: textarea });
    assert.equal(changes, 2);
    assert.equal(field.capture().acf.field_example, '<strong>Draft Visual</strong>');
    assert.equal(textarea.value, 'Saved textarea');
    hidden = true;
    textarea.value = '';
    assert.equal(field.capture().acf.field_example, '');
    assert.equal(field.capture()._acf_nonce, 'taxonomy nonce');
    hidden = false;
    throwWhenSerializing = true;
    assert.throws(() => field.capture(), /serialization failed/);
    assert.equal(textarea.value, '');
    field.destroy();
    assert.equal(editorInit, undefined);
    assert.equal(destroyed, true);
    assert.equal(handlers.has('input change undo redo SetContent'), false);
});
