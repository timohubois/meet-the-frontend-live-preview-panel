import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { sourceForVm, previewSourceForVm } from './helpers/modules.mjs';
import { editorExtensionsFixture } from './helpers/editor-extensions.mjs';

// ES modules are strict in production, including receipt cleanup on rejected native saves.
const source = `"use strict";\n${await sourceForVm(new URL('../src/screens/block-editor.js', import.meta.url))}`;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function fixture({ ready = true, loaded = true, available = true, route = '/wp/v2/posts/123', acfEnabled = false, taxonomies = {}, yoastPrimaryTaxonomies = [], extend, browserAcf = true, revisions = false } = {}) {
    const calls = { pauses: [], pauseStates: [], suspensions: [], resumes: [], titles: [], changes: 0, requests: [], contentReads: 0 };
    const acfFields = { ready: true, saved: 0, destroyed: false, waitAfterSave: false };
    let acfChanged;
    const state = { id: ready ? 123 : 0, loaded, type: 'post', saving: false, previewing: false, author: 7, title: 'Title', content: '<!-- wp:paragraph --><p>Unsaved</p><!-- /wp:paragraph -->', excerpt: 'Excerpt', blocks: [], savedContent: 'Saved content' };
    state.yoastPostId = 123;
    state.primary = {};
    state.yoastAvailable = true;
    const cookies = new Map();
    let subscription, filter, middleware, pending;
    const apiFetch = async (options) => { calls.requests.push(options); return { url: '/preview' }; };
    apiFetch.use = (value) => { middleware = value; };
    const selectors = {
        getCurrentPostId: () => state.id,
        getCurrentPostType: () => state.type,
        getCurrentPost: () => state.loaded ? { id: state.id, content: state.savedContent, meta: state.savedMeta } : undefined,
        getPostEdits: () => ({ content: state.content, meta: state.meta }),
        getEditedPostAttribute: (name) => state[name],
        getEditedPostContent: () => { calls.contentReads++; return state.content ?? state.savedContent; },
        isSavingPost: () => state.saving,
        isPreviewingPost: () => state.previewing,
    };
    const config = {
        postId: 123, postType: 'post', postRoute: route, restRoot: 'http://site.test/wp-json/',
        postFormUrl: 'http://site.test/wp-admin/post.php',
        endpoint: 'http://site.test/wp-json/meet-the-frontend-live-preview-panel/v1/posts/123/preview',
        base: 'a'.repeat(64), available, acfEnabled, taxonomies, yoastPrimaryTaxonomies, adminCookiePath: '/wp-admin/', strings: { loading: 'Loading preview…', nativeSaveFailed: 'Save not confirmed', savedPostConflict: 'The saved post changed', postOnly: 'Return to post', acfRefreshing: 'Waiting for ACF fields', integrationFailed: 'Integration failed', acfUnavailable: 'ACF unavailable' },
    };
    let notifyRevisionDom;
    const editorRoot = { getElementsByClassName(name) {
        assert.equal(name, 'editor-revisions-header');
        return { get length() { return revisions ? 1 : 0; } };
    } };
    const document = {
        getElementById: (id) => id === 'editor' ? editorRoot : null,
        querySelectorAll: () => [],
        get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
        set cookie(value) { if (value.includes('Max-Age=0')) cookies.delete(value.split('=')[0]); },
    };
    const context = {
        URL, URLSearchParams, FormData, queueMicrotask, document,
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe(root, options) {
                assert.equal(root, editorRoot);
                assert.ok(options.childList && options.subtree);
                notifyRevisionDom = this.callback;
            }
            disconnect() { notifyRevisionDom = undefined; }
        },
        window: { crypto: webcrypto, location: new URL('http://site.test/wp-admin/post.php'), addEventListener() {},
            ...(browserAcf ? { acf: { addAction() {}, removeAction() {} } } : {}), jQuery() {} },
        imports: {
            '@wordpress/api-fetch': { default: apiFetch },
            '@wordpress/data': { select: (store) => store === 'yoast-seo/editor' ? (state.yoastAvailable ? {
                getPostId: () => state.yoastPostId, getPrimaryTaxonomyId: (name) => state.primary[name],
            } : undefined) : selectors, subscribe: (callback) => { subscription = callback; return () => { subscription = null; }; } },
            '@wordpress/hooks': { addFilter: (name, scope, callback) => { assert.equal(name, 'editor.preSavePost'); filter = callback; }, removeFilter: () => { filter = null; } },
        },
    };
    context.imports['./editor-extensions.js'] = editorExtensionsFixture(context, {
        createBlockEditorAcf(changed) {
            acfChanged = changed;
            return {
                get ready() { return acfFields.ready; }, observe() {},
                saved() { acfFields.saved++; acfFields.ready = !acfFields.waitAfterSave; },
                capture: () => new URLSearchParams({ 'acf[field_test]': 'Unsaved ACF', _acf_nonce: 'acf-nonce' }),
                destroy: () => { acfFields.destroyed = true; },
            };
        },
    });
    extend?.(context.imports['./editor-extensions.js'].hooks);
    const native = vm.runInNewContext(`${source}\ncreateBlockEditor`, context)(config);
    native.connect({
        pause: (text, state) => { calls.pauses.push(text); calls.pauseStates.push(state); return pending; },
        resume: (error) => calls.resumes.push(error),
        setSuspended: (value) => calls.suspensions.push(value),
        changed: () => calls.changes++, setTitle: (title) => calls.titles.push(title),
    });
    return {
        native, config, state, calls, cookies, acfFields, document,
        showRevisions: (value) => { revisions = value; notifyRevisionDom?.(); return flush(); },
        acfChanged: async () => { acfChanged?.(); await flush(); },
        emit: async () => { subscription?.(); await flush(); },
        beforeSave: (...args) => filter(...args),
        request: (options, next) => middleware(options, next),
        setPending: (value) => { pending = value; },
        receipt: (options, after = 'b'.repeat(64), available = true) => ({
            request: options.headers['X-MTFLPP-Request'], before: options.headers['X-MTFLPP-Base'], after, available,
        }),
        metaBody() { const body = new FormData(); body.set('post_ID', '123'); body.set('action', 'editpost'); body.set('acf[field_test]', 'Value'); return body; },
    };
}

