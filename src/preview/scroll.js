// Scroll presentation is independent of comparison state and editor values.
export function createPreviewScroll() {
    let position = 0;
    let restoration = 0;
    return {
        remember(doc) {
            try { if (doc) position = doc.defaultView.scrollY; }
            catch { /* Keep the last HTML offset if its document is no longer readable. */ }
        },
        async restore(doc, element, canFollow = () => true) {
            const version = ++restoration;
            try {
                const frameWindow = doc.defaultView;
                frameWindow.scrollTo({ top: position, left: 0, behavior: 'instant' });
                if (element?.ownerDocument === doc && canFollow()) {
                    // Give normal frontend initialization one rendering opportunity before inspecting
                    // native hiding. This is bounded, not a readiness guarantee for lazy widgets.
                    await presentationFrame(frameWindow);
                    if (version !== restoration || element.ownerDocument !== doc || !canFollow()) return;
                    if (revealAncestors(element, () => version === restoration && canFollow())) {
                        // Flush immediate owner updates (including beforematch microtasks), not arbitrary
                        // transitions or lazy loading. One task, then one scroll; never retry activation.
                        await new Promise((resolve) => frameWindow.setTimeout(resolve, 0));
                    }
                    if (version !== restoration || !canFollow()) return;
                    const target = element.ownerDocument === doc ? visibleTarget(element) : null;
                    if (target) revealChange(target);
                }
                position = frameWindow.scrollY;
            } catch { /* Displaying native output does not depend on HTML enhancements. */ }
        },
    };
}

function presentationFrame(win) {
    return new Promise((resolve) => {
        const finish = () => {
            win.clearTimeout(timeout);
            win.cancelAnimationFrame(frame);
            resolve();
        };
        // Background documents need a bound too: requestAnimationFrame may be suspended.
        const timeout = win.setTimeout(finish, 100);
        let frame = win.requestAnimationFrame(() => {
            frame = win.requestAnimationFrame(finish);
        });
    });
}

// Follow HTML's ancestor-reveal contracts, not inferred widget controls. beforematch is a
// notification: dispatching it does not ask the browser to remove hidden on our behalf.
function revealAncestors(element, canFollow) {
    const doc = element.ownerDocument;
    // Check the whole path before changing state: unreachable native content can otherwise
    // close a visible exclusive peer. until-found itself may use author display:none CSS.
    for (let node = element; node; node = node.parentElement) {
        if (node.getAttribute('hidden')?.toLowerCase() !== 'until-found'
            && (node.hasAttribute('hidden') || doc.defaultView.getComputedStyle(node).display === 'none')) return false;
    }
    let revealed = false;
    for (let node = element; node; node = node.parentElement) {
        if (!element.isConnected || element.ownerDocument !== doc || !canFollow()) break;
        if (node.getAttribute('hidden')?.toLowerCase() === 'until-found') {
            node.dispatchEvent(new doc.defaultView.Event('beforematch', { bubbles: true }));
            if (!element.isConnected || element.ownerDocument !== doc || !node.isConnected
                || node.ownerDocument !== doc || !node.contains(element) || !canFollow()) break;
            if (node.getAttribute('hidden')?.toLowerCase() === 'until-found') node.removeAttribute('hidden');
            revealed = true;
        }
        const parent = node.parentElement;
        if (parent instanceof doc.defaultView.HTMLDetailsElement && !parent.open) {
            const summary = Array.from(parent.children).find((child) => child.localName === 'summary');
            // A disclosure's own box and its first summary are already visible.
            if (node !== summary) {
                parent.open = true;
                revealed = true;
            }
        }
    }
    return revealed;
}

// Resolve only the identified element's presentation, never choose between unrelated changes.
function visibleTarget(element) {
    if (!element?.isConnected) return null;
    if (isVisible(element)) return element;
    for (const node of element.querySelectorAll('*')) {
        if (isVisible(node)) return node;
    }
    for (let node = element.parentElement; node; node = node.parentElement) {
        if (isVisible(node)) return node;
    }
    return null;
}

function isVisible(node) {
    return !!node?.getClientRects().length
        && (!node.checkVisibility || node.checkVisibility({ visibilityProperty: true }))
        && node.ownerDocument.defaultView.getComputedStyle(node).visibility === 'visible';
}

// Decide clearance up front: one native scroll, with no delayed adjustment or scroll listeners.
function revealChange(target) {
    const doc = target.ownerDocument;
    const win = doc.defaultView;
    const margin = win.getComputedStyle(target).scrollMarginTop;
    const header = visibleHeaderBottom(target);
    const viewportHeight = doc.documentElement.clientHeight;
    const padding = win.getComputedStyle(doc.documentElement);
    const paddingTop = scrollPaddingPixels(padding.scrollPaddingTop, viewportHeight);
    const paddingBottom = scrollPaddingPixels(padding.scrollPaddingBottom, viewportHeight);
    // Site padding and margin already contribute to clearance; do not add header height twice.
    const clearance = header > 0 && paddingTop !== null ? `max(${margin}, ${header - paddingTop}px)` : margin;
    const original = target.getAttribute('style');
    try {
        target.style.setProperty('scroll-margin-top', `calc(${clearance} + 1lh)`, 'important');
        const offsets = win.getComputedStyle(target);
        // Leave CSS math to native scrolling: unknown padding conservatively keeps the beginning visible.
        let block = 'start';
        if (paddingTop !== null && paddingBottom !== null) {
            const availableHeight = viewportHeight - paddingTop - paddingBottom
                - parseFloat(offsets.scrollMarginTop) - parseFloat(offsets.scrollMarginBottom);
            if (target.getBoundingClientRect().height <= availableHeight) block = 'center';
        }
        const behavior = win.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
        target.scrollIntoView({ behavior, block, inline: 'nearest' });
    } finally {
        // Restore exact styles through the attribute API before removing an originally absent attribute:
        // otherwise pending CSSOM changes can recreate it as style="".
        target.setAttribute('style', original ?? '');
        if (original === null) target.removeAttribute('style');
    }
}

function scrollPaddingPixels(value, height) {
    if (value === 'auto') return 0;
    const length = parseFloat(value);
    return Number.isFinite(length) ? length * (value.endsWith('%') ? height / 100 : 1) : null;
}

// Sample the viewport's top edge for a currently visible fixed/stuck header, not future header states.
function visibleHeaderBottom(target) {
    const doc = target.ownerDocument;
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    for (let node = doc.elementFromPoint(x, 1); node && !node.contains(target); node = node.parentElement) {
        const style = doc.defaultView.getComputedStyle(node);
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        const box = node.getBoundingClientRect();
        if (style.position === 'fixed' || box.top <= parseFloat(style.top) + 1) return box.bottom;
    }
    return 0;
}
