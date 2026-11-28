import { select, dispatch } from '@wordpress/data';
import { store as preferencesStore } from '@wordpress/preferences';
import { createPreviewControls, createPreviewLauncher } from './controls.js';
import { createPreviewViewport } from './viewport.js';
import { createPanelGeometry } from './geometry.js';

// Bind the PHP-rendered panel. Never capture fields, fetch previews, acquire locks or control native saves.
export function createPreviewPanel(strings, {
    postTitle = '', publicRedirect, inlineLauncher, nativeLauncher, canRememberVisibility = true,
    onOpen, onClose, onRefresh, onRetry, beforeMove, afterMove, beforeViewportChange,
}) {
    const mainWindow = window;
    const mainDocument = document;
    const scope = 'meet-the-frontend-live-preview-panel';
    const preferences = select(preferencesStore);
    const preferenceActions = dispatch(preferencesStore);
    // The old 'window' fit was capped at 100%. A new key distinguishes it from
    // the now-uncapped Fit to window without changing saved users' viewing behavior.
    const defaultFit = preferences.get(scope, 'fit') === 'width' ? 'width' : 'automatic';
    preferenceActions.setDefaults(scope, {
        rememberVisibility: true, rememberPosition: true, panelOpen: true, scrollToChanges: true, viewport: 'desktop',
        fitMode: defaultFit, customZoom: 100, tabletOrientation: 'portrait', mobileOrientation: 'portrait',
    });
    const floatingLauncherAvailable = () => !inlineLauncher && (!nativeLauncher || nativeLauncher.fallbackMedia.matches);
    let rememberVisibility = preferences.get(scope, 'rememberVisibility') !== false;
    let rememberPosition = preferences.get(scope, 'rememberPosition') !== false;
    let followChanges = preferences.get(scope, 'scrollToChanges') !== false;
    const launcherContainer = inlineLauncher?.parentElement ?? mainDocument.getElementById('mtflpp-toggle');
    const panel = mainDocument.getElementById('mtflpp-panel');
    if (!launcherContainer || !panel) throw new Error('Preview panel markup is missing.');
    const launcher = inlineLauncher || createPreviewLauncher(launcherContainer);

    const move = panel.querySelector('.mtflpp-move-control');
    const resize = panel.querySelector('.mtflpp-resize');
    const resizeEdges = panel.querySelectorAll('[data-resize-edge]');
    const header = panel.querySelector('.mtflpp-header');
    const caption = panel.querySelector('.mtflpp-caption');
    const viewport = panel.querySelector('.mtflpp-viewport');
    const canvas = panel.querySelector('.mtflpp-canvas');
    const stage = panel.querySelector('.mtflpp-stage');
    const empty = panel.querySelector('.mtflpp-empty');
    const devicebar = panel.querySelector('.mtflpp-devicebar');
    const dimensions = panel.querySelector('.mtflpp-dimensions');
    const feedback = panel.querySelector('.mtflpp-feedback');
    const status = panel.querySelector('[role="status"]');
    let controls;
    const responsiveViewport = createPreviewViewport(viewport, stage, dimensions, {
        device: preferences.get(scope, 'viewport'), fit: preferences.get(scope, 'fitMode') ?? defaultFit,
        customZoom: preferences.get(scope, 'customZoom'),
        tabletOrientation: preferences.get(scope, 'tabletOrientation'), mobileOrientation: preferences.get(scope, 'mobileOrientation'),
    }, () => syncControls(), strings);

    const editorWrap = mainDocument.querySelector('#wpbody-content > .wrap');
    const adminBar = mainDocument.getElementById('wpadminbar');
    function area(free = false) {
        // Fixed coordinates use the layout viewport, excluding any scrollbar. Read the editor's
        // outer gutter rather than duplicating WordPress's responsive LTR/RTL spacing rules.
        const width = Math.max(1, mainDocument.documentElement.clientWidth);
        const height = Math.max(1, mainDocument.documentElement.clientHeight);
        // RTL scrollbars can shift the fixed-position viewport's physical origin.
        const origin = mainDocument.documentElement.getBoundingClientRect().left + mainWindow.scrollX;
        const wrap = !free && editorWrap?.getBoundingClientRect();
        const gutter = wrap ? Math.max(0, mainWindow.getComputedStyle(editorWrap).direction === 'rtl'
            ? wrap.left - origin : origin + width - wrap.right) : 20;
        const gap = free ? 0 : gutter;
        const left = Math.min(gap, (width - 1) / 2);
        const top = Math.min(Math.max(0, adminBar?.getBoundingClientRect().bottom || 0) + gap, height - 1);
        const right = width - left;
        const bottom = height - Math.min(gap, height - top - 1);
        return { left, top, right, bottom, width: right - left, height: bottom - top };
    }

    let visible = canRememberVisibility && (!rememberVisibility || preferences.get(scope, 'panelOpen') !== false);
    let suspended = false;
    let pipWindow;
    const savedLayout = preferences.get(scope, 'layout');
    // Older layouts retain their last preset in the dock or, after dragging, the shared anchor.
    const savedPosition = preferences.get(scope, 'position') ?? savedLayout?.dock ?? savedLayout?.anchor;
    let position = ['left', 'center', 'right'].includes(savedPosition) ? savedPosition : 'right';
    const geometry = createPanelGeometry(rememberPosition ? savedLayout : undefined, area, position);
    const { compactRect, usableEdge } = geometry;
    let takeOverAction = false;
    let windowNotice = '';
    let checkedPublicRedirect = false;
    let publicRedirectDestination;
    let current = {
        text: strings.loading, state: 'loading', hasPreview: false, canRetry: false, reason: '',
    };
    let launcherDragClick = false;
    function setTitle(value) {
        // Plain text, not an editor field or a full-width focus/drag button.
        const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
        caption.textContent = title ? `${strings.preview} — ${title}` : strings.title;
        caption.title = caption.textContent;
        if (pipWindow) pipWindow.document.title = caption.textContent;
    }
    setTitle(postTitle);

    function presentation() {
        const { text, state, hasPreview, reason } = current;
        if (state === 'handover') {
            return { heading: text, description: '', note: strings.tabEdits };
        }
        if (state === 'conflict') {
            const description = {
                'handed-off': strings.handedOffHelp,
                busy: strings.takeoverTimeoutHelp,
                manual: strings.closeOtherHelp,
            }[reason] || '';
            const note = reason === 'manual' ? strings.manualSwitchHint : strings.tabEdits;
            return { heading: text, description, note };
        }
        if (state === 'paused') {
            return { heading: strings.pausedTitle, description: text, note: '' };
        }
        if (state === 'error') return errorPresentation();
        if (!hasPreview) return { heading: strings.loading, description: strings.preparing, note: '' };
        return { heading: text, description: '', note: '' };
    }

    function errorPresentation() {
        const { text, hasPreview, canRetry, reason } = current;
        if (reason === 'origin-mismatch') {
            return {
                heading: strings.originMismatchTitle,
                description: hasPreview ? `${text} ${strings.previousPreview}` : text,
                note: '',
            };
        }
        if (reason === 'unavailable' || reason === 'browser') {
            const heading = reason === 'unavailable' ? strings.unavailableTitle : strings.browserTitle;
            return { heading, description: text, note: '' };
        }
        if (reason === 'reload') {
            return { heading: hasPreview ? strings.stopped : strings.couldNotStart, description: strings.reloadEditor, note: '' };
        }
        if (reason === 'reload-before-save' || reason === 'unconfirmed') {
            const description = reason === 'reload-before-save' ? strings.nativePreviewAcfReload : strings.reloadEditor;
            return { heading: text, description, note: '' };
        }
        if (hasPreview) {
            return {
                heading: canRetry || text === strings.failed ? strings.refreshFailed : text,
                description: strings.previousPreview,
                note: '',
            };
        }
        if (canRetry) return { heading: strings.failed, description: strings.failedHelp, note: '' };
        return { heading: strings.failed, description: text === strings.failed ? '' : text, note: '' };
    }

    function restoreFocus(focused, wasInside) {
        if (!focused || !wasInside) return;
        if (panel.contains(focused) && !focused.closest('[hidden]') && !focused.disabled
            && (current.hasPreview || !canvas.contains(focused))) return;
        controls.focus(empty.hidden ? 'actions' : 'empty-title');
    }

    function retryLabel() {
        if (current.reason === 'manual') return strings.startPreview;
        if (!takeOverAction) return strings.retry;
        return current.state === 'handover' ? strings.takingOver : strings.takeOver;
    }

    function noticeSeverity(problem) {
        if (!problem || ['handover', 'paused'].includes(current.state)) return 'info';
        return current.state === 'error' && !current.canRetry ? 'error' : 'warning';
    }

    function redirectMessage() {
        if (current.redirectDestination) return `${strings.redirected} ${current.redirectDestination}`;
        if (current.hasHtmlPreview && publicRedirectDestination) {
            return `${strings.publicRedirected} ${publicRedirectDestination}`;
        }
        return '';
    }

    async function checkPublicRedirect() {
        if (!publicRedirect || checkedPublicRedirect) return;
        checkedPublicRedirect = true;
        try {
            const endpoint = new URL(publicRedirect.endpoint);
            if (endpoint.origin !== mainWindow.location.origin) return;
            const response = await mainWindow.fetch(endpoint, {
                credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-WP-Nonce': publicRedirect.nonce },
            });
            if (!response.ok) return;
            const { destination } = await response.json();
            if (typeof destination !== 'string' || !destination) return;
            publicRedirectDestination = destination;
            if (!visible) return;
            syncControls();
            if (current.state === 'ready' && current.hasHtmlPreview && !current.redirectDestination && !windowNotice) {
                status.textContent = redirectMessage();
            }
        } catch { /* Public routing is advisory; unavailable checks don't affect the preview. */ }
    }

    function feedbackState() {
        const { state, hasPreview, canRetry, reason } = current;
        const problem = hasPreview && ['error', 'conflict', 'handover', 'paused'].includes(state);
        const redirect = hasPreview && !problem && !windowNotice ? redirectMessage() : '';
        feedback.hidden = !problem && !windowNotice && !redirect;
        feedback.tabIndex = feedback.hidden ? -1 : 0;
        panel.dataset.hasFeedback = String(!feedback.hidden);
        if (feedback.hidden) return null;
        if (redirect) return { heading: redirect, status: 'info', dismissible: false };
        const { heading, description } = presentation();
        return {
            heading: problem ? heading : windowNotice,
            description: problem ? description : strings.windowNoticeHelp,
            status: noticeSeverity(problem),
            dismissible: !problem,
            retry: problem && (takeOverAction || (canRetry && ['error', 'conflict'].includes(state))),
            close: problem && state === 'error' && !canRetry && !['reload', 'reload-before-save', 'unconfirmed'].includes(reason),
            disabled: state === 'handover',
            action: retryLabel(),
        };
    }

    // A failed window operation must not change preview ownership, readiness or refresh controls.
    function showWindowNotice(text) {
        if (!(current.hasPreview && ['error', 'conflict', 'handover', 'paused'].includes(current.state))) {
            windowNotice = text;
            syncControls();
        }
        status.textContent = `${text} ${strings.windowNoticeHelp}`;
    }

    function clearWindowNotice() {
        windowNotice = '';
        syncControls();
    }

    function report(text, state = 'loading', {
        canTakeOver = false, hasPreview = false, hasHtmlPreview = false, redirectDestination,
        canRefresh = false, canRetry = true, reason = '',
    } = {}) {
        const focused = panel.ownerDocument.activeElement;
        const wasInside = panel.contains(focused);
        const resetEmptyScroll = !hasPreview && (current.state !== state || current.text !== text || current.reason !== reason);
        const previewChanged = current.hasPreview !== hasPreview;
        current = { text, state, canTakeOver, hasPreview, hasHtmlPreview, redirectDestination, canRefresh, canRetry, reason };
        if (['error', 'conflict', 'handover', 'paused'].includes(state)) windowNotice = '';
        panel.dataset.state = state;
        panel.dataset.hasPreview = String(hasPreview);
        takeOverAction = canTakeOver && ['conflict', 'handover'].includes(state);
        empty.hidden = hasPreview;
        devicebar.hidden = !hasPreview;
        const { heading, description, note } = presentation();
        if (resetEmptyScroll) empty.scrollTop = 0;
        const redirect = state === 'ready' && !windowNotice ? redirectMessage() : '';
        // Placeholder announces its instructions; the live region supplies the heading without repeating them.
        const announcement = hasPreview ? [heading, description, note, redirect].filter(Boolean).join(' ') : heading;
        if (status.textContent !== announcement) status.textContent = announcement;
        syncControls();
        if (previewChanged) responsiveViewport.layout();
        restoreFocus(focused, wasInside);
        if (visible && state === 'ready' && hasHtmlPreview && !redirectDestination) checkPublicRedirect();
    }

    function toggleFollow() {
        followChanges = !followChanges;
        preferenceActions.set(scope, 'scrollToChanges', followChanges);
        syncControls();
        // Seed the baseline now, not with the next edit; existing loads/recovery retain their refresh gate.
        if (followChanges && current.canRefresh) onRefresh(false);
    }

    function rememberPanelVisibility(value) {
        if (canRememberVisibility && rememberVisibility && preferences.get(scope, 'panelOpen') !== value) {
            preferenceActions.set(scope, 'panelOpen', value);
        }
    }

    function toggleRememberVisibility() {
        rememberVisibility = !rememberVisibility;
        preferenceActions.set(scope, 'rememberVisibility', rememberVisibility);
        // Re-enabling adopts the current panel, rather than an older hidden state.
        if (rememberVisibility) rememberPanelVisibility(visible);
        syncControls();
    }

    function rememberLayout() {
        if (rememberPosition) preferenceActions.set(scope, 'layout', geometry.layout);
    }

    function toggleRememberPosition() {
        rememberPosition = !rememberPosition;
        preferenceActions.set(scope, 'rememberPosition', rememberPosition);
        if (rememberPosition) rememberLayout();
        else {
            // Keep the chosen preset, including one inherited from an older layout, but discard custom geometry.
            preferenceActions.set(scope, 'position', position);
            preferenceActions.set(scope, 'layout', undefined);
        }
        syncControls();
    }

    function launcherRect() {
        // Initial markup and a just-closed panel still hide the launcher. Measure its real label
        // and CSS size synchronously before revealing it at the fitted position.
        const hidden = launcherContainer.hidden;
        launcherContainer.hidden = false;
        launcherContainer.style.maxWidth = `${area(!geometry.dock).width}px`;
        const size = { width: launcherContainer.offsetWidth, height: launcherContainer.offsetHeight };
        launcherContainer.hidden = hidden;
        return geometry.launcherRect(size);
    }

    function draw() {
        if (pipWindow) return;
        if (!visible && floatingLauncherAvailable()) {
            const rect = launcherRect();
            const factor = geometry.anchorFactor;
            Object.assign(launcherContainer.style, {
                left: `${rect.x + rect.width * factor}px`, top: `${rect.y + rect.height}px`,
                transform: `translate(${-100 * factor}%, -100%)`,
            });
        }
        let rect = compactRect();
        panel.dataset.anchor = geometry.anchor;
        if (geometry.expanded) {
            const available = area();
            rect = { x: available.left, y: available.top, width: available.width, height: available.height };
        }
        Object.assign(panel.style, {
            left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, transform: '',
        });
    }

    function dockWindow(side = 'right', resetSize = false) {
        geometry.dockTo(side, resetSize);
        position = side;
        preferenceActions.set(scope, 'position', position);
        draw();
        rememberLayout();
        syncControls();
    }

    function supportsPip() {
        return typeof mainWindow.documentPictureInPicture?.requestWindow === 'function';
    }

    function modeLabel(fullscreen) {
        if (fullscreen) return strings.exitFullscreen;
        return geometry.expanded ? strings.compact : strings.expand;
    }

    function syncControls() {
        if (!controls) return;
        const full = panel.ownerDocument.fullscreenElement === panel;
        const inPage = !pipWindow && !full;
        const movable = inPage && !geometry.expanded;
        panel.classList.toggle('mtflpp-expanded', geometry.expanded);
        resize.hidden = !movable;
        for (const edge of resizeEdges) edge.hidden = !movable || !usableEdge(edge.dataset.resizeEdge);
        const retry = takeOverAction || (current.canRetry && ['error', 'conflict'].includes(current.state));
        controls.update({
            inPage, inPip: !!pipWindow, movable, dock: geometry.dock,
            canRememberVisibility, rememberVisibility, rememberPosition, followChanges, device: responsiveViewport.device,
            busy: current.hasPreview && ['stale', 'loading'].includes(current.state) && current.text !== strings.saving,
            empty: current.hasPreview ? null : {
                ...presentation(), busy: ['loading', 'stale', 'ready', 'handover'].includes(current.state),
                icon: ['paused', 'conflict'].includes(current.state) || ['unavailable', 'browser', 'origin-mismatch'].includes(current.reason) ? 'info' : 'warning',
                retry, disabled: current.state === 'handover', close: current.state === 'error' && !retry,
                action: retryLabel(),
            },
            notice: feedbackState(),
            fit: responsiveViewport.fit, orientation: responsiveViewport.orientation,
            customZoom: responsiveViewport.customZoom, zoomPercent: responsiveViewport.zoomPercent, dpr: responsiveViewport.dpr,
            canRefresh: current.canRefresh, hasPreview: current.hasPreview,
            canPip: inPage && supportsPip(),
            canFullscreen: inPage && !!mainDocument.fullscreenEnabled,
            mode: full || geometry.expanded ? 'compact' : 'expand',
            modeLabel: modeLabel(full),
        });
    }

    function toggleMode() {
        controls.closeMenu();
        if (pipWindow) {
            pipWindow.close();
            return;
        }
        if (mainDocument.fullscreenElement === panel) {
            mainDocument.exitFullscreen().then(clearWindowNotice, () => showWindowNotice(strings.fullscreenFailed));
            return;
        }
        geometry.toggleExpanded();
        draw();
        rememberLayout();
        syncControls();
        controls.focus('mode');
    }

    header.addEventListener('dblclick', (event) => {
        if (!pipWindow && !event.target.closest('button, a')) toggleMode();
    });
    async function enterFullscreen() {
        if (suspended || pipWindow || !mainDocument.fullscreenEnabled) return;
        controls.closeMenu();
        try {
            await panel.requestFullscreen();
            if (suspended) {
                returnToEditor();
                return;
            }
            clearWindowNotice();
            controls.focus('mode');
        } catch {
            if (suspended) return;
            controls.focus('actions');
            showWindowNotice(strings.fullscreenFailed);
        }
    }
    mainDocument.addEventListener('fullscreenchange', syncControls);

    // Move the visible panel with a compositor transform. Hidden-panel/launcher layout and resizing are batched.
    function geometryControl(control, resizing = false, edge) {
        const isLauncher = control === launcher;
        const isHeader = control === header;
        const resizeEdge = () => edge || (geometry.anchor === 'left' ? 'ne' : 'nw');
        const fixed = () => pipWindow || (!isLauncher && geometry.expanded) || mainDocument.fullscreenElement === panel
            || (resizing && !usableEdge(resizeEdge()));
        let drag;
        let animation;
        const startRect = () => ({ ...(isLauncher ? launcherRect() : compactRect()), preferredBounds: geometry.layout.bounds });
        function paint() {
            animation = null;
            if (!drag) return;
            if (!resizing && !isLauncher) {
                const rect = compactRect();
                // Scroll/resize redraws can replace the layout position during this drag.
                const dx = rect.x - parseFloat(panel.style.left);
                const dy = rect.y - parseFloat(panel.style.top);
                // Undocking can change temporary fitting. Paint the size that release will commit.
                Object.assign(panel.style, {
                    width: `${rect.width}px`, height: `${rect.height}px`, transform: `translate3d(${dx}px, ${dy}px, 0)`,
                });
            } else draw();
        }
        function finish() {
            if (!drag) return;
            const { pointer, moved } = drag;
            drag = null;
            mainWindow.cancelAnimationFrame(animation);
            if (control.hasPointerCapture(pointer)) control.releasePointerCapture(pointer);
            panel.classList.remove('mtflpp-dragging');
            control.classList.remove('mtflpp-edge-active');
            mainDocument.documentElement.classList.remove('mtflpp-window-dragging');
            mainDocument.documentElement.style.removeProperty('--mtflpp-drag-cursor');
            draw();
            if (moved) {
                if (isLauncher) launcherDragClick = true;
                rememberLayout();
                syncControls();
            }
        }
        control.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || fixed()) return;
            if (isHeader && event.target.closest('button, a, [role="button"]')) return;
            if (isLauncher) launcherDragClick = false;
            event.preventDefault();
            if (isLauncher) launcher.focus({ preventScroll: true });
            else if (control === move) controls.focus('move');
            controls.closeMenu();
            drag = { ...startRect(), pointer: event.pointerId, pointerX: event.clientX, pointerY: event.clientY };
            control.setPointerCapture(event.pointerId);
        });
        control.addEventListener('pointermove', (event) => {
            if (!drag || drag.pointer !== event.pointerId) return;
            const dx = event.clientX - drag.pointerX;
            const dy = event.clientY - drag.pointerY;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            drag.moved = true;
            panel.classList.add('mtflpp-dragging');
            if (resizing) control.classList.add('mtflpp-edge-active');
            mainDocument.documentElement.style.setProperty(
                '--mtflpp-drag-cursor', resizing ? mainWindow.getComputedStyle(control).cursor : 'grabbing'
            );
            mainDocument.documentElement.classList.add('mtflpp-window-dragging');
            if (resizing) geometry.resize(drag, resizeEdge(), dx, dy);
            else geometry.move(drag, dx, dy, isLauncher);
            if (!animation) animation = mainWindow.requestAnimationFrame(paint);
        });
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) control.addEventListener(event, finish);
        mainWindow.addEventListener('blur', finish);
        if (isHeader || edge) return; // Pointer-only titlebar/edges add no extra keyboard stops.
        control.addEventListener('keydown', (event) => {
            const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
            if (!delta || event.altKey || event.ctrlKey || event.metaKey || fixed()) return;
            event.preventDefault();
            controls.closeMenu();
            const start = startRect();
            const step = event.shiftKey ? 40 : 10;
            if (resizing) geometry.resize(start, resizeEdge(), delta[0] * step, delta[1] * step);
            else geometry.move(start, delta[0] * step, delta[1] * step, isLauncher);
            draw();
            rememberLayout();
            syncControls();
            const rect = compactRect();
            status.textContent = resizing
                ? `${strings.resize}: ${Math.round(rect.width)} × ${Math.round(rect.height)}` : strings.moved;
        });
    }
    resize.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') resize.classList.add('mtflpp-help-dismissed');
    });
    resize.addEventListener('blur', () => resize.classList.remove('mtflpp-help-dismissed'));
    geometryControl(move);
    geometryControl(header);
    if (!inlineLauncher) geometryControl(launcher);
    geometryControl(resize, true);
    for (const edge of resizeEdges) geometryControl(edge, true, edge.dataset.resizeEdge);
    // Viewport corrections are temporary, not new saved layout preferences.
    mainWindow.addEventListener('resize', draw);
    // On small screens the admin bar scrolls with the page instead of remaining fixed.
    mainWindow.addEventListener('scroll', draw, { passive: true });

    async function popOut() {
        if (suspended || pipWindow || mainDocument.fullscreenElement === panel || !supportsPip()) return;
        controls.closeMenu();
        let detached;
        const restore = () => {
            if (pipWindow !== detached) return;
            beforeMove();
            responsiveViewport.beforeMove();
            controls.beforeMove();
            mainDocument.body.append(panel);
            panel.classList.remove('mtflpp-pip');
            pipWindow = null;
            controls.remount();
            draw();
            responsiveViewport.afterMove();
            syncControls();
            if (!suspended) {
                // Moving an iframe between documents can reload it. Refresh from current editor values.
                afterMove();
                if (visible) controls.focus('mode');
            }
        };
        try {
            // A rejected request leaves the current document and preview completely untouched.
            detached = await mainWindow.documentPictureInPicture.requestWindow({ width: 640, height: 440 });
            if (!visible || suspended) {
                detached.close();
                return;
            }
            const theme = mainWindow.getComputedStyle(panel);
            // Adoption loses inherited editor language and direction in the new document.
            detached.document.documentElement.lang = mainDocument.documentElement.lang;
            detached.document.documentElement.dir = theme.direction;
            for (const name of ['--wp-admin-theme-color', '--wp-admin-theme-color-darker-10', '--wp-admin-border-width-focus']) {
                const value = theme.getPropertyValue(name);
                if (value) detached.document.documentElement.style.setProperty(name, value);
            }
            // Core concatenation removes the individual wp-components stylesheet ID.
            // Native controls also inject runtime styles (including the spinner's strokes and animation).
            // Keep the admin bundles, component runtime styles and panel CSS in source order.
            const stylesheets = mainDocument.querySelectorAll([
                'link[rel="stylesheet"][href*="/load-styles.php"]',
                '#wp-theme-css', '#wp-theme-inline-css',
                '#wp-components-css', '#wp-components-inline-css',
                'style[data-emotion]', 'style[data-wp-hash]',
                '#meet-the-frontend-live-preview-panel-css', '#meet-the-frontend-live-preview-panel-inline-css',
            ].join(', '));
            for (const stylesheet of stylesheets) {
                const copy = stylesheet.cloneNode(true);
                // Runtime insertRule() styles can have empty textContent; cloning alone loses their CSS.
                if (stylesheet.tagName === 'STYLE' && stylesheet.sheet) {
                    copy.textContent = Array.from(stylesheet.sheet.cssRules, (rule) => rule.cssText).join('\n');
                }
                copy.addEventListener('load', responsiveViewport.layout, { once: true });
                detached.document.head.append(copy);
            }
            detached.document.title = caption.textContent;
            detached.document.body.className = 'mtflpp-pip-document';
            detached.addEventListener('resize', responsiveViewport.layout);
            detached.addEventListener('pagehide', restore, { once: true });
            pipWindow = detached;
            beforeMove();
            responsiveViewport.beforeMove();
            controls.beforeMove();
            panel.classList.add('mtflpp-pip');
            detached.document.body.append(panel);
            controls.remount();
            responsiveViewport.afterMove();
            syncControls();
            clearWindowNotice();
            controls.focus('mode');
            afterMove();
        } catch {
            if (detached) {
                restore();
                detached.close();
            }
            if (suspended) return;
            controls.focus('actions');
            showWindowNotice(strings.pipFailed);
        }
    }

    function updateVisibility() {
        panel.hidden = suspended || !visible;
        launcherContainer.hidden = suspended || (!inlineLauncher && (visible || !floatingLauncherAvailable()));
        launcher.setAttribute('aria-expanded', String(!panel.hidden));
    }

    function returnToEditor() {
        controls.closeMenu();
        pipWindow?.close();
        if (mainDocument.fullscreenElement === panel) mainDocument.exitFullscreen().catch(() => {});
    }

    nativeLauncher?.fallbackMedia.addEventListener('change', () => {
        draw();
        updateVisibility();
    });

    // Only explicit opening and closing changes saved visibility.
    function closePanel() {
        controls.closeMenu();
        rememberPanelVisibility(false);
        onClose();
        if (inlineLauncher || floatingLauncherAvailable()) launcher.focus();
        else nativeLauncher.focus();
    }

    function openFromLauncher(focus = true) {
        if (suspended) return;
        if (visible) {
            controls.focus('actions');
            return;
        }
        rememberPanelVisibility(true);
        onOpen();
        if (visible && focus) controls.focus('actions');
    }

    launcher.addEventListener('click', (event) => {
        if (launcherDragClick && event.detail !== 0) {
            launcherDragClick = false;
            event.preventDefault();
            return;
        }
        launcherDragClick = false;
        openFromLauncher(event.detail === 0);
    });
    controls = createPreviewControls(panel, strings, {
        refresh: () => { if (current.canRefresh) onRefresh(); },
        retry: () => {
            if (current.state !== 'handover' && (takeOverAction || (current.canRetry && ['error', 'conflict'].includes(current.state)))) {
                onRetry(takeOverAction);
            }
        },
        dismissNotice: () => {
            clearWindowNotice();
            status.textContent = current.text;
            controls.focus('actions');
        },
        mode: toggleMode, close: closePanel, popOut, fullscreen: enterFullscreen,
        dock: (side) => dockWindow(side), reset: () => dockWindow('right', true),
        follow: toggleFollow, rememberVisibility: toggleRememberVisibility, rememberPosition: toggleRememberPosition,
        device(name) {
            const previous = responsiveViewport.device;
            if (name === previous && name === 'desktop') return;
            let keepPan = false;
            if (visible && followChanges && beforeViewportChange) {
                const { fit, customZoom, canvasTarget, whenSettled, finishMotion, canvasWasPanned } = responsiveViewport;
                keepPan = !!beforeViewportChange({
                    canvas, canvasTarget, whenSettled, finishMotion, canvasWasPanned,
                    canFollow: () => responsiveViewport.fit === fit && responsiveViewport.customZoom === customZoom,
                });
            }
            // A tracked switch needs only the reflow, not a separate zoom animation before following.
            const options = { animate: visible && !keepPan, keepPan };
            if (name === previous) {
                responsiveViewport.rotate(options);
                preferenceActions.set(scope, `${name}Orientation`, responsiveViewport.orientation);
            } else {
                responsiveViewport.select(name, options);
                if (responsiveViewport.device !== previous) preferenceActions.set(scope, 'viewport', responsiveViewport.device);
            }
            syncControls();
        },
        fit(value) {
            const previous = responsiveViewport.fit;
            responsiveViewport.setFit(value);
            if (responsiveViewport.fit !== previous) preferenceActions.set(scope, 'fitMode', responsiveViewport.fit);
            syncControls();
        },
        zoom(value) {
            const previousFit = responsiveViewport.fit;
            const previousZoom = responsiveViewport.customZoom;
            responsiveViewport.setZoom(value);
            if (responsiveViewport.customZoom !== previousZoom) preferenceActions.set(scope, 'customZoom', responsiveViewport.customZoom);
            if (responsiveViewport.fit !== previousFit) preferenceActions.set(scope, 'fitMode', responsiveViewport.fit);
            syncControls();
        },
    });
    report(strings.loading, 'loading', { canRetry: false });
    draw();
    // Reveal the positioned panel and enable any server-rendered launcher after binding controls.
    updateVisibility();
    if (inlineLauncher) inlineLauncher.disabled = false;

    return {
        // The coordinator owns frame contents; the panel owns their document and viewport geometry.
        stage,
        canvasTarget: responsiveViewport.canvasTarget,
        get visible() { return visible; },
        get followChanges() { return followChanges; },
        openFromLauncher,
        setSuspended(value) {
            if (suspended === value) return;
            // Hide temporarily without changing the user's open/closed preference or layout.
            suspended = value;
            updateVisibility();
            if (value) returnToEditor();
            else draw();
        },
        setVisible(value) {
            if (!value) {
                controls.closeMenu();
                windowNotice = '';
                syncControls();
                responsiveViewport.layout();
            }
            visible = value;
            draw();
            updateVisibility();
        },
        report,
        setTitle,
        clearPreview() {
            stage.replaceChildren();
            const loading = ['ready', 'stale', 'loading'].includes(current.state);
            report(loading ? strings.loading : current.text, loading ? 'loading' : current.state, {
                ...current, hasPreview: false, hasHtmlPreview: false, redirectDestination: undefined, canRefresh: false,
                canRetry: loading ? false : current.canRetry,
            });
        },
        returnToEditor,
    };
}