test('Visual Revisions suspends the editor preview without relying on a URL or post change', async () => {
    const h = fixture();
    assert.equal(h.native.ready, true);
    const entering = h.showRevisions(true);
    assert.equal(h.native.ready, false, 'A pending refresh cannot write before DOM observation settles.');
    await entering;
    assert.deepEqual(h.calls.suspensions, [true]);
    assert.deepEqual(h.calls.pauseStates, ['paused']);
    const changes = h.calls.changes;
    h.state.title = 'Changed while browsing';
    await h.emit();
    assert.equal(h.calls.changes, changes);
    // A native Restore save still participates in the normal saved-baseline handshake.
    await h.request({ path: h.config.postRoute, method: 'POST' }, async (options) => ({ id: 123, _mtflpp_receipt: h.receipt(options) }));
    assert.equal(h.config.base, 'b'.repeat(64));
    assert.equal(h.native.ready, false);
    await h.showRevisions(false);
    assert.deepEqual(h.calls.suspensions, [true, false]);
    assert.equal(h.native.ready, true);
    assert.equal(h.calls.resumes.length, 2);
    assert.equal(h.calls.titles.at(-1), h.state.title);
    h.native.destroy();
    await h.showRevisions(true);
    assert.deepEqual(h.calls.suspensions, [true, false]);
});

test('an editor initialized in Visual Revisions starts with its live preview suspended', async () => {
    const h = fixture({ revisions: true });
    assert.equal(h.native.ready, false);
    assert.deepEqual(h.calls.suspensions, [true]);
    assert.deepEqual(h.calls.resumes, []);
    await h.showRevisions(false);
    assert.equal(h.native.ready, true);
    assert.deepEqual(h.calls.suspensions, [true, false]);
    assert.equal(h.calls.resumes.length, 1);
});

test('block comparison values are frozen at capture and never sent to the endpoint', async () => {
    const h = fixture({ acfEnabled: true });
    h.document.querySelectorAll = () => [{ name: 'acf[field_test]', localName: 'input', type: 'text',
        value: 'Newer UI field', classList: { contains: () => false } }];
    const expected = h.state.content;
    const pending = h.native.preparePreview();
    h.state.content = '<p>A newer editor state</p>';
    const result = await pending;
    assert.equal(result.comparisonValues.content.value, expected);
    assert.equal(result.comparisonValues.content.type, 'html');
    assert.equal(result.comparisonValues['acf[field_test]'].value, 'Unsaved ACF');
    assert.equal(Object.hasOwn(result.comparisonValues, '_acf_nonce'), false);
    assert.equal(h.calls.requests[0].body.has('comparisonValues'), false);
    assert.equal(h.calls.requests[0].body.get('content'), expected);
    h.native.destroy();
});

const noteExample = await sourceForVm(new URL('../docs/examples/post-note/preview.js', import.meta.url));
for (const transport of ['JSON', 'peer form', 'ACF form']) {
    test(`post-note example composes with a typed contributor over ${transport}`, async () => {
        const h = fixture({ acfEnabled: transport === 'ACF form', extend(wpHooks) {
            wpHooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/choice', ({ hooks }) => {
                hooks.addFilter('additionalPreviewValues', 'vendor/choice', (values, editor) => {
                    const choice = editor.getEditedPostAttribute('choice');
                    return choice === undefined ? values : { ...values, vendor_choice: JSON.stringify(choice) };
                }, 5);
                if (transport === 'peer form') hooks.addFilter('previewFormBody', 'vendor/choice', (body) => {
                    body ??= new URLSearchParams();
                    body.append('vendor_list[]', 'first');
                    body.append('vendor_list[]', '');
                    return body;
                });
            });
            vm.runInNewContext(noteExample, { wp: { hooks: wpHooks } });
        } });
        const before = h.calls.changes;
        h.state.savedMeta = { example_post_note: 'Saved note', unrelated: 'Original' };
        h.state.meta = { ...h.state.savedMeta, unrelated: 'Do not send' };
        await h.emit();
        assert.equal(h.calls.changes, before, 'editing unrelated meta must not contribute the saved note');
        h.state.meta.example_post_note = `Editor's C:\\draft 🧪`;
        await h.emit();
        assert.equal(h.calls.changes, before + 1);
        assert.equal(h.calls.contentReads, 0, 'observing edited meta must not serialize core content');
        async function capture() {
            await h.native.preparePreview();
            const { body, data } = h.calls.requests.at(-1);
            assert.equal(!!body, transport !== 'JSON');
            return body ?? new Map(Object.entries(data));
        }
        for (const choice of [false, 'false', 0, '0', null, '', ['first', '']]) {
            h.state.choice = choice;
            const fields = await capture();
            assert.equal(fields.get('example_post_note'), h.state.meta.example_post_note);
            assert.equal(fields.get('vendor_choice'), JSON.stringify(choice));
            assert.equal(fields.has('unrelated'), false);
            if (transport === 'peer form') assert.deepEqual(fields.getAll('vendor_list[]'), ['first', '']);
            if (transport === 'ACF form') assert.equal(fields.get('acf[field_test]'), 'Unsaved ACF');
        }
        h.state.meta.example_post_note = '';
        await h.emit();
        assert.equal((await capture()).get('example_post_note'), '');
        h.state.meta.example_post_note = h.state.savedMeta.example_post_note;
        await h.emit();
        assert.equal(h.calls.changes, before + 3, 'reverting the note must remove the contribution and refresh');
        assert.equal((await capture()).has('example_post_note'), false);
        delete h.state.meta.example_post_note;
        assert.equal((await capture()).has('example_post_note'), false);
        h.state.meta.example_post_note = null;
        const requests = h.calls.requests.length;
        await assert.rejects(capture(), { code: 'mtflpp_integration_failed' });
        assert.equal(h.calls.requests.length, requests, 'an invalid note must not become an empty form value');
        h.native.destroy();
    });
}

test('an integration failure after an acknowledged meta-box save never rejects WordPress saving', async () => {
    let cleaned = 0;
    const h = fixture({ extend(hooks) {
        hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/failure', ({ hooks, onDestroy }) => {
            hooks.addAction('nativeMetaboxSaveAcknowledged', 'vendor/failure', () => { throw new Error('Adapter save observer failed'); });
            onDestroy(() => cleaned++);
        });
    } });
    const response = {};
    const result = await h.request({ url: 'http://site.test/wp-admin/post.php?meta-box-loader=1', method: 'POST', body: h.metaBody() }, async (options) => {
        h.cookies.set(`mtflpp_preview_${options.body.get('mtflpp_preview')}`, `${h.config.base}.${'c'.repeat(64)}`);
        return response;
    });
    await flush();
    assert.equal(result, response, 'preserve the original native response');
    assert.equal(h.config.base, 'c'.repeat(64));
    assert.equal(h.native.ready, false);
    assert.equal(h.calls.resumes.at(-1).code, 'mtflpp_integration_failed');
    h.native.destroy(); h.native.destroy();
    assert.equal(cleaned, 1);
});

