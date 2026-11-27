import { guardPreviewInputs, submittedValues } from './preview-inputs.js';
import { setupClassicEditorAcf } from '../compatibility/acf-editor.js';
import { addRowMarkers, requestRowMarkers, resolveRowRegions } from '../preview/row-evidence.js';
import { createLivePreview } from '../preview/live-preview.js';

// Classic fields and native form controls stay outside the shared preview lifecycle.
export function initLivePreview(config, nativeEditor, inlineLauncher) {
    const form = document.getElementById('post');
    if (!config || !form) return;
    let capturing = false;
    const inputs = guardPreviewInputs(config);
    let acf;
    const editors = new Set();
    let destroyed = false;
    nativeEditor.title = document.getElementById('title')?.value ?? config.postTitle;
    function capturePreview(followChanges) {
        if (destroyed) throw new Error('This editor session has ended.');
        capturing = true;
        let values;
        try {
            window.tinymce?.triggerSave();
            values = new FormData(form);
        } finally { capturing = false; }
        const data = new URLSearchParams();
        for (const [name, value] of values) {
            if (typeof value === 'string' && ['post_title', 'content', 'excerpt'].includes(name)) data.append(name, value);
        }
        const coreValues = Object.fromEntries([...data].map(([key, value]) => [
            key, { type: key === 'post_title' ? 'text' : 'html', value },
        ]));
        inputs.run(() => acf?.appendFormFields(data, values));
        if (inputs.error) throw inputs.error;
        let hints = submittedValues(data, coreValues, form);
        try { hints = acf?.comparisonValues(hints, data) ?? hints; }
        catch { /* Optional hints do not prevent a valid preview. */ }
        const comparisonValues = Object.fromEntries(hints);
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
        // Preserve the actual submitted controls (including hidden and repeated values), not optional evidence.
        const rowSubmission = followChanges && Object.values(comparisonValues).some((hint) => hint?.type === 'row-order')
            ? [...data].filter(([name]) => !['base', '_acf_nonce', 'mtflpp_row_text_fields'].includes(name))
            : undefined;
        if (followChanges && config.previewRowEvidence) requestRowMarkers(data);
        return { data, comparisonValues, rowFields, rowSubmission };
    }
    nativeEditor.preparePreview = async (followChanges) => {
        const { data, comparisonValues, rowFields, rowSubmission } = capturePreview(followChanges);
        const response = await fetch(config.endpoint, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'X-WP-Nonce': config.nonce }, body: data,
        });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.message || config.strings.failed), { code: result.code });
        const displayValues = { ...comparisonValues };
        for (const name of rowFields) {
            const formatted = result.rowDisplayText?.[name];
            if (typeof formatted === 'string') displayValues[name] = { ...displayValues[name], formatted };
        }
        if (followChanges && config.previewRowEvidence) addRowMarkers(displayValues, result.rowMarkers);
        return { url: result.url, comparisonValues: displayValues, rowSubmission, stillMatches: () => {
            const current = capturePreview(followChanges);
            return current.data.toString() === data.toString() && (!followChanges
                || JSON.stringify(current.comparisonValues) === JSON.stringify(comparisonValues));
        } };
    };
    const preview = createLivePreview(config, nativeEditor, {
        inlineLauncher,
        resolveRenderedRegions: config.previewRowEvidence ? resolveRowRegions : undefined,
    });
    function handleChange(notify) {
        if (capturing || destroyed) return;
        const waiting = inputs.run(() => acf && !acf.ready);
        const reason = inputs.error?.message || (waiting ? config.strings.acfRefreshing : '');
        const becameReady = nativeEditor.ready === false && !reason;
        nativeEditor.ready = !reason;
        nativeEditor.notReady = reason;
        nativeEditor.notReadyState = 'paused';
        if (inputs.error) preview.resume(inputs.error);
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
        const acfError = inputs.run(() => acf?.nativePreviewError(error, saved));
        preview.resume(inputs.error || error || acfError);
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
    acf = inputs.run(() => setupClassicEditorAcf({
        config, form, changed, acfFieldChanged, watchEditor, cancelNativeSave,
    }));
    const destroyNative = nativeEditor.destroy;
    nativeEditor.destroy = () => {
        if (destroyed) return;
        destroyed = true;
        try { acf?.destroy(); } catch { /* Continue releasing native editor listeners. */ }
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
    nativeEditor.isValidating = () => inputs.run(() => acf?.isValidating()) ?? false;
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
    if (!inputs.error) preview.start();
}
