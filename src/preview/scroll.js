// Scroll presentation is independent of comparison state and editor values.
export function createPreviewScroll() {
    let position = 0;
    let restoration = 0;
    let pendingViewport;
    return {
        remember(doc) {
            try { if (doc) position = doc.defaultView.scrollY; }
            catch { /* Keep the last HTML offset if its document is no longer readable. */ }
        },
        async restore(doc, element, canFollow = () => true) {
            const version = ++restoration;
            try {
                const frameWindow = doc.defaultView;
                let followed;
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
                    if (target) {
                        revealChange(target);
                        // A broad ancestor is a fallback for the initial follow, not a breakpoint anchor.
                        if (element.contains(target)) followed = target;
                    }
                }
                position = frameWindow.scrollY;
                return followed;
            } catch { /* Displaying native output does not depend on HTML enhancements. */ }
        },
        keepInView(target, { canvas, canvasTarget, whenSettled, finishMotion, canvasWasPanned, canFollow }) {
            try {
                // An intermediate layout may already have moved the anchor out of view.
                const continuing = pendingViewport?.target === target && pendingViewport.canFollow();
                pendingViewport?.cancel();
                if (!target.isConnected || !canFollow()) return;
                if (!continuing) {
                    const presentation = viewportTarget(target, canvasTarget);
                    if (!canvasFragment(presentation, canvasTarget)?.visible) return;
                }
                const controller = new AbortController();
                const request = {
                    target,
                    canFollow: () => !controller.signal.aborted && canFollow(),
                    cancel() {
                        controller.abort();
                        if (pendingViewport === request) pendingViewport = null;
                    },
                };
                pendingViewport = request;
                watchScrollInput(target.ownerDocument.defaultView, canvas, canvasWasPanned, controller.signal, () => {
                    request.cancel();
                    // The camera also writes the canvas offsets while animating.
                    finishMotion?.();
                });
                // A pending check lets the viewport keep its current pan instead of resetting it.
                return keepTargetInView(target, canvasTarget, whenSettled, request.canFollow).finally(request.cancel);
            } catch { /* Resizing still works if the iframe is no longer readable. */ }
        },
    };
}

const scrollKeys = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', ' ']);

function watchScrollInput(frameWindow, canvas, canvasWasPanned, signal, cancel) {
    const interrupt = (event) => {
        if (event.isTrusted && (event.type !== 'keydown' || scrollKeys.has(event.key))) cancel();
    };
    const options = { capture: true, passive: true, signal };
    for (const surface of [frameWindow, canvas]) {
        for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) surface?.addEventListener(type, interrupt, options);
    }
    // Native scrollbar drags may not deliver a DOM pointer event. Ignore the camera's own scrolling.
    canvas?.addEventListener('scroll', () => { if (canvasWasPanned?.()) cancel(); }, options);
}

async function keepTargetInView(target, canvasTarget, whenSettled, canFollow) {
    try {
        // Let the iframe reflow and wait until the camera won't overwrite the canvas pan.
        const win = target.ownerDocument.defaultView;
        await presentationFrame(win);
        if (!canFollow()) return;
        const { scrollX, scrollY } = win;
        await whenSettled();
        // Also respect new page scroll offsets during the camera wait (e.g. a native scrollbar drag).
        if (!canFollow() || win.scrollX !== scrollX || win.scrollY !== scrollY) return;
        let presentation = viewportTarget(target, canvasTarget);
        if (presentation && !presentation.rects.length) {
            revealChange(target, { behavior: 'instant', header: presentation.header });
            presentation = viewportTarget(target, canvasTarget);
        }
        canvasFragment(presentation, canvasTarget)?.reveal();
    } catch { /* The same element or iframe may no longer be available. */ }
}

