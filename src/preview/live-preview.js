import { createPreviewPanel } from '../panel/window.js';
import { createPreviewFrame } from '../preview/frame.js';
import { createPreviewScroll } from '../preview/scroll.js';

// Share preview writes, frames and ownership, not editor-specific fields or save controls.
export function createLivePreview(config, nativeEditor) {
    const strings = config.strings;
    const subjectId = config.termId ?? config.postId;
    const mainWindow = window;
    const scrolling = createPreviewScroll();
    const view = createPreviewPanel(strings, {
        postTitle: nativeEditor.title ?? config.postTitle,
        publicRedirect: config.publicRedirect,
        onOpen: () => startPreview(),
        onClose: () => stopPreview(),
        onRefresh: refreshPreview,
        onRetry: (takeOver) => takeOver ? startPreview(true) : refreshPreview(),
        beforeMove: discardFrames,
        afterMove: () => { if (previewActive) refreshPreview(); },
    });

    // Visibility belongs to the view: a shown panel can be active, waiting or paused.
    // Disabling refreshes does not release ownership until the outstanding refresh has drained.
    let previewActive = false;
    let generation = 0;
    let refreshTimer;
    const frames = createPreviewFrame(view, scrolling, strings, report, config.comparisonExcludedSelectors);
    let followPending = false;
    let refreshTask;
    let previewError;
    // Native saves drain only the server write, never a refresh waiting for that same native save.
    let writeTask;
    // Covers queued acquisition, active ownership and draining the final refresh before release.
    let ownershipTask;
    let requestStop;
    let takeoverRequest;
    let takeoverTimer;
    let channel;
    try {
        if (mainWindow.BroadcastChannel) {
            channel = new mainWindow.BroadcastChannel(
                `a-floating-live-preview-panel:${config.endpoint}:${subjectId}:${config.userId}`
            );
            channel.onmessage = (event) => {
                if (event.data?.type !== 'takeover' || !previewActive) return;
                stopPreview(true);
                report(strings.handedOff, 'conflict', { reason: 'handed-off' });
            };
            mainWindow.addEventListener('pagehide', (event) => { if (!event.persisted) channel.close(); });
        }
    } catch {
        channel?.close();
        channel = null; // Keep manual close/retry when cross-tab messaging is unavailable.
    }

    function report(text, state = 'loading', { canRetry = true, reason = '' } = {}) {
        if (state === 'ready') followPending = false;
        view.report(text, state, {
            canTakeOver: !!channel, hasPreview: frames.hasPreview, canRetry, reason,
            hasHtmlPreview: frames.hasHtmlPreview, redirectDestination: frames.redirectDestination,
            canRefresh: previewActive && !nativeEditor.saving && ['ready', 'error'].includes(state) && (state !== 'error' || canRetry),
        });
    }

    function failureReason(error) {
        const code = error?.code;
        if (code === 'aflpp_post_locked') return 'post-locked';
        if ([
            'aflpp_invalid_nonce', 'rest_cookie_invalid_nonce', 'aflpp_preview_conflict',
            'aflpp_source_changed', 'aflpp_acf_unavailable', 'aflpp_integration_failed',
        ].includes(code)) return 'reload';
        if (['aflpp_cannot_preview', 'rest_forbidden', 'rest_cannot_edit'].includes(code)) return 'permission';
        if (code === 'aflpp_preview_origin_mismatch') return 'origin-mismatch';
        if (code === 'aflpp_preview_unsupported_url') return 'unsupported-url';
        return '';
    }

    function reportFailure(error) {
        // Recovery hints only affect the panel; never reload or alter native editor controls.
        const code = error?.code;
        const reason = failureReason(error);
        if (reason) {
            previewActive = false;
            clearTimeout(refreshTimer);
            frames.cancel();
            requestStop?.();
        }
        const text = typeof code === 'string' ? error.message : strings.failed;
        // WordPress's Take over action reloads the editor, which starts a fresh preview session.
        report(text, reason === 'post-locked' ? 'paused' : 'error', { reason, canRetry: !reason });
    }

    function changed() {
        if (!previewActive) return;
        generation += 1;
        followPending = true;
        frames.cancel();
        clearTimeout(refreshTimer);
        if (nativeEditor.saving) return;
        report(strings.stale, 'stale');
        if (!nativeEditor.previewing) refreshTimer = setTimeout(update, 1000);
    }

    function pause(text = strings.saving, state = 'loading') {
        generation += 1;
        clearTimeout(refreshTimer);
        frames.cancel();
        if (previewActive || (view.visible && state === 'paused')) report(text, state, { canRetry: false });
        return writeTask;
    }

    function resume(error) {
        previewError = error;
        if (error) {
            if (view.visible) reportFailure(error);
            return;
        }
        if (view.visible && !previewActive && !ownershipTask) {
            startPreview();
            return;
        }
        changed();
    }

    function loadFrame(address, version, values) {
        return frames.load(address, () => previewActive && version === generation,
            () => view.followChanges && followPending, values);
    }

    function update() {
        if (!previewActive || refreshTask || nativeEditor.ready === false || nativeEditor.previewing || nativeEditor.saving) return;
        clearTimeout(refreshTimer);
        const version = generation;
        report(strings.updating);
        refreshTask = (async () => {
            try {
                await nativeEditor.idle;
                if (!previewActive || nativeEditor.ready === false || nativeEditor.saving) return;
                const base = config.base;
                let result;
                let failure;
                // Assign before yielding: a pre-save hook must always see an already-started write.
                writeTask = nativeEditor.preparePreview();
                try {
                    result = await writeTask;
                } catch (error) {
                    failure = error;
                } finally {
                    writeTask = null;
                }
                // An overlapping classic draft autosave may invalidate both a success and a failure.
                await nativeEditor.idle;
                if (!previewActive || nativeEditor.ready === false || nativeEditor.saving || base !== config.base) return;
                if (failure) throw failure;
                if (typeof result.url !== 'string') {
                    throw Object.assign(new Error(result.message || strings.failed), { code: result.code });
                }
                if (previewActive && version === generation) await loadFrame(result.url, version, result.comparisonValues);
            } catch (error) {
                if (previewActive && !nativeEditor.saving) reportFailure(error);
            } finally {
                refreshTask = null;
                if (previewActive && nativeEditor.ready !== false && !nativeEditor.previewing && !nativeEditor.saving && version !== generation) {
                    clearTimeout(refreshTimer);
                    refreshTimer = setTimeout(update, 1000);
                }
            }
        })();
    }

    function discardFrames() {
        generation += 1;
        frames.clear();
    }

    function stopPreview(keepVisible = false) {
        view.setVisible(keepVisible);
        previewActive = false;
        clearTimeout(refreshTimer);
        discardFrames();
        clearTimeout(takeoverTimer);
        takeoverTimer = null;
        takeoverRequest?.abort();
        view.returnToEditor();
        requestStop?.();
    }

    async function startPreview(takeOver = false) {
        view.setVisible(true);
        if (previewActive) return;
        if (previewError) {
            reportFailure(previewError);
            return;
        }
        if (ownershipTask) {
            if (takeoverRequest && !takeoverRequest.signal.aborted) return;
            const version = generation;
            try {
                await ownershipTask;
            } catch {
                // Cancelled or timed-out lock request.
            }
            if (view.visible && version === generation) startPreview(takeOver);
            return;
        }
        if (nativeEditor.ready === false) {
            report(nativeEditor.notReady, nativeEditor.notReadyState ?? 'paused', { canRetry: false });
            return;
        }
        if (!config.available) {
            report(strings.unavailable, 'error', { canRetry: false, reason: 'unavailable' });
            return;
        }
        if (!mainWindow.isSecureContext || !navigator.locks) {
            report(strings.browser, 'error', { canRetry: false, reason: 'browser' });
            return;
        }
        const controller = takeOver && channel ? new AbortController() : null;
        let timedOut = false;
        takeoverRequest = controller;
        if (controller) {
            report(strings.waiting, 'handover');
            takeoverTimer = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, 15000);
        } else report(nativeEditor.saving ? strings.saving : strings.updating);
        try {
            // Queue cooperatively. Never steal: the current owner must finish its PHP write first.
            const options = controller ? { signal: controller.signal } : { ifAvailable: true };
            // The endpoint separates sites and entity types; users editing the same entity must still contend.
            ownershipTask = navigator.locks.request(`a-floating-live-preview-panel:${config.endpoint}:${subjectId}`, options, async (lock) => {
                clearTimeout(takeoverTimer);
                takeoverTimer = null;
                takeoverRequest = null;
                if (!view.visible || controller?.signal.aborted) return;
                if (!lock) {
                    report(channel ? strings.conflict : strings.closeOther, 'conflict', {
                        reason: channel ? 'other-tab' : 'manual',
                    });
                    return;
                }
                report(nativeEditor.saving ? strings.saving : strings.updating);
                try {
                    await new Promise((resolve) => {
                        requestStop = resolve;
                        previewActive = true;
                        generation += 1;
                        update();
                    });
                    // A cancelled fetch does not cancel a PHP write; finish it before releasing ownership.
                    await refreshTask;
                } finally {
                    requestStop = null;
                }
            });
            if (controller) {
                try {
                    channel.postMessage({ type: 'takeover' });
                } catch (error) {
                    controller.abort();
                    if (previewActive) stopPreview(true);
                    await ownershipTask.catch(() => {});
                    throw error;
                }
            }
            await ownershipTask;
            if (view.visible && timedOut) report(strings.takeoverTimeout, 'conflict', { reason: 'busy' });
        } catch (error) {
            previewActive = false;
            if (view.visible && timedOut) report(strings.takeoverTimeout, 'conflict', { reason: 'busy' });
            else if (view.visible && error.name !== 'AbortError') reportFailure(error);
        } finally {
            clearTimeout(takeoverTimer);
            takeoverTimer = null;
            takeoverRequest = null;
            ownershipTask = null;
        }
    }

    function refreshPreview(follow = true) {
        if (nativeEditor.saving) return;
        if (!follow) followPending = false;
        if (!previewActive) {
            startPreview();
            return;
        }
        generation += 1;
        frames.cancel();
        update();
    }

    return {
        changed, pause, resume,
        setTitle: view.setTitle,
        start: () => { if (view.visible) startPreview(); },
        // Classic Preview/save coordination retains its original whole-refresh drain.
        get pending() { return refreshTask; },
    };
}