test('missing browser ACF APIs leave a controlled preview error and native saves intact', async () => {
    const h = fixture({ acfEnabled: true, browserAcf: false });
    assert.equal(h.native.ready, false);
    assert.equal(h.calls.resumes.at(-1).message, 'ACF unavailable');
    assert.throws(() => h.native.preparePreview(), (error) => error.code === 'mtflpp_integration_failed');
    assert.equal(h.calls.requests.length, 0);
    const edits = { id: 123, content: 'Native save' };
    assert.equal(await h.beforeSave(edits), edits);
    h.native.destroy();
});

test('Yoast primary changes are observed and captured through native store selectors', async () => {
    const h = fixture({ taxonomies: { category: 'categories' }, yoastPrimaryTaxonomies: ['category'] });
    h.state.categories = [41, 42];
    h.state.primary.category = '41';
    await h.emit();
    await h.native.preparePreview();
    assert.deepEqual(JSON.parse(h.calls.requests.at(-1).data.yoast_primary_terms), { category: 41 });
    const before = h.calls.changes;
    const serialized = h.calls.contentReads;
    h.state.primary.category = 42;
    await h.emit();
    assert.equal(h.calls.changes, before + 1, 'primary-only changes refresh the frame');
    assert.equal(h.calls.contentReads, serialized, 'observation never serializes content');
    await h.native.preparePreview();
    assert.deepEqual(JSON.parse(h.calls.requests.at(-1).data.yoast_primary_terms), { category: 42 });
    h.state.categories = [41];
    await h.emit();
    await h.native.preparePreview();
    assert.deepEqual(JSON.parse(h.calls.requests.at(-1).data.yoast_primary_terms), { category: 0 });
    assert.equal(h.state.primary.category, 42, 'capture never mutates Yoast state');
});

test('Yoast absence, uninitialized controls and other post contexts retain the saved fallback', async () => {
    const h = fixture({ yoastPrimaryTaxonomies: ['category'], taxonomies: { category: 'categories' } });
    h.state.categories = [41];
    await h.native.preparePreview();
    assert.equal(h.calls.requests.at(-1).data.yoast_primary_terms, undefined);
    h.state.primary.category = 41;
    h.state.yoastPostId = 999;
    await h.native.preparePreview();
    assert.equal(h.calls.requests.at(-1).data.yoast_primary_terms, undefined);
    h.state.yoastPostId = 123;
    h.state.yoastAvailable = false;
    await h.native.preparePreview();
    assert.equal(h.calls.requests.at(-1).data.yoast_primary_terms, undefined);
});

test('Yoast primary clearing and custom rest-base transport work with ACF forms', async () => {
    const h = fixture({ acfEnabled: true, taxonomies: { topic: 'topics_v2' }, yoastPrimaryTaxonomies: ['topic'] });
    h.state.topics_v2 = [41];
    h.state.primary.topic = 41;
    await h.native.preparePreview();
    assert.deepEqual(JSON.parse(h.calls.requests.at(-1).body.get('yoast_primary_terms')), { topic: 41 });
    for (const cleared of [-1, '', 0]) {
        h.state.primary.topic = cleared;
        await h.emit();
        await h.native.preparePreview();
        assert.deepEqual(JSON.parse(h.calls.requests.at(-1).body.get('yoast_primary_terms')), { topic: 0 });
    }
});

test('wait for the intended post and capture only supported unsaved editor values', async () => {
    const h = fixture({ ready: false });
    assert.equal(h.native.ready, false);
    h.state.id = 123;
    await h.emit();
    assert.equal(h.native.ready, true);
    await h.native.preparePreview();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.requests[0].data)), {
        author: 7, post_title: h.state.title, content: h.state.content, excerpt: h.state.excerpt, featured_media: 0, base: h.config.base,
    });
    const changes = h.calls.changes;
    await h.emit();
    assert.equal(h.calls.changes, changes, 'unrelated store updates do not refresh');
    h.state.content = '<p>New content</p>';
    await h.emit();
    assert.equal(h.calls.changes, changes + 1);
});

for (const options of [{ ready: false }, { loaded: false }]) {
    test(`initial Gutenberg setup stays loading until the post is available: ${JSON.stringify(options)}`, async () => {
        const h = fixture(options);
        assert.equal(h.native.ready, false);
        assert.equal(h.native.notReady, 'Loading preview…');
        assert.equal(h.native.notReadyState, 'loading');
        assert.equal(h.calls.pauseStates.at(-1), 'loading');
        assert.equal(h.calls.resumes.length, 0);
        assert.equal(h.calls.requests.length, 0);
        await h.emit();
        assert.equal(h.calls.pauseStates.includes('paused'), false);
        h.state.id = 123;
        h.state.loaded = true;
        await h.emit();
        assert.equal(h.native.ready, true);
        assert.equal(h.calls.resumes.length, 1);
    });
}

test('unrelated notifications and metadata edits never serialize content or rewrite the caption', async () => {
    const h = fixture();
    const titles = h.calls.titles.length, changes = h.calls.changes;
    for (let i = 0; i < 100; i++) {
        h.state.meta = { unrelated: i };
        await h.emit();
    }
    assert.equal(h.calls.contentReads, 0, 'capture is deferred until the debounced preview request');
    assert.equal(h.calls.titles.length, titles);
    assert.equal(h.calls.changes, changes);
    h.state.title = 'New title';
    await h.emit();
    assert.equal(h.calls.titles.at(-1), 'New title');
    assert.equal(h.calls.titles.length, titles + 1);
    assert.equal(h.calls.changes, changes + 1);
    h.state.excerpt = '';
    await h.emit();
    assert.equal(h.calls.changes, changes + 2);
    assert.equal(h.calls.titles.length, titles + 1);
    assert.equal(h.calls.contentReads, 0);
    await h.native.preparePreview();
    assert.equal(h.calls.contentReads, 1);
});

