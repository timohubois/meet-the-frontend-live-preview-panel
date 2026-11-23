import { createLivePreview } from '../preview/live-preview.js';

export function initTermPreview(config, form, setupFields) {
    const nameField = '.term-name-wrap input[name="name"]';
    const descriptionField = '.term-description-wrap textarea[name="description"]';
    const editorEvents = 'input change undo redo SetContent';
    let editor;
    // Plugins can move or replace controls during startup. Read the current native rows on each refresh.
    function readFields() {
        const name = form.querySelector(nameField)?.value;
        const textarea = form.querySelector(descriptionField);
        // A wp_editor() replacement writes to its textarea on save; read Visual edits without saving.
        const visual = editor && editor.getElement() === textarea && editor.getBody() && !editor.isHidden();
        const description = visual ? editor.getContent() : textarea?.value;
        if (typeof name !== 'string' || typeof description !== 'string') {
            throw new Error(config.strings.bootFailed);
        }
        return { name, description };
    }
    let fields;
    const preview = createLivePreview(config, {
        title: readFields().name,
        async preparePreview() {
            const values = readFields();
            const extra = fields?.capture();
            const headers = { 'X-WP-Nonce': config.nonce };
            // JSON avoids PHP truncation of repeaters with many native form inputs.
            if (extra) headers['Content-Type'] = 'application/json';
            const response = await fetch(config.endpoint, {
                method: 'POST', credentials: 'same-origin', headers,
                body: extra ? JSON.stringify({ ...extra, ...values }) : new URLSearchParams(values),
            });
            const result = await response.json();
            if (!response.ok) throw Object.assign(new Error(result.message || config.strings.failed), { code: result.code });
            return {
                ...result,
                comparisonValues: {
                    name: { type: 'text', value: values.name },
                    description: { type: 'html', value: values.description },
                },
            };
        },
    });
    fields = setupFields?.(config, form, preview.changed);
    function changed(event) {
        if (event.target.matches(nameField)) preview.setTitle(event.target.value);
        else if (!event.target.matches(descriptionField)) return;
        preview.changed();
    }

    function richDescriptionChanged() { preview.changed(); }
    function watchDescription(candidate) {
        if (candidate?.id !== 'description' || candidate === editor || !form.contains(candidate.getElement())) return;
        editor?.off(editorEvents, richDescriptionChanged);
        editor = candidate;
        editor.on(editorEvents, richDescriptionChanged);
        richDescriptionChanged();
    }
    const documentEvents = window.jQuery?.(form.ownerDocument);
    documentEvents?.on('tinymce-editor-init.mtflppTermEditor', (event, candidate) => watchDescription(candidate));
    watchDescription(window.tinymce?.get('description'));
    window.addEventListener('pagehide', (event) => {
        if (event.persisted) return;
        editor?.off(editorEvents, richDescriptionChanged);
        documentEvents?.off('tinymce-editor-init.mtflppTermEditor');
        fields?.destroy();
    });
    form.addEventListener('input', changed);
    form.addEventListener('change', changed, true);
    preview.start();
}
