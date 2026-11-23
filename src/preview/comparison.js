// Comparison state belongs to one preview owner. Visibility is supporting evidence, not scroll presentation.
export function createPreviewComparison(excludedSelectors = []) {
    // PHP supplies the complete policy, including an intentional empty list.
    const selectors = Array.isArray(excludedSelectors) ? [...excludedSelectors] : [];
    const snapshots = new WeakMap();
    return {
        capture(doc, values) {
            try {
                if (snapshots.has(doc)) return;
                const source = sourceDocument(doc);
                snapshots.set(doc, {
                    source: source ? contentSnapshot(source, doc, selectors) : null,
                    dom: contentSnapshot(doc, doc, selectors),
                    values: values && Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { ...value }])),
                });
            } catch { /* An unreadable document must not block native output or scroll restoration. */ }
        },
        findChange(previous, next) {
            try {
                const before = snapshots.get(previous);
                const after = snapshots.get(next);
                if (!before || !after) return null;
                const hints = inputChanges(before.values, after.values);
                const edited = valuesChanged(before.values, after.values);
                const captured = !!before.source && !!after.source;
                const transition = !!before.source !== !!after.source;
                const candidates = [
                    ...(captured ? changedCandidates(before.source, after.source).map((item) => ({ ...item, source: true })) : []),
                    ...changedCandidates(before.dom, after.dom).map((item) => ({ ...item, source: false })),
                ];
                const ranked = rankCandidates(candidates, hints);
                // With clean source, runtime-only mutations need author evidence. A known input
                // change can support transformed/conditional DOM content without a literal match;
                // unrelated DOM-only styling is not enough. Correlated source/DOM signals aren't votes.
                const eligible = ranked.filter((item) => (item.source || (!captured && !transition)
                    || item.input || (edited && item.priority === 2))
                    && (item.priority > 0 || item.input));
                return selectChange(eligible);
            } catch { return null; } // Optional comparison must never prevent displaying native output.
        },
    };
}

function rankCandidates(candidates, hints) {
    const text = new Map();
    const textOf = (entry) => entryText(entry, text);
    const ranked = [];
    for (const candidate of candidates) {
        if (candidate.unresolved) {
            for (const resolved of resolveRegion(candidate, hints, textOf)) ranked.push(resolved);
        }
        // Input evidence belongs to a matching inserted sibling, not the entire range.
        // Without literal support, keep the range's existing structural target intact.
        if (candidate.kind === 'insert' && candidate.added.length > 1) {
            const supported = candidate.added.map((entry) => {
                const insertion = { ...candidate, after: entry, added: [entry] };
                const input = inputSupport(insertion, hints, textOf);
                return { ...insertion, input };
            }).filter((item) => item.input);
            if (supported.length) {
                ranked.push(...supported);
                continue;
            }
        }
        const input = inputSupport(candidate, hints, textOf);
        ranked.push({ ...candidate, input });
    }
    return ranked;
}

// Unaligned regions remain evidence, not an early veto. Unique input transitions
// can identify a node inside them without inventing cross-response node identities.
function resolveRegion(candidate, hints, textOf) {
    const resolved = [];
    for (const hint of hints) {
        if (!hint.after) continue;
        const oldMatches = matchingEntries(candidate.oldRange, hint.before, textOf, hint, true);
        const newMatches = matchingEntries(candidate.newRange, hint.after, textOf, hint, false);
        if (!oldMatches.length) continue;
        // Merely moving existing old/new values is not an observed transition.
        // Require loss/gain within an unaligned region before using loose value correspondence.
        const wrapping = hint.type === 'markup' && hint.oldTag === hint.newTag;
        if (!wrapping && hint.before
            && (oldMatches.length <= matchingEntries(candidate.newRange, hint.before, textOf, hint, true).length
                || newMatches.length <= matchingEntries(candidate.oldRange, hint.after, textOf, hint, false).length)) continue;
        for (const entry of newMatches) {
            if (wrapping && !oldMatches.some((old) => old.signature !== entry.signature)) continue;
            resolved.push({
                ...candidate, unresolved: false, before: null, after: entry,
                kind: 'content', input: hint.before && hint.after ? 2 : 1, priority: 2, matches: [hint],
            });
        }
    }
    return resolved;
}

