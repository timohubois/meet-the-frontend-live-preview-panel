// The payload is data from this verified response, never inserted into the live DOM or executed.
export function sourceDocument(doc) {
    try {
        const marker = doc.querySelector('meta[name="meet-the-frontend-live-preview-panel"]');
        const payload = marker?.getAttribute('data-mtflpp-source');
        if (!payload) return null;
        const html = JSON.parse(payload);
        if (typeof html !== 'string') return null;
        const source = new DOMParser().parseFromString(html, 'text/html');
        return source.querySelector('meta[name="meet-the-frontend-live-preview-panel"]')?.content === marker.content ? source : null;
    } catch { return null; } // Missing/invalid data or a restrictive Trusted Types policy uses the DOM fallback.
}

export function comparisonRoot(doc) {
    return doc.querySelector('main, [role="main"]') || doc.querySelector('article') || doc.body;
}

// Compare content and presentation without theme/field knowledge or viewport-dependent geometry.
export function contentSnapshot(doc, live, excludedSelectors, root = comparisonRoot(doc)) {
    if (!root) return null;
    // Validate CSS once per cached snapshot, not for every node. Bad extension selectors remain inert.
    const excluded = excludedSelectors.filter((selector) => {
        if (typeof selector !== 'string' || !selector.trim()) return false;
        try { root.matches(selector); return true; }
        catch { return false; }
    }).join(', ');
    const contentRoot = subtreeSnapshot(root, excluded, doc !== live ? mappedPreviewNodes(live) : undefined);
    if (!contentRoot) return null;
    // Ancestor attributes can control layout; their unrelated siblings/text are not preview content.
    let snapshot = contentRoot;
    const target = contentRoot.node;
    for (let node = root.parentElement; node; node = node.parentElement) {
        const parent = snapshotEntry(node, target, node.localName);
        parent.children = [snapshot];
        parent.parts = [snapshot];
        snapshot = parent;
    }
    snapshot.excluded = excluded;
    snapshot.contentRoot = contentRoot;
    return snapshot;
}

export function mappedPreviewNodes(doc) {
    const targets = new Map();
    for (const node of doc.querySelectorAll('[data-mtflpp-node]')) {
        const key = node.getAttribute('data-mtflpp-node');
        // Cloned markers are ambiguous; never silently choose the first matching widget.
        targets.set(key, targets.has(key) ? null : node);
    }
    return targets;
}

export function subtreeSnapshot(root, excluded, targets) {
    const entries = new Map();
    for (const node of [root, ...root.querySelectorAll('*')]) {
        if (excluded && node.closest(excluded)) continue;
        const ownText = [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent);
        const text = normalizedText(ownText.join(' '));
        const media = ['img', 'source', 'video', 'audio', 'iframe'].includes(node.localName)
            ? ['src', 'srcset', 'poster'].map((name) => node.getAttribute(`data-${name}`) || node.getAttribute(name) || '')
            : [];
        const background = node.style?.backgroundImage || node.getAttribute('data-bg') || '';
        // Include empty wrappers: layout/structure changes need not alter text or media.
        const marker = node.getAttribute('data-mtflpp-node');
        const target = targets ? targets.get(marker) || null : node;
        const entry = snapshotEntry(node, target, JSON.stringify([node.localName, text, media, background]));
        if (node.localName === 'img') entry.marker = marker;
        entry.text = text;
        entry.rawText = ownText.join('');
        entry.media = [...media, background];
        entry.parent = entries.get(node.parentElement);
        entries.set(node, entry);
        entry.parent?.children.push(entry);
    }
    // Preserve text-node order without duplicating every ancestor's complete text.
    for (const [node, entry] of entries) {
        entry.parts = [...node.childNodes].map((child) => child.nodeType === 3 ? child.textContent : entries.get(child))
            .filter((part) => part !== undefined);
    }
    return entries.get(root);
}

function presentationAttributes(node) {
    const attributes = [];
    for (const { name, value } of node.attributes) {
        // Keep authored accessibility/identity values eligible; normalize reference churn separately.
        if (name === 'data-mtflpp-node' || name.startsWith('data-mtflpp-evidence-') || name.startsWith('on')
            || /(?:^|-)(nonce|token)(?:-|$)/.test(name)) continue;
        // Media sources are normalized separately, so loading a declared lazy source is not an edit.
        if (/^(?:data-)?(?:src|srcset|poster|sizes|bg)$/.test(name)) continue;
        let normalized = value;
        if (name === 'class') normalized = [...node.classList].sort().join(' ');
        if (name === 'style') {
            normalized = [...node.style].sort().map((property) => [
                property, node.style.getPropertyValue(property), node.style.getPropertyPriority(property),
            ]);
        }
        if ((name === 'class' || name === 'style') && !normalized.length) continue;
        attributes.push([name, normalized]);
    }
    return attributes.sort(([a], [b]) => a.localeCompare(b));
}

function snapshotEntry(node, target, signature) {
    const attributes = presentationAttributes(node);
    return {
        node: target, tag: node.localName, signature, attributes, children: [], parts: [],
        presentation: JSON.stringify(attributes.filter(([name]) => !referenceAttribute(name))),
        references: JSON.stringify(attributes.filter(([name]) => referenceAttribute(name))),
    };
}

// Identity/reference churn is not meaningful output on its own. An authored value transition can
// still confirm it; labels, descriptions, expanded/hidden state and other ARIA remain ordinary evidence.
function referenceAttribute(name) {
    return ['id', 'for', 'headers', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns',
        'aria-flowto', 'aria-activedescendant', 'aria-details', 'aria-errormessage'].includes(name);
}

export function normalizedText(value) {
    return value.replace(/\s+/g, ' ').trim();
}

export function entryText(entry, cache = new Map()) {
    if (!entry) return '';
    if (!cache.has(entry)) cache.set(entry, (entry.parts || []).map((part) => {
        if (typeof part === 'string') return part;
        return childFlowText(part.tag, entryText(part, cache));
    }).join(''));
    return cache.get(entry);
}

// Block boundaries separate words even without serialized whitespace; inline formatting does not.
export function isFlowBoundary(tag) {
    return /^(?:p|div|section|article|main|aside|header|footer|nav|h[1-6]|li|[ou]l|d[ldt]|blockquote|pre|table|tr|t[dh]|caption|figure|figcaption|br|hr)$/.test(tag);
}

export function childFlowText(tag, text) {
    return isFlowBoundary(tag) ? ` ${text} ` : text;
}

export function sameRowPosition(before, after) {
    // Only comparable boxes can disprove a move. Native disclosures and display:contents can be boxless.
    if (!before?.getClientRects().length || !after.getClientRects().length) return false;
    const a = before.getBoundingClientRect(), b = after.getBoundingClientRect();
    const from = before.ownerDocument.defaultView, to = after.ownerDocument.defaultView;
    return Math.abs((a.top + from.scrollY) - (b.top + to.scrollY)) < 1
        && Math.abs((a.left + from.scrollX) - (b.left + to.scrollX)) < 1;
}

export function containsEntry(parent, child) {
    return !!parent?.children.some((entry) => entry === child
        || (entry.node && entry.node === child?.node) || containsEntry(entry, child));
}
