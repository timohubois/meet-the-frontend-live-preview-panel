import { addAction } from '@wordpress/hooks';

const namespace = 'meet-the-frontend-live-preview-panel/flynt';
const attribute = 'data-mtflpp-evidence-flynt-row';

addAction('mtflpp.classicEditor.previewSetup', namespace, ({ config, hooks }) => {
    if (!config.flyntRows) return;
    hooks.addFilter('previewFormBody', namespace, (body, _values, followingParams) => {
        if (followingParams && [...body.keys()].some((name) => name.startsWith('acf[') && name.endsWith('[acf_fc_layout]'))) {
            followingParams.set('mtflpp_row_markers', '1');
        }
        return body;
    }, 20);
    hooks.addFilter('previewResponseComparisonValues', namespace, (values, response) => {
        if (!response.rowMarkers) return values;
        return Object.fromEntries(Object.entries(values).map(([key, hint]) => [
            key, hint?.type === 'row-order' && response.rowMarkers[key]
                ? { ...hint, flyntMarkers: response.rowMarkers[key] } : hint,
        ]));
    });
    hooks.addFilter('previewRenderedRegions', namespace, (proposal, context) => proposal ?? resolveFlyntRegions(context));
});

export function resolveFlyntRegions({ sourceDocument, document, values, subject, order }) {
    const markers = values[subject]?.flyntMarkers;
    if (!markers || order.some((row) => !/^[a-f0-9]{64}$/.test(markers[row]))) return null;
    const rows = new Map(order.map((row) => [markers[row], row]));
    if (rows.size !== order.length) return null;
    function collect(doc) {
        const rendered = new Map();
        for (const node of doc.querySelectorAll(`[${attribute}]`)) {
            const [key, index] = node.getAttribute(attribute).split(':');
            const row = rows.get(key);
            if (!row) continue;
            if (!rendered.has(row)) rendered.set(row, []);
            const roots = rendered.get(row);
            // A duplicated render restarts at zero, even when the copies are adjacent.
            if (String(roots.length) !== index) return null;
            roots.push(node);
        }
        return rendered;
    }
    const captured = collect(sourceDocument), live = collect(document);
    if (!captured || !live || captured.size !== live.size) return null;
    for (const [row, roots] of captured) if (live.get(row)?.length !== roots.length) return null;
    return new Map([...captured].map(([row, roots]) => [row, roots.map((node, i) => [node, live.get(row)[i]])]));
}
