import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { sourceForVm } from './helpers/modules.mjs';
import { previewInputImports } from './helpers/preview-inputs.mjs';

test('submission hints include owned text/choices and repeated hidden values only for order', () => {
    const controls = [
        ['note', 'input', 'text'], ['rich', 'textarea', 'textarea'], ['toggle', 'input', 'checkbox'],
        ['choice', 'select', 'select-one'], ['nonce', 'input', 'hidden'], ['attachment', 'input', 'hidden'],
        ['attachments[]', 'input', 'hidden'], ['password', 'input', 'password'],
        ['unsubmitted', 'input', 'text'], ['repeated', 'input', 'text'], ['__proto__', 'input', 'text'],
    ].map(([name, localName, type]) => ({ name, localName, type, value: 'Later UI state',
        classList: { contains: () => name === 'rich' } }));
    const context = { URLSearchParams, document: { querySelectorAll: () => controls } };
    const { submittedValues } = previewInputImports(context)['./preview-inputs.js'];
    const body = new URLSearchParams([
        ['note', 'Captured note'], ['rich', '<p>Captured rich text</p>'], ['toggle', '0'], ['toggle', '1'],
        ['choice', 'image-id'], ['nonce', 'nonce'], ['attachment', '123'],
        ['attachments[]', '215'], ['attachments[]', '123'], ['attachments[]', '215'], ['password', 'secret'],
        ['repeated', 'one'], ['repeated', 'two'], ['__proto__', 'Safe name'],
    ]);
    const values = Object.fromEntries(submittedValues(body, {
        post_title: { type: 'text', value: 'Title' }, content: { type: 'html', value: '<p>Content</p>' },
        featured_media: { type: 'value', value: 17 },
    }, context.document));
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
});

test('submission hints preserve core field types supplied by the screen owner', () => {
    const context = { URLSearchParams, document: { querySelectorAll: () => [] } };
    const { submittedValues } = previewInputImports(context)['./preview-inputs.js'];
    const content = { type: 'text', value: '<strong>Literal markup</strong>' };
    const title = { type: 'html', value: '<em>Owner supplied</em>' };
    const values = Object.fromEntries(submittedValues(null, { content, post_title: title }, context.document));
    assert.equal(values.content, content, 'Core names must not trigger shared reclassification.');
    assert.equal(values.post_title, title);
});


const classicSource = await sourceForVm(new URL('../src/screens/classic-editor.js', import.meta.url));

function classicFixture({ entries = [], controls = [], previewRowEvidence = false, response = {}, ready = true, acfEnabled = true,
    browserAcf = true, fields: overrides = {} } = {}) {
    const calls = [], requests = [], actions = new Map();
    let destroyed = 0, acfDestroyed = 0, resolveRegions;
    const native = { destroy: () => destroyed++ };
    const form = {
        querySelectorAll: () => controls,
        addEventListener() {},
        removeEventListener() {},
    };
    const config = { base: 'baseline', acfEnabled, previewRowEvidence,
        strings: { integrationFailed: 'Integration failed', acfUnavailable: 'ACF unavailable', acfRefreshing: 'ACF refreshing' } };
    const context = {
        URLSearchParams, document: { getElementById: (id) => id === 'post' ? form : null },
        window: { addEventListener() {}, removeEventListener() {}, jQuery: () => ({ on() {}, off() {} }),
            ...(browserAcf ? { acf: {
                didAction: () => ready,
                addAction(name, callback) { actions.set(name, callback); },
                removeAction(name, callback) { if (actions.get(name) === callback) actions.delete(name); },
            } } : {}),
        },
        FormData: class { *[Symbol.iterator]() { yield* entries; } },
        fetch: async (url, options) => {
            requests.push(options.body);
            return { ok: true, json: async () => ({ url: '/preview', ...response }) };
        },
    };
    context.imports = {
        ...previewInputImports(context, { initAcf: () => ({
            accepts: (name) => name.startsWith('acf[') || name.startsWith('_acf_'),
            layoutOrders: (values) => values,
            destroy() { acfDestroyed++; },
            ...overrides,
        }) }),
        '../preview/live-preview.js': { createLivePreview: (config, native, { resolveRenderedRegions }) => {
            resolveRegions = resolveRenderedRegions;
            return {
                start() { calls.push(['start', native.ready]); },
                pause(reason) { calls.push(['pause', reason]); },
                changed() { calls.push(['changed', native.ready]); },
                resume(error) { calls.push(error ? ['error', error.message] : ['resume', native.ready]); },
            };
        } },
    };
    vm.runInNewContext(`${classicSource}\ninitLivePreview`, context)(config, native);
    return { native, calls, requests, actions, resolveRegions, get destroyed() { return destroyed; },
        get acfDestroyed() { return acfDestroyed; } };
}

