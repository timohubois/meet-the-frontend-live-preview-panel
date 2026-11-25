// Optional integration: report changes to core; never refresh or save independently.
export function initAcf(form, changed, watchEditor, cancelNativeSave) {
    const acf = window.acf;
    acf.addAction('wysiwyg_tinymce_init', watchEditor);
    for (const action of ['append', 'remove', 'sortstop', 'change_field']) acf.addAction(action, changed);
    const validationFailure = ($form) => {
        if ($form[0] === form) cancelNativeSave?.();
    };
    acf.addAction('validation_failure', validationFailure);

    function isField(target) {
        return !!target?.closest?.('.acf-field');
    }

    let movedLayout;
    // Native input/change events belong to the coordinator; bridge jQuery-only events and row sorting.
    window.jQuery(form).on('input.mtflppAcf change.mtflppAcf sortupdate.mtflppAcf', (event, ui) => {
        if (!isField(event.target)) return;
        if (event.type === 'sortupdate') {
            movedLayout = ui?.item?.[0]?.querySelector(':scope > input[type="hidden"][name$="[acf_fc_layout]"]')?.name;
        }
        if (!event.originalEvent || event.type === 'sortupdate') changed();
    });

    return {
        isField,
        isValidating() { return !!form.classList?.contains('is-validating'); },
        hasStructuralPaginationChanges() {
            // Value reads do not describe pending paginated row deltas; do not reconstruct ACF's row state.
            return !!form.querySelector(
                '.acf-repeater[data-pagination="1"] .acf-row:is(.acf-added, .acf-inserted, .acf-reordered, .acf-deleted)'
            );
        },
        accepts(name) {
            return name === '_acf_nonce' || name.startsWith('acf[') || name.startsWith('_acf_fields[');
        },
        layoutOrders(values, body) {
            // ACF moves the named controls without renumbering them. Use the exact submitted order.
            const groups = new Map(), fields = new Map(), disabled = new Set();
            for (const [name, value] of body) {
                if (value === '1' && name.endsWith('[acf_fc_layout_disabled]')) {
                    disabled.add(name.replace(/\[acf_fc_layout_disabled\]$/, '[acf_fc_layout]'));
                }
                const field = name.match(/^(acf\[.+)\[[^\]]+\]\[acf_fc_layout\]$/)?.[1];
                if (!field) continue;
                if (!groups.has(field)) groups.set(field, []);
                groups.get(field).push(name);
                fields.set(name, []);
            }
            const enclosingRows = (name) => Array.from(name.matchAll(/\]\[/g), ({ index }) => `${name.slice(0, index + 1)}[acf_fc_layout]`);
            function enabledRow(name) {
                const rows = enclosingRows(name);
                if (!rows.some((row) => disabled.has(row))) return rows.findLast((row) => fields.has(row));
            }
            // A nested text control belongs to its enclosing rows, unless a layout on its path is disabled.
            for (const [name, hint] of values) {
                if (!name.startsWith('acf[') || !['text', 'html'].includes(hint.type)) continue;
                const rows = enclosingRows(name);
                if (rows.some((row) => disabled.has(row))) continue;
                for (const row of rows) fields.get(row)?.push(name);
            }
            // Only dedicated image controls can supply a label for the exact submitted attachment.
            for (const uploader of form.querySelectorAll('.acf-field[data-type="image"] .acf-image-uploader.has-value')) {
                const control = uploader.querySelector(':scope > input[type="hidden"][name]');
                const image = uploader.querySelector(':scope > .image-wrap > img[data-name="image"]');
                const name = control?.name;
                if (!name?.startsWith('acf[') || !image || control.matches(':disabled') || uploader.closest('.acf-clone')) continue;
                const submitted = body.getAll(name);
                if (submitted.length !== 1 || submitted[0] !== control.value || !/^[1-9]\d*$/.test(submitted[0])) continue;
                const row = enabledRow(name);
                if (!row) continue;
                fields.get(row).push(name);
                values.set(name, { type: 'row-image', value: submitted[0], alt: image.alt });
            }
            for (const gallery of form.querySelectorAll('.acf-field[data-type="gallery"] .acf-gallery')) {
                const control = gallery.querySelector(':scope > input[type="hidden"][name]');
                const name = control?.name;
                if (!name?.startsWith('acf[') || control.matches(':disabled') || gallery.closest('.acf-clone')) continue;
                const key = `${name}[]`, empty = body.getAll(name), ids = body.getAll(key);
                if (enclosingRows(name).some((row) => disabled.has(row)) || empty.length !== 1 || empty[0] !== ''
                    || ids.some((id) => !/^[1-9]\d*$/.test(id))) continue;
                const controls = [...gallery.querySelectorAll(':scope > .acf-gallery-main > .acf-gallery-attachments > .acf-gallery-attachment > input[type="hidden"][name]')];
                if (controls.length !== ids.length || controls.some((item, i) => item.name !== key || item.value !== ids[i]
                    || item.matches(':disabled'))) continue;
                // The full name identifies the occurrence, even when neighboring rows share a field key.
                values.set(key, { type: 'gallery-order', value: JSON.stringify(ids), members: JSON.stringify([...ids].sort()) });
            }
            for (const [field, submitted] of groups) {
                // Disabled layouts remain in the request but cannot occupy a rendered position.
                const order = submitted.filter((name) => !disabled.has(name));
                if (order.length < 2 || new Set(order).size !== order.length) continue;
                const moved = order.includes(movedLayout) ? movedLayout : undefined;
                values.set(`acf-layout-order:${field}`, {
                    type: 'row-order', value: JSON.stringify(order), members: JSON.stringify([...order].sort()), moved,
                    fieldsByRow: Object.fromEntries(order.map((row) => [row, fields.get(row)])),
                });
            }
            return values;
        },
        destroy() {
            acf.removeAction('wysiwyg_tinymce_init', watchEditor);
            for (const action of ['append', 'remove', 'sortstop', 'change_field']) acf.removeAction(action, changed);
            acf.removeAction('validation_failure', validationFailure);
            window.jQuery(form).off('.mtflppAcf');
        },
    };
}
