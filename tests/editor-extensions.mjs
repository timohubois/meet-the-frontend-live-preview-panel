import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { editorExtensionsFixture } from './helpers/editor-extensions.mjs';
import { sourceForVm } from './helpers/modules.mjs';
import vm from 'node:vm';

function fixture({ acfEnabled = false, browserAcf = true, classicAcf } = {}) {
    const config = { acfEnabled, strings: { integrationFailed: 'Integration failed', acfUnavailable: 'ACF unavailable', acfRefreshing: 'ACF refreshing' } };
    const context = {
        URLSearchParams,
        window: { jQuery: () => ({ on() {}, off() {} }),
            ...(browserAcf ? { acf: classicAcf || { addAction() {}, removeAction() {} } } : {}) },
    };
    const fields = { ready: true, changes: 0, saves: 0, destroys: 0,
        observe() { this.changes++; }, saved() { this.saves++; }, destroy() { this.destroys++; },
        capture: () => new URLSearchParams([['acf[field_empty]', ''], ['_acf_fields[group][]', 'one'], ['_acf_fields[group][]', 'two']]),
    };
    const runtime = editorExtensionsFixture(context, { createBlockEditorAcf: () => fields });
    const create = (setupAction = 'mtflpp.blockEditor.previewSetup', context = {}) =>
        runtime.createEditorExtensions(setupAction, { config, changed() {}, ...context });
    return { ...runtime, config, fields, create };
}

test('no optional integrations leaves core values, capture and readiness untouched', () => {
    const h = fixture({ browserAcf: false });
    const extensions = h.create();
    assert.equal(extensions.error, undefined);
    assert.equal(extensions.capture(null), null, 'preserve core-only JSON transport');
    assert.deepEqual(extensions.filter('additionalPreviewValues', {}), {});
    assert.equal(extensions.filter('previewPauseReason', ''), '');
    extensions.action('observePreviewInputs');
    extensions.destroy();
    assert.equal(h.fields.changes, 0);
    assert.equal(h.fields.destroys, 0);
});

for (const priority of [5, 20]) {
    test(`an external integration composes with ACF before/after its capture: priority ${priority}`, () => {
        const h = fixture({ acfEnabled: true });
        let destroyed = 0;
        h.hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/custom-fields', ({ config, hooks, onDestroy }) => {
            assert.equal(config, h.config);
            hooks.addFilter('previewFormBody', 'vendor/custom-fields', (body) => {
                const next = body === null ? new URLSearchParams() : new URLSearchParams(body);
                for (const value of ['first', '', 'second']) next.append('vendor[value][]', value);
                return next;
            }, priority);
            // No contribution: returning null here would discard every preceding form entry.
            hooks.addFilter('previewFormBody', 'vendor/inactive-field', (body) => body, 30);
            hooks.addFilter('additionalPreviewValues', 'vendor/custom-fields', (values) => ({ ...values, vendor_value: 'extra' }));
            onDestroy(() => destroyed++);
        });
        const extensions = h.create();
        const body = extensions.capture(null);
        assert.equal(body.get('acf[field_empty]'), '');
        assert.deepEqual(body.getAll('_acf_fields[group][]'), ['one', 'two']);
        assert.deepEqual(body.getAll('vendor[value][]'), ['first', '', 'second']);
        assert.equal(extensions.filter('additionalPreviewValues', {}).vendor_value, 'extra');
        extensions.action('observePreviewInputs');
        extensions.action('nativeMetaboxSaveAcknowledged');
        assert.equal(h.fields.changes, 1);
        assert.equal(h.fields.saves, 1);
        extensions.destroy(); extensions.destroy();
        assert.equal(h.fields.destroys, 1);
        assert.equal(destroyed, 1);
    });
}

