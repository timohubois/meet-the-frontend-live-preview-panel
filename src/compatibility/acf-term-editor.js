import { initAcf } from './acf-fields.js';

export function setupAcfTermEditor(config, form, changed) {
    if (!config.acfTermEnabled || !form.querySelector('[name="_acf_nonce"]')) return;
    const { acf, jQuery, tinymce } = window;
    const unavailable = () => Object.assign(new Error(config.strings.acfUnavailable), { code: 'mtflpp_acf_unavailable' });
    if (typeof acf?.serialize !== 'function' || typeof acf.addAction !== 'function'
        || typeof acf.removeAction !== 'function' || typeof jQuery !== 'function') throw unavailable();

    const editors = new Set();
    const editorEvents = 'input change undo redo SetContent';
    function watchEditor(editor) {
        const textarea = editor?.getElement?.();
        if (!textarea?.name?.startsWith('acf[') || !form.contains(textarea) || editors.has(editor)) return;
        editors.add(editor);
        editor.on(editorEvents, changed);
        editor.on('remove', () => {
            editors.delete(editor);
            editor.off(editorEvents, changed);
        });
    }
    const fields = initAcf(form, changed, watchEditor);
    for (const editor of tinymce?.editors ?? []) watchEditor(editor);
    const documentEvents = jQuery(form.ownerDocument);
    const editorInit = 'tinymce-editor-init.mtflppAcfTerm';
    documentEvents.on(editorInit, (event, editor) => watchEditor(editor));
    const onInput = (event) => { if (fields.isField(event.target)) changed(); };
    form.addEventListener('input', onInput);
    form.addEventListener('change', onInput, true);

    return {
        capture() {
            const restore = [];
            try {
                // Read Visual content while serializing, without saving the editor or changing its native form state.
                for (const editor of editors) {
                    const textarea = editor.getElement();
                    if (!textarea || !form.contains(textarea) || !editor.getBody() || editor.isHidden()) continue;
                    restore.push([textarea, textarea.value]);
                    textarea.value = editor.getContent();
                }
                const { acf: values, _acf_nonce, _acf_fields } = acf.serialize(jQuery(form));
                if (!values) return {};
                if (!_acf_nonce) throw unavailable();
                return { acf: values, _acf_nonce, _acf_fields };
            } finally {
                for (const [textarea, value] of restore) textarea.value = value;
            }
        },
        destroy() {
            fields.destroy();
            documentEvents.off(editorInit);
            form.removeEventListener('input', onInput);
            form.removeEventListener('change', onInput, true);
            for (const editor of editors) editor.off(editorEvents, changed);
            editors.clear();
        },
    };
}