test('featured-image additions, replacements and removal are live inputs without serializing blocks', async () => {
    const h = fixture();
    const changes = h.calls.changes;
    for (const [i, id] of [41, 42, 0].entries()) {
        h.state.featured_media = id;
        await h.emit();
        assert.equal(h.calls.changes, changes + i + 1);
        assert.equal(h.calls.contentReads, i);
        await h.native.preparePreview();
        assert.equal(h.calls.requests.at(-1).data.featured_media, id);
    }
});

test('author changes and reverting to the saved author refresh without serializing blocks', async () => {
    const h = fixture();
    const changes = h.calls.changes;
    for (const [i, author] of [8, 9, 7].entries()) {
        h.state.author = author;
        await h.emit();
        assert.equal(h.calls.changes, changes + i + 1);
        assert.equal(h.calls.contentReads, i);
        await h.native.preparePreview();
        assert.equal(h.calls.requests.at(-1).data.author, author);
    }
});

test('post types without an author attribute omit the author input', async () => {
    const h = fixture();
    h.state.author = undefined;
    await h.native.preparePreview();
    assert.equal(Object.hasOwn(h.calls.requests.at(-1).data, 'author'), false);
});

test('publication dates, resets and omitted dates use the native editor attribute', async () => {
    const h = fixture();
    const changes = h.calls.changes;
    for (const [i, date] of ['2024-07-15T13:45:00', '2035-01-10T09:00:00+01:00', null].entries()) {
        h.state.date = date;
        await h.emit();
        assert.equal(h.calls.changes, changes + i + 1);
        assert.equal(h.calls.contentReads, i);
        await h.native.preparePreview();
        assert.equal(h.calls.requests.at(-1).data.date, date);
    }
    h.state.date = undefined;
    await h.native.preparePreview();
    assert.equal(Object.hasOwn(h.calls.requests.at(-1).data, 'date'), false);
});

test('taxonomy assignments use configured native REST attributes, including custom bases and clearing', async () => {
    const h = fixture({ taxonomies: { category: 'categories', post_tag: 'tags', mtflpp_topic: 'topics' } });
    h.state.categories = [11];
    h.state.tags = [12];
    h.state.topics = [13];
    await h.emit();
    const changes = h.calls.changes;
    await h.emit();
    assert.equal(h.calls.changes, changes);
    assert.equal(h.calls.contentReads, 0);
    await h.native.preparePreview();
    assert.deepEqual(JSON.parse(h.calls.requests.at(-1).data.terms), {
        category: [11], post_tag: [12], mtflpp_topic: [13],
    });
    h.state.categories = [];
    h.state.topics = [14];
    await h.emit();
    assert.equal(h.calls.changes, changes + 1);
    await h.native.preparePreview();
    assert.deepEqual(JSON.parse(h.calls.requests.at(-1).data.terms), {
        category: [], post_tag: [12], mtflpp_topic: [14],
    });
    delete h.state.tags;
    await h.native.preparePreview();
    assert.equal(Object.hasOwn(JSON.parse(h.calls.requests.at(-1).data.terms), 'post_tag'), false);
});

test('date resets and empty term assignments survive the ACF form transport', async () => {
    const h = fixture({ acfEnabled: true, taxonomies: { category: 'categories' } });
    h.state.date = null;
    h.state.categories = [];
    await h.native.preparePreview();
    assert.equal(h.calls.requests.at(-1).body.get('date'), '');
    assert.deepEqual(JSON.parse(h.calls.requests.at(-1).body.get('terms')), { category: [] });
});

test('ACF capture shares the Gutenberg snapshot without sending native save controls', async () => {
    const h = fixture({ acfEnabled: true });
    const changes = h.calls.changes;
    await h.acfChanged();
    assert.equal(h.calls.changes, changes + 1);
    h.state.featured_media = 42;
    await h.native.preparePreview();
    const { body, data } = h.calls.requests.at(-1);
    assert.equal(data, undefined);
    assert.equal(body.get('acf[field_test]'), 'Unsaved ACF');
    assert.equal(body.get('_acf_nonce'), 'acf-nonce');
    assert.equal(body.get('featured_media'), '42');
    assert.equal(body.get('author'), '7');
    assert.equal(body.get('content'), h.state.content);
    assert.equal(body.get('base'), h.config.base);
    h.native.destroy();
    assert.equal(h.acfFields.destroyed, true);
});

test('ACF native row reload pauses capture and resumes only after field replacement', async () => {
    const h = fixture({ acfEnabled: true });
    h.acfFields.waitAfterSave = true;
    await h.request({ url: 'http://site.test/wp-admin/post.php?post=123&meta-box-loader=1', method: 'POST', body: h.metaBody(), parse: false }, async (options) => {
        h.cookies.set(`mtflpp_preview_${options.body.get('mtflpp_preview')}`, `${h.config.base}.${'c'.repeat(64)}`);
        return {};
    });
    await h.emit();
    assert.equal(h.acfFields.saved, 1);
    assert.equal(h.native.ready, false);
    assert.equal(h.native.notReady, 'Waiting for ACF fields');
    assert.equal(h.calls.pauseStates.at(-1), 'paused');
    const resumes = h.calls.resumes.length;
    await h.acfChanged();
    assert.equal(h.calls.resumes.length, resumes);
    h.acfFields.ready = true;
    await h.acfChanged();
    assert.equal(h.native.ready, true);
    assert.equal(h.calls.resumes.length, resumes + 1);
});

test('unacknowledged ACF saves never assume native row reload succeeded', async () => {
    const h = fixture({ acfEnabled: true });
    await h.request({ url: 'http://site.test/wp-admin/post.php?post=123&meta-box-loader=1', method: 'POST', body: h.metaBody(), parse: false }, async () => ({}));
    await h.emit();
    assert.equal(h.acfFields.saved, 0);
    assert.equal(h.calls.resumes.at(-1)?.code, 'mtflpp_source_changed');
});

test('block references and raw code edits schedule capture without serializing', async () => {
    const h = fixture();
    const changes = h.calls.changes;
    h.state.blocks = [{ name: 'core/paragraph', attributes: { content: 'Changed block' } }];
    await h.emit();
    assert.equal(h.calls.changes, changes + 1, 'visual edits change the block reference');
    h.state.content = '';
    await h.emit();
    assert.equal(h.calls.changes, changes + 2, 'clearing code content is still an edit');
    h.state.content = undefined;
    await h.emit();
    const savedChanges = h.calls.changes;
    h.state.savedContent = 'Updated saved content';
    await h.emit();
    assert.equal(h.calls.changes, savedChanges + 1, 'saved content is tracked when there is no raw edit');
    assert.equal(h.calls.contentReads, 0);
});

