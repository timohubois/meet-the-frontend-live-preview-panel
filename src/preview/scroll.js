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
        async restore(doc, element, canFollow = () => true, canvasTarget) {
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
                        followChange(target, canvasTarget);
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
        // A layout can run several rounds of resize observers. Let the new breakpoint render
        // once before deciding whether its target is still visible or revealable.
        const win = target.ownerDocument.defaultView;
        await presentationFrame(win);
        if (!canFollow()) return;
        const { scrollX, scrollY } = win;
        const settled = whenSettled();
        if (settled) await settled;
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
        let frame = win.requestAnimationFrame(() => { frame = win.requestAnimationFrame(finish); });
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
    const initial = targetBounds(element, true);
    if (initial?.clipped) return element;
    if (!initial?.boundary) {
        for (const node of element.querySelectorAll('*')) {
            if (targetBounds(node, true)?.clipped) return node;
        }
    }
    for (let node = initial?.boundary || element.parentElement; node; ) {
        const presentation = targetBounds(node, true);
        if (presentation?.clipped) return node;
        // Scroll the clipping container itself, not a child that could move its internal viewport.
        node = presentation?.boundary || node.parentElement;
    }
    return null;
}

function targetBounds(target, forRefresh = false) {
    if (!isVisible(target, { visibilityProperty: true, opacityProperty: true })) return;
    const { left, right, top, bottom, width, height } = target.getBoundingClientRect();
    if (!forRefresh && (!width || !height)) return;
    const doc = target.ownerDocument;
    const { documentElement: root, body, defaultView: win } = doc;
    // The start of an emptied container is still a position. Test a one-pixel strip against the clips.
    const clipped = { left, right: width ? right : left + 1, top, bottom: height ? bottom : top + 1 };
    const reachable = { ...clipped };
    const extent = { x: clipped.right - clipped.left, y: clipped.bottom - clipped.top };
    // Accumulate clips before projecting into the canvas. A hard clip can only be
    // escaped if a scrollport inside it can move the target into the exposed area.
    const bodyOverflowIsViewport = win.getComputedStyle(root).overflow === 'visible';
    const targetStyle = win.getComputedStyle(target);
    for (let node = target; node && node !== root; ) {
        const style = node === target ? targetStyle : win.getComputedStyle(node);
        const { position, display, overflowX, overflowY } = style;
        if (node !== target && (node !== body || !bodyOverflowIsViewport)
            && display !== 'inline' && (overflowX !== 'visible' || overflowY !== 'visible')
            && node.offsetWidth && node.offsetHeight) {
            const { bounds, scaleX, scaleY } = overflowGeometry(node, style);
            for (const [axis, overflow, start, end, scale] of [
                ['x', overflowX, 'left', 'right', scaleX], ['y', overflowY, 'top', 'bottom', scaleY],
            ]) {
                if (overflow === 'visible') continue;
                const travel = overflow === 'clip' ? [0, 0] : scrollTravel(node, style, axis, scale);
                const hidden = forRefresh && overflow === 'hidden';
                const blockAxis = (axis === 'y') === (style.writingMode === 'horizontal-tb');
                // Alignment can pan even overflow:hidden, including when the box fits but its
                // scroll margin or the scrollport's padding would put it outside the alignment area.
                if (hidden && travel.some((amount) => amount)
                    && (blockAxis || clipped[start] < bounds[start] || clipped[end] > bounds[end]
                        || hasScrollInsets(style, targetStyle, axis))) return { boundary: node };
                if (!clipAxis(clipped, reachable, bounds, start, end, hidden ? [0, 0] : travel)) return { boundary: node };
                // Scrolling can move the reachable region, but cannot enlarge the part a clip lets through.
                extent[axis] = Math.min(extent[axis], reachable[end] - reachable[start]);
            }
        }
        // Positioned boxes escape overflow clips between them and their containing block.
        node = position === 'absolute' || position === 'fixed' ? node.offsetParent : node.parentElement;
    }
    return { clipped, extent };
}

function hasScrollInsets(scrollport, target, axis) {
    const edges = axis === 'x' ? ['Left', 'Right'] : ['Top', 'Bottom'];
    // Defer to the container for author insets rather than duplicating native alignment math.
    const nonzero = (value) => value && value !== 'auto' && parseFloat(value) !== 0;
    return edges.some((edge) => nonzero(scrollport[`scrollPadding${edge}`]) || nonzero(target[`scrollMargin${edge}`]));
}