for (const editor of ['classicEditor', 'blockEditor']) {
    test(`only submitted ACF plain-text controls get exact-follow provenance: ${editor}`, () => {
        const h = fixture({ acfEnabled: true });
        const fields = [
            { name: 'acf[field_heading]', type: 'text' },
            { name: 'acf[field_copy]', localName: 'textarea', type: 'textarea', wysiwyg: true },
            { name: 'vendor[title]', type: 'text' },
        ].map((field) => ({ ...field, classList: { contains: (key) => key === 'wp-editor-area' && !!field.wysiwyg } }));
        const form = { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => fields };
        const extensions = h.create(`mtflpp.${editor}.previewSetup`, { form });
        const values = extensions.comparisonValues(new URLSearchParams(fields.map(({ name }) => [name, 'Sample'])), {
            post_title: { type: 'text', value: 'Post' },
        });
        assert.equal(values['acf[field_heading]'].acfPlainText, true);
        assert.equal(values['acf[field_heading]'].type, 'text');
        assert.equal(values['acf[field_copy]'].type, 'html');
        assert.equal(values['acf[field_copy]'].acfPlainText, undefined);
        assert.equal(values['vendor[title]'].acfPlainText, undefined);
        assert.equal(values.post_title.acfPlainText, undefined);
        extensions.destroy();
    });
}

test('multiple readiness contributors retain the first blocker and can release it', () => {
    const h = fixture({ acfEnabled: true });
    let blocked = true;
    h.fields.ready = false;
    h.hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/readiness', ({ hooks }) => {
        hooks.addFilter('previewPauseReason', 'vendor/readiness', (reason) => reason || (blocked ? 'Vendor refreshing' : ''));
    });
    const extensions = h.create();
    assert.equal(extensions.filter('previewPauseReason', ''), 'ACF refreshing');
    h.fields.ready = true;
    assert.equal(extensions.filter('previewPauseReason', ''), 'Vendor refreshing');
    blocked = false;
    assert.equal(extensions.filter('previewPauseReason', ''), '');
    extensions.destroy();
});

for (const ready of [false, true]) {
    test(`classic preview waits for ACF conditional field setup only if needed: ready=${ready}`, () => {
        const callbacks = new Map();
        const h = fixture({ acfEnabled: true, classicAcf: {
            didAction: (action) => action === 'ready' && ready,
            addAction(action, callback) { callbacks.set(action, callback); },
            removeAction(action, callback) { if (callbacks.get(action) === callback) callbacks.delete(action); },
        } });
        let changes = 0;
        const form = { addEventListener() {}, removeEventListener() {} };
        const extensions = h.create('mtflpp.classicEditor.previewSetup', { form, changed: () => changes++ });
        assert.equal(extensions.filter('previewPauseReason', ''), ready ? '' : 'ACF refreshing');
        callbacks.get('ready')?.();
        assert.equal(extensions.filter('previewPauseReason', ''), '');
        assert.equal(changes, ready ? 0 : 1);
        extensions.destroy();
        assert.equal(callbacks.size, 0);
    });
}

test('classic and block setup actions expose separate contexts and local contributions', () => {
    const h = fixture();
    const form = {};
    const calls = [];
    h.hooks.addAction('mtflpp.classicEditor.previewSetup', 'vendor/classic', (context) => {
        assert.equal(context.form, form);
        context.hooks.addFilter('previewFormBody', 'vendor/classic', (body) => {
            body.append('vendor_classic', 'Classic');
            return body;
        });
        calls.push('classic');
    });
    h.hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/block', (context) => {
        assert.equal(context.form, undefined);
        context.hooks.addFilter('additionalPreviewValues', 'vendor/block', (values) => ({ ...values, vendor_block: 'Block' }));
        calls.push('block');
    });
    const block = h.create();
    assert.deepEqual(calls, ['block']);
    assert.equal(block.capture(null), null);
    assert.equal(block.filter('additionalPreviewValues', {}).vendor_block, 'Block');
    const classic = h.create('mtflpp.classicEditor.previewSetup', { form });
    assert.deepEqual(calls, ['block', 'classic']);
    assert.equal(classic.capture(new URLSearchParams()).get('vendor_classic'), 'Classic');
    assert.deepEqual(classic.filter('additionalPreviewValues', {}), {});
    classic.destroy(); block.destroy();
});