for (const options of [{}, { isAutosave: true }, { isPreview: true }]) {
    test(`pre-save drains writes without altering native edits ${JSON.stringify(options)}`, async () => {
        const h = fixture();
        const pending = deferred();
        h.setPending(pending.promise);
        const edits = { id: 123, title: 'Native save' };
        let finished = false;
        const task = h.beforeSave(edits, options).then((result) => { finished = true; assert.equal(result, edits); });
        await flush();
        assert.equal(finished, false);
        pending.resolve();
        await task;
        assert.equal(h.native.saving, true);
    });
}

test('preview drain rejection never rejects a native save', async () => {
    const h = fixture();
    h.setPending(Promise.reject(new Error('Preview failed')));
    const edits = { id: 123 };
    assert.equal(await h.beforeSave(edits), edits);
});

for (const route of ['/wp/v2/posts/123', '/custom/v1/articles/123', '/wp/v2/posts/123/autosaves']) {
    test(`native receipts are correlated and removed from ${route}`, async () => {
        const h = fixture({ route: route.replace('/autosaves', '') });
        h.state.saving = true;
        await h.emit();
        const result = await h.request({ path: `${route}?context=edit`, method: 'POST', data: { title: 'Native' } }, async (options) => ({ id: 123, title: 'Native', _mtflpp_receipt: h.receipt(options) }));
        assert.deepEqual(JSON.parse(JSON.stringify(result)), { id: 123, title: 'Native' });
        assert.equal(h.config.base, 'b'.repeat(64));
        h.state.saving = false;
        await h.emit();
        assert.equal(h.calls.resumes.at(-1), undefined);
    });
}

for (const bad of ['missing', 'request', 'before', 'after', 'available']) {
    test(`unproven ${bad} receipts pause only the preview`, async () => {
        const h = fixture();
        const result = await h.request({ path: h.config.postRoute, method: 'PUT' }, async (options) => {
            const receipt = h.receipt(options);
            if (bad !== 'missing') receipt[bad] = 'invalid';
            return { id: 123, _mtflpp_receipt: bad === 'missing' ? undefined : receipt };
        });
        await flush();
        assert.equal(result.id, 123, 'WordPress still receives its saved record');
        assert.equal(h.config.base, 'a'.repeat(64));
        assert.equal(h.calls.resumes.at(-1)?.code, 'mtflpp_source_changed');
    });
}

test('a confirmed conflict reports that the saved post changed, without withholding the native save result', async () => {
    const h = fixture();
    const result = await h.request({ path: h.config.postRoute, method: 'PUT' }, async (options) => ({
        id: 123, _mtflpp_receipt: h.receipt(options, 'conflict'),
    }));
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { id: 123 });
    assert.equal(h.config.base, 'a'.repeat(64));
    assert.equal(h.calls.resumes.at(-1)?.message, h.config.strings.savedPostConflict);
});

for (const parse of [true, false]) {
    test(`array-valued fingerprints fail closed without changing the native response: parse=${parse}`, async () => {
        const h = fixture();
        let response;
        const result = await h.request({ path: h.config.postRoute, method: 'PUT', parse }, async (options) => {
            const record = { id: 123, _mtflpp_receipt: h.receipt(options, ['b'.repeat(64)]) };
            response = parse ? record : new Response(JSON.stringify(record));
            return response;
        });
        await flush();
        if (parse) assert.deepEqual(JSON.parse(JSON.stringify(result)), { id: 123 });
        else {
            assert.equal(result, response);
            assert.equal((await response.json()).id, 123, 'receipt inspection must not consume the native response');
        }
        assert.equal(h.config.base, 'a'.repeat(64));
        assert.equal(h.calls.resumes.at(-1)?.code, 'mtflpp_source_changed');
    });
}

test('the first acknowledged draft save enables preview without a reload', async () => {
    const h = fixture({ available: false });
    await h.request({ path: h.config.postRoute, method: 'PUT' }, async (options) => ({ id: 123, _mtflpp_receipt: h.receipt(options) }));
    await flush();
    assert.equal(h.config.available, true);
    assert.equal(h.calls.resumes.at(-1), undefined);
});

test('legacy meta-box saving chains the REST base and preserves native FormData and response', async () => {
    const h = fixture();
    h.state.saving = true;
    await h.emit();
    await h.request({ path: h.config.postRoute, method: 'PUT' }, async (options) => ({ id: 123, _mtflpp_receipt: h.receipt(options) }));
    const body = h.metaBody(), response = { native: true };
    const resumes = h.calls.resumes.length;
    const result = await h.request({ url: 'http://site.test/wp-admin/post.php?post=123&meta-box-loader=1', method: 'POST', body, parse: false }, async (options) => {
        assert.equal(options.body.get('mtflpp_base'), 'b'.repeat(64));
        assert.equal(options.body.get('acf[field_test]'), 'Value');
        h.cookies.set(`mtflpp_preview_${options.body.get('mtflpp_preview')}`, `${'b'.repeat(64)}.${'c'.repeat(64)}`);
        return response;
    });
    assert.equal(result, response);
    assert.equal(body.has('mtflpp_base'), false, 'never modify the native FormData object');
    assert.equal(h.cookies.size, 0);
    assert.equal(h.config.base, 'c'.repeat(64));
    await flush();
    assert.equal(h.calls.resumes.length, resumes, 'wait for the entire native save lifecycle');
    h.state.saving = false;
    await h.emit();
    assert.equal(h.calls.resumes.length, resumes + 1);
});

test('native meta-box receipts use WordPress-provided admin paths without a private editor global', async () => {
    const h = fixture();
    h.config.postFormUrl = 'http://site.test/wordpress/wp-admin/post.php';
    const body = h.metaBody();
    await h.request({
        url: `${h.config.postFormUrl}?post=123&meta-box-loader=1&meta-box-loader-nonce=rotated-native-nonce`,
        method: 'POST', body, parse: false,
    }, async (options) => {
        assert.equal(options.body.get('post_ID'), '123');
        assert.equal(options.body.get('mtflpp_base'), 'a'.repeat(64));
        assert.match(options.url, /meta-box-loader-nonce=rotated-native-nonce$/);
        h.cookies.set(`mtflpp_preview_${options.body.get('mtflpp_preview')}`, `${'a'.repeat(64)}.${'b'.repeat(64)}`);
        return {};
    });
    assert.equal(h.config.base, 'b'.repeat(64));
    assert.equal(body.has('mtflpp_preview'), false);
});

