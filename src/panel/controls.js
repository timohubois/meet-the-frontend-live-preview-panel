import { createElement as h, createPortal, createRoot, flushSync, Fragment } from '@wordpress/element';
import {
    Button, Dropdown, DropdownMenu, MenuGroup, MenuItem, MenuItemsChoice, Notice, Placeholder,
    Popover, RadioControl, RangeControl, SlotFillProvider, Spinner, Toolbar, ToolbarButton,
} from '@wordpress/components';
import { dispatch } from '@wordpress/data';
import { InlineNotices, store as noticesStore } from '@wordpress/notices';
import { icons } from './icons.js';

// Keep the launcher mounted in the editor while panel controls unmount for fullscreen/PiP moves.
export function createPreviewLauncher(container) {
    let button;
    const { title, moveHelp } = container.dataset;
    flushSync(() => createRoot(container).render(h(Button, {
        ref: (element) => { button = element; },
        variant: 'secondary', label: title, title, description: moveHelp,
        'aria-controls': 'mtflpp-panel', 'aria-expanded': false,
    },
    h('span', { className: 'mtflpp-launcher-label' }, title),
    )));
    return button;
}

// Public WordPress UI only. The shell owns geometry, recovery decisions and preview state.
export function createPreviewControls(panel, strings, callbacks) {
    const container = panel.querySelector('.mtflpp-controls');
    const refreshContainer = panel.querySelector('.mtflpp-refresh-control');
    const moveContainer = panel.querySelector('.mtflpp-move-control');
    const devicesContainer = panel.querySelector('.mtflpp-device-controls');
    const zoomContainer = panel.querySelector('.mtflpp-fit-control');
    const pipContainer = panel.querySelector('.mtflpp-pip-control');
    const emptyContainer = panel.querySelector('.mtflpp-empty');
    const feedbackContainer = panel.querySelector('.mtflpp-feedback');
    let root = createRoot(container);
    let state;
    let open = false;
    let zoomOpen = false;
    let focusZoomField = false;
    // InlineNotices is public in newer core; older core retains its native Notice component.
    const noticeActions = InlineNotices ? dispatch(noticesStore) : null;
    // wp-notices loads wp-theme when needed; that handle is absent in older core.
    const ThemeProvider = panel.ownerDocument.defaultView?.wp?.theme?.ThemeProvider;
    const noticeContext = 'meet-the-frontend-live-preview-panel';
    const noticeId = 'preview-feedback';
    let lastNotice = '';

    function noticeProps() {
        const notice = state.notice;
        const heading = /[.!?…。！？]$/.test(notice.heading) ? notice.heading : `${notice.heading}.`;
        return {
            message: notice.description ? `${heading} ${notice.description}` : notice.heading,
            status: notice.status, isDismissible: notice.dismissible,
            actions: [
                ...(notice.retry ? [{ label: notice.action, disabled: notice.disabled, onClick: callbacks.retry }] : []),
                ...(notice.close ? [{ label: strings.close, onClick: callbacks.close }] : []),
            ],
        };
    }

    function clearNotice() {
        if (noticeActions && lastNotice) noticeActions.removeNotice(noticeId, noticeContext);
        lastNotice = '';
    }

    function syncNotice() {
        if (!noticeActions) return;
        if (!state.notice) {
            clearNotice();
            return;
        }
        const next = JSON.stringify(state.notice);
        if (lastNotice === next) return;
        const { message, status, ...props } = noticeProps();
        noticeActions.createNotice(status, message, {
            ...props, id: noticeId, context: noticeContext,
            // The shell's status region already announces changes once.
            speak: false, onDismiss: callbacks.dismissNotice,
        });
        lastNotice = next;
    }

    function renderNotice() {
        if (!state.notice) return null;
        if (noticeActions) {
            const content = h(InlineNotices, { context: noticeContext, className: 'mtflpp-inline-notices' });
            return ThemeProvider ? h(ThemeProvider, { cornerRadius: 'none' }, content) : content;
        }
        const { message, ...props } = noticeProps();
        return h(Notice, { ...props, onRemove: callbacks.dismissNotice, spokenMessage: '', politeness: 'polite' }, message);
    }

    function zoomControl() {
        const { fit, customZoom = 100, dpr = 1 } = state;
        const labels = { automatic: strings.automatic, window: strings.fitToWindow, width: strings.fitToWidth };
        const descriptions = { automatic: strings.automaticHelp, window: strings.fitToWindowHelp, width: strings.fitToWidthHelp };
        const label = fit === 'custom' ? strings.fixedZoom : labels[fit] ?? strings.automatic;
        return h(Dropdown, {
            open: zoomOpen,
            onToggle(value) {
                zoomOpen = value;
                if (value) {
                    open = false;
                    focusZoomField = state.fit === 'custom';
                }
                render();
            },
            contentClassName: 'mtflpp-zoom-popover',
            focusOnMount: 'firstElement',
            popoverProps: { placement: 'top-end', offset: 8, shift: true, resize: false, role: 'dialog', 'aria-label': strings.fitting },
            renderToggle: ({ isOpen, onToggle }) => h(Button, {
                className: 'mtflpp-zoom-toggle', variant: 'secondary', size: 'compact',
                label, showTooltip: true, 'aria-label': `${strings.fitting}: ${label}`,
                'aria-haspopup': 'dialog', 'aria-expanded': isOpen, onClick: onToggle, 'data-action': 'zoom',
            }, h('span', { className: 'mtflpp-zoom-value' }, label), icons.chevron),
            renderContent: () => h('div', { className: 'mtflpp-zoom-content' },
                h(RadioControl, {
                    label: strings.zoomMode, selected: fit,
                    options: [
                        ...Object.entries(labels).map(([value, label]) => ({ value, label, description: descriptions[value] })),
                        { value: 'custom', label: strings.fixedZoom, description: strings.fixedZoomHelp },
                    ],
                    onFocus(event) {
                        if (!focusZoomField) return;
                        focusZoomField = false;
                        // Native opening focuses the checked radio after recording the focus-return target.
                        const field = event.currentTarget.closest('.mtflpp-zoom-content')?.querySelector('.mtflpp-custom-zoom input[type="number"]');
                        field?.focus({ preventScroll: true });
                        const content = field?.closest('.components-popover__content');
                        if (content) {
                            const rect = field.getBoundingClientRect();
                            const bounds = content.getBoundingClientRect();
                            // Reveal the focused field in short popovers without scrolling the editor or PiP window.
                            content.scrollTop += Math.min(0, rect.top - bounds.top) + Math.max(0, rect.bottom - bounds.bottom);
                        }
                    },
                    onChange(value) {
                        // Keep radio-key navigation in the group; focus the number only when reopening fixed zoom.
                        focusZoomField = false;
                        if (value === 'custom') {
                            callbacks.zoom(customZoom);
                            return;
                        }
                        callbacks.fit(value);
                    },
                }),
                fit === 'custom' && h('div', {
                    className: 'mtflpp-custom-zoom',
                    onKeyDown(event) {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        const number = Number(event.target.value);
                        if (event.target.validity?.valid !== false && Number.isInteger(number) && number >= 10 && number <= 400) closeMenu();
                    },
                }, h(RangeControl, {
                    label: strings.customZoom, min: 10, max: 400, step: 1,
                    __nextHasNoMarginBottom: true, __next40pxDefaultSize: true,
                    value: customZoom, help: strings.customZoomHelp, withInputField: true,
                    onChange(value) {
                        if (Number.isInteger(value) && value >= 10 && value <= 400) callbacks.zoom(value);
                    },
                })),
                h('div', { className: 'mtflpp-dpr-note', role: 'group', 'aria-label': strings.displayInformation },
                    h('span', { className: 'mtflpp-dpr-value' }, `${strings.displayDpr}: ${Number(dpr.toFixed(2))}`),
                    h('span', { className: 'mtflpp-pixel-note' }, strings.pixelZoomHelp),
                ),
            ),
        });
    }

    function command(action) {
        return () => {
            closeMenu();
            action();
        };
    }

    function actionsMenu() {
        const { canPip, canFullscreen, inPage, inPip, dock, rememberVisibility, rememberPosition, followChanges } = state;
        return h(DropdownMenu, {
            className: 'mtflpp-actions', label: strings.actions, icon: icons.more, open,
            onToggle(value) {
                open = value;
                if (value) zoomOpen = false;
                render();
            },
            toggleProps: { className: 'mtflpp-icon', size: 'compact', 'data-action': 'actions' },
            popoverProps: { placement: 'bottom-end', offset: 6, shift: true, className: 'mtflpp-menu-popover' },
        }, () => h(Fragment, null,
            (canPip || canFullscreen) && h(MenuGroup, { label: strings.display },
                canPip && h(MenuItem, {
                    label: strings.popOutHelp, description: strings.popOutHelp, showTooltip: true,
                    onClick: command(callbacks.popOut), 'data-action': 'pip', 'aria-label': strings.popOut,
                }, strings.popOut),
                canFullscreen && h(MenuItem, {
                    onClick: command(callbacks.fullscreen), 'data-action': 'fullscreen',
                }, strings.fullscreen),
            ),
            inPage && h(MenuGroup, { label: strings.position }, h(MenuItemsChoice, {
                value: dock,
                choices: [
                    { value: 'left', label: strings.bottomLeft },
                    { value: 'center', label: strings.bottomCenter },
                    { value: 'right', label: strings.bottomRight },
                ],
                onSelect(side) {
                    closeMenu();
                    callbacks.dock(side);
                },
            })),
            h(MenuGroup, { label: strings.preferences },
                h(MenuItem, {
                    role: 'menuitemcheckbox', isSelected: rememberVisibility, icon: rememberVisibility ? icons.check : undefined,
                    info: strings.rememberVisibilityHelp,
                    onClick: command(callbacks.rememberVisibility), 'data-action': 'remember-visibility',
                }, strings.rememberVisibility),
                h(MenuItem, {
                    role: 'menuitemcheckbox', isSelected: rememberPosition, icon: rememberPosition ? icons.check : undefined,
                    info: strings.rememberPositionHelp,
                    onClick: command(callbacks.rememberPosition), 'data-action': 'remember-position',
                }, strings.rememberPosition),
                h(MenuItem, {
                    role: 'menuitemcheckbox', isSelected: followChanges, icon: followChanges ? icons.check : undefined,
                    info: strings.followHelp,
                    onClick: command(callbacks.follow), 'data-action': 'follow',
                }, strings.follow),
            ),
            inPage && h(MenuGroup, null, h(MenuItem, {
                info: strings.resetHelp, onClick: command(callbacks.reset), 'data-action': 'reset',
            }, strings.reset)),
            inPip && h(MenuGroup, null, h(MenuItem, {
                onClick: command(callbacks.close), 'data-action': 'close',
            }, strings.closeLivePreview)),
        ));
    }

    function deviceToolbar() {
        const { device, orientation } = state;
        return h(Toolbar, { className: 'mtflpp-devices', label: strings.viewport, variant: 'unstyled' },
            ...['desktop', 'tablet', 'mobile'].map((name) => {
                const selected = device === name;
                const rotatable = selected && name !== 'desktop';
                const rotated = rotatable && orientation === 'landscape';
                const rotateLabel = orientation === 'portrait' ? strings.rotateLandscape : strings.rotatePortrait;
                return h(ToolbarButton, {
                    key: name, icon: icons[name], className: rotated ? 'mtflpp-device-rotated' : undefined,
                    label: rotatable ? `${strings[name]} — ${rotateLabel}` : strings[name],
                    isPressed: selected, 'data-viewport': name, onClick: () => callbacks.device(name),
                });
            }),
        );
    }

    function emptyState() {
        const { empty } = state;
        if (!empty) return null;
        return h(Placeholder, {
            className: empty.stackIcon ? 'mtflpp-placeholder mtflpp-placeholder-stacked' : 'mtflpp-placeholder',
            icon: empty.busy ? h(Spinner) : icons[empty.icon],
            label: h('h3', { className: 'mtflpp-empty-title', tabIndex: -1, 'data-action': 'empty-title' }, empty.heading),
            instructions: empty.description,
        },
        empty.retry && h(Button, {
            key: 'retry', variant: 'primary', disabled: empty.disabled, onClick: callbacks.retry, 'data-action': 'retry',
        }, empty.action),
        empty.close && h(Button, { key: 'close', variant: 'secondary', onClick: callbacks.close, 'data-action': 'close' }, strings.close),
        empty.note && h('p', { className: 'mtflpp-empty-note' }, empty.note),
        );
    }

    function Controls() {
        const {
            inPage, inPip, mode, modeLabel, movable, busy, canRefresh, hasPreview, canPip,
        } = state;
        return h(SlotFillProvider, null,
            createPortal(movable && inPage && h(Button, {
                className: 'mtflpp-icon mtflpp-move', size: 'compact', icon: icons.move, label: strings.move, showTooltip: true, tooltipPosition: 'bottom',
                'data-action': 'move',
            }), moveContainer),
            createPortal(h(Button, {
                className: 'mtflpp-icon', size: 'compact', icon: busy ? h(Spinner) : icons.refresh,
                label: strings.refresh, showTooltip: true,
                // Loading must not move focus from Refresh to the panel's fallback action.
                accessibleWhenDisabled: true, disabled: !canRefresh, onClick: callbacks.refresh, 'data-action': 'refresh',
            }), refreshContainer),
            createPortal(canPip && hasPreview && h('div', { className: 'mtflpp-pip-surface' }, h(Button, {
                className: 'mtflpp-pip-button', icon: icons.pip, label: strings.popOutHelp, 'aria-label': strings.popOut,
                description: strings.popOutHelp, showTooltip: true, onClick: callbacks.popOut, 'data-action': 'pop-out',
            })), pipContainer),
            actionsMenu(),
            !inPip && h(Button, {
                className: 'mtflpp-icon mtflpp-mode', size: 'compact', icon: icons[mode], label: modeLabel, showTooltip: true,
                onClick: callbacks.mode, 'data-action': 'mode',
            }),
            !inPip && h(Button, {
                className: 'mtflpp-icon', size: 'compact', icon: icons.close, label: strings.close, showTooltip: true,
                onClick: callbacks.close, 'data-action': 'close',
            }),
            createPortal(deviceToolbar(), devicesContainer),
            createPortal(zoomControl(), zoomContainer),
            createPortal(emptyState(), emptyContainer),
            createPortal(renderNotice(), feedbackContainer),
            // Escape the panel's stacking context in-page; fullscreen/PiP must stay inside the panel.
            inPage ? createPortal(h(Popover.Slot), panel.ownerDocument.body) : h(Popover.Slot),
        );
    }

    function render() {
        if (!state || !root) return;
        syncNotice();
        flushSync(() => root.render(h(Controls)));
    }

    function closeMenu() {
        if (!open && !zoomOpen) return;
        open = false;
        zoomOpen = false;
        render();
    }

    function focus(action) {
        if (state?.inPip && action === 'mode') action = 'actions';
        panel.querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
    }

    return {
        update(next) {
            const recoverZoomFocus = zoomOpen && !next.hasPreview
                && panel.ownerDocument.activeElement?.closest('.mtflpp-zoom-popover');
            if (!next.hasPreview) zoomOpen = false;
            state = next;
            render();
            if (recoverZoomFocus) focus('empty-title');
        },
        closeMenu,
        focus,
        beforeMove() {
            open = false;
            zoomOpen = false;
            root?.unmount();
            root = null;
            clearNotice();
        },
        remount() {
            root = createRoot(container);
            render();
        },
    };
}