function selectChange(eligible) {
    if (!eligible.length) return null;
    // Ordered evidence, not percentages or added votes: paired input > one-sided input
    // > rendered-only; content/structure > presentation > unconfirmed reference churn.
    const bestInput = eligible.reduce((best, item) => Math.max(best, item.input), 0);
    const supported = eligible.filter((item) => item.input === bestInput);
    const priority = supported.reduce((best, item) => Math.max(best, item.priority), 0);
    const best = supported.filter((item) => item.priority === priority);
    if (best.some((item) => item.unresolved)) return null;
    // A wrapper can contain the same transition as its edited child without changing
    // that text itself. Prefer the precise child, but keep independently edited parent text.
    const precise = best.filter((item) => !item.input || item.directInput || !best.some((other) =>
        other !== item && item.matches?.length && item.matches.every((hint) => other.matches?.includes(hint))
        && containsEntry(item.after, other.after)));
    // Source and DOM can nominate the same live element. Deletions use their surviving
    // boundary, not the common parent, so separate deletion ranges remain separate.
    const seen = new Map();
    const unique = precise.filter((item) => {
        const boundary = item.kind === 'delete' ? item.following[0] || item.preceding[0] || item.after : item.after;
        const node = boundary?.node;
        if (!node) return true;
        const kind = item.kind === 'delete' && !item.following.length ? 'delete-last' : item.kind;
        const kinds = seen.get(node) || new Set();
        if (kinds.has(kind)) return false;
        kinds.add(kind);
        seen.set(node, kinds);
        return true;
    });
    // Visibility must not turn equally corroborated, different elements into a winner.
    if (bestInput && seen.size > 1) return null;
    return identifyElement(unique);
}

// Candidate kinds and snapshot entries never cross the comparison boundary.
// Visibility can disambiguate weak output or a deletion boundary, but no ancestor is revealed here.
function identifyElement(changes) {
    const direct = new Set(), hidden = new Set();
    for (const change of changes) {
        let entry, contextOnly = false;
        if (change.kind === 'delete') {
            contextOnly = !change.removed.some(renderedElement);
            entry = contextOnly ? change.after
                : change.following.find(renderedElement) || change.preceding.find(renderedElement)
                    || change.following.find(liveElement) || change.preceding.find(liveElement) || change.after;
        } else if (change.kind === 'insert') {
            entry = change.added.find(renderedElement) || change.added.find(liveElement);
        } else entry = change.after;
        const node = liveElement(entry);
        if (!node) continue;
        const rendered = renderedElement(entry);
        // Preserve the eligible mapped child of a boxless wrapper, inside or moved outside it.
        // Returning the wrapper would let presentation rediscover excluded live descendants.
        const element = rendered || node;
        (rendered && !contextOnly ? direct : hidden).add(element);
    }
    const identified = direct.size ? direct : hidden;
    return identified.size === 1 ? identified.values().next().value : null;
}

function liveElement(entry) {
    if (entry?.node) return entry.node;
    for (const child of entry?.children || []) {
        const node = liveElement(child);
        if (node) return node;
    }
    return null;
}

function renderedElement(entry) {
    const node = entry?.node;
    if (node?.getClientRects().length
        && node.ownerDocument.defaultView.getComputedStyle(node).visibility === 'visible') return node;
    for (const child of entry?.children || []) {
        const rendered = renderedElement(child);
        if (rendered) return rendered;
    }
    return null;
}