for (const target of ['another-origin', 'another-admin-path', 'another-post', 'another-action', 'not-meta-boxes', 'no-form-url']) {
    test(`legacy meta-box matching leaves ${target} requests unchanged`, async () => {
        const h = fixture();
        const body = h.metaBody();
        let url = `${h.config.postFormUrl}?post=123&meta-box-loader=1`;
        if (target === 'another-origin') url = url.replace('site.test', 'elsewhere.test');
        if (target === 'another-admin-path') url = url.replace('/wp-admin/', '/another/wp-admin/');
        if (target === 'another-post') body.set('post_ID', '456');
        if (target === 'another-action') body.set('action', 'unrelated');
        if (target === 'not-meta-boxes') url = h.config.postFormUrl;
        if (target === 'no-form-url') delete h.config.postFormUrl;
        const options = { url, method: 'POST', body, parse: false };
        const response = {};
        const result = await h.request(options, async (forwarded) => {
            assert.equal(forwarded, options);
            assert.equal(forwarded.body, body);
            assert.equal(forwarded.body.has('mtflpp_preview'), false);
            return response;
        });
        assert.equal(result, response);
        assert.equal(h.config.base, 'a'.repeat(64));
        assert.equal(h.calls.pauses.length, 0);
    });
}

test('a missing meta-box receipt cannot silently accept metadata changes', async () => {
    const h = fixture();
    await h.request({ url: 'http://site.test/wp-admin/post.php?post=123&meta-box-loader=1', method: 'POST', body: h.metaBody(), parse: false }, async () => ({}));
    await flush();
    assert.equal(h.calls.resumes.at(-1)?.code, 'mtflpp_source_changed');
});

for (const [error, uncertain] of [
    [{ code: 'rest_invalid_param', data: { status: 400 } }, true],
    [{ code: 'rest_cannot_edit', data: { status: 403 } }, true],
    [{ code: 'rest_cannot_update', data: { status: 403 } }, true],
    [{ code: 'rest_invalid_featured_media', data: { status: 400 } }, true],
    [{ code: 'rest_save_failed', data: { status: 500 } }, true],
    [{ code: 'fetch_error' }, true],
    [{ code: 'invalid_json' }, true],
    [{ code: 'ECONNRESET' }, true],
    [new TypeError('Network failure'), true],
    [new DOMException('The request was aborted.', 'AbortError'), true],
]) {
    test(`${error.code || error.name} preserves native failure and ${uncertain ? 'requires a reload' : 'allows retrying preview'}`, async () => {
        const h = fixture();
        await assert.rejects(h.request({ path: h.config.postRoute, method: 'PUT' }, async () => { throw error; }), (received) => received === error);
        await flush();
        assert.equal(h.config.base, 'a'.repeat(64), 'a rejection never advances the saved fingerprint');
        assert.equal(h.calls.resumes.at(-1)?.code, uncertain ? 'mtflpp_source_changed' : undefined);
    });
}

for (const bad of [null, 'request', 'before', 'after', 'available']) {
    test(`a REST rejection ${bad ? `with an invalid ${bad} receipt requires reload` : 'with an unchanged-state receipt allows preview and native retry'}`, async () => {
        const h = fixture();
        let error;
        await assert.rejects(h.request({ path: h.config.postRoute, method: 'PUT' }, async (options) => {
            const receipt = h.receipt(options, h.config.base);
            if (bad) receipt[bad] = bad === 'after' ? 'b'.repeat(64) : 'invalid';
            error = { code: 'rest_invalid_param', data: { status: 400 }, _mtflpp_receipt: receipt };
            throw error;
        }), (received) => received === error);
        await flush();
        assert.equal('_mtflpp_receipt' in error, false, 'private receipts never reach core');
        assert.equal(h.config.base, 'a'.repeat(64), 'a rejected request never advances the baseline');
        assert.equal(h.calls.resumes.at(-1)?.code, bad ? 'mtflpp_source_changed' : undefined);
        if (!bad) {
            const edits = { id: 123, title: 'Retry' };
            assert.equal(await h.beforeSave(edits), edits);
            await h.request({ path: h.config.postRoute, method: 'PUT' }, async (options) => ({ id: 123, _mtflpp_receipt: h.receipt(options) }));
            await flush();
            assert.equal(h.config.base, 'b'.repeat(64));
            assert.equal(h.calls.resumes.at(-1), undefined);
        }
    });
}

for (const immutable of ['frozen', 'non-configurable']) {
    test(`${immutable} error receipts preserve the original rejection and conservatively pause preview`, async () => {
        const h = fixture();
        let error;
        await assert.rejects(h.request({ path: h.config.postRoute, method: 'PUT' }, async (options) => {
            error = { code: 'rest_invalid_param', data: { status: 400 } };
            const receipt = h.receipt(options, h.config.base);
            if (immutable === 'frozen') error = Object.freeze({ ...error, _mtflpp_receipt: receipt });
            else Object.defineProperty(error, '_mtflpp_receipt', { value: receipt, configurable: false });
            throw error;
        }), (received) => received === error);
        await flush();
        assert.equal(h.config.base, 'a'.repeat(64));
        assert.equal(h.calls.resumes.at(-1)?.code, 'mtflpp_source_changed');
        assert.equal(await h.beforeSave({ id: 123 }).then((edits) => edits.id), 123, 'native retry remains available');
    });
}

test('a post update followed by a metadata 403 cannot resume against the old baseline', async () => {
    const h = fixture();
    const error = { code: 'rest_cannot_update', data: { status: 403 } };
    await assert.rejects(h.request({ path: h.config.postRoute, method: 'PUT' }, async () => {
        h.state.savedContent = 'Partially saved before metadata was rejected';
        throw error;
    }), (received) => received === error);
    await flush();
    assert.equal(h.config.base, 'a'.repeat(64));
    assert.equal(h.calls.resumes.at(-1)?.code, 'mtflpp_source_changed');
    const edits = { id: 123, title: 'Native retry remains available' };
    assert.equal(await h.beforeSave(edits), edits);
});

