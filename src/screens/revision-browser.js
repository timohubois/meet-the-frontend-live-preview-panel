import { createPreviewPanel } from '../panel/window.js';
import { createPreviewFrame } from '../preview/frame.js';
import { createPreviewScroll } from '../preview/scroll.js';

// Read the native To selection. Never capture editor fields, write revisions, or acquire editor locks.
export function initRevisionPreview(config, model, backLink) {
    const { strings } = config;
    let selected = model.get('to');
    let generation = 0;
    let timer;
    const doc = backLink.ownerDocument;
    const container = doc.getElementById('mtflpp-toggle');
    container.classList.replace('mtflpp-launcher', 'mtflpp-inline-launcher');
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'button-link';
    button.textContent = strings.previewRevision;
    button.setAttribute('aria-controls', 'mtflpp-panel');
    container.append(button);
    backLink.after(container);

    const view = createPreviewPanel(strings, {
        postTitle: label(selected),
        publicRedirect: config.publicRedirect,
        inlineLauncher: button,
        canRememberVisibility: false,
        onOpen() { view.setVisible(true); refresh(); },
        onClose: close,
        onRefresh: refresh,
        onRetry: () => refresh(),
        beforeViewportChange: (viewport) => frames.beforeViewportChange(viewport),
        beforeMove() { generation++; frames.clear(); },
        afterMove() { if (view.visible) refresh(); },
    });
    const frames = createPreviewFrame(view, createPreviewScroll(), strings, report, config.comparisonExcludedSelectors);

    function label(revision) {
        if (!revision) return '';
        const date = revision.get('dateShort') || revision.get('date') || '';
        const author = revision.get('author')?.name || '';
        const detail = strings.revisionLabel.replace('%1$s', () => date).replace('%2$s', () => author);
        return revision.id === config.postId ? `${strings.currentVersion} — ${detail}` : detail;
    }

    function report(text, state = 'loading', options = {}) {
        // Retain the previous revision's identity until its replacement has actually loaded.
        if (state === 'ready' || !frames.hasPreview) view.setTitle(label(selected));
        view.report(text, state, {
            hasPreview: frames.hasPreview, hasHtmlPreview: frames.hasHtmlPreview, redirectDestination: frames.redirectDestination,
            canRefresh: view.visible && ['ready', 'error'].includes(state),
            ...options,
        });
    }

    async function refresh(follow = true) {
        clearTimeout(timer);
        frames.cancel();
        const version = ++generation;
        if (!view.visible) return;
        const url = selected?.id === config.postId
            ? config.currentPreviewUrl : selected?.get('mtflppPreviewUrl');
        if (typeof url !== 'string' || !url) {
            // An unavailable selection must not leave another revision presented as its preview.
            frames.clear();
            report(strings.unavailable, 'error', { canRetry: false, canRefresh: false, reason: 'unavailable' });
            return;
        }
        try {
            await frames.load(url, () => view.visible && version === generation, () => view.followChanges && follow,
                { revision: { type: 'value', value: selected.id } });
        } catch (error) {
            if (view.visible && version === generation) {
                const reason = {
                    mtflpp_preview_origin_mismatch: 'origin-mismatch',
                    mtflpp_preview_unsupported_url: 'unsupported-url',
                }[error?.code] || '';
                report(reason === 'origin-mismatch' ? error.message : strings.failed, 'error', {
                    canRetry: !reason, canRefresh: !reason, reason,
                });
            }
        }
    }

    function changed() {
        const next = model.get('to');
        if (next?.id === selected?.id) return;
        selected = next;
        generation++;
        frames.cancel();
        clearTimeout(timer);
        if (!view.visible) return;
        report(strings.stale, 'stale');
        timer = setTimeout(refresh, 250);
    }

    function close() {
        generation++;
        clearTimeout(timer);
        view.setVisible(false);
        frames.clear();
        view.returnToEditor();
    }

    model.on('update:revisions', changed);
    window.addEventListener('pagehide', (event) => {
        if (event.persisted) return;
        model.off('update:revisions', changed);
        close();
    });
    if (view.visible) refresh();
}
