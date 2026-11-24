import { createPreviewComparison } from './comparison.js';

function redirectedHtmlPath(doc, requested) {
    if (doc?.contentType !== 'text/html') return;
    // A different URL alone could be a history update, not a redirect. Unobservable redirects stay native.
    const navigation = doc.defaultView?.performance.getEntriesByType('navigation')[0];
    if (!(navigation?.redirectCount > 0)) return;
    const final = new URL(navigation.name);
    if (final.origin === requested.origin && (final.pathname !== requested.pathname || final.search !== requested.search)) {
        // Display text only; preview tokens and other destination query values are not for the notice.
        return final.pathname;
    }
}

// Own iframe loading and optional HTML enhancements, not the source's writes or selection lifecycle.
export function createPreviewFrame(view, scrolling, strings, report, excludedSelectors = []) {
    const comparison = createPreviewComparison(excludedSelectors);
    let activeFrame;
    let activeDocument;
    let followedTarget;
    let redirectDestination;
    let cancelLoad;

    function cancel() {
        cancelLoad?.();
    }

    function load(nextAddress, isCurrent, followChanges = () => false, comparisonValues) {
        const url = new URL(nextAddress);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw Object.assign(new Error(strings.failed), { code: 'mtflpp_preview_unsupported_url' });
        }
        if (url.origin !== window.location.origin) {
            // Report only the origin; the URL can contain preview state and other private values.
            const message = strings.originMismatch.replace('%s', () => url.origin);
            throw Object.assign(new Error(message), { code: 'mtflpp_preview_origin_mismatch' });
        }
        const token = url.searchParams.get('mtflpp_token');
        if (!token) throw new Error(strings.failed);
        // Isolated editors cannot inspect otherwise same-origin, non-isolated preview documents.
        if (window.crossOriginIsolated) url.searchParams.set('mtflpp_isolated', '1');
        cancel();
        // Capture only following iframe loads, even if the provided URL already contains the flag.
        url.searchParams.delete('mtflpp_source');
        if (view.followChanges) url.searchParams.set('mtflpp_source', '1');
        // Navigate natively so non-HTML output can use the browser's own viewer.
        report(strings.updating);
        return new Promise((resolve, reject) => {
            const frame = view.stage.ownerDocument.createElement('iframe');
            frame.title = strings.title;
            frame.className = 'mtflpp-frame mtflpp-loading';
            frame.setAttribute('aria-hidden', 'true');
            frame.setAttribute('tabindex', '-1');
            // Authorization is server-side; sandboxing would block native output such as Chromium's PDF viewer.
            frame.referrerPolicy = 'same-origin';
            let settled = false;
            let canceled = false;
            const timeout = setTimeout(() => finish(new Error(strings.failed)), 30000);
            const cancel = () => { canceled = true; finish(); };
            cancelLoad = cancel;
            function finish(error) {
                if (settled) return;
                settled = true;
                if (error) canceled = true;
                clearTimeout(timeout);
                if (cancelLoad === cancel) cancelLoad = null;
                if (frame !== activeFrame) {
                    frame.onload = null;
                    frame.onerror = null;
                    frame.remove();
                }
                if (error) reject(error);
                else resolve();
            }
            frame.onload = async () => {
                const replacing = frame !== activeFrame;
                if (!replacing) {
                    activeDocument = null;
                    followedTarget = null;
                }
                if (canceled || !isCurrent()) { finish(); return; }
                let doc;
                let destination;
                try {
                    const candidate = frame.contentDocument;
                    const marker = candidate?.querySelector('meta[name="meet-the-frontend-live-preview-panel"]');
                    if (marker?.content === token) doc = candidate;
                    else if (replacing && !marker) destination = redirectedHtmlPath(candidate, url);
                } catch { /* Cross-origin and browser-owned documents are not inspectable. */ }
                // Freeze following documents before preview-only styles; disabled loads need no snapshot.
                // The next following load establishes a fresh baseline without retroactively capturing old output.
                // Native navigation is not a new editor submission and receives no old hints.
                if (doc) {
                    if (view.followChanges) comparison.capture(doc, replacing ? comparisonValues : undefined);
                    // Keep page-boundary scrolling from moving the separate preview canvas.
                    doc.documentElement.style.setProperty('overscroll-behavior', 'contain', 'important');
                }
                let target;
                if (doc && replacing) {
                    scrolling.remember(activeDocument);
                    if (view.followChanges && followChanges() && activeDocument) target = comparison.findChange(activeDocument, doc);
                }
                if (replacing && activeFrame) {
                    activeFrame.onload = null;
                    activeFrame.onerror = null;
                    activeFrame.remove();
                }
                activeFrame = frame;
                activeDocument = doc;
                followedTarget = null;
                redirectDestination = destination;
                frame.classList.remove('mtflpp-loading');
                frame.removeAttribute('aria-hidden');
                frame.removeAttribute('tabindex');
                const isActive = () => !canceled && isCurrent() && frame === activeFrame && doc === activeDocument
                    && (!doc || frame.contentDocument === doc);
                let revealed;
                if (doc && replacing) {
                    revealed = await scrolling.restore(doc, target, () => isActive() && view.followChanges && followChanges());
                }
                if (!isActive()) { finish(); return; }
                followedTarget = revealed;
                // A load is not proof of valid content; only marked HTML receives scroll enhancements.
                report(strings.current, 'ready');
                finish();
            };
            frame.onerror = () => {
                if (frame === activeFrame) {
                    activeDocument = null;
                    followedTarget = null;
                    redirectDestination = undefined;
                    if (isCurrent()) report(strings.failed, 'error');
                } else finish(new Error(strings.failed));
            };
            frame.src = url.href;
            view.stage.append(frame);
        });
    }

    return {
        get hasPreview() { return !!activeFrame; },
        get hasHtmlPreview() { return !!activeDocument; },
        get redirectDestination() { return redirectDestination; },
        load,
        cancel,
        beforeViewportChange({ canvasTarget, canFollow, ...viewport }) {
            const target = followedTarget;
            const doc = activeDocument;
            const frame = activeFrame;
            if (!target || !doc) return;
            return scrolling.keepInView(target, {
                ...viewport,
                canvasTarget: (bounds) => canvasTarget(frame, bounds),
                canFollow: () => target === followedTarget && doc === activeDocument && frame.contentDocument === doc
                    && view.visible && view.followChanges && canFollow(),
            });
        },
        clear() {
            cancel();
            scrolling.remember(activeDocument);
            if (activeFrame) {
                activeFrame.onload = null;
                activeFrame.onerror = null;
            }
            activeFrame = null;
            activeDocument = null;
            followedTarget = null;
            redirectDestination = undefined;
            view.clearPreview();
        },
    };
}