test('unrelated reads, posts and plugin writes pass through untouched', async () => {
    const h = fixture();
    for (const options of [
        { path: h.config.postRoute, method: 'GET' },
        { path: '/wp/v2/posts/124', method: 'PUT' },
        { url: h.config.endpoint, method: 'POST' },
        { path: '/wp/v2/wp_block/123', method: 'PUT' },
    ]) {
        await h.request(options, async (received) => { assert.equal(received, options); return {}; });
    }
    assert.equal(h.config.base, 'a'.repeat(64));
});

test('editing a separate entity pauses capture and returning resumes the intended post', async () => {
    const h = fixture();
    h.state.type = 'wp_template';
    await h.emit();
    assert.equal(h.native.ready, false);
    assert.equal(h.calls.pauses.at(-1), 'Return to post');
    assert.equal(h.calls.pauseStates.at(-1), 'paused');
    assert.equal(h.native.notReady, 'Return to post');
    h.state.type = 'post';
    await h.emit();
    assert.equal(h.native.ready, true);
});

test('destroy detaches observers and leaves middleware inert', async () => {
    const h = fixture();
    h.native.destroy();
    const options = { path: h.config.postRoute, method: 'PUT' };
    await h.request(options, async (received) => { assert.equal(received, options); return {}; });
});

async function previewFixture({ ready = true, notReady = 'Return to post', notReadyState = 'paused', pending, idle = Promise.resolve() } = {}) {
    const source = await sourceForVm(new URL('../src/preview/live-preview.js', import.meta.url));
    const calls = { reports: [], writes: 0, loads: 0, clears: 0, locks: 0 };
    const timers = new Map();
    let callbacks, loaded = false, nextTimer = 0;
    const view = { visible: true, report: (text, state, options) => calls.reports.push({ text, state, ...options }),
        setVisible(value) { this.visible = value; }, setTitle() {}, returnToEditor() {},
    };
    const native = { ready, notReady, notReadyState, idle, saving: false,
        preparePreview: () => { calls.writes++; return pending ?? Promise.resolve({ url: '/preview' }); },
    };
    const session = vm.runInNewContext(`${source}\ncreateLivePreview`, {
        performance, window: { isSecureContext: true, addEventListener() {} },
        navigator: { locks: { request: (name, options, run) => { calls.locks++; return run({}); } } },
        setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: (id) => timers.delete(id),
        imports: {
            '../panel/window.js': { createPreviewPanel: (strings, options) => { callbacks = options; return view; } },
            '../preview/scroll.js': { createPreviewScroll: () => ({}) },
            '../preview/frame.js': { createPreviewFrame: (view, scrolling, strings, report) => ({
                get hasPreview() { return loaded; },
                load() { calls.loads++; loaded = true; report(strings.current, 'ready'); }, cancel() {},
                clear() { loaded = false; calls.clears++; },
            }) },
        },
    })({ available: true, endpoint: '/preview', base: 'base', strings: { loading: 'Loading preview…', updating: 'Updating preview…', current: 'Refreshed' } }, native);
    session.start();
    await flush();
    return { session, native, calls, view, callbacks,
        async tick() {
            for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
            await flush();
        },
    };
}

test('opening and reopening during Gutenberg initialization stays loading without acquiring preview ownership', async () => {
    const h = await previewFixture({ ready: false, notReady: 'Loading preview…', notReadyState: 'loading' });
    h.callbacks.onClose();
    h.callbacks.onOpen();
    const report = h.calls.reports.at(-1);
    assert.equal(report.text, 'Loading preview…');
    assert.equal(report.state, 'loading');
    assert.equal(report.canRetry, false);
    assert.equal(report.canRefresh, false);
    assert.equal(h.calls.reports.some(({ state }) => state === 'paused'), false);
    assert.equal(h.calls.locks, 0);
    assert.equal(h.calls.writes, 0);
    h.native.ready = true;
    h.session.resume();
    await h.tick();
    assert.equal(h.calls.reports.at(-1).state, 'ready');
    assert.equal(h.calls.locks, 1);
    assert.equal(h.calls.loads, 1);
    h.callbacks.onClose();
    await flush();
});

for (const ready of [false, true]) {
    test(`an unsupported context pauses ${ready ? 'a retained preview' : 'initial opening and reopening'} and resumes on return`, async () => {
        const h = await previewFixture({ ready });
        if (ready) {
            assert.equal(h.calls.loads, 1);
            h.native.ready = false;
            h.session.pause(h.native.notReady, 'paused');
        } else {
            assert.equal(h.calls.locks, 0);
            h.callbacks.onClose();
            h.callbacks.onOpen();
        }
        const report = h.calls.reports.at(-1);
        assert.equal(report.text, 'Return to post');
        assert.equal(report.state, 'paused');
        assert.equal(report.hasPreview, ready);
        assert.equal(report.canRefresh, false);
        assert.equal(report.canRetry, false);
        assert.equal(h.calls.loads, ready ? 1 : 0);
        if (ready) assert.equal(h.calls.clears, 0, 'pausing retains the existing frame');
        h.native.ready = true;
        h.session.resume();
        await h.tick();
        assert.equal(h.calls.reports.at(-1).state, 'ready');
        assert.equal(h.calls.loads, ready ? 2 : 1);
        h.callbacks.onClose();
        await flush();
    });
}

test('an obsolete preview write failure cannot replace the unsupported-context explanation', async () => {
    const write = deferred();
    const h = await previewFixture({ pending: write.promise });
    assert.equal(h.calls.writes, 1);
    h.native.ready = false;
    h.session.pause(h.native.notReady, 'paused');
    write.reject(new Error('Late failure'));
    await h.tick();
    assert.equal(h.calls.reports.at(-1).state, 'paused');
    assert.equal(h.calls.reports.at(-1).text, 'Return to post');
    assert.equal(h.calls.loads, 0);
    h.callbacks.onClose();
    await flush();
});

test('a refresh waiting for native idle cannot start a write after leaving the post', async () => {
    const idle = deferred();
    const h = await previewFixture({ idle: idle.promise });
    h.native.ready = false;
    h.session.pause(h.native.notReady, 'paused');
    idle.resolve();
    await h.tick();
    assert.equal(h.calls.writes, 0);
    assert.equal(h.calls.reports.at(-1).state, 'paused');
    h.callbacks.onClose();
    await flush();
});

