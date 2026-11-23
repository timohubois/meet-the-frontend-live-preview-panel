// Observe WordPress's native Preview, autosave and validation without replacing their behavior.
export function createNativeEditor(config, form) {
    const nativeEditor = {
        idle: Promise.resolve(), saving: false, previewing: false, deferredSaves: new WeakSet(),
    };
    let finishNative;
    let nativePreview;
    let replayingPreview = false;

    function beginPreview() {
        const token = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
        const base = config.base;
        const name = `mtflpp_preview_${token}`;
        const fields = Object.entries({ mtflpp_base: base, mtflpp_preview: token }).map(([name, value]) => {
            const field = document.createElement('input');
            Object.assign(field, { type: 'hidden', name, value });
            form.append(field);
            return field;
        });
        let timer;
        let settled = false;
        let resolve;
        const done = new Promise((finish) => { resolve = finish; });
        const deadline = Date.now() + 30000;
        const finish = (error) => {
            settled = true;
            clearTimeout(timer);
            nativePreview = null;
            nativeEditor.previewing = false;
            for (const field of fields) field.remove();
            document.cookie = `${name}=; Max-Age=0; Path=${config.adminCookiePath}; SameSite=Strict`;
            resolve();
            nativeEditor.onPreview?.(error, config.base !== base);
        };
        const check = () => {
            if (settled) return;
            clearTimeout(timer);
            const receipt = document.cookie.split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`));
            const value = receipt?.slice(name.length + 1);
            if (value?.startsWith(`${base}.`) && /^[a-f0-9]{64}$/.test(value.slice(65))) {
                config.base = value.slice(65);
                finish();
            } else if (receipt || Date.now() >= deadline) {
                finish(Object.assign(new Error(config.strings.nativePreviewFailed), { code: 'mtflpp_source_changed' }));
            } else timer = setTimeout(check, 100);
        };
        nativePreview = { done, check };
        nativeEditor.idle = Promise.all([nativeEditor.idle, done]);
        timer = setTimeout(check, 100);
    }

    const previewClick = (event) => {
        const control = event.target.closest('#post-preview');
        if (!control || control.classList.contains('disabled') || replayingPreview || !window.crypto?.getRandomValues) return;
        if (nativeEditor.previewing) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        nativeEditor.previewing = true;
        const pending = nativeEditor.beforePreview?.();
        if (!pending) { beginPreview(); return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        // Reserve core's named preview tab during the user gesture, before awaiting a write.
        window.open('', control.target || 'wp-preview');
        const proceed = () => {
            beginPreview();
            replayingPreview = true;
            try { control.click(); } finally { replayingPreview = false; }
        };
        pending.then(proceed, proceed);
    };
    form.addEventListener('click', previewClick, true);
    window.jQuery(document).on('heartbeat-send.mtflpp', (event, data) => {
        nativePreview?.check();
        data.mtflpp_base = config.base;
    }).on('before-autosave.mtflpp', () => {
        // Core emits this even when its heartbeat-send handler was registered after ours.
        const autosave = new Promise((resolve) => { finishNative = resolve; });
        nativeEditor.idle = Promise.all([autosave, nativePreview?.done]);
        nativeEditor.onAutosave?.();
    }).on('heartbeat-tick.mtflpp heartbeat-error.mtflpp', (event, data) => {
        if (typeof data?.mtflpp_base === 'string' && /^[a-f0-9]{64}$/.test(data.mtflpp_base)) {
            config.base = data.mtflpp_base;
        }
        if (typeof data?.rest_nonce === 'string') config.nonce = data.rest_nonce;
        finishNative?.();
        finishNative = null;
    });
    // Core's Text-mode link dialog emits jQuery-only changes; native events use the form listeners.
    window.jQuery(form).on('input.mtflpp change.mtflpp', (event) => {
        if (!event.originalEvent && ['post_title', 'content', 'excerpt'].includes(event.target.name)) {
            nativeEditor.onFieldChange?.(event);
        }
    });
    const cancelSave = () => {
        if (nativeEditor.onSaveCancelled) nativeEditor.onSaveCancelled();
        else nativeEditor.saving = false;
    };
    form.addEventListener('invalid', cancelSave, true);
    let submission = 0;
    let destroyed = false;
    function watchSaveCancellation(event) {
        if (event.type === 'click') {
            const control = event.target.closest('#publish, #save-post');
            if (!control || control.disabled || control.classList.contains('disabled')) return;
        } else if (form.querySelector('#wp-preview')?.value === 'dopreview') return;
        const attempt = ++submission;
        // Trusted dispatch can flush microtasks between listeners; inspect cancellation in the next task.
        setTimeout(() => {
            const cancelled = event.defaultPrevented || event.isDefaultPrevented?.();
            if (!destroyed && attempt === submission && cancelled && !nativeEditor.deferredSaves.has(event)
                && !nativeEditor.isValidating?.()) cancelSave();
        }, 0);
    }
    // Capture also sees rejected button clicks and validators that stop events from bubbling.
    form.addEventListener('click', watchSaveCancellation, true);
    form.addEventListener('submit', watchSaveCancellation, true);
    window.jQuery(form).on('submit.mtflpp', (event) => {
        if (!event.originalEvent) watchSaveCancellation(event);
    });
    nativeEditor.destroy = () => {
        destroyed = true;
        nativeEditor.beforePreview = null;
        nativeEditor.onPreview = null;
        nativeEditor.onAutosave = null;
        nativeEditor.onFieldChange = null;
        nativeEditor.onSaveCancelled = null;
        nativeEditor.isValidating = null;
        form.removeEventListener('click', previewClick, true);
        form.removeEventListener('invalid', cancelSave, true);
        form.removeEventListener('click', watchSaveCancellation, true);
        form.removeEventListener('submit', watchSaveCancellation, true);
        window.jQuery(document).off('.mtflpp');
        window.jQuery(form).off('.mtflpp');
    };
    return nativeEditor;
}