// The payload is data from this verified response, never inserted into the live DOM or executed.
function sourceDocument(doc) {
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

// Compare content and presentation without theme/field knowledge or viewport-dependent geometry.
function contentSnapshot(doc, live, excludedSelectors, root = doc.querySelector('main, [role="main"]') || doc.querySelector('article') || doc.body) {
    if (!root) return null;
    // Validate CSS once per cached snapshot, not for every node. Bad extension selectors remain inert.
    const excluded = excludedSelectors.filter((selector) => {
        if (typeof selector !== 'string' || !selector.trim()) return false;
        try { root.matches(selector); return true; }
        catch { return false; }
    }).join(', ');
    const entries = new Map();
    const targets = new Map();
    if (doc !== live) {
        for (const node of live.querySelectorAll('[data-mtflpp-node]')) {
            const key = node.getAttribute('data-mtflpp-node');
            // Cloned markers are ambiguous; never silently choose the first matching widget.
            targets.set(key, targets.has(key) ? null : node);
        }
    }
    for (const node of [root, ...root.querySelectorAll('*')]) {
        if (excluded && node.closest(excluded)) continue;
        const text = [...node.childNodes].filter((child) => child.nodeType === 3)
            .map((child) => child.textContent).join(' ').replace(/\s+/g, ' ').trim();
        const media = ['img', 'source', 'video', 'audio', 'iframe'].includes(node.localName)
            ? ['src', 'srcset', 'poster'].map((name) => node.getAttribute(`data-${name}`) || node.getAttribute(name) || '')
            : [];
        const background = node.style?.backgroundImage || node.getAttribute('data-bg') || '';
        // Include empty wrappers: layout/structure changes need not alter text or media.
        const target = doc === live ? node : targets.get(node.getAttribute('data-mtflpp-node')) || null;
        const entry = snapshotEntry(node, target, JSON.stringify([node.localName, text, media, background]));
        entry.text = text;
        entry.media = [...media, background];
        entries.set(node, entry);
        entries.get(node.parentElement)?.children.push(entry);
    }
    // Preserve text-node order without duplicating every ancestor's complete text.
    for (const [node, entry] of entries) {
        entry.parts = [...node.childNodes].map((child) => child.nodeType === 3 ? child.textContent : entries.get(child))
            .filter((part) => part !== undefined);
    }
    let snapshot = entries.get(root);
    if (!snapshot) return null;
    // Ancestor attributes can control layout; their unrelated siblings/text are not preview content.
    const target = snapshot.node;
    for (let node = root.parentElement; node; node = node.parentElement) {
        const parent = snapshotEntry(node, target, node.localName);
        parent.children = [snapshot];
        parent.parts = [snapshot];
        snapshot = parent;
    }
    return snapshot;
}

function presentationAttributes(node) {
    const attributes = [];
    for (const { name, value } of node.attributes) {
        // Keep authored accessibility/identity values eligible; normalize reference churn separately.
        if (name === 'data-mtflpp-node' || name.startsWith('on')
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

function changedCandidates(previous, next) {
    const identities = new Map(), keys = new Map(), presentationKeys = new Map(), exactKeys = new Map(), candidates = [];
    function intern(value) {
        const signature = JSON.stringify(value);
        if (!identities.has(signature)) identities.set(signature, identities.size + 1);
        return identities.get(signature);
    }
    function identify(entry) {
        if (!entry) return 0;
        const key = intern([entry.signature, entry.children.map(identify)]);
        keys.set(entry, key);
        presentationKeys.set(entry, intern([key, entry.presentation,
            entry.children.map((child) => presentationKeys.get(child))]));
        exactKeys.set(entry, intern([key, entry.presentation, entry.references,
            entry.children.map((child) => exactKeys.get(child))]));
        return key;
    }
    identify(previous);
    identify(next);
    function positions(entries) {
        const result = new Map();
        entries.forEach((entry, index) => {
            const key = keys.get(entry);
            result.set(key, result.has(key) ? -1 : index);
        });
        return result;
    }
    function compare(before, after) {
        if (!before || !after) return;
        if (before.signature !== after.signature) candidates.push({ kind: 'content', before, after, priority: 2 });
        if (before.presentation !== after.presentation || before.references !== after.references) {
            candidates.push({ kind: 'attributes', before, after,
                priority: before.presentation !== after.presentation ? 1 : 0 });
        }
        align(before.children, after.children, after);
    }
    function align(before, after, parent) {
        const oldPositions = positions(before), newPositions = positions(after);
        const oldAttributes = new Set(before.flatMap((entry) => [presentationKeys.get(entry), exactKeys.get(entry)]));
        const newAttributes = new Set(after.flatMap((entry) => [presentationKeys.get(entry), exactKeys.get(entry)]));
        function corresponds(old, next, index) {
            const a = index.get(old), b = index.get(next);
            // Equal content cannot establish an attribute transition when either unchanged
            // subtree survives elsewhere among these siblings. Let normal alignment resolve it.
            return a === b || (!newAttributes.has(a) && !oldAttributes.has(b));
        }
        function aligned(old, next) {
            // Reference churn must not mask a presentation permutation; preserved references
            // still matter when the authored change itself concerns an identity or association.
            return keys.get(old) === keys.get(next) && corresponds(old, next, presentationKeys)
                && corresponds(old, next, exactKeys);
        }
        function unresolved(oldStart, oldEnd, newStart, newEnd) {
            candidates.push({ kind: 'region', after: parent, priority: 2, unresolved: true,
                oldRange: before.slice(oldStart, oldEnd), newRange: after.slice(newStart, newEnd) });
        }
        function range(oldStart, oldEnd, newStart, newEnd) {
            while (oldStart < oldEnd && newStart < newEnd
                && aligned(before[oldStart], after[newStart])) {
                compare(before[oldStart], after[newStart]);
                oldStart++; newStart++;
            }
            while (oldStart < oldEnd && newStart < newEnd
                && aligned(before[oldEnd - 1], after[newEnd - 1])) {
                oldEnd--; newEnd--;
                compare(before[oldEnd], after[newEnd]);
            }
            if (oldStart === oldEnd && newStart === newEnd) return;
            if (oldStart === oldEnd || newStart === newEnd) {
                const deleted = newStart === newEnd;
                const changed = deleted ? before.slice(oldStart, oldEnd) : after.slice(newStart, newEnd);
                const boundary = deleted ? [after[newStart - 1], after[newStart]] : [before[oldStart - 1], before[oldStart]];
                if (changed.some((entry) => boundary.some((neighbor) => neighbor && keys.get(neighbor) === keys.get(entry)))) {
                    unresolved(oldStart, oldEnd, newStart, newEnd);
                } else if (deleted) {
                    candidates.push({ kind: 'delete', after: parent, removed: changed, priority: 2,
                        following: after.slice(newStart), preceding: after.slice(0, newStart).reverse() });
                } else candidates.push({ kind: 'insert', after: changed[0], added: changed, priority: 2 });
                return;
            }
            if (oldEnd - oldStart === 1 && newEnd - newStart === 1) {
                compare(before[oldStart], after[newStart]);
                return;
            }
            const anchors = [];
            for (let index = oldStart; index < oldEnd; index++) {
                const key = keys.get(before[index]), match = newPositions.get(key);
                if (oldPositions.get(key) !== index || match === undefined || match < newStart || match >= newEnd) continue;
                if (anchors.length && match <= anchors[anchors.length - 1][1]) {
                    unresolved(oldStart, oldEnd, newStart, newEnd);
                    return;
                }
                anchors.push([index, match]);
            }
            if (!anchors.length) { unresolved(oldStart, oldEnd, newStart, newEnd); return; }
            for (const [oldIndex, newIndex] of [...anchors, [oldEnd, newEnd]]) {
                range(oldStart, oldIndex, newStart, newIndex);
                if (oldIndex < oldEnd) compare(before[oldIndex], after[newIndex]);
                oldStart = oldIndex + 1;
                newStart = newIndex + 1;
            }
        }
        range(0, before.length, 0, after.length);
    }
    compare(previous, next);
    return candidates;
}

function normalizedText(value) {
    return value.replace(/\s+/g, ' ').trim();
}

function entryText(entry, cache = new Map()) {
    if (!entry) return '';
    if (!cache.has(entry)) cache.set(entry, (entry.parts || []).map((part) => {
        if (typeof part === 'string') return part;
        const text = entryText(part, cache);
        // HTML block boundaries separate words even when serialized without whitespace.
        // Inline elements remain contiguous, including words split by formatting.
        return /^(?:p|div|section|article|main|aside|header|footer|nav|h[1-6]|li|[ou]l|d[ldt]|blockquote|pre|table|tr|t[dh]|caption|figure|figcaption|br|hr)$/.test(part.tag)
            ? ` ${text} ` : text;
    }).join(''));
    return cache.get(entry);
}

function valuesChanged(before, after) {
    return !!before && !!after && [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .some((key) => !Object.hasOwn(before, key) || !Object.hasOwn(after, key)
            || before[key]?.type !== after[key]?.type || before[key]?.value !== after[key]?.value);
}

function inputChanges(before, after) {
    if (!before || !after) return [];
    const changes = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const old = Object.hasOwn(before, key) ? before[key] : { type: after[key]?.type, value: '' };
        const next = Object.hasOwn(after, key) ? after[key] : { type: before[key]?.type, value: '' };
        if (old.type !== next.type || !['text', 'html'].includes(next.type)
            || typeof old.value !== 'string' || typeof next.value !== 'string' || old.value === next.value) continue;
        let oldDoc, newDoc;
        try {
            oldDoc = old.type === 'html' ? new DOMParser().parseFromString(old.value, 'text/html') : null;
            newDoc = next.type === 'html' ? new DOMParser().parseFromString(next.value, 'text/html') : null;
        } catch { continue; } // Restrictive Trusted Types must not veto otherwise usable rendered evidence.
        const oldContent = oldDoc ? contentSnapshot(oldDoc, oldDoc, [], oldDoc.body) : null;
        const newContent = newDoc ? contentSnapshot(newDoc, newDoc, [], newDoc.body) : null;
        const a = normalizedText(oldDoc ? entryText(oldContent) : old.value);
        const b = normalizedText(newDoc ? entryText(newContent) : next.value);
        if (a !== b) changes.push({ ...textTransition(a, b), type: 'text' });
        // Reuse structural comparison for markup-only intent rather than searching raw HTML.
        else if (oldDoc && newDoc) {
            for (const change of changedCandidates(oldContent, newContent)) {
                if (change.kind === 'attributes') {
                    const oldAttributes = new Map(change.before.attributes), newAttributes = new Map(change.after.attributes);
                    for (const name of new Set([...oldAttributes.keys(), ...newAttributes.keys()])) {
                        const previous = oldAttributes.get(name) ?? '', value = newAttributes.get(name) ?? '';
                        if (JSON.stringify(previous) !== JSON.stringify(value)) {
                            changes.push({ type: 'attribute', name,
                                before: typeof previous === 'string' ? previous : JSON.stringify(previous),
                                after: typeof value === 'string' ? value : JSON.stringify(value) });
                        }
                    }
                } else if (change.kind === 'content') {
                    if (normalizedText(entryText(change.before)) === normalizedText(entryText(change.after))) changes.push({ type: 'markup',
                        before: normalizedText(entryText(change.before)), after: normalizedText(entryText(change.after)),
                        oldTag: change.before.tag, newTag: change.after.tag });
                    (change.before.media || []).forEach((value, index) => {
                        const current = change.after.media?.[index];
                        if (value && current && value !== current) changes.push({ type: 'media', before: value, after: current });
                    });
                }
            }
        }
    }
    return changes;
}

// Narrow whole-field edits to changed words, not single shared characters or an entire post wrapper.
function textTransition(before, after) {
    let start = 0;
    let suffix = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    while (suffix < before.length - start && suffix < after.length - start
        && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
    let oldEnd = before.length - suffix;
    let newEnd = after.length - suffix;
    while (start > 0 && /\S/.test(before[start - 1])) start--;
    if (oldEnd > start && /\S/.test(before[oldEnd - 1])) {
        while (oldEnd < before.length && /\S/.test(before[oldEnd])) oldEnd++;
    }
    if (newEnd > start && /\S/.test(after[newEnd - 1])) {
        while (newEnd < after.length && /\S/.test(after[newEnd])) newEnd++;
    }
    return { before: before.slice(start, oldEnd).trim(), after: after.slice(start, newEnd).trim() };
}

function matchesValue(text, value) {
    return value ? containsText(text, value) : normalizedText(text) === '';
}

function containsText(text, value) {
    if (!value) return false;
    text = normalizedText(text);
    // Avoid matching a changed word merely inside a longer, unrelated word.
    let start = text.indexOf(value);
    while (start !== -1) {
        const end = start + value.length;
        if ((!start || !/[\p{L}\p{N}_]/u.test(text[start - 1]) || !/[\p{L}\p{N}_]/u.test(value[0]))
            && (end === text.length || !/[\p{L}\p{N}_]/u.test(text[end]) || !/[\p{L}\p{N}_]/u.test(value.at(-1)))) return true;
        start = text.indexOf(value, start + 1);
    }
    return false;
}

function matchingEntries(entries = [], value, textOf, hint, before) {
    return entries.flatMap((entry) => {
        const children = matchingEntries(entry.children, value, textOf, hint, before);
        let matches;
        if (hint.type === 'media') matches = entry.media?.includes(value);
        else if (hint.type === 'attribute') matches = entry.attributes.some(([name, current]) =>
            name === hint.name && containsText(typeof current === 'string' ? current : JSON.stringify(current), value));
        else matches = (hint.type !== 'markup' || entry.tag === (before ? hint.oldTag : hint.newTag))
            && matchesValue(textOf(entry), value);
        if (hint.type === 'text' && children.length) return children;
        return [...(matches ? [entry] : []), ...children];
    });
}

function inputSupport(candidate, hints, textOf) {
    if (candidate.unresolved) return 0;
    let strength = 0;
    candidate.matches = [];
    for (const hint of hints) {
        let support = 0;
        if (candidate.kind === 'attributes') {
            if (!['text', 'attribute'].includes(hint.type)) continue;
            const transition = hint;
            const before = new Map(candidate.before.attributes), after = new Map(candidate.after.attributes);
            for (const name of new Set([...before.keys(), ...after.keys()])) {
                if (hint.type === 'attribute' && name !== hint.name) continue;
                const a = before.get(name), b = after.get(name);
                if (JSON.stringify(a) === JSON.stringify(b)) continue;
                // Attribute matching uses the actual value, not its name or another element's text.
                const oldValue = typeof a === 'string' ? a : JSON.stringify(a) || '';
                const newValue = typeof b === 'string' ? b : JSON.stringify(b) || '';
                if (matchesValue(oldValue, transition.before) && matchesValue(newValue, transition.after)) {
                    support = hint.type === 'attribute' || (hint.before && hint.after) ? 2 : 1;
                }
            }
        } else if (candidate.kind === 'insert') {
            if (!hint.before && candidate.added.some((entry) => containsText(textOf(entry), hint.after))) support = Math.max(support, 1);
        } else if (candidate.kind === 'delete') {
            if (!hint.after && candidate.removed.some((entry) => containsText(textOf(entry), hint.before))) support = Math.max(support, 1);
        } else if (hint.type === 'media') {
            if ((candidate.before?.media || []).some((value, index) =>
                value === hint.before && candidate.after?.media?.[index] === hint.after)) support = 2;
        } else if (hint.type !== 'attribute'
            && (hint.type !== 'markup' || (candidate.before?.tag === hint.oldTag && candidate.after?.tag === hint.newTag))
            && matchesValue(textOf(candidate.before), hint.before) && matchesValue(textOf(candidate.after), hint.after)) {
            support = hint.before && hint.after ? 2 : 1;
            if (hint.type === 'text' && containsText(candidate.before?.text || '', hint.before)
                && containsText(candidate.after?.text || '', hint.after)) candidate.directInput = true;
        }
        if (support) candidate.matches.push(hint);
        strength = Math.max(strength, support);
    }
    return strength;
}

function containsEntry(parent, child) {
    return !!parent?.children.some((entry) => entry === child
        || (entry.node && entry.node === child?.node) || containsEntry(entry, child));
}