test('setup and cleanup are scoped to each editor session, not global filters', () => {
    const h = fixture();
    let cleaned = 0;
    h.hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/session', ({ hooks, onDestroy }) => {
        let count = 0;
        hooks.addFilter('additionalPreviewValues', 'vendor/session', (values) => ({ ...values, count: ++count }));
        onDestroy(() => cleaned++);
    });
    const first = h.create(), second = h.create();
    assert.equal(first.filter('additionalPreviewValues', {}).count, 1);
    assert.equal(first.filter('additionalPreviewValues', {}).count, 2);
    assert.equal(second.filter('additionalPreviewValues', {}).count, 1);
    first.destroy();
    assert.deepEqual(first.filter('additionalPreviewValues', {}), {});
    assert.equal(second.filter('additionalPreviewValues', {}).count, 2);
    second.destroy();
    assert.equal(cleaned, 2);
    assert.throws(() => first.capture(null), (error) => error.code === 'mtflpp_integration_failed',
        'ended sessions cannot silently fall back to core-only writes');
});

test('missing browser ACF APIs produce a controlled error instead of aborting the editor', () => {
    const h = fixture({ acfEnabled: true, browserAcf: false });
    const extensions = h.create();
    assert.equal(extensions.error.code, 'mtflpp_integration_failed');
    assert.equal(extensions.error.message, 'ACF unavailable');
    assert.throws(() => extensions.capture(null), (error) => error === extensions.error);
    assert.equal(h.fields.destroys, 0, 'no ACF instance or subscriptions were created');
});

for (const lifecycle of ['observePreviewInputs', 'nativeMetaboxSaveAcknowledged', 'additionalPreviewValues', 'previewFormBody']) {
    test(`a failing ${lifecycle} callback blocks preview capture without escaping into native saving`, () => {
        const h = fixture();
        h.hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/failure', ({ hooks }) => {
            const fail = () => { throw new Error('Private adapter failure'); };
            if (['additionalPreviewValues', 'previewFormBody'].includes(lifecycle)) hooks.addFilter(lifecycle, 'vendor/failure', fail);
            else hooks.addAction(lifecycle, 'vendor/failure', fail);
        });
        const extensions = h.create();
        if (lifecycle === 'additionalPreviewValues') extensions.filter(lifecycle, {});
        else if (lifecycle !== 'previewFormBody') assert.doesNotThrow(() => extensions.action(lifecycle));
        assert.throws(() => extensions.capture(null), (error) => error.code === 'mtflpp_integration_failed');
        assert.equal(extensions.error.message, 'Integration failed');
        extensions.destroy();
    });
}

test('setup failures release earlier subscriptions even when another cleanup throws', () => {
    const h = fixture({ acfEnabled: true });
    const cleaned = [];
    h.hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/failure', ({ onDestroy }) => {
        onDestroy(() => cleaned.push('first'));
        onDestroy(() => { cleaned.push('second'); throw new Error('Cleanup failure'); });
        throw new Error('Setup failure');
    });
    const extensions = h.create();
    assert.equal(extensions.error.code, 'mtflpp_integration_failed');
    assert.deepEqual(cleaned, ['second', 'first']);
    assert.equal(h.fields.destroys, 1);
    extensions.destroy();
    assert.equal(h.fields.destroys, 1);
});

for (const result of [{}, undefined, new FormData()]) {
    test(`invalid capture contracts fail closed: ${Object.prototype.toString.call(result)}`, () => {
        const h = fixture();
        h.hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/invalid', ({ hooks }) => {
            hooks.addFilter('previewFormBody', 'vendor/invalid', () => result);
        });
        const extensions = h.create();
        assert.throws(() => extensions.capture(null), (error) => error.code === 'mtflpp_integration_failed');
    });
}