test('native saves drain the real preview write without waiting for their own idle promise', async () => {
    const source = await previewSourceForVm(new URL('../src/preview/live-preview.js', import.meta.url));
    const write = deferred(), nativeSave = deferred();
    const native = { idle: Promise.resolve(), preparePreview: () => write.promise, saving: false };
    const session = vm.runInNewContext(`${source}\ncreateLivePreview`, {
        console, window: { isSecureContext: true, addEventListener() {} }, navigator: { locks: { request: (name, options, run) => run({}) } },
        setTimeout: () => 1, clearTimeout() {},
        imports: {
            '../panel/window.js': { createPreviewPanel: () => ({ visible: true, report() {}, setVisible() {}, setTitle() {} }) },
            '../preview/scroll.js': { createPreviewScroll: () => ({}) },
        },
    })({ available: true, endpoint: '/preview', base: 'base', strings: {} }, native);
    session.start();
    await flush();
    native.idle = nativeSave.promise;
    native.saving = true;
    const drain = session.pause();
    assert.equal(drain, write.promise);
    write.resolve({ url: '/preview' });
    await drain;
    nativeSave.resolve();
    await flush();
});

for (const url of [
    'http://site.test/wp-json/wp/v2/posts/123?_locale=user',
    'http://site.test/?rest_route=/wp/v2/posts/123&_locale=user',
]) {
    test(`native receipt handling supports absolute REST URLs: ${url}`, async () => {
        const h = fixture();
        const result = await h.request({ url, method: 'POST' }, async (options) => ({ id: 123, _mtflpp_receipt: h.receipt(options) }));
        assert.equal(result.id, 123);
        assert.equal(h.config.base, 'b'.repeat(64));
        await h.request({ url: url.replace('site.test', 'elsewhere.test'), method: 'POST' }, async (options) => {
            assert.equal(options.headers, undefined, 'never add receipts to another origin');
            return {};
        });
    });
}

for (const fail of [false, true]) {
    test(`the block entry connects only its adapter and cleans up on startup failure: ${fail}`, async () => {
        const entry = await sourceForVm(new URL('../src/block-editor.js', import.meta.url));
        const calls = [];
        const session = {};
        const native = { connect: (value) => { assert.equal(value, session); calls.push('connect'); }, destroy: () => calls.push('destroy') };
        vm.runInNewContext(entry, {
            window: { meetTheFrontendLivePreviewPanel: { strings: { bootFailed: 'Unavailable' } } },
            imports: {
                '@wordpress/element': {},
                './screens/block-editor.js': { createBlockEditor: () => { calls.push('observePreviewInputs'); return native; } },
                './preview/live-preview.js': { createLivePreview: (config, editor, { inlineLauncher, nativeLauncher }) => {
                    assert.equal(editor, native);
                    assert.equal(inlineLauncher, undefined, 'Gutenberg does not add an in-page launcher.');
                    assert.equal(nativeLauncher, undefined, 'Keep the floating launcher when the native menu API is unavailable.');
                    calls.push('preview');
                    if (fail) throw new Error('Fixture failure');
                    return session;
                } },
                './panel/startup-error.js': { showStartupError: () => calls.push('notice') },
            },
        });
        assert.deepEqual(calls, fail ? ['observePreviewInputs', 'preview', 'destroy', 'notice'] : ['observePreviewInputs', 'preview', 'connect']);
    });
}

test('the block entry adds a separate action to the native View menu', async () => {
    const entry = await sourceForVm(new URL('../src/block-editor.js', import.meta.url));
    const PreviewMenuItem = () => {};
    const calls = [];
    const preview = { openFromLauncher: () => calls.push('open') };
    const fallbackMedia = { matches: false };
    let menu, options, openOnFrame, viewHidden = false;
    const view = { focus(settings) {
        assert.equal(settings.preventScroll, true);
        if (!viewHidden) {
            document.activeElement = view;
            calls.push('focus View');
        }
    } };
    const editingArea = { focus(settings) {
        assert.equal(settings.preventScroll, true);
        document.activeElement = editingArea;
        calls.push('focus editing area');
    } };
    const document = {
        activeElement: null,
        querySelector(selector) {
            if (selector === '.editor-preview-dropdown__toggle') return view;
            assert.equal(selector, '.interface-interface-skeleton__content[tabindex="-1"]');
            return editingArea;
        },
    };
    vm.runInNewContext(entry, {
        window: {
            meetTheFrontendLivePreviewPanel: { strings: {
                showLivePreview: 'Show live preview', showLivePreviewHelp: 'See unsaved changes in a floating window.',
            } },
            matchMedia(query) {
                assert.equal(query, '(max-width: 782px)');
                return fallbackMedia;
            },
            requestAnimationFrame(callback) { openOnFrame = callback; },
            wp: { editor: { PluginPreviewMenuItem: PreviewMenuItem }, plugins: {
                registerPlugin(name, plugin) { assert.equal(name, 'meet-the-frontend-live-preview-panel'); menu = plugin; },
            } },
        },
        document,
        imports: {
            '@wordpress/element': { createElement: (component, props, text) => ({ component, props, text }) },
            './screens/block-editor.js': { createBlockEditor: () => ({ connect: (value) => assert.equal(value, preview) }) },
            './preview/live-preview.js': { createLivePreview: (config, editor, settings) => { options = settings; return preview; } },
            './panel/startup-error.js': { showStartupError: (message, error) => { throw error; } },
        },
    });
    const action = menu.render();
    assert.equal(action.component, PreviewMenuItem);
    assert.equal(action.props.role, 'menuitem');
    assert.equal(action.props.icon, null, 'Suppress the default plugin icon.');
    assert.equal(action.props.info, 'See unsaved changes in a floating window.');
    assert.equal(action.text, 'Show live preview');
    action.props.onClick();
    assert.deepEqual(calls, [], 'Wait for the native menu to finish before focusing the preview.');
    openOnFrame();
    assert.equal(options.nativeLauncher.fallbackMedia, fallbackMedia);
    options.nativeLauncher.focus();
    assert.equal(document.activeElement, view);
    viewHidden = true;
    document.activeElement = null;
    options.nativeLauncher.focus();
    assert.equal(document.activeElement, editingArea);
    assert.deepEqual(calls, ['open', 'focus View', 'focus editing area']);
});