function viewportTarget(target, canvasTarget, forRefresh = false) {
    // No presentation means scrolling cannot expose the target; no rects means it is off-screen.
    const bounds = targetBounds(target, forRefresh);
    if (!bounds?.clipped) return;
    const { clipped, extent } = bounds;
    const { ownerDocument: doc } = target;
    const root = doc.documentElement;
    clipped.left = Math.max(root.clientLeft, clipped.left);
    clipped.right = Math.min(root.clientLeft + root.clientWidth, clipped.right);
    clipped.top = Math.max(0, clipped.top);
    clipped.bottom = Math.min(root.clientHeight, clipped.bottom);
    if (clipped.right <= clipped.left) return { rects: [] };

    // Prefer the part of the target under the panel, but keep a horizontal sample
    // even when reflow moved it vertically off-screen and it needs scroll clearance.
    const projection = canvasTarget?.({ ...clipped, top: 0, bottom: root.clientHeight });
    const x = projection?.visibleCenterX ?? (clipped.left + clipped.right) / 2;
    const header = visibleHeaderAt(target, x);
    if (clipped.bottom <= clipped.top) return { rects: [], header: header?.bottom };
    const presentation = { rects: [clipped], inViewport: true, extent };
    if (!header) return presentation;
    const overlap = {
        left: Math.max(clipped.left, header.left), right: Math.min(clipped.right, header.right),
        top: Math.max(clipped.top, header.top), bottom: Math.min(clipped.bottom, header.bottom),
    };
    // A target stacked above the header is still visible. Only subtract a header
    // we can actually hit in the area where it overlaps the target.
    if (!hasArea(overlap) || !header.node.contains(doc.elementFromPoint(x, (overlap.top + overlap.bottom) / 2))) {
        return presentation;
    }
    const rects = [
        { ...clipped, top: overlap.bottom },
        { ...clipped, bottom: overlap.top },
        { ...overlap, left: clipped.left, right: overlap.left },
        { ...overlap, left: overlap.right, right: clipped.right },
    ].filter(hasArea);
    if (!rects.length && header.bottom >= root.clientHeight && header.top <= 0) return;
    return { rects, inViewport: true, extent, header: header.bottom };
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

function followChange(target, canvasTarget) {
    const presentation = viewportTarget(target, canvasTarget, true);
    if (!presentation?.inViewport) {
        revealChange(target);
        return;
    }
    const { rects, extent, header = 0 } = presentation;
    const root = target.ownerDocument.documentElement;
    const requiredWidth = Math.min(extent.x, root.clientWidth);
    const requiredHeight = Math.min(extent.y, root.clientHeight - header);
    // A large target can already fill the usable viewport. Tolerate subpixel clipping.
    if (rects.some((rect) => rect.right - rect.left >= requiredWidth - 1
        && rect.bottom - rect.top >= requiredHeight - 1)) {
        // In cropped zoom modes the page can already show the edit while the panel still clips it.
        if (canvasTarget) canvasFragment(presentation, canvasTarget)?.reveal(followMotion(target.ownerDocument.defaultView));
        return;
    }
    revealChange(target, { nearest: true, header });
}

function followMotion(win) {
    return win.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}

// Decide clearance up front: at most one native scroll, with no delayed adjustment or scroll listeners.
function revealChange(target, { behavior, header = visibleHeaderBottom(target), nearest = false } = {}) {
    const doc = target.ownerDocument;
    const win = doc.defaultView;
    const motion = behavior ?? followMotion(win);
    if (nearest && !header) {
        target.scrollIntoView({ behavior: motion, block: 'nearest', inline: 'nearest' });
        return;
    }
    const margin = win.getComputedStyle(target).scrollMarginTop;
    const root = doc.documentElement;
    const viewportHeight = root.clientHeight;
    const padding = win.getComputedStyle(root);
    const paddingTop = scrollPaddingPixels(padding.scrollPaddingTop, viewportHeight);
    const paddingBottom = scrollPaddingPixels(padding.scrollPaddingBottom, viewportHeight);
    let originalRoot, originalTarget;
    try {
        let block = nearest ? 'nearest' : 'start';
        if (nearest) {
            // Clear the page header without imposing its height on inner scrollports.
            const neededPadding = header - parseFloat(margin);
            if (paddingTop !== null && neededPadding > paddingTop) {
                originalRoot = root.getAttribute('style');
                root.style.setProperty('scroll-padding-top', `${neededPadding}px`, 'important');
            }
        } else {
            // Site padding and margin already contribute to clearance; do not add header height twice.
            const clearance = header > 0 && paddingTop !== null ? `max(${margin}, ${header - paddingTop}px)` : margin;
            originalTarget = target.getAttribute('style');
            target.style.setProperty('scroll-margin-top', `calc(${clearance} + 1lh)`, 'important');
        }
        // Leave CSS math to native scrolling: unknown padding conservatively keeps the beginning visible.
        if (!nearest && paddingTop !== null && paddingBottom !== null) {
            const offsets = win.getComputedStyle(target);
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
        target.scrollIntoView({ behavior: motion, block, inline: 'nearest' });
    } finally {
        if (originalRoot !== undefined) restoreInlineStyle(root, originalRoot);
        if (originalTarget !== undefined) restoreInlineStyle(target, originalTarget);
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