test('Classic captures the native form once, preserving ACF entries and excluding template rows', async () => {
    const note = 'acf[field_note]', repeat = '_acf_fields[group][]';
    const entries = [['content', '<p>Captured content</p>'], [note, ''], [repeat, 'first'], [repeat, 'second'],
        ['acf[field_rows][acfcloneindex][field_note]', 'Template'], ['unrelated', 'ignored']];
    const controls = [{ name: note, type: 'text', classList: { contains: () => false } }];
    const h = classicFixture({ entries, controls });
    const capture = h.native.preparePreview();
    entries[0][1] = '<p>Newer editor state</p>';
    const result = await capture;
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].get('content'), '<p>Captured content</p>');
    assert.equal(h.requests[0].get(note), '');
    assert.deepEqual(h.requests[0].getAll(repeat), ['first', 'second']);
    assert.deepEqual([...h.requests[0].keys()], ['content', note, repeat, repeat, 'base']);
    assert.equal(result.comparisonValues.content.type, 'html');
    assert.equal(result.comparisonValues[note].value, '');
    assert.equal(result.comparisonValues[note].acfPlainText, true);
    h.native.destroy(); h.native.destroy();
    assert.equal(h.acfDestroyed, 1);
    assert.equal(h.destroyed, 1);
});

test('Classic ACF waits for conditional controls, then resumes and releases readiness listeners', () => {
    const h = classicFixture({ ready: false });
    assert.equal(h.native.ready, false);
    assert.deepEqual(h.calls[0], ['pause', 'ACF refreshing']);
    h.actions.get('ready')();
    assert.equal(h.native.ready, true);
    assert.deepEqual(h.calls.at(-1), ['resume', true]);
    h.native.destroy();
    assert.equal(h.actions.size, 0);
});

test('missing Classic ACF APIs pause the panel without starting preview writes', async () => {
    const h = classicFixture({ browserAcf: false });
    assert.equal(h.native.ready, false);
    assert.deepEqual(h.calls, [['error', 'ACF unavailable']]);
    await assert.rejects(h.native.preparePreview(), { code: 'mtflpp_integration_failed' });
    assert.equal(h.requests.length, 0);
    h.native.destroy();
    assert.equal(h.destroyed, 1);
});

test('Classic rendered row evidence adds optional evidence after native form data and the baseline', async () => {
    const path = 'acf[field_rows]', row = `${path}[row-0][acf_fc_layout]`, name = `${path}[row-0][field_body]`;
    const label = `${path}[row-0][field_label]`, other = 'acf[field_unrelated]', key = 'acf-layout-order:' + path;
    const raw = "The editor's options...", formatted = '<p>The editor&#8217;s options&#8230;</p>';
    const controls = [name, label, other].map((field) => ({
        name: field, localName: 'textarea', classList: { contains: () => field !== label },
    }));
    const markers = { [row]: 'a'.repeat(64) };
    const h = classicFixture({
        previewRowEvidence: true, controls,
        entries: [[row, 'text'], [name, raw], [label, 'Label'], [other, 'Unrelated']],
        fields: { layoutOrders: (values) => values.set(key, { type: 'row-order', fieldsByRow: { [row]: [name, label, 'missing'] } }) },
        response: { rowDisplayText: { [name]: formatted, [other]: '<p>Unrelated</p>' }, rowMarkers: { [key]: markers } },
    });
    assert.equal(typeof h.resolveRegions, 'function');
    const { comparisonValues, rowSubmission } = await h.native.preparePreview(true);
    assert.deepEqual([...h.requests[0].keys()].slice(-3), ['base', 'mtflpp_row_text_fields', 'mtflpp_row_markers']);
    assert.deepEqual(JSON.parse(h.requests[0].get('mtflpp_row_text_fields')), [name]);
    assert.equal(h.requests[0].get(name), raw);
    assert.equal(comparisonValues[name].value, raw);
    assert.equal(comparisonValues[name].formatted, formatted);
    assert.equal(comparisonValues[other].formatted, undefined);
    assert.equal(comparisonValues[key].rowMarkers, markers);
    assert.equal(rowSubmission.some(([field]) => field === 'mtflpp_row_markers'), false);
    const disabled = await h.native.preparePreview(false);
    assert.equal(h.requests[1].has('mtflpp_row_text_fields'), false);
    assert.equal(h.requests[1].has('mtflpp_row_markers'), false);
    assert.equal(disabled.comparisonValues[key].rowMarkers, undefined);
    assert.equal(disabled.comparisonValues[name].formatted, undefined);
    assert.equal(h.requests.length, 2);
    h.native.destroy();
});
