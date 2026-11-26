import { normalizedText } from './snapshot.js';

const attribute = (entry, key) => entry.attributes.find(([name]) => name === key)?.[1];

export function duplicateIds(doc) {
    const seen = new Set(), duplicates = new Set();
    for (const { id } of doc.querySelectorAll('[id]')) {
        if (seen.has(id)) duplicates.add(id);
        seen.add(id);
    }
    return duplicates;
}

// Captured output only. A generated index doesn't explain a move; a verified move can explain an index.
export function markRowNavigationEchoes(changes, previous, next) {
    const moves = changes.filter((item) => item.moved);
    if (moves.length !== 1 || !moves[0].unchangedRows || changes.length < 2) return;
    const [origin, destination] = moves[0].moved;
    const oldDoc = origin.node?.ownerDocument, doc = destination.node?.ownerDocument;
    // A base URL can send a literal fragment link to a different document.
    if (!oldDoc || !doc || !previous.duplicateIds || !next.duplicateIds
        || oldDoc.querySelector('base[href]') || doc.querySelector('base[href]')) return;
    const oldRows = origin.parent.children, rows = destination.parent.children;
    if (oldRows.length !== rows.length) return;
    const rotation = oldRows.map((_, index) => index);
    const from = oldRows.indexOf(origin), to = rows.indexOf(destination);
    rotation.splice(to, 0, ...rotation.splice(from, 1));
    const oldTargets = rowTargets(oldRows, oldDoc, previous.duplicateIds);
    const targets = rowTargets(rows, doc, next.duplicateIds);
    const lists = new Map(), echoes = new Map();
    for (const change of changes) {
        const pairs = navigationPairs(change);
        if (pairs) echoes.set(change, pairs);
    }
    for (const [before, after] of [...echoes.values()].flat()) {
        if (after.tag === 'select') continue;
        const oldLinks = fragmentLinks(before), links = fragmentLinks(after);
        if (!oldLinks || !links || !sameItems(oldLinks, links)) continue;
        const oldOrder = oldLinks.map(({ id }) => oldTargets.get(id));
        const order = links.map(({ id }) => targets.get(id));
        if (!ordered(oldOrder) || !ordered(order) || !oldOrder.includes(from)
            || oldLinks.every(({ id }, i) => id === links[i].id)
            || links.some(({ id }, i) => rotation[order[i]] !== oldTargets.get(id))) continue;
        lists.set(after, { before, oldLinks, links });
    }
    for (const [change, pairs] of echoes) change.rowNavigationEcho = pairs.every(([before, after]) => {
        if (after.tag !== 'select') return lists.has(after);
        // Native options are not links. Require an unambiguous sibling link rendering of the same list.
        const peers = [...lists].filter(([list, peer]) => list.parent === after.parent && peer.before.parent === before.parent);
        if (peers.length !== 1) return false;
        const { oldLinks, links } = peers[0][1];
        const oldOptions = selectOptions(before, oldLinks), options = selectOptions(after, links);
        return oldOptions && options && sameItems(oldOptions, options);
    });
}

function navigationPairs({ unresolved, after, oldRange, newRange }) {
    if (!unresolved || !oldRange.length || oldRange.length !== newRange.length) return;
    const isList = ({ tag }) => ['ul', 'ol', 'select'].includes(tag);
    // Adjacent anonymous lists may share one unaligned range rather than two list boundaries.
    const pairs = isList(after) ? [[oldRange[0].parent, after]] : oldRange.map((entry, i) => [entry, newRange[i]]);
    if (pairs.every(([a, b]) => isList(b) && a.signature === b.signature && a.presentation === b.presentation
        && a.references === b.references && a.rawText === b.rawText)) return pairs;
}

function rowTargets(rows, liveDocument, sourceDuplicates) {
    const liveDuplicates = duplicateIds(liveDocument);
    const targets = new Map();
    function visit(entry, row, index) {
        const id = attribute(entry, 'id');
        if (id && !sourceDuplicates.has(id) && !liveDuplicates.has(id) && entry.node?.isConnected
            && entry.node.id === id && row.node?.contains(entry.node)) targets.set(id, index);
        for (const child of entry.children) visit(child, row, index);
    }
    rows.forEach((row, index) => visit(row, row, index));
    return targets;
}

function ordered(indices) {
    return indices.length > 1 && indices.every((index, i) => index !== undefined && (!i || indices[i - 1] < index));
}

function fragmentId(href) {
    if (!href?.startsWith('#') || href.length === 1) return;
    try { return decodeURIComponent(href.slice(1)); }
    catch { return undefined; }
}

function fragmentLinks(list) {
    if (!list.node?.isConnected) return;
    const result = [];
    for (const [i, item] of list.children.entries()) {
        const [link] = item.children;
        if (item.tag !== 'li' || item.text || item.children.length !== 1 || link.tag !== 'a') return;
        const id = fragmentId(attribute(link, 'href'));
        if (!id || !list.node?.contains(link.node) || fragmentId(link.node.getAttribute('href')) !== id) return;
        const { key, label } = describe(item, i + 1);
        if (!label) return;
        result.push({ id, key, label, link });
    }
    return result;
}

function selectOptions(select, links) {
    if (!select.node?.isConnected || select.children.length !== links.length) return;
    const options = [];
    let destinationAttributes;
    for (const [i, option] of select.children.entries()) {
        const { id, link, label } = links[i];
        if (option.tag !== 'option' || !select.node?.contains(option.node)) return;
        const item = describe(option, i + 1), value = attribute(option, 'value');
        if (value !== (option.node.getAttribute('value') ?? undefined)) return;
        // Require the same kind of destination witness for every option. A data attribute
        // carries no meaning alone: its value must also match the verified fragment on the link.
        let witnesses;
        if (value !== undefined) {
            if (fragmentId(value) !== id) return;
            witnesses = ['value'];
        } else {
            witnesses = option.attributes.filter(([name, data]) => name.startsWith('data-') && data === id
                && attribute(link, name) === id && option.node.getAttribute(name) === id && link.node.getAttribute(name) === id)
                .map(([name]) => name);
        }
        destinationAttributes = destinationAttributes?.filter((name) => witnesses.includes(name)) ?? witnesses;
        if (item.label !== label || !destinationAttributes.length) return;
        options.push({ id, key: item.key });
    }
    return options;
}

function sameItems(before, after) {
    const keys = new Map(before.map(({ id, key }) => [id, key]));
    return before.length === after.length && keys.size === before.length
        && new Set(after.map(({ id }) => id)).size === after.length && after.every(({ id, key }) => keys.get(id) === key);
}

function describe(entry, position) {
    let first = true, label = '';
    const ordinal = new RegExp(`^(\\s*)${position}(?=[.)](?:\\s|$)|\\s|$)`);
    function visit(node) {
        return [node.tag, node.presentation, node.references, node.media, node.parts.map((part) => {
            if (typeof part !== 'string') return visit(part);
            if (!first || !part.trim()) {
                label += part;
                return part;
            }
            first = false;
            const match = part.match(ordinal);
            if (!match) {
                label += part;
                return part;
            }
            label += part.slice(match[0].length).replace(/^[.)]/, '');
            // Preserve the rest of the text and markup, including authored prefixes and whitespace.
            return [match[1], part.slice(match[0].length)];
        })];
    }
    const key = JSON.stringify(visit(entry));
    return { key, label: normalizedText(label) };
}
