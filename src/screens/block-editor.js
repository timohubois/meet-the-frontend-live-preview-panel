import apiFetch from '@wordpress/api-fetch';
import { select, subscribe } from '@wordpress/data';
import { addFilter, removeFilter } from '@wordpress/hooks';
import { guardPreviewInputs, submittedValues } from './preview-inputs.js';
import { markAcfPlainText, setupBlockEditorAcf } from '../compatibility/acf-editor.js';
import { yoastPrimaryTerms } from '../compatibility/yoast.js';

const scope = 'meet-the-frontend-live-preview-panel';
const fingerprint = /^[a-f0-9]{64}$/;

// Use public editor selectors/hooks. Never replace savePost or inspect the block canvas.
export function createBlockEditor(config) {
    const editorRoot = document.getElementById('editor');
    // Visual Revisions renders its own header even for browser backups. Core's mode selector is private.
    const revisionHeaders = editorRoot?.getElementsByClassName('editor-revisions-header');
    const isBrowsingRevisions = () => !!revisionHeaders?.length;
    let ready = false;
    let browsingRevisions = false;
    let revisionObserver;
    const native = {
        // Check the DOM again at the write gate, even before the mutation observer has run.
        get ready() { return ready && !isBrowsingRevisions(); },
        notReady: config.strings.loading, notReadyState: 'loading', saving: false, idle: Promise.resolve(), title: config.postTitle,
    };
    let preview;
    let destroyed = false;
    let lastValues;
    let wasSaving = false;
    let requests = 0;
    let failure;
    let settleQueued = false;
    const inputs = guardPreviewInputs(config);
    const acf = inputs.run(() => setupBlockEditorAcf(config, () => { preview?.changed(); scheduleObserve(); }));
    const editor = () => select('core/editor');
    const ownsPost = () => Number(editor()?.getCurrentPostId()) === config.postId
        && editor()?.getCurrentPostType() === config.postType;
    const fail = (conflict = false) => {
        const message = conflict ? config.strings.savedPostConflict : config.strings.nativeSaveFailed;
        failure = Object.assign(new Error(message), { code: 'mtflpp_source_changed' });
    };
    const token = () => Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');

    function primaryTerms(state) {
        const primary = inputs.run(() => yoastPrimaryTerms(config, state));
        return primary === undefined ? {} : { yoast_primary_terms: primary };
    }

    function values() {
        const state = editor();
        const author = state.getEditedPostAttribute('author');
        const date = state.getEditedPostAttribute('date');
        const terms = {};
        for (const [taxonomy, attribute] of Object.entries(config.taxonomies || {})) {
            const ids = state.getEditedPostAttribute(attribute);
            if (Array.isArray(ids)) terms[taxonomy] = ids;
        }
        return {
            ...primaryTerms(state),
            ...(author ? { author } : {}),
            ...(date !== undefined ? { date } : {}),
            ...(Object.keys(terms).length ? { terms: JSON.stringify(terms) } : {}),
            post_title: state.getEditedPostAttribute('title') ?? '',
            content: state.getEditedPostContent(),
            excerpt: state.getEditedPostAttribute('excerpt') ?? '',
            featured_media: state.getEditedPostAttribute('featured_media') ?? 0,
        };
    }

    function notReadyReason(postLoaded, postReady, pauseReason) {
        if (!postLoaded) return config.strings.loading;
        if (!postReady) return config.strings.postOnly;
        return inputs.error?.message || pauseReason;
    }

    function observe() {
        if (destroyed || !preview) return;
        const revisions = isBrowsingRevisions();
        if (revisions !== browsingRevisions) {
            browsingRevisions = revisions;
            if (revisions) {
                ready = false;
                preview.pause(config.strings.postOnly, 'paused');
            }
            preview.setSuspended(revisions);
        }
        if (revisions) return;
        const state = editor();
        // An empty editor store is still initializing, not an unsupported editing context.
        const postLoaded = !!state?.getCurrentPost()?.id;
        const postReady = postLoaded && ownsPost();
        if (postReady) inputs.run(() => acf?.observe());
        const waiting = inputs.run(() => acf && !acf.ready);
        const pauseReason = waiting ? config.strings.acfRefreshing : '';
        const canPreview = postReady && !pauseReason && !inputs.error;
        native.notReady = notReadyReason(postLoaded, postReady, pauseReason);
        native.notReadyState = postLoaded ? 'paused' : 'loading';
        const saving = postReady && (state.isSavingPost() || requests > 0);
        const becameReady = canPreview && !ready;
        ready = canPreview;
        native.saving = saving;
        if (inputs.error) {
            preview.resume(inputs.error);
            return;
        }
        if (!ready) {
            preview.pause(native.notReady, native.notReadyState);
            return;
        }
        if (saving && !wasSaving) {
            preview.pause(editor().isPreviewingPost() ? config.strings.nativePreview : config.strings.saving);
        }
        const finished = wasSaving && !saving;
        wasSaving = saving;
        // Track cheap raw values and immutable block references; serialize only when capturing a preview.
        const current = {
            ...primaryTerms(state),
            post_title: state.getEditedPostAttribute('title') ?? '',
            excerpt: state.getEditedPostAttribute('excerpt') ?? '',
            content: state.getPostEdits().content ?? state.getCurrentPost().content,
            blocks: state.getEditedPostAttribute('blocks'),
            author: state.getEditedPostAttribute('author'),
            date: state.getEditedPostAttribute('date'),
            ...Object.fromEntries(Object.entries(config.taxonomies || {}).map(([taxonomy, attribute]) =>
                [`terms:${taxonomy}`, state.getEditedPostAttribute(attribute)])),
            featured_media: state.getEditedPostAttribute('featured_media') ?? 0,
        };
        if (inputs.error) {
            ready = false;
            preview.resume(inputs.error);
            return;
        }
        if (native.title !== current.post_title) {
            native.title = current.post_title;
            preview.setTitle(native.title);
        }
        if (!lastValues || Object.keys(current).length !== Object.keys(lastValues).length
            || Object.keys(current).some((key) => current[key] !== lastValues[key])) {
            lastValues = current;
            preview.changed();
        }
        if (finished || becameReady) preview.resume(failure);
    }

    // Store subscriptions can run during core's action dispatch. Defer our own observation, not native saves.
    function scheduleObserve() {
        if (settleQueued) return;
        settleQueued = true;
        queueMicrotask(() => { settleQueued = false; observe(); });
    }

    async function beforeSave(edits) {
        if (destroyed || !preview || Number(edits.id) !== config.postId || !ownsPost()) return edits;
        native.saving = true;
        const pending = preview.pause(editor().isPreviewingPost() ? config.strings.nativePreview : config.strings.saving);
        // A preview failure must never reject WordPress's save.
        try { await pending; } catch { /* Native saving takes precedence. */ }
        return edits;
    }

    function requestRoute(options) {
        if (typeof options.path === 'string' && options.path.startsWith('/')) return options.path.split('?')[0].replace(/\/$/, '');
        if (typeof options.url !== 'string') return '';
        const url = new URL(options.url, window.location.href);
        const root = new URL(config.restRoot, window.location.href);
        if (url.origin !== root.origin) return '';
        if (url.searchParams.has('rest_route')) return url.searchParams.get('rest_route').replace(/\/$/, '');
        if (!url.pathname.startsWith(root.pathname)) return '';
        return `/${url.pathname.slice(root.pathname.length)}`.replace(/\/$/, '');
    }

    function isMetaSave(options) {
        if (typeof config.postFormUrl !== 'string'
            || !(options.body instanceof FormData) || typeof options.url !== 'string') return false;
        const url = new URL(options.url, window.location.href);
        // WordPress supplies its admin form URL; do not depend on its private nonce-bearing JS global.
        const expected = new URL(config.postFormUrl, window.location.href);
        return url.origin === window.location.origin && url.origin === expected.origin && url.pathname === expected.pathname
            && url.searchParams.has('meta-box-loader') && options.body.get('post_ID') === String(config.postId)
            && options.body.get('action') === 'editpost';
    }

    function accept(receipt, request, base) {
        if (!receipt || receipt.request !== request || receipt.before !== base || config.base !== base
            || typeof receipt.available !== 'boolean') {
            fail();
            return;
        }
        if (typeof receipt.after !== 'string' || !fingerprint.test(receipt.after)) {
            fail(receipt.after === 'conflict');
            return;
        }
        config.base = receipt.after;
        config.available = receipt.available;
    }

    async function middleware(options, next) {
        if (destroyed || !preview || !['POST', 'PUT', 'PATCH'].includes((options.method || 'GET').toUpperCase())) return next(options);
        const route = requestRoute(options);
        const restSave = route === config.postRoute || route === `${config.postRoute}/autosaves`;
        const metaSave = !restSave && isMetaSave(options);
        if (!restSave && !metaSave) return next(options);
        requests++;
        native.saving = true;
        scheduleObserve();
        const pending = preview.pause(config.strings.saving);
        try { await pending; } catch { /* Drain errors belong to the panel, not the native save. */ }
        const base = config.base;
        const request = token();
        let cookieName;
        try {
            if (restSave) {
                const response = await next({ ...options, headers: {
                    ...options.headers, 'X-MTFLPP-Base': base, 'X-MTFLPP-Request': request,
                } });
                // Core's native saves use parsed records. Preserve parse:false for other opted-in callers too.
                if (options.parse === false) {
                    try {
                        const data = await response.clone().json();
                        accept(data?._mtflpp_receipt, request, base);
                    } catch { fail(); }
                    return response;
                }
                if (!response || typeof response !== 'object') { fail(); return response; }
                const { _mtflpp_receipt: receipt, ...record } = response;
                accept(receipt, request, base);
                return record;
            }
            const body = new FormData();
            for (const [key, value] of options.body) body.append(key, value);
            body.set('mtflpp_base', base);
            body.set('mtflpp_preview', request);
            body.set('mtflpp_metabox', '1');
            cookieName = `mtflpp_preview_${request}`;
            const response = await next({ ...options, body });
            const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
            const receipt = cookie?.slice(cookieName.length + 1);
            const after = receipt?.startsWith(`${base}.`) ? receipt.slice(65) : '';
            accept({ request, before: base, after: receipt === 'conflict' ? receipt : after, available: config.available }, request, base);
            if (!destroyed && !failure) inputs.run(() => acf?.saved());
            return response;
        } catch (error) {
            // Even a REST 4xx can follow wp_update_post(). Retry preview only when the server
            // confirms this request left its baseline unchanged; never advance a rejected save.
            let receipt = error?._mtflpp_receipt;
            try {
                if (receipt !== undefined) delete error._mtflpp_receipt;
            } catch {
                // Read-only errors must keep WordPress's original rejection; pause without trusting the receipt.
                receipt = undefined;
            }
            const status = error?.data?.status;
            if (restSave && error?.name !== 'AbortError' && typeof error?.code === 'string'
                && Number.isInteger(status) && status >= 400 && status < 500 && receipt?.after === base) {
                accept(receipt, request, base);
            } else fail();
            throw error;
        } finally {
            if (cookieName) document.cookie = `${cookieName}=; Max-Age=0; Path=${config.adminCookiePath}; SameSite=Strict`;
            requests--;
            scheduleObserve();
        }
    }

    native.preparePreview = () => {
        if (destroyed) throw new Error('This editor session has ended.');
        const data = values();
        const captured = inputs.run(() => acf?.capture());
        if (inputs.error) throw inputs.error;
        const body = captured?.size ? captured : null;
        const types = { post_title: 'text', content: 'html', excerpt: 'html' };
        const hints = submittedValues(body, Object.fromEntries(Object.entries(data).map(([key, value]) => [
            key, { type: Object.hasOwn(types, key) ? types[key] : 'value', value },
        ])), document);
        const comparisonValues = Object.fromEntries(acf ? markAcfPlainText(hints) : hints);
        data.base = config.base;
        let request;
        if (body === null) request = apiFetch({ url: config.endpoint, method: 'POST', data });
        else {
            for (const [key, value] of Object.entries(data)) body.set(key, value ?? '');
            request = apiFetch({ url: config.endpoint, method: 'POST', body });
        }
        return request.then((result) => ({ ...result, comparisonValues }));
    };
    const unsubscribe = subscribe(scheduleObserve);
    addFilter('editor.preSavePost', scope, beforeSave);
    apiFetch.use(middleware);
    native.connect = (session) => {
        preview = session;
        if (editorRoot) {
            revisionObserver = new MutationObserver(() => {
                if (isBrowsingRevisions() !== browsingRevisions) scheduleObserve();
            });
            revisionObserver.observe(editorRoot, { childList: true, subtree: true });
        }
        observe();
    };
    native.destroy = () => {
        if (destroyed) return;
        destroyed = true;
        revisionObserver?.disconnect();
        unsubscribe();
        try { acf?.destroy(); } catch { /* Continue releasing native editor listeners. */ }
        removeFilter('editor.preSavePost', scope);
    };
    window.addEventListener('pagehide', (event) => { if (!event.persisted) native.destroy(); });
    return native;
}
