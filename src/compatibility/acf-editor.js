import { initAcf } from './acf-fields.js';
import { createBlockEditorAcf } from './acf-block-editor.js';

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
export function markAcfPlainText(values) {
    for (const [name, hint] of values) {
        if (name.startsWith('acf[') && hint?.type === 'text') values.set(name, { ...hint, acfPlainText: true });
    }
    return values;
}

export function setupBlockEditorAcf(config, changed) {
    if (checkAcf(config)) return createBlockEditorAcf(changed);
}

export function setupClassicEditorAcf({ config, form, changed, acfFieldChanged, watchEditor, cancelNativeSave }) {
    if (!checkAcf(config)) return;
    const fields = initAcf(form, changed, watchEditor, cancelNativeSave, acfFieldChanged);
    const acf = window.acf;
    let waiting = false;
    let listening = false;
    const onReady = () => { waiting = false; changed(); };
    const onInput = (event) => { if (fields.isField(event.target)) changed(event); };
    function destroy() {
        form.removeEventListener('input', onInput);
        form.removeEventListener('change', onInput, true);
        try { if (listening) acf.removeAction('ready', onReady); }
        finally { fields.destroy(); }
    }
    try {
        if (typeof acf.didAction === 'function' && !acf.didAction('ready')) {
            // Conditional logic disables controls during initial field setup.
            listening = waiting = true;
            acf.addAction('ready', onReady, 100);
        }
        form.addEventListener('input', onInput);
        form.addEventListener('change', onInput, true);
    } catch (error) {
        destroy();
        throw error;
    }
    return {
        get ready() { return !waiting; },
        isValidating: () => fields.isValidating(),
        appendFormFields(body, values) {
            for (const [name, value] of values) {
                // Template rows are never submitted, even without readiness tracking.
                if (typeof value === 'string' && fields.accepts(name) && !name.includes('[acfcloneindex]')) {
                    body.append(name, value);
                }
            }
        },
        comparisonValues: (values, body) => fields.layoutOrders(markAcfPlainText(values), body),
        nativePreviewError(error, saved) {
            // Row deltas still refer to the pre-Preview draft after native Preview saves structural edits.
            return error || (saved && fields.hasStructuralPaginationChanges()
                ? Object.assign(new Error(config.strings.nativePreviewAcf), { code: 'mtflpp_acf_rows_stale' }) : undefined);
        },
        destroy,
    };
}