for (const result of [null, [], undefined, new Map(), Promise.resolve({}), { nested: [] }, { omitted: undefined }, { invalid: NaN }]) {
    test(`invalid extra-value contracts stop capture: ${Object.prototype.toString.call(result)}`, () => {
        const h = fixture();
        h.hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/invalid', ({ hooks }) => {
            hooks.addFilter('additionalPreviewValues', 'vendor/invalid', () => result);
        });
        const extensions = h.create();
        extensions.filter('additionalPreviewValues', {});
        assert.throws(() => extensions.capture(null), (error) => error.code === 'mtflpp_integration_failed');
    });
}

for (const [name, capture] of [
    ['a null body', () => null],
    ['an empty replacement', () => new URLSearchParams()],
    ['an integration-only replacement', () => new URLSearchParams({ vendor_note: 'Note' })],
    ['a deleted core field', (body) => { body.delete('content'); return body; }],
    ['an overwritten core field', (body) => { body.set('post_title', 'Saved title'); return body; }],
    ['a deleted empty value', (body) => { body.delete('excerpt'); return body; }],
    ['collapsed repeated values', (body) => { body.set('content', 'First'); return body; }],
    ['reordered repeated values', (body) => {
        body.delete('content'); body.append('content', 'Second'); body.append('content', 'First'); return body;
    }],
    ['an appended core value', (body) => { body.append('content', 'Third'); return body; }],
]) {
    test(`classic capture fails closed for ${name}`, () => {
        const h = fixture();
        h.hooks.addAction('mtflpp.classicEditor.previewSetup', 'vendor/invalid', ({ hooks }) => {
            hooks.addFilter('previewFormBody', 'vendor/invalid', capture);
        });
        const extensions = h.create('mtflpp.classicEditor.previewSetup');
        const body = new URLSearchParams([
            ['post_title', 'Unsaved title'], ['content', 'First'], ['content', 'Second'], ['excerpt', ''],
        ]);
        assert.throws(() => extensions.capture(body),
            (error) => error === extensions.error && error.code === 'mtflpp_integration_failed');
        extensions.destroy();
    });
}

test('the Classic post-note example omits disabled controls but submits an intentional clear', async () => {
    const guide = await readFile(new URL('../docs/integrations.md', import.meta.url), 'utf8');
    const example = [...guide.matchAll(/^```js\n([\s\S]*?)^```/gm)].find(([, code]) => code.includes('mtflpp.classicEditor.previewSetup'));
    assert.ok(example, 'Expected the copyable Classic setup in the guide.');
    const h = fixture();
    vm.runInNewContext(example[1], { wp: { hooks: h.hooks } });
    const input = Object.assign(new EventTarget(), { name: 'example_post_note', value: 'Saved note', disabled: true });
    const extensions = h.create('mtflpp.classicEditor.previewSetup', { form: { querySelector: () => input } });
    const native = new FormData(); // A disabled input is visible in the DOM, but not in native form data.
    const capture = () => extensions.capture(new URLSearchParams({ post_title: 'Edited title' }), native);
    assert.equal(capture().has(input.name), false);
    input.disabled = false;
    native.set(input.name, '');
    assert.deepEqual(capture().getAll(input.name), ['']);
    native.set(input.name, 'Edited note');
    assert.equal(capture().get(input.name), 'Edited note');
    extensions.destroy();
});

for (const copy of [false, true]) {
    test(`classic capture preserves empty/repeated core values and integration contributions: copy ${copy}`, () => {
        const h = fixture();
        h.hooks.addAction('mtflpp.classicEditor.previewSetup', 'vendor/fields', ({ hooks }) => {
            hooks.addFilter('previewFormBody', 'vendor/first', (body) => {
                body.append('vendor[first][]', 'one'); body.append('vendor[first][]', 'two');
                return body;
            }, 5);
            hooks.addFilter('previewFormBody', 'vendor/second', (body) => {
                const result = copy ? new URLSearchParams(body) : body;
                result.append('vendor[second]', '');
                return result;
            }, 20);
        });
        const extensions = h.create('mtflpp.classicEditor.previewSetup');
        const entries = [['post_title', 'Unsaved title'], ['content', 'First'], ['content', 'Second'], ['excerpt', '']];
        assert.deepEqual([...extensions.capture(new URLSearchParams(entries))], [
            ...entries, ['vendor[first][]', 'one'], ['vendor[first][]', 'two'], ['vendor[second]', ''],
        ]);
        assert.equal(extensions.error, undefined);
        extensions.destroy();
    });
}

