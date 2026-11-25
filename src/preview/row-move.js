import { childFlowText, containsEntry, contentSnapshot, entryText, isFlowBoundary, normalizedText, subtreeSnapshot } from './snapshot.js';

const CONFIRMED = 'confirmed';
const DO_NOT_INFER = 'do-not-infer';
const TRY_COLLECTION = 'try-collection';

// An order hint can name a moved item, but its claim must agree with both submitted snapshots.
export function inputRowMove(before, after, orderOnly) {
    if (!before || !after) return;
    const changes = Object.entries(after).filter(([key, next]) => next?.type === 'row-order'
        && before[key]?.type === 'row-order' && before[key].value !== next.value);
    if (changes.length !== 1) return;
    const [[key, next]] = changes;
    const old = before[key];
    if (!next.moved || next.members !== old.members) return;
    const a = JSON.parse(old.value), b = JSON.parse(next.value);
    const from = a.indexOf(next.moved), to = b.indexOf(next.moved);
    if (from === -1 || to === -1 || from === to || a.length !== b.length) return;
    const siblings = a.filter((_, i) => i !== from);
    b.splice(to, 1);
    if (!siblings.every((item, i) => item === b[i])) return;

    const evidence = { html: new Map(), peerLabels: new Map() };
    const groups = rowGroups(key, next.moved, siblings, before, after, evidence);
    const elements = [
        rowImageEvidence(old.fieldsByRow, next.fieldsByRow, next.moved, siblings, before, after),
        rowLinkEvidence(old.fieldsByRow, next.fieldsByRow, next.moved, siblings, before, after, evidence.html),
    ].filter(Boolean);
    const groupsFor = (row) => rowGroups(key, row, a.filter((item) => item !== row), before, after, evidence);
    // Most moves have a direct witness. Only inspect the whole collection for an otherwise unexplained source rotation.
    const peerGroups = orderOnly ? () => a.map((row) => row === next.moved ? [] : groupsFor(row)) : undefined;
    let boundaryGroups;
    if (orderOnly && !groups.length
        && hasNoRowContent(old, next.moved, before, evidence.html) && hasNoRowContent(next, next.moved, after, evidence.html)) {
        const crossed = siblings.slice(Math.min(from, to), Math.max(from, to)).map(groupsFor);
        if (crossed.every((labels) => labels.length)) boundaryGroups = crossed;
    }
    return { from, offset: to - from, count: a.length, groups, elements, peerGroups, boundaryGroups };
}

function hasNoRowContent(order, row, values, html) {
    // An image field still represents content when the attachment has an empty alt.
    return order.fieldsByRow?.[row]?.every((name) => rowFieldText(values[name], html)?.label === '');
}

function isEmptyLayout(entry) {
    return !entry.text && !entry.media?.some(Boolean)
        && !/^(?:a|button|input|select|textarea|form|details|img|video|audio|iframe|canvas|svg|object|embed)$/.test(entry.tag)
        && entry.children.every(isEmptyLayout);
}

function rowImageEvidence(oldFields, newFields, row, siblings, before, after) {
    if ([row, ...siblings].some((item) => !oldFields?.[item] || !newFields?.[item])) return;
    const fields = new Set(oldFields[row]), labels = new Set(), peerLabels = new Set(), peerIds = new Set();
    for (const [order, values] of [[oldFields, before], [newFields, after]]) {
        for (const name of siblings.flatMap((sibling) => order[sibling])) {
            const hint = values[name];
            if (hint?.type !== 'row-image') continue;
            peerIds.add(hint.value);
            peerLabels.add(hint.alt);
        }
    }
    for (const name of newFields[row]) {
        const old = before[name], next = after[name];
        if (!fields.has(name) || old?.type !== 'row-image' || next?.type !== 'row-image'
            || !/^[1-9]\d*$/.test(next.value) || old.value !== next.value || peerIds.has(next.value)) continue;
        const label = next.alt;
        if (label?.trim() && old.alt === label && !peerLabels.has(label)) labels.add(label);
    }
    if (labels.size) return { tag: 'img', keys: labels };
}

