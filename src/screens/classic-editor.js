import { createEditorExtensions } from './editor-extensions.js';
import { createLivePreview } from '../preview/live-preview.js';

// Classic fields and native form controls stay outside the shared preview lifecycle.
export function initLivePreview(config, nativeEditor, inlineLauncher) {
    const form = document.getElementById('post');
    if (!config || !form) return;
    let capturing = false;
    let extensions;
    const editors = new Set();
    let destroyed = false;
    nativeEditor.title = document.getElementById('title')?.value ?? config.postTitle;
    function capturePreview(followChanges) {
        capturing = true;
        let values;
        try {
            window.tinymce?.triggerSave();
            values = new FormData(form);
        } finally { capturing = false; }
        const core = new URLSearchParams();
        for (const [name, value] of values) {
            if (typeof value === 'string' && ['post_title', 'content', 'excerpt'].includes(name)) core.append(name, value);
        }
        // Extension capture appends to this body; freeze core semantics before it is extended.
        const coreValues = Object.fromEntries([...core].map(([key, value]) => [
            key, { type: key === 'post_title' ? 'text' : 'html', value },
        ]));
        const data = extensions.capture(core, values);
        const comparisonValues = extensions.comparisonValues(data, coreValues);
        const rowFields = new Set();
        if (followChanges) for (const hint of Object.values(comparisonValues)) {
            if (hint?.type !== 'row-order' || !hint.fieldsByRow) continue;
            for (const fields of Object.values(hint.fieldsByRow).filter(Array.isArray)) for (const name of fields) {
                if (comparisonValues[name]?.type === 'html' && data.has(name)) rowFields.add(name);
            }
        }
        data.set('base', config.base);
        // PHP can truncate large forms; keep the optional hint after the required baseline.
        if (rowFields.size) data.set('mtflpp_row_text_fields', JSON.stringify([...rowFields]));
        return { data, comparisonValues, rowFields };
    }
    nativeEditor.preparePreview = async (followChanges) => {
        const { data, comparisonValues, rowFields } = capturePreview(followChanges);
        const response = await fetch(config.endpoint, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'X-WP-Nonce': config.nonce }, body: data,
        });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.message || config.strings.failed), { code: result.code });
        const { rowDisplayText, ...preview } = result;
        const displayValues = { ...comparisonValues };
        // Keep this local to scroll comparison. Preserve field occurrence order, including
        // hidden values that do not supply comparison hints.
        const rowSubmission = followChanges && Object.values(comparisonValues).some((hint) => hint?.type === 'row-order')
            ? [...data].filter(([name]) => !['base', '_acf_nonce', 'mtflpp_row_text_fields'].includes(name))
            : undefined;
        for (const name of rowFields) {
            const formatted = rowDisplayText?.[name];
            if (typeof formatted === 'string') displayValues[name] = { ...displayValues[name], formatted };
        }
        return { ...preview, comparisonValues: displayValues, rowSubmission, stillMatches: () => {
            const current = capturePreview(followChanges);
            return current.data.toString() === data.toString() && (!followChanges
                || JSON.stringify(current.comparisonValues) === JSON.stringify(comparisonValues));
        } };
    };
    const preview = createLivePreview(config, nativeEditor, { inlineLauncher });
    function handleChange(notify) {
        if (capturing || destroyed) return;
        const reason = extensions?.filter('previewPauseReason', '') || extensions?.error?.message;
        const becameReady = nativeEditor.ready === false && !reason;
        nativeEditor.ready = !reason;
        nativeEditor.notReady = reason;
        nativeEditor.notReadyState = 'paused';
        if (extensions?.error) preview.resume(extensions.error);
        else if (reason) preview.pause(reason, 'paused');
        else if (becameReady) preview.resume();
        else notify();
    }
    const changed = (event) => handleChange(event?.type === 'change' && event.isTrusted && event.bubbles
        && ['text', 'search', 'email', 'url', 'tel', 'textarea'].includes(event.target?.type ?? '')
        ? preview.recheck : preview.changed);
    const acfFieldChanged = () => handleChange(preview.relatedChange);
    nativeEditor.onAutosave = changed;
    nativeEditor.beforePreview = () => {
        preview.pause(config.strings.nativePreview);
        return preview.pending;
    };
    nativeEditor.onPreview = (error, saved) => {
        error = extensions.filter('nativePreviewHandoffError', error, saved);
        preview.resume(extensions.error || error);
    };
    function watchEditor(editor) {
        if (destroyed || !editor || editors.has(editor)) return;
        editors.add(editor);
        editor.on('input change undo redo SetContent', changed);
    }
    if (window.tinymce) {
        window.tinymce.editors.forEach(watchEditor);
        window.tinymce.on('AddEditor', onEditorAdded);
    }
    function onEditorAdded(event) { watchEditor(event.editor); }
    // Core may load TinyMCE after this entry, including on the first switch from Text to Visual.
    window.jQuery?.(document).on('tinymce-editor-init.mtflppClassicEditor', onEditorInitialized);
    function onEditorInitialized(event, editor) { watchEditor(editor); }
    function cancelNativeSave() {
        if (!nativeEditor.saving) return;
        nativeEditor.saving = false;
        changed();
    }
    nativeEditor.onSaveCancelled = cancelNativeSave;
    extensions = createEditorExtensions('mtflpp.classicEditor.previewSetup', {
        config, form, changed, acfFieldChanged, watchEditor, cancelNativeSave,
    });
    const destroyNative = nativeEditor.destroy;
    nativeEditor.destroy = () => {
        if (destroyed) return;
        destroyed = true;
        extensions.destroy();
        form.removeEventListener('input', onFieldChange);
        form.removeEventListener('change', onFieldChange, true);
        form.removeEventListener('click', onSaveClick, true);
        form.removeEventListener('submit', onSaveSubmit, true);
        window.removeEventListener('pagehide', onPageHide);
        window.tinymce?.off('AddEditor', onEditorAdded);
        window.jQuery?.(document).off('tinymce-editor-init.mtflppClassicEditor', onEditorInitialized);
        for (const editor of editors) editor.off('input change undo redo SetContent', changed);
        editors.clear();
        destroyNative?.();
    };
    function onPageHide(event) { if (!event.persisted) nativeEditor.destroy(); }
    window.addEventListener('pagehide', onPageHide);
    nativeEditor.isValidating = () => extensions.filter('nativeSaveValidationPending', false);
    function onFieldChange(event) {
        if (event.target.name === 'post_title') preview.setTitle(event.target.value);
        if (['post_title', 'content', 'excerpt'].includes(event.target.name)) changed(event);
    }
    nativeEditor.onFieldChange = onFieldChange;
    form.addEventListener('input', onFieldChange);
    // Quicktags emits non-bubbling native change events after toolbar and media insertions.
    form.addEventListener('change', onFieldChange, true);

    let drainingNativeSave = false;
    function continueNativeSave(event, resume) {
        if (event.defaultPrevented) return;
        if (drainingNativeSave) {
            nativeEditor.deferredSaves?.add(event);
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (nativeEditor.saving) return;
        nativeEditor.saving = true;
        preview.pause();
        const pending = preview.pending || (nativeEditor.previewing ? nativeEditor.idle : null);
        if (!pending) return;
        nativeEditor.deferredSaves?.add(event);
        event.preventDefault();
        event.stopImmediatePropagation();
        drainingNativeSave = true;
        const proceed = () => {
            drainingNativeSave = false;
            if (!destroyed && nativeEditor.saving) resume();
        };
        pending.then(proceed, proceed);
    }
    function onSaveClick(event) {
        const control = event.target.closest('#publish, #save-post');
        if (control && !control.disabled && !control.classList.contains('disabled')) {
            continueNativeSave(event, () => control.click());
        }
    }
    function onSaveSubmit(event) {
        if (form.querySelector('#wp-preview')?.value === 'dopreview') return;
        continueNativeSave(event, () => form.requestSubmit(event.submitter || undefined));
    }
    form.addEventListener('click', onSaveClick, true);
    form.addEventListener('submit', onSaveSubmit, true);
    changed();
    if (!extensions.error) preview.start();
}