test('submission hints include owned text/choices and repeated hidden values only for order', () => {
    const controls = [
        ['note', 'input', 'text'], ['rich', 'textarea', 'textarea'], ['toggle', 'input', 'checkbox'],
        ['choice', 'select', 'select-one'], ['nonce', 'input', 'hidden'], ['attachment', 'input', 'hidden'],
        ['attachments[]', 'input', 'hidden'], ['password', 'input', 'password'],
        ['unsubmitted', 'input', 'text'], ['repeated', 'input', 'text'], ['__proto__', 'input', 'text'],
    ].map(([name, localName, type]) => ({ name, localName, type, value: 'Later UI state',
        classList: { contains: () => name === 'rich' } }));
    const context = { URLSearchParams, document: { querySelectorAll: () => controls } };
    const extensions = editorExtensionsFixture(context).createEditorExtensions('vendor/setup', { config: { strings: {} } });
    const body = new URLSearchParams([
        ['note', 'Captured note'], ['rich', '<p>Captured rich text</p>'], ['toggle', '0'], ['toggle', '1'],
        ['choice', 'image-id'], ['nonce', 'nonce'], ['attachment', '123'],
        ['attachments[]', '215'], ['attachments[]', '123'], ['attachments[]', '215'], ['password', 'secret'],
        ['repeated', 'one'], ['repeated', 'two'], ['__proto__', 'Safe name'],
    ]);
    const values = extensions.comparisonValues(body, {
        post_title: { type: 'text', value: 'Title' }, content: { type: 'html', value: '<p>Content</p>' },
        featured_media: { type: 'value', value: 17 },
    });
    assert.equal(values.content.type, 'html');
    assert.equal(values.post_title.type, 'text');
    assert.equal(values.featured_media.type, 'value');
    assert.equal(values.note.value, 'Captured note');
    assert.equal(values.rich.type, 'html');
    assert.equal(values.toggle.type, 'value');
    assert.deepEqual(JSON.parse(values.toggle.value), ['0', '1']);
    assert.equal(values.choice.type, 'value');
    assert.equal(values.repeated.type, 'value');
    assert.equal(values['attachments[]'].type, 'order');
    assert.deepEqual(JSON.parse(values['attachments[]'].value), ['215', '123', '215']);
    assert.deepEqual(JSON.parse(values['attachments[]'].members), ['123', '215', '215']);
    for (const name of ['nonce', 'attachment', 'password', 'unsubmitted']) assert.equal(Object.hasOwn(values, name), false);
    assert.equal(Object.hasOwn(values, '__proto__'), true);
    assert.equal(values.__proto__.value, 'Safe name');
    extensions.destroy();
});

test('extension capture preserves core field types supplied by the screen owner', () => {
    const context = { URLSearchParams, document: { querySelectorAll: () => [] } };
    const extensions = editorExtensionsFixture(context).createEditorExtensions('vendor/setup', { config: { strings: {} } });
    const content = { type: 'text', value: '<strong>Literal markup</strong>' };
    const title = { type: 'html', value: '<em>Owner supplied</em>' };
    const values = extensions.comparisonValues(null, { content, post_title: title });
    assert.equal(values.content, content, 'Core names must not trigger shared reclassification.');
    assert.equal(values.post_title, title);
    extensions.destroy();
});