function linkKey(href, text) {
    const label = normalizedText(text);
    if (href && label) return JSON.stringify([href, label]);
}

function fieldLinkKeys(previous, hint, html) {
    if (previous?.type !== 'html' || hint?.type !== 'html') return;

    // Accept the entire field, never an incidental CTA taken from a longer passage.
    function soleLink(field) {
        let entry = field?.entry;
        while (entry && entry.tag !== 'a' && !entry.text && entry.children.length === 1) entry = entry.children[0];
        if (entry?.tag !== 'a') return;
        const href = entry.node.getAttribute('href'), key = linkKey(href, field.label);
        if (key) return { href, key };
    }
    const [link, formatted] = rowFieldVariants(hint, html, sameRowHtml(previous.formatted, hint.formatted, html)).map(soleLink);
    if (!link || soleLink(rowFieldText(previous, html))?.key !== link.key) return;
    const { href } = link;
    if (!href.trim() || href.trim() === '#') return;
    // Use a base only to validate relative destinations; compare the literal attribute, never fetch it.
    try { if (!['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(href, 'https://example.invalid/').protocol)) return; }
    catch { return; }
    return formatted?.href === href && formatted.key !== link.key ? [link.key, formatted.key] : [link.key];
}

function rowLinkEvidence(oldFields, newFields, row, siblings, before, after, html) {
    if ([row, ...siblings].some((item) => !oldFields?.[item] || !newFields?.[item])) return;
    const previousNames = new Set(oldFields[row]);
    const fields = newFields[row].filter((name) => previousNames.has(name))
        .map((name) => fieldLinkKeys(before[name], after[name], html)).filter(Boolean);
    if (!fields.length) return;

    const evidence = { tag: 'a', keys: new Set(fields.flat()) };
    for (const [order, values] of [[oldFields, before], [newFields, after]]) {
        for (const name of siblings.flatMap((sibling) => order[sibling])) {
            let hint = values[name];
            if (hint?.type === 'row-image') continue;
            // A plain textarea may render HTML. It can rule out a shared link, never identify the moved row as one.
            if (hint?.type === 'text') {
                if (!/<a\b/i.test(hint.value)) continue;
                hint = { type: 'html', value: hint.value };
            }
            const peer = rowFieldVariants(hint, html);
            if (!peer.length) return;
            for (const { entry } of peer) {
                for (const key of uniqueElementAnchors(entry, evidence).keys()) evidence.keys.delete(key);
            }
            if (!evidence.keys.size) return;
        }
    }
    // A sibling sharing either spelling rules out that field, not a different link from the moved row.
    const unshared = fields.filter((keys) => keys.every((key) => evidence.keys.has(key)));
    if (unshared.length) return { tag: 'a', keys: new Set(unshared.flat()) };
}

function uniqueElementAnchors(root, { tag, keys }) {
    const anchors = new Map(), text = new Map();
    function visit(entry) {
        if (entry.tag === tag) {
            const attribute = tag === 'img' ? 'alt' : 'href';
            const value = entry.attributes.find(([name]) => name === attribute)?.[1];
            const key = tag === 'img' ? value : linkKey(value, entryText(entry, text));
            if (keys.has(key)) anchors.set(key, anchors.has(key) ? null : entry);
        }
        entry.children.forEach(visit);
    }
    if (root) visit(root);
    return anchors;
}

function rowGroups(key, row, siblings, before, after, { html, peerLabels }) {
    const { fieldsByRow } = after[key], oldFields = before[key].fieldsByRow;
    if ([row, ...siblings].some((item) => !oldFields?.[item] || !fieldsByRow?.[item])) return [];
    const groups = [], previousNames = new Set(oldFields[row]);
    let peers;
    function submittedLabels(names, values) {
        if (peerLabels.has(names)) return peerLabels.get(names);
        const labels = new Set();
        function collect(entry, cache) {
            // A sibling can supply an exact element's text, even from inside a longer HTML field.
            labels.add(normalizedText(entryText(entry, cache)));
            for (const child of entry.children) collect(child, cache);
        }
        for (const name of names) {
            if (values[name]?.type === 'row-image') continue;
            const fields = rowFieldVariants(values[name], html);
            if (!fields.length) return null; // An unreadable sibling field cannot establish uniqueness.
            for (const field of fields) {
                if (field.entry) collect(field.entry, field.cache);
                else labels.add(field.label);
            }
        }
        peerLabels.set(names, labels);
        return labels;
    }
    function shared(label, blocks) {
        // Check each sibling in each submission, never a pool of different rows or snapshots.
        peers ??= siblings.flatMap((row) => [submittedLabels(oldFields[row], before), submittedLabels(fieldsByRow[row], after)]);
        return peers.some((peer) => !peer || peer.has(label) || (blocks.length && blocks.every((block) => peer.has(block))));
    }
    for (const name of fieldsByRow[row]) {
        const hint = after[name], previous = before[name];
        if (!previousNames.has(name) || !sameRowField(previous, hint, html)) continue;
        // An alternate spelling is evidence only when the native formatter returned it in both requests.
        const nativeMatch = sameRowHtml(previous.formatted, hint.formatted, html);
        for (const { entry, cache, label } of rowFieldVariants(hint, html, nativeMatch)) {
            if (!label) continue;
            if (!entry) {
                if (!shared(label, [])) groups.push([label]);
                continue;
            }
            const blocks = rowTextBlocks(entry, cache).map((block) => normalizedText(entryText(block, cache)));
            const anchors = uniqueRowAnchors(entry, new Set([label, ...blocks]), cache);
            // Rendering all the blocks as one label doesn't make them unique to this row.
            if (anchors.get(label)?.substantive && !shared(label, blocks.join(' ') === label ? blocks : [])) groups.push([label]);
            // Match authored blocks together without requiring an action-only paragraph.
            const witnesses = [...new Set(blocks.filter((text) => anchors.has(text)))];
            if (witnesses.length > 1 && witnesses.some((text) => anchors.get(text).substantive)
                && !shared(label, witnesses)) groups.push(witnesses);
        }
    }
    return groups;
}

function sameRowField(previous, next, html) {
    if (!previous || !next || previous.type !== next.type) return false;
    return next.type === 'html' ? sameRowHtml(previous.value, next.value, html) : previous.value === next.value;
}

function sameRowHtml(before, after, html) {
    if (before === after) return true;
    if (typeof before !== 'string' || typeof after !== 'string') return false;
    return comparableRowHtml(before, html)?.isEqualNode(comparableRowHtml(after, html)) ?? false;
}

// A rich-text editor can reserialize the field on the first drag. Compare its inert markup,
// not just its label: changed tags, attributes and whitespace within inline copy still matter.
function comparableRowHtml(value, html) {
    const field = rowFieldText({ type: 'html', value }, html);
    if (!field) return null;
    const root = field.document.documentElement.cloneNode(true);
    for (const node of root.querySelectorAll('*')) {
        if (node.style?.length) node.setAttribute('style', node.style.cssText);
        if (!isFlowBoundary(node.localName) || node.parentElement.closest('pre, textarea')) continue;
        for (const sibling of [node.previousSibling, node.nextSibling]) {
            if (sibling?.nodeType === 3 && /^[\t\r\n ]*\n[\t\r\n ]*$/.test(sibling.data)) sibling.remove();
        }
    }
    return root;
}

function rowFieldVariants(hint, html, includeFormatted = true) {
    const raw = rowFieldText(hint, html);
    if (!raw) return [];
    const formatted = includeFormatted && hint.type === 'html' && typeof hint.formatted === 'string'
        ? rowFieldText({ type: 'html', value: hint.formatted }, html) : null;
    return formatted ? [raw, formatted] : [raw];
}

function rowFieldText(hint, html) {
    if (typeof hint?.value !== 'string') return;
    if (hint.type === 'text') return { label: normalizedText(hint.value) };
    if (hint.type !== 'html') return;
    if (!html.has(hint.value)) {
        try {
            const doc = new DOMParser().parseFromString(hint.value, 'text/html');
            const entry = contentSnapshot(doc, doc, [], doc.body), cache = new Map();
            html.set(hint.value, { document: doc, entry, cache, label: normalizedText(entryText(entry, cache)) });
        } catch { html.set(hint.value, null); } // Unreadable formatted fields are optional evidence.
    }
    return html.get(hint.value);
}

function rowTextBlocks(entry, cache) {
    const blocks = entry.children.flatMap((child) => rowTextBlocks(child, cache));
    if (blocks.length || !/^(?:p|h[1-6]|li|d[dt]|blockquote|pre|figcaption)$/.test(entry.tag)) return blocks;
    return normalizedText(entryText(entry, cache)) ? [entry] : [];
}

// Classify the text that actually supplies an anchor, not the tag of its common wrapper.
function rowTextEvidence(entry, label, cache) {
    let evidence;
    // A literal symbol can be the whole field, but separators between actions aren't a content witness.
    if (entry.text === label || /[\p{L}\p{N}]/u.test(entry.text || '')) evidence = ownRowTextEvidence(entry, cache);
    for (const child of entry.children) {
        if (evidence === 'content') break;
        evidence = rowTextEvidence(child, label, cache) || evidence;
    }
    return evidence;
}

function ownRowTextEvidence(entry, cache) {
    let evidence = 'content';
    for (let current = entry; current; current = current.parent) {
        const role = current.attributes.find(([name]) => name === 'role')?.[1] ?? '';
        if (current.tag === 'button' || /(?:^|\s)button(?:\s|$)/.test(role)) return;
        if (current.tag !== 'a' && !/(?:^|\s)link(?:\s|$)/.test(role)) continue;
        const blocks = rowTextBlocks(current, cache);
        if (blocks.length < 2 || !blocks.some((block) => /^h[1-6]$/.test(block.tag))) return;
        const block = blocks.find((item) => item === entry || containsEntry(item, entry));
        if (!block) return;
        // A linked card's paragraph might itself be the CTA. It can corroborate, not identify.
        if (!/^h[1-6]$/.test(block.tag)) evidence = 'support';
    }
    return evidence;
}

function uniqueRowAnchors(root, labels, text = new Map()) {
    const anchors = new Map();
    function visit(entry) {
        const label = normalizedText(entryText(entry, text));
        if (labels.has(label)) {
            const previous = anchors.get(label);
            // Wrappers and their children can expose the same text; only separate branches are ambiguous.
            anchors.set(label, previous === undefined || (previous && containsEntry(previous, entry)) ? entry : null);
        }
        entry.children.forEach(visit);
    }
    if (root) visit(root);
    const matches = new Map();
    for (const [label, entry] of anchors) {
        const evidence = entry && rowTextEvidence(entry, label, text);
        if (evidence) matches.set(label, { entry, substantive: evidence === 'content' });
    }
    return matches;
}

// One verifier per snapshot pair: anchor uniqueness is document-wide, alignment is local to the sibling range.
export function createRowMoveVerifier(previous, next, move, { cleanSource, presentationKey }) {
    if (!move) return;
    // An image alt needs captured source; a literal authored link can also match two DOM snapshots.
    const elements = move.elements.filter(({ tag }) => cleanSource || tag === 'a');
    if (!move.groups.length && !elements.length && !(cleanSource && move.peerGroups)) return;
    let rowAnchors, elementAnchors, peerGroups, peerAnchors;

    function textAnchors(groups) {
        const labels = new Set(groups.flat(2));
        return [uniqueRowAnchors(previous, labels), uniqueRowAnchors(next, labels)];
    }

    function matchesRow(old, dest, groups, { elementHints = [], requireLink = false, peer = false } = {}) {
        let elementMatch = TRY_COLLECTION;
        if (elementHints.length) {
            elementAnchors ??= elementHints.map((hint) => ({
                keys: hint.keys, before: uniqueElementAnchors(previous, hint), after: uniqueElementAnchors(next, hint),
            }));
            for (const { keys, before, after } of elementAnchors) for (const key of keys) {
                const anchor = before.get(key), target = after.get(key);
                if (!anchor || !target) continue;
                if (!belongsTo(old, anchor) || !belongsTo(dest, target)) return DO_NOT_INFER;
                if (elementMatch !== CONFIRMED && (!requireLink || anchor.tag === 'a')) {
                    elementMatch = liveAnchorMatches(old, anchor, key, previous.excluded)
                        && liveAnchorMatches(dest, target, key, next.excluded) ? CONFIRMED : DO_NOT_INFER;
                }
            }
        }
        if (requireLink && elementMatch !== CONFIRMED) return DO_NOT_INFER;
        if (!groups.length) return elementMatch;
        const [oldAnchors, newAnchors] = peer ? peerAnchors : (rowAnchors ??= textAnchors(move.boundaryGroups ?? [move.groups]));
        const matched = new Map();
        let staleLabel = false;
        for (const label of new Set(groups.flat())) {
            const anchor = oldAnchors.get(label), target = newAnchors.get(label);
            if (!anchor || !target) continue;
            if (!belongsTo(old, anchor.entry) || !belongsTo(dest, target.entry)) return DO_NOT_INFER;
            // Renderers can keep the mapped element but replace the story inside it.
            if (!liveTextMatches(old, anchor.entry, label, previous.excluded) || !liveTextMatches(dest, target.entry, label, next.excluded)) {
                if (peer) return DO_NOT_INFER; // That peer no longer corroborates the inferred collection order.
                staleLabel = true;
                continue; // Another field can still identify the moved row directly.
            }
            matched.set(label, anchor.substantive && target.substantive);
        }
        if (elementMatch === CONFIRMED || groups.some((group) => group.every((label) => matched.has(label))
            && group.some((label) => matched.get(label)))) return CONFIRMED;
        return staleLabel || matched.size ? DO_NOT_INFER : elementMatch;
    }

    function matchesLiveSubtree(entry, excluded) {
        // Inference has no field witness of its own. Recheck just this row: either frame may have hydrated since capture.
        if (!inLiveRow(entry, entry.node, excluded)
            || entry.node.ownerDocument.defaultView.getComputedStyle(entry.node).visibility !== 'visible') return false;
        const live = subtreeSnapshot(entry.node, excluded);
        return presentationKey(live) === presentationKey(entry) && normalizedText(entryText(live)) === normalizedText(entryText(entry));
    }

    function collectionConfirmsMove(rotation) {
        if (!cleanSource || !move.peerGroups) return false;
        const oldParent = rotation.before[0].parent, parent = rotation.after[0].parent;
        const before = oldParent.children, after = parent.children;
        if (before.length !== move.count || after.length !== before.length) return false;
        const from = move.from, to = from + move.offset, start = Math.min(from, to);
        const old = before[from], dest = after[to];
        if (rotation.before[rotation.from] !== old || rotation.after[rotation.to] !== dest || isEmptyLayout(old)) return false;

        // Without a field witness in the moved section, verify the entire one-row-per-sibling mapping.
        // Ignore response-local IDs, but not changes to the content or presentation of any section.
        const key = presentationKey(old);
        const destinations = before.map((_, i) => rotation.pairs[i - start]?.[1] ?? after[i]);
        if (!before.every((a, i) => (i === from || presentationKey(a) !== key)
            && presentationKey(a) === presentationKey(destinations[i]))) return false;
        if (!liveSiblingOrder(oldParent, previous.excluded) || !liveSiblingOrder(parent, next.excluded)) return false;

        peerGroups ??= move.peerGroups();
        peerAnchors ??= textAnchors(peerGroups);
        let confirmed = false;
        for (const [i, groups] of peerGroups.entries()) {
            if (i === from || !groups.length) continue;
            const match = matchesRow(before[i], destinations[i], groups, { peer: true });
            if (match === DO_NOT_INFER) return false;
            if (rotation.pairs[i - start] && match === CONFIRMED) confirmed = true;
        }
        return confirmed && matchesLiveSubtree(old, previous.excluded) && matchesLiveSubtree(dest, next.excluded);
    }

    function spacerBoundary(rotation) {
        if (!cleanSource || !move.boundaryGroups) return;
        if (!isEmptyLayout(rotation.before[rotation.from])
            || !rotation.pairs.every(([a, b]) => presentationKey(a) === presentationKey(b))) return;
        // The crossed rows identify the gap. Identical spacers outside this rotation
        // do not have to be distinguishable from the one that moved.
        const crossed = rotation.pairs.filter((_, index) => index !== rotation.from);
        if (!crossed.every(([a, b], index) => matchesRow(a, b, move.boundaryGroups[index]) === CONFIRMED)) return;
        // The boundary starts at the second box of the pair at the destination.
        return { before: rotation.before, after: rotation.after, index: rotation.to || 1 };
    }

    return function verifyRowMove(before, after, aligned, repeatedContent) {
        const length = Math.abs(move.offset) + 1;
        if (before.length !== length || after.length !== length) return;
        const down = move.offset > 0, from = down ? 0 : length - 1, to = down ? length - 1 : 0;
        const shift = down ? length - 1 : 1;
        const pairs = before.map((entry, index) => [entry, after[(index + shift) % length]]);
        const rotation = { before, after, from, to, pairs };
        let moved;
        if (pairs.every(([a, b]) => aligned(a, b))) {
            const [old, dest] = pairs[from];
            // Content keys omit hrefs. Only a confirmed link can distinguish otherwise identical rows.
            const match = move.groups.length || elements.length
                ? matchesRow(old, dest, move.groups, { elementHints: elements, requireLink: repeatedContent(old) })
                : TRY_COLLECTION;
            if (match === CONFIRMED || (match === TRY_COLLECTION && collectionConfirmsMove(rotation))) moved = pairs[from];
        }
        const boundary = spacerBoundary(rotation);
        if (moved || boundary) return { moved, boundary, pairs };
    };
}

function belongsTo(row, entry) {
    return row === entry || containsEntry(row, entry);
}

function inLiveRow(row, node, excluded) {
    if (!node?.isConnected || !row.node?.contains(node) || (excluded && node.closest(excluded))) return false;
    for (let current = node; current; current = current.parentElement) if (suppressesRowSubtree(current)) return false;
    return true;
}

function liveTextMatches(row, { node }, label, excluded) {
    return inLiveRow(row, node, excluded) && normalizedText(liveRowText(node, excluded)) === label;
}

function liveAnchorMatches(row, { node, tag }, key, excluded) {
    if (!inLiveRow(row, node, excluded) || node.localName !== tag) return false;
    if (tag === 'img') {
        return node.getAttribute('alt') === key && node.ownerDocument.defaultView.getComputedStyle(node).visibility === 'visible';
    }
    return linkKey(node.getAttribute('href'), liveRowText(node, excluded)) === key;
}

// Native disclosures remain discoverable. A stale label hidden by the theme cannot identify a visible row.
function suppressesRowSubtree(node, style = node.ownerDocument.defaultView.getComputedStyle(node)) {
    return style.display === 'none' || style.opacity === '0' || (node.getAttribute('hidden')?.toLowerCase() !== 'until-found'
        && (node.hasAttribute('hidden') || style.contentVisibility === 'hidden'));
}

function liveRowText(node, excluded) {
    if (excluded && node.matches(excluded)) return '';
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    if (suppressesRowSubtree(node, style)) return '';
    // Visibility is inherited but a descendant can override it. Test the element supplying each text node.
    let text = '';
    for (const child of node.childNodes) {
        if (child.nodeType === 3 && style.visibility === 'visible') text += child.textContent;
        else if (child.nodeType === 1) text += liveRowText(child, excluded);
    }
    return childFlowText(node.localName, text);
}

function liveSiblingOrder({ node, children }, excluded) {
    if (!node?.isConnected || (excluded && node.closest(excluded))) return false;
    const live = [...node.children].filter((child) => !excluded || !child.matches(excluded));
    return children.length === live.length && children.every((entry, i) => entry.node === live[i]);
}
