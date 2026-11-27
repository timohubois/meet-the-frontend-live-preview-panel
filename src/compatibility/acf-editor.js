import { addAction } from '@wordpress/hooks';
import { initAcf } from './acf-fields.js';
import { createBlockEditorAcf } from './acf-block-editor.js';

const namespace = 'meet-the-frontend-live-preview-panel/acf';

addAction('mtflpp.blockEditor.previewSetup', namespace, setupBlockEditorAcf);
addAction('mtflpp.classicEditor.previewSetup', namespace, setupClassicEditorAcf);

// Disabled integrations are inert; an enabled integration with missing APIs must not discard fields.
function checkAcf(config) {
    if (!config.acfEnabled) return false;
    if (typeof window.acf?.addAction !== 'function' || typeof window.acf?.removeAction !== 'function'
        || typeof window.jQuery !== 'function') {
        throw Object.assign(new Error(config.strings.acfUnavailable), { code: 'mtflpp_integration_failed' });
    }
    return true;
}

// Keep ordinary hint types intact; only the exact-text fallback uses this provenance.
function markAcfPlainText(values) {
    for (const [name, hint] of values) {
        if (name.startsWith('acf[') && hint?.type === 'text') values.set(name, { ...hint, acfPlainText: true });
    }
    return values;
}

function setupBlockEditorAcf({ config, changed, hooks, onDestroy }) {
    if (!checkAcf(config)) return;
    const fields = createBlockEditorAcf(changed);
    onDestroy(() => fields.destroy());
    hooks.addAction('observePreviewInputs', namespace, () => fields.observe());
    hooks.addAction('nativeMetaboxSaveAcknowledged', namespace, () => fields.saved());
    hooks.addFilter('previewComparisonValues', namespace, markAcfPlainText);
    hooks.addFilter('previewPauseReason', namespace, (reason) => reason || (fields.ready ? '' : config.strings.acfRefreshing));
    hooks.addFilter('previewFormBody', namespace, (body) => {
        for (const [name, value] of fields.capture()) {
            body ??= new URLSearchParams();
            body.append(name, value);
        }
        return body;
    });
}

function setupClassicEditorAcf({ config, form, changed, acfFieldChanged, watchEditor, cancelNativeSave, hooks, onDestroy }) {
    if (!checkAcf(config)) return;
    const fields = initAcf(form, changed, watchEditor, cancelNativeSave, acfFieldChanged);
    onDestroy(() => fields.destroy());
    const acf = window.acf;
    if (typeof acf.didAction === 'function' && !acf.didAction('ready')) {
        // Conditional logic disables controls during ACF's initial field setup.
        // Wait for that setup so the first preview uses the same successful controls as later edits.
        let ready = false;
        const onReady = () => {
            ready = true;
            changed();
        };
        acf.addAction('ready', onReady, 100);
        onDestroy(() => acf.removeAction('ready', onReady));
        hooks.addFilter('previewPauseReason', namespace, (reason) => reason || (ready ? '' : config.strings.acfRefreshing));
    }
    const onInput = (event) => { if (fields.isField(event.target)) changed(event); };
    form.addEventListener('input', onInput);
    form.addEventListener('change', onInput, true);
    onDestroy(() => {
        form.removeEventListener('input', onInput);
        form.removeEventListener('change', onInput, true);
    });
    hooks.addFilter('nativeSaveValidationPending', namespace, (validating) => validating || fields.isValidating());
    hooks.addFilter('previewComparisonValues', namespace, (values, body) => fields.layoutOrders(markAcfPlainText(values), body));
    hooks.addFilter('previewFormBody', namespace, (body, values) => {
        for (const [name, value] of values) {
            // Template rows are never submitted, including on ACF versions without readiness tracking.
            if (typeof value === 'string' && fields.accepts(name) && !name.includes('[acfcloneindex]')) {
                body.append(name, value);
            }
        }
        return body;
    });
    hooks.addFilter('nativePreviewHandoffError', namespace, (error, saved) => {
        // Row deltas still refer to the pre-Preview draft after native Preview saves structural edits.
        return error || (saved && fields.hasStructuralPaginationChanges()
            ? Object.assign(new Error(config.strings.nativePreviewAcf), { code: 'mtflpp_acf_rows_stale' }) : undefined);
    });
}
