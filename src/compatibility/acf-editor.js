import { addAction } from '@wordpress/hooks';
import { initAcf } from './acf-fields.js';
import { createBlockEditorAcf } from './acf-block-editor.js';

const namespace = 'meet-the-frontend-live-preview-panel/acf';

// Disabled integrations are inert; an enabled integration with missing APIs must not discard fields.
function checkAcf(config) {
    if (!config.acfEnabled) return false;
    if (typeof window.acf?.addAction !== 'function' || typeof window.acf?.removeAction !== 'function'
        || typeof window.jQuery !== 'function') {
        throw Object.assign(new Error(config.strings.acfUnavailable), { code: 'mtflpp_integration_failed' });
    }
    return true;
}

addAction('mtflpp.blockEditor.previewSetup', namespace, ({ config, changed, hooks, onDestroy }) => {
    if (!checkAcf(config)) return;
    const fields = createBlockEditorAcf(changed);
    onDestroy(() => fields.destroy());
    hooks.addAction('observePreviewInputs', namespace, () => fields.observe());
    hooks.addAction('nativeMetaboxSaveAcknowledged', namespace, () => fields.saved());
    hooks.addFilter('previewPauseReason', namespace, (reason) => reason || (fields.ready ? '' : config.strings.acfRefreshing));
    hooks.addFilter('previewFormBody', namespace, (body) => {
        body ??= new URLSearchParams();
        for (const [name, value] of fields.capture()) body.append(name, value);
        return body;
    });
});

addAction('mtflpp.classicEditor.previewSetup', namespace, ({
    config, form, changed, watchEditor, cancelNativeSave, hooks, onDestroy,
}) => {
    if (!checkAcf(config)) return;
    const fields = initAcf(form, changed, watchEditor, cancelNativeSave);
    onDestroy(() => fields.destroy());
    const onInput = (event) => { if (fields.isField(event.target)) changed(); };
    form.addEventListener('input', onInput);
    form.addEventListener('change', onInput, true);
    onDestroy(() => {
        form.removeEventListener('input', onInput);
        form.removeEventListener('change', onInput, true);
    });
    hooks.addFilter('nativeSaveValidationPending', namespace, (validating) => validating || fields.isValidating());
    hooks.addFilter('previewFormBody', namespace, (body, values) => {
        for (const [name, value] of values) {
            if (typeof value === 'string' && fields.accepts(name)) body.append(name, value);
        }
        return body;
    });
    hooks.addFilter('nativePreviewHandoffError', namespace, (error, saved) => {
        // Row deltas still refer to the pre-Preview draft after native Preview saves structural edits.
        return error || (saved && fields.hasStructuralPaginationChanges()
            ? Object.assign(new Error(config.strings.nativePreviewAcf), { code: 'mtflpp_source_changed' }) : undefined);
    });
});