// Share the real classic adapter setup across its boundary tests.
const classicSource = await sourceForVm(new URL('../src/screens/classic-editor.js', import.meta.url));
function classicFixture(setup, entries = [['content', 'Unsaved content']], controls = [], response = {}) {
    const calls = [], requests = [], listeners = new Map();
    let destroyed = 0;
    const native = { destroy: () => destroyed++ };
    const form = {
        querySelectorAll: () => controls,
        addEventListener(name, callback) { listeners.set(name, callback); },
        removeEventListener(name) { listeners.delete(name); },
    };
    const config = { base: 'baseline', strings: { integrationFailed: 'Integration failed' } };
    const context = {
        URLSearchParams, document: { getElementById: (id) => id === 'post' ? form : null },
        window: { addEventListener() {}, removeEventListener() {} },
        FormData: class { *[Symbol.iterator]() { yield* entries; } },
        fetch: async (url, options) => {
            requests.push(options.body);
            return { ok: true, json: async () => ({ url: '/preview', ...response }) };
        },
    };
    const runtime = editorExtensionsFixture(context);
    runtime.hooks.addAction('mtflpp.classicEditor.previewSetup', 'vendor/fixture', setup);
    context.imports = {
        './editor-extensions.js': runtime,
        '../preview/live-preview.js': { createLivePreview: () => ({
            start() { calls.push(['start', native.ready]); },
            pause() {},
            changed() { calls.push(['changed', native.ready]); },
            resume(error) { calls.push(error ? ['error', error.code] : ['resume', native.ready]); },
        }) },
    };
    vm.runInNewContext(`${classicSource}\ninitLivePreview`, context)(config, native);
    return { native, calls, requests, listeners, get destroyed() { return destroyed; } };
}

test('classic comparison values stay tied to the submitted core and contributed fields', async () => {
    const entries = [['content', '<p>Captured content</p>'], ['vendor_note', 'Captured note'],
        ['_acf_nonce', 'nonce'], ['image_id', '123']];
    const controls = ['vendor_note', '_acf_nonce', 'image_id'].map((name) => ({
        name, localName: 'input', type: name === 'vendor_note' ? 'text' : 'hidden', value: 'Later UI',
        classList: { contains: () => false },
    }));
    const h = classicFixture(({ hooks }) => {
        hooks.addFilter('previewFormBody', 'vendor/note', (body, values) => {
            for (const [name, value] of values) if (['vendor_note', '_acf_nonce', 'image_id'].includes(name)) body.append(name, value);
            return body;
        });
    }, entries, controls);
    const capture = h.native.preparePreview();
    entries[0][1] = '<p>Newer content while request loads</p>';
    const result = await capture;
    assert.equal(result.comparisonValues.content.value, '<p>Captured content</p>');
    assert.equal(result.comparisonValues.vendor_note.value, 'Captured note');
    assert.equal(result.comparisonValues.vendor_note.type, 'text');
    assert.equal(Object.hasOwn(result.comparisonValues, '_acf_nonce'), false);
    assert.equal(Object.hasOwn(result.comparisonValues, 'image_id'), false);
    assert.equal(h.requests[0].has('comparisonValues'), false, 'Hints stay in browser memory, outside REST transport.');
    h.native.destroy();
});

