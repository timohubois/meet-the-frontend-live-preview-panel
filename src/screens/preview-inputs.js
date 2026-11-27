// Integration errors pause preview writes without rejecting a native editor save.
export function guardPreviewInputs(config) {
    let failure;
    return {
        get error() { return failure; },
        run(read) {
            if (failure) return;
            try { return read(); }
            catch (error) {
                failure = error?.code === 'mtflpp_integration_failed' ? error
                    : Object.assign(new Error(config.strings.integrationFailed), {
                        code: 'mtflpp_integration_failed', cause: error,
                    });
            }
        },
    };
}

// Use the submitted values, not whatever happens to be in the editor when the preview finishes.
export function submittedValues(body, coreValues, root) {
    const result = new Map(Object.entries(coreValues));
    if (!body) return result;
    try {
        const hidden = new Set();
        for (const control of root.querySelectorAll('input[name], textarea[name], select[name]')) {
            if (result.has(control.name) || !body.has(control.name) || control.type === 'password') continue;
            if (control.type === 'hidden') {
                hidden.add(control.name);
                continue;
            }
            const textual = control.localName === 'textarea'
                || ['text', 'search', 'email', 'url', 'tel'].includes(control.type);
            const submitted = body.getAll(control.name);
            let type = 'value';
            if (textual && submitted.length === 1) type = control.classList.contains('wp-editor-area') ? 'html' : 'text';
            result.set(control.name, { type, value: submitted.length === 1 ? submitted[0] : JSON.stringify(submitted) });
        }
        // Repeated hidden values can corroborate order, never a text match or ordinary edit.
        for (const name of hidden) {
            if (result.has(name)) continue;
            const submitted = body.getAll(name);
            if (submitted.length > 1) result.set(name, {
                type: 'order', value: JSON.stringify(submitted), members: JSON.stringify(submitted.sort()),
            });
        }
    } catch { /* Comparison evidence cannot prevent an otherwise valid preview. */ }
    return result;
}
