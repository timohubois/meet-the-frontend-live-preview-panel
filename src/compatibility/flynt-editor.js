const attribute = 'data-mtflpp-evidence-flynt-row';

export function requestFlyntRowMarkers(body) {
    for (const name of body.keys()) if (name.startsWith('acf[') && name.endsWith('[acf_fc_layout]')) {
        body.set('mtflpp_row_markers', '1');
        return;
    }
}

export function addFlyntRowMarkers(values, markers) {
    if (!markers) return;
    for (const [key, hint] of Object.entries(values)) {
        if (hint?.type === 'row-order' && markers[key]) values[key] = { ...hint, flyntMarkers: markers[key] };
    }
}

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