test('classic following requests native formatting only for submitted rich-text row fields', async () => {
    const name = 'vendor[row-1][body]', label = 'vendor[row-1][label]', other = 'vendor[other]';
    const raw = "The editor's options...", formatted = '<p>The editor&#8217;s options&#8230;</p>';
    const controls = [name, label, other].map((field) => ({
        name: field, localName: 'textarea', classList: { contains: () => field !== label },
    }));
    const h = classicFixture(({ hooks }) => {
        hooks.addFilter('previewFormBody', 'vendor/rows', (body, values, followingParams) => {
            for (const [field, value] of values) body.append(field, value);
            followingParams?.set('vendor_following', '1');
            return body;
        });
        hooks.addFilter('previewComparisonValues', 'vendor/rows', (values) => values.set('rows', {
            type: 'row-order', fieldsByRow: { a: [name, label, 'vendor[missing]'], b: [name] },
        }));
        hooks.addFilter('previewResponseComparisonValues', 'vendor/rows', (values, response) => ({
            ...values, rows: { ...values.rows, vendorEvidence: response.vendorEvidence },
        }));
    }, [[name, raw], [label, 'Label'], [other, 'Unrelated']], controls,
    { rowDisplayText: { [name]: formatted, [other]: '<p>Unrelated</p>' }, vendorEvidence: 'example' });
    const { comparisonValues, ...preview } = await h.native.preparePreview(true);
    assert.deepEqual(JSON.parse(h.requests[0].get('mtflpp_row_text_fields')), [name]);
    assert.deepEqual([...h.requests[0].keys()].slice(-3), ['base', 'mtflpp_row_text_fields', 'vendor_following'],
        'If PHP truncates the extras, the required baseline still arrives.');
    assert.equal(h.requests[0].get(name), raw);
    assert.equal(comparisonValues[name].value, raw);
    assert.equal(comparisonValues[name].formatted, formatted);
    assert.equal(comparisonValues[other].formatted, undefined);
    assert.equal(preview.rowDisplayText, undefined);
    assert.equal(comparisonValues.rows.vendorEvidence, 'example');
    assert.equal(preview.vendorEvidence, undefined);
    assert.equal(preview.rowSubmission.some(([field]) => field === 'vendor_following'), false);
    const disabled = await h.native.preparePreview(false);
    assert.equal(h.requests[1].has('mtflpp_row_text_fields'), false);
    assert.equal(h.requests[1].has('vendor_following'), false);
    assert.equal(disabled.comparisonValues.rows.vendorEvidence, undefined);
    assert.equal(disabled.comparisonValues[name].formatted, undefined);
    h.native.destroy();
});

for (const [name, capture] of [
    ['replaced core values', () => new URLSearchParams({ vendor_note: 'Note' })],
    ['deleted core values', (body) => { body.delete('content'); return body; }],
]) {
    test(`classic ${name} cannot reach the preview endpoint`, async () => {
        const h = classicFixture(({ hooks }) => {
            hooks.addFilter('previewFormBody', 'vendor/invalid', capture);
        });
        await assert.rejects(h.native.preparePreview(), (error) => error.code === 'mtflpp_integration_failed');
        assert.equal(h.requests.length, 0);
        h.native.destroy();
    });
}

test('classic external fields can pause initial preview, resume and clean up without editor-specific imports', async () => {
    let blocked = true, signal, cleaned = 0;
    const h = classicFixture(({ hooks, changed, onDestroy }) => {
        signal = changed;
        hooks.addFilter('previewPauseReason', 'vendor/note', (reason) => reason || (blocked ? 'Wait for fields' : ''));
        hooks.addFilter('previewFormBody', 'vendor/note', (body, values) => {
            for (const [name, value] of values) if (name === 'vendor_note') body.append(name, value);
            return body;
        });
        onDestroy(() => cleaned++);
    }, [['content', 'Native content'], ['vendor_note', 'Unsaved note']]);
    assert.equal(h.native.ready, false);
    assert.equal(h.native.notReady, 'Wait for fields');
    assert.deepEqual(h.calls, [['start', false]]);
    blocked = false;
    signal();
    assert.deepEqual(h.calls.at(-1), ['resume', true]);
    await h.native.preparePreview();
    const body = h.requests.at(-1);
    assert.equal(body.get('vendor_note'), 'Unsaved note');
    assert.equal(body.get('content'), 'Native content');
    assert.equal(body.get('base'), 'baseline');
    h.native.destroy(); h.native.destroy();
    assert.equal(cleaned, 1);
    assert.equal(h.destroyed, 1);
    assert.equal(h.listeners.size, 0);
    await assert.rejects(h.native.preparePreview(), (error) => error.code === 'mtflpp_integration_failed');
});

test('classic startup uses the same failure path once and never starts preview writes after setup errors', () => {
    let cleaned = 0;
    const h = classicFixture(({ onDestroy }) => {
        onDestroy(() => cleaned++);
        throw new Error('Setup failed');
    });
    assert.equal(h.native.ready, false);
    assert.equal(h.native.notReady, 'Integration failed');
    assert.deepEqual(h.calls, [['error', 'mtflpp_integration_failed']]);
    h.native.destroy(); h.native.destroy();
    assert.equal(cleaned, 1);
});