function canvasFragment(presentation, canvasTarget) {
    let closest;
    for (const rect of presentation?.rects ?? []) {
        const candidate = canvasTarget(rect);
        if (candidate.visible) return candidate;
        if (!closest || candidate.distance < closest.distance) closest = candidate;
    }
    return closest;
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

function viewportTarget(target, canvasTarget) {
    // No presentation means scrolling cannot expose the target; no rects means it is off-screen.
    if (!isVisible(target, { visibilityProperty: true, opacityProperty: true })) return;
    const { left, right, top, bottom, width, height } = target.getBoundingClientRect();
    if (!width || !height) return;
    const doc = target.ownerDocument;
    const { documentElement: root, body, defaultView: win } = doc;
    const clipped = { left, right, top, bottom };
    const reachable = { ...clipped };
    // Accumulate clips before projecting into the canvas. A hard clip can only be
    // escaped if a scrollport inside it can move the target into the exposed area.
    const bodyOverflowIsViewport = win.getComputedStyle(root).overflow === 'visible';
    for (let node = target; node && node !== root; ) {
        const style = win.getComputedStyle(node);
        const { position, display, overflowX, overflowY } = style;
        if (node !== target && (node !== body || !bodyOverflowIsViewport)
            && display !== 'inline' && (overflowX !== 'visible' || overflowY !== 'visible')
            && node.offsetWidth && node.offsetHeight) {
            const { bounds, scaleX, scaleY } = overflowGeometry(node, style);
            if (overflowX !== 'visible' && !clipAxis(clipped, reachable, bounds, 'left', 'right',
                overflowX === 'clip' ? [0, 0] : scrollTravel(node, style, 'x', scaleX))) return;
            if (overflowY !== 'visible' && !clipAxis(clipped, reachable, bounds, 'top', 'bottom',
                overflowY === 'clip' ? [0, 0] : scrollTravel(node, style, 'y', scaleY))) return;
        }
        // Positioned boxes escape overflow clips between them and their containing block.
        node = position === 'absolute' || position === 'fixed' ? node.offsetParent : node.parentElement;
    }
    clipped.left = Math.max(root.clientLeft, clipped.left);
    clipped.right = Math.min(root.clientLeft + root.clientWidth, clipped.right);
    clipped.top = Math.max(0, clipped.top);
    clipped.bottom = Math.min(root.clientHeight, clipped.bottom);
    if (clipped.right <= clipped.left) return { rects: [] };

    // Prefer the part of the target under the panel, but keep a horizontal sample
    // even when reflow moved it vertically off-screen and it needs scroll clearance.
    const { visibleCenterX } = canvasTarget({ ...clipped, top: 0, bottom: root.clientHeight });
    const x = visibleCenterX ?? (clipped.left + clipped.right) / 2;
    const header = visibleHeaderAt(target, x);
    if (clipped.bottom <= clipped.top) return { rects: [], header: header?.bottom };
    if (!header) return { rects: [clipped] };
    const overlap = {
        left: Math.max(clipped.left, header.left), right: Math.min(clipped.right, header.right),
        top: Math.max(clipped.top, header.top), bottom: Math.min(clipped.bottom, header.bottom),
    };
    // A target stacked above the header is still visible. Only subtract a header
    // we can actually hit in the area where it overlaps the target.
    if (!hasArea(overlap) || !header.node.contains(doc.elementFromPoint(x, (overlap.top + overlap.bottom) / 2))) {
        return { rects: [clipped] };
    }
    const rects = [
        { ...clipped, top: overlap.bottom },
        { ...clipped, bottom: overlap.top },
        { ...overlap, left: clipped.left, right: overlap.left },
        { ...overlap, left: overlap.right, right: clipped.right },
    ].filter(hasArea);
    if (!rects.length && header.bottom >= root.clientHeight && header.top <= 0) return;
    return { rects, header: header.bottom };
}

function hasArea({ left, right, top, bottom }) {
    return right > left && bottom > top;
}

function clipAxis(clipped, reachable, bounds, start, end, [minShift, maxShift]) {
    clipped[start] = Math.max(clipped[start], bounds[start]);
    clipped[end] = Math.min(clipped[end], bounds[end]);
    // The outer clip only sees positions the inner scrollports can reach from here.
    reachable[start] = Math.max(bounds[start], reachable[start] + minShift);
    reachable[end] = Math.min(bounds[end], reachable[end] + maxShift);
    return reachable[end] > reachable[start];
}

function scrollTravel(node, style, axis, scale) {
    const horizontal = axis === 'x';
    const range = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
    if (range <= 0) return [0, 0];
    const offset = horizontal ? node.scrollLeft : node.scrollTop;
    const reverseFlex = style.display.endsWith('flex') && style.flexDirection === (horizontal ? 'row-reverse' : 'column-reverse');
    const reverse = (horizontal && style.direction === 'rtl') !== reverseFlex;
    let min = reverse ? -range : 0;
    let max = reverse ? 0 : range;
    // If the origin is ambiguous, do not rule out a potentially reachable target.
    if (style.writingMode !== 'horizontal-tb' || offset < min || offset > max) {
        min = -range;
        max = range;
    }
    return [(offset - max) * scale, (offset - min) * scale];
}

function overflowGeometry(node, style) {
    const box = node.getBoundingClientRect();
    const scaleX = box.width / node.offsetWidth, scaleY = box.height / node.offsetHeight;
    const left = box.left + node.clientLeft * scaleX, top = box.top + node.clientTop * scaleY;
    const bounds = { left, top, right: left + node.clientWidth * scaleX, bottom: top + node.clientHeight * scaleY };
    const margin = style.overflowClipMargin;
    if ((style.overflowX !== 'clip' && style.overflowY !== 'clip') || !margin || margin === '0px') {
        return { bounds, scaleX, scaleY };
    }
    const amount = margin.split(' ').map(parseFloat).find(Number.isFinite) ?? 0;
    const origin = margin.includes('border-box') ? box : bounds;
    const content = margin.includes('content-box');
    return {
        scaleX, scaleY,
        bounds: {
            left: origin.left + ((content ? parseFloat(style.paddingLeft) : 0) - amount) * scaleX,
            right: origin.right - ((content ? parseFloat(style.paddingRight) : 0) - amount) * scaleX,
            top: origin.top + ((content ? parseFloat(style.paddingTop) : 0) - amount) * scaleY,
            bottom: origin.bottom - ((content ? parseFloat(style.paddingBottom) : 0) - amount) * scaleY,
        },
    };
}

function isVisible(node, options = { visibilityProperty: true }) {
    return !!node?.isConnected && !!node.getClientRects().length
        && (!node.checkVisibility || node.checkVisibility(options))
        && node.ownerDocument.defaultView.getComputedStyle(node).visibility === 'visible';
}

// Decide clearance up front: one native scroll, with no delayed adjustment or scroll listeners.
function revealChange(target, { behavior, header = visibleHeaderBottom(target) } = {}) {
    const doc = target.ownerDocument;
    const win = doc.defaultView;
    const margin = win.getComputedStyle(target).scrollMarginTop;
    const root = doc.documentElement;
    const viewportHeight = root.clientHeight;
    const padding = win.getComputedStyle(root);
    const paddingTop = scrollPaddingPixels(padding.scrollPaddingTop, viewportHeight);
    const paddingBottom = scrollPaddingPixels(padding.scrollPaddingBottom, viewportHeight);
    // Site padding and margin already contribute to clearance; do not add header height twice.
    const clearance = header > 0 && paddingTop !== null ? `max(${margin}, ${header - paddingTop}px)` : margin;
    const original = target.getAttribute('style');
    let originalRoot;
    try {
        target.style.setProperty('scroll-margin-top', `calc(${clearance} + 1lh)`, 'important');
        const offsets = win.getComputedStyle(target);
        // Leave CSS math to native scrolling: unknown padding conservatively keeps the beginning visible.
        let block = 'start';
        if (paddingTop !== null && paddingBottom !== null) {
            const availableHeight = viewportHeight - paddingTop - paddingBottom
                - parseFloat(offsets.scrollMarginTop) - parseFloat(offsets.scrollMarginBottom);
            const freeHeight = availableHeight - target.getBoundingClientRect().height;
            if (freeHeight >= 0) block = 'center';
            if (freeHeight > 0 && padding.writingMode === 'horizontal-tb') {
                // Bias the viewport's center toward its upper third without clipping the target.
                // Apply the bias to the root so nested scrollports retain their own alignment.
                const bias = Math.min(availableHeight / 3, freeHeight);
                originalRoot = root.getAttribute('style');
                root.style.setProperty('scroll-padding-bottom', `${paddingBottom + bias}px`, 'important');
            }
        }
        const motion = behavior ?? (win.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');
        target.scrollIntoView({ behavior: motion, block, inline: 'nearest' });
    } finally {
        if (originalRoot !== undefined) restoreInlineStyle(root, originalRoot);
        restoreInlineStyle(target, original);
    }
}

function restoreInlineStyle(element, original) {
    // Flush pending CSSOM changes so they cannot recreate an absent attribute as style="".
    element.setAttribute('style', original ?? '');
    if (original === null) element.removeAttribute('style');
}

function scrollPaddingPixels(value, height) {
    if (value === 'auto') return 0;
    const length = parseFloat(value);
    return Number.isFinite(length) ? length * (value.endsWith('%') ? height / 100 : 1) : null;
}

function visibleHeaderBottom(target) {
    const rect = target.getBoundingClientRect();
    return visibleHeaderAt(target, rect.left + rect.width / 2)?.bottom ?? 0;
}

// Sample the viewport's top edge for a currently visible fixed/stuck header, not future header states.
function visibleHeaderAt(target, x) {
    const doc = target.ownerDocument;
    for (let node = doc.elementFromPoint(x, 1); node && !node.contains(target); node = node.parentElement) {
        const style = doc.defaultView.getComputedStyle(node);
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        // Transparent headers can still win hit testing, but do not obscure the target.
        if (style.opacity === '0' || !isVisible(node, { visibilityProperty: true, opacityProperty: true })) continue;
        const { left, right, top, bottom } = node.getBoundingClientRect();
        if (style.position === 'fixed' || top <= parseFloat(style.top) + 1) return { node, left, right, top, bottom };
    }
}
