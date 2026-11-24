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
                    values: values && structuredClone(values),
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
                const move = inputMove(before.values, after.values,
                    captured && !edited && !inputOrderChanged(before.values, after.values));
                const sourceChanges = captured ? changedCandidates(before.source, after.source, move, true) : [];
                if (move?.boundaryGroups?.length) {
                    const meaningful = sourceChanges.filter((item) => item.priority > 0);
                    if (meaningful.length === 1 && meaningful[0].boundary) {
                        return renderedBoundary(meaningful[0].boundary, after.source?.excluded);
                    }
                }
                const candidates = [
                    ...sourceChanges.map((item) => ({ ...item, source: true })),
                    ...changedCandidates(before.dom, after.dom, move),
                ];
                const rendered = new Map();
                const ranked = rankCandidates(candidates, hints).filter((item) => (item.priority > 0 || item.input)
                    && (!item.spacing || renderedSpacingChanged(item, rendered, after.dom?.excluded)));
                // When source is available, a field change alone cannot confirm live text or styling.
                // Keep conditional insertions/removals as a fallback when there is no source change.
                const mayFollowConditionalContent = captured && edited && !ranked.some((item) => item.source);
                const eligible = ranked.filter((item) => item.source || item.input || (!captured && !transition)
                    || (mayFollowConditionalContent && (item.kind === 'insert' || item.kind === 'delete')));
                return selectChange(eligible, {
                    rowMove: !!move, excluded: after.source?.excluded ?? after.dom?.excluded,
                    canFollowLiveReorder: !captured && (edited || inputOrderChanged(before.values, after.values)),
                    canFollowLiveMove: !captured && !transition,
                });
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
        if (!hint.after || hint.type === 'spacing') continue;
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
            if (wrapping && !oldMatches.some((old) => markupChanged(old, entry, textOf))) continue;
            resolved.push({
                ...candidate, unresolved: false, before: null, after: entry,
                kind: 'content', input: hint.before && hint.after ? 2 : 1, priority: 2, matches: [hint],
            });
        }
    }
    return resolved;
}

function selectChange(eligible, reorder) {
    if (!eligible.length) return null;
    // Ordered evidence, not percentages or added votes: paired input > one-sided input
    // > rendered-only; content/structure > presentation > unconfirmed reference churn.
    const bestInput = eligible.reduce((best, item) => Math.max(best, item.input), 0);
    const supported = eligible.filter((item) => item.input === bestInput);
    const priority = supported.reduce((best, item) => Math.max(best, item.priority), 0);
    const best = supported.filter((item) => item.priority === priority);
    if ((reorder.rowMove && !bestInput) || best.some((item) => item.unresolved)) return identifyRegion(best, reorder);
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

// A local replacement or reorder can identify its container without identifying one edited child.
// Do not combine unrelated changes or follow browser-only movement in a captured page.
function identifyRegion(changes, { rowMove, excluded, canFollowLiveReorder, canFollowLiveMove }) {
    if (rowMove) {
        const move = changes.find((item) => item.moved && (item.source || canFollowLiveMove));
        const target = move?.moved.node;
        if (!target?.isConnected || !move.after.node?.contains(target)) return null;
        const onlyMove = changes.every((change) => change === move
            || (move.source && !change.source && (change.moved || change.regionChange === 'reorder')));
        if (!onlyMove) return null;
        if (target.ownerDocument.defaultView.getComputedStyle(target).display !== 'contents') return target;
        // A moved row needs a position inside that row, not an excluded or relocated child.
        return findMappedElement(move.moved, (node) => target.contains(node)
            && (!excluded || !node.closest(excluded)) && hasRenderedBox(node));
    }
    const region = changes.find((item) => item.unresolved && (item.regionChange === 'replacement'
        || (item.regionChange === 'reorder' && (item.source || canFollowLiveReorder))));
    const node = region?.after.node;
    if (!node?.isConnected) return null;
    for (const change of changes) {
        if (change.unresolved) {
            // A live-only reorder cannot establish a region or veto one confirmed by clean source.
            if (region.source && !change.source && change.regionChange === 'reorder') continue;
            if (!change.regionChange || change.after.node !== node) return null;
        } else {
            const entries = change.kind === 'insert' ? change.added : [change.after];
            if (!entries.every((entry) => node.contains(entry.node))) return null;
        }
    }
    // A boxless container has no position of its own. Do not select an arbitrary child of it.
    return node.ownerDocument.defaultView.getComputedStyle(node).display !== 'contents' ? node : null;
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

function findMappedElement(entry, eligible) {
    if (entry?.node && eligible(entry.node)) return entry.node;
    for (const child of entry?.children || []) {
        const node = findMappedElement(child, eligible);
        if (node) return node;
    }
    return null;
}

function liveElement(entry) {
    return findMappedElement(entry, () => true);
}

function hasRenderedBox(node) {
    return node.getClientRects().length && node.ownerDocument.defaultView.getComputedStyle(node).visibility === 'visible';
}

function renderedElement(entry) {
    return findMappedElement(entry, hasRenderedBox);
}

// The seam starts at the second box, regardless of which side the empty space moved to.
function renderedBoundary({ before, after }, excluded) {
    for (const [first, second] of [before, after]) {
        const a = first.node, b = second.node;
        if (!a?.isConnected || !b?.isConnected || a.nextElementSibling !== b) return null;
        const boxes = [];
        for (const node of [a, b]) {
            const { position, marginTop, marginBottom } = node.ownerDocument.defaultView.getComputedStyle(node);
            if ((excluded && node.closest(excluded)) || !hasRenderedBox(node) || !['static', 'relative'].includes(position)
                || node.closest('[hidden], details:not([open])')
                || node.checkVisibility?.({ opacityProperty: true, contentVisibilityAuto: true }) === false) return null;
            const box = node.getBoundingClientRect();
            // Empty blocks can occupy space through margins alone.
            if (!box.height && !(parseFloat(marginTop) > 0 || parseFloat(marginBottom) > 0)) return null;
            boxes.push(box);
        }
        const [firstBox, secondBox] = boxes;
        if (firstBox.bottom > secondBox.top
            || Math.max(firstBox.left, secondBox.left) >= Math.min(firstBox.right, secondBox.right)) return null;
    }
    return after[1].node;
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
        const ownText = [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent);
        const text = normalizedText(ownText.join(' '));
        const media = ['img', 'source', 'video', 'audio', 'iframe'].includes(node.localName)
            ? ['src', 'srcset', 'poster'].map((name) => node.getAttribute(`data-${name}`) || node.getAttribute(name) || '')
            : [];
        const background = node.style?.backgroundImage || node.getAttribute('data-bg') || '';
        // Include empty wrappers: layout/structure changes need not alter text or media.
        const target = doc === live ? node : targets.get(node.getAttribute('data-mtflpp-node')) || null;
        const entry = snapshotEntry(node, target, JSON.stringify([node.localName, text, media, background]));
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
    snapshot.excluded = excluded;
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

function replacesFormFields(before, after) {
    function fieldNames(groups) {
        const names = new Set();
        function collect(entry) {
            if (['input', 'select', 'textarea'].includes(entry.tag)) {
                const name = entry.attributes.find(([key]) => key === 'name')?.[1];
                const type = entry.attributes.find(([key]) => key === 'type')?.[1]?.toLowerCase();
                if (!name || (entry.tag === 'input' && type === 'hidden')) return false;
                names.add(name);
                return true;
            }
            let found = false;
            for (const child of entry.children) if (collect(child)) found = true;
            return found;
        }
        // Standalone copy in the range can be independent of the field replacement.
        return groups.every(collect) ? names : null;
    }
    const oldNames = fieldNames(before), newNames = fieldNames(after);
    // A native form provides a boundary for a change in both directions, not for label edits
    // or changes to generated IDs, actions and hidden metadata alone.
    return oldNames && newNames && [...oldNames].some((name) => !newNames.has(name))
        && [...newNames].some((name) => !oldNames.has(name));
}

function couldBeSeparateReplacements(before, after) {
    if (before.length < 2 || after.length < 2) return false;
    const oldSubtrees = before.filter((entry) => entry.children.length).length;
    const newSubtrees = after.filter((entry) => entry.children.length).length;
    // Neither a run of leaves nor several separate subtrees establishes a single replacement.
    if ((!oldSubtrees && !newSubtrees) || (oldSubtrees > 1 && newSubtrees > 1)) return true;
    // Even a mixed range can contain independent edits to siblings with the same element types.
    const counts = new Map();
    for (const { tag } of after) counts.set(tag, (counts.get(tag) || 0) + 1);
    let matches = 0;
    for (const { tag } of before) {
        const available = counts.get(tag);
        if (!available) continue;
        if (++matches === 2) return true;
        counts.set(tag, available - 1);
    }
    return false;
}

function changedCandidates(previous, next, move, cleanSource = false) {
    const identities = new Map(), keys = new Map(), presentationKeys = new Map(), exactKeys = new Map(), candidates = [];
    let rowAnchors;
    function matchesRow(old, dest, groups) {
        rowAnchors ??= [uniqueRowAnchors(previous, new Set(groups.flat())), uniqueRowAnchors(next, new Set(groups.flat()))];
        const [oldAnchors, newAnchors] = rowAnchors;
        const matched = new Map();
        for (const [label, anchor] of oldAnchors) {
            const target = newAnchors.get(label);
            if (!target) continue;
            if ((old !== anchor.entry && !containsEntry(old, anchor.entry))
                || (dest !== target.entry && !containsEntry(dest, target.entry))) return false;
            matched.set(label, anchor.substantive && target.substantive);
        }
        return groups.some((group) => group.every((label) => matched.has(label))
            && group.some((label) => matched.get(label)));
    }
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
    const contentKey = (entry) => keys.get(entry);
    function childIdentity(entry) {
        const id = entry.attributes.find(([name]) => name === 'id')?.[1];
        return id ? `${entry.tag} ${id}` : undefined;
    }
    function collectionKey(entry) {
        if (entry.children.length < 2) return;
        // The same members can identify an anonymous sibling collection across a reorder.
        return intern(['collection', entry.signature, entry.children.map(contentKey).sort((a, b) => a - b)]);
    }
    function positions(entries, keyOf) {
        const result = new Map();
        entries.forEach((entry, index) => {
            const key = keyOf(entry);
            if (key !== undefined) result.set(key, result.has(key) ? -1 : index);
        });
        return result;
    }
    function compare(before, after) {
        if (!before || !after) return;
        if (before.signature !== after.signature) candidates.push({ kind: 'content', before, after, priority: 2 });
        else if (before.rawText !== after.rawText) candidates.push({ kind: 'content', before, after, priority: 2, spacing: true });
        if (before.presentation !== after.presentation || before.references !== after.references) {
            candidates.push({ kind: 'attributes', before, after,
                priority: before.presentation !== after.presentation ? 1 : 0 });
        }
        align(before.children, after.children, before, after);
    }
    function align(before, after, oldParent, parent) {
        const local = parent.parent && oldParent.parent && parent.tag === oldParent.tag;
        const oldPositions = positions(before, contentKey), newPositions = positions(after, contentKey);
        let oldIds, newIds, oldCollections, newCollections;
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
        function unresolved(oldStart, oldEnd, newStart, newEnd, reason, moved, boundary) {
            const oldRange = before.slice(oldStart, oldEnd), newRange = after.slice(newStart, newEnd);
            const replaced = reason === 'replacement' && local
                && oldRange.some((entry) => !newPositions.has(keys.get(entry)))
                && newRange.some((entry) => !oldPositions.has(keys.get(entry)))
                && (!couldBeSeparateReplacements(oldRange, newRange)
                    || (parent.tag === 'form' && replacesFormFields(oldRange, newRange)));
            const regionChange = local && (reason === 'reorder' || replaced) ? reason : undefined;
            candidates.push({ kind: 'region', after: parent, priority: 2, unresolved: true,
                regionChange, oldRange, newRange, moved, boundary });
        }
        function movedEntry(oldStart, oldEnd, newStart, newEnd) {
            if (!move?.groups.length) return;
            const length = Math.abs(move.offset) + 1;
            if (oldEnd - oldStart !== length || newEnd - newStart !== length) return;
            const from = move.offset > 0 ? oldStart : oldEnd - 1;
            const to = move.offset > 0 ? newEnd - 1 : newStart;
            const key = contentKey(before[from]);
            if (oldPositions.get(key) !== from || newPositions.get(key) !== to) return;
            const shift = move.offset > 0 ? length - 1 : 1;
            for (let i = 0; i < length; i++) {
                if (!aligned(before[oldStart + i], after[newStart + (i + shift) % length])) return;
            }
            // An unrelated list or reversed output can show the same rotation. Require a
            // unique, unchanged value from the dropped row inside both rendered sections.
            if (matchesRow(before[from], after[to], move.groups)) return after[to];
        }
        function adjacentBoundary(oldStart, oldEnd, newStart, newEnd) {
            if (!cleanSource || !move?.boundaryGroups?.length || oldEnd - oldStart !== 2 || newEnd - newStart !== 2) return;
            const oldPair = before.slice(oldStart, oldEnd), newPair = after.slice(newStart, newEnd);
            const keysOf = (entry) => presentationKeys.get(entry);
            const [a, b] = oldPair.map(keysOf);
            if (a === b || b !== keysOf(newPair[0]) || a !== keysOf(newPair[1])) return;
            // Presentation can distinguish different empty layouts; an ID alone cannot.
            const from = move.offset > 0 ? 0 : 1, crossed = 1 - from;
            const blank = oldPair[from], key = keysOf(blank);
            if (before.filter((entry) => keysOf(entry) === key).length !== 1
                || after.filter((entry) => keysOf(entry) === key).length !== 1
                || !isEmptyLayout(blank) || !matchesRow(oldPair[crossed], newPair[from], move.boundaryGroups)) return;
            return { before: oldPair, after: newPair };
        }
        function reordered(oldStart, oldEnd, newStart, newEnd) {
            const length = oldEnd - oldStart;
            if (length < 2 || length !== newEnd - newStart) return false;
            const counts = new Map();
            let moved = false;
            for (let index = 0; index < length; index++) {
                const old = keys.get(before[oldStart + index]), next = keys.get(after[newStart + index]);
                moved ||= old !== next;
                counts.set(old, (counts.get(old) || 0) + 1);
                counts.set(next, (counts.get(next) || 0) - 1);
            }
            return moved && [...counts.values()].every((count) => count === 0);
        }
        function findAnchors(oldStart, oldEnd, newStart, newEnd, oldIndex, newIndex, keyOf) {
            const anchors = [];
            for (let index = oldStart; index < oldEnd; index++) {
                const key = keyOf(before[index]), match = newIndex.get(key);
                if (oldIndex.get(key) !== index || match === undefined || match < newStart || match >= newEnd) continue;
                if (anchors.length && match <= anchors[anchors.length - 1][1]) return null;
                anchors.push([index, match]);
            }
            return anchors;
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
            // Compare order before choosing anchors so a move is not split into an insertion and a deletion.
            const moved = movedEntry(oldStart, oldEnd, newStart, newEnd);
            const boundary = adjacentBoundary(oldStart, oldEnd, newStart, newEnd);
            if (moved || boundary || (local && reordered(oldStart, oldEnd, newStart, newEnd))) {
                if (boundary) {
                    compare(boundary.before[0], boundary.after[1]);
                    compare(boundary.before[1], boundary.after[0]);
                }
                unresolved(oldStart, oldEnd, newStart, newEnd, 'reorder', moved, boundary);
                return;
            }
            let anchors = findAnchors(oldStart, oldEnd, newStart, newEnd, oldPositions, newPositions, contentKey);
            if (anchors?.length === 0) {
                // Stable sibling IDs can separate changed containers with no unchanged content between them.
                oldIds ??= positions(before, childIdentity);
                newIds ??= positions(after, childIdentity);
                anchors = findAnchors(oldStart, oldEnd, newStart, newEnd, oldIds, newIds, childIdentity);
            }
            if (anchors?.length === 0) {
                oldCollections ??= positions(before, collectionKey);
                newCollections ??= positions(after, collectionKey);
                anchors = findAnchors(oldStart, oldEnd, newStart, newEnd, oldCollections, newCollections, collectionKey);
            }
            if (!anchors?.length) {
                unresolved(oldStart, oldEnd, newStart, newEnd, anchors ? 'replacement' : undefined);
                return;
            }
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

function spacingOnly(before, after) {
    return before !== after && before.replace(/\s/g, '') === after.replace(/\s/g, '');
}

function renderedSpacingChanged({ before, after }, cache, excluded) {
    const oldFlow = renderedFlowText(before, cache, excluded), newFlow = renderedFlowText(after, cache, excluded);
    return oldFlow && newFlow && oldFlow.omitted === newFlow.omitted && spacingOnly(oldFlow.text, newFlow.text);
}

function renderedFlowText(entry, cache, excluded) {
    // Let native text collection resolve HTML/CSS whitespace across inline boundaries.
    // Only do that work for a raw-text difference the normal comparison could not see.
    while (entry.node?.isConnected && entry.parent?.node) {
        const { display } = entry.node.ownerDocument.defaultView.getComputedStyle(entry.node);
        if (display !== 'inline' && display !== 'contents') break;
        entry = entry.parent;
    }
    if (!cache.has(entry)) {
        const { node } = entry;
        const omitted = [];
        // Validate the same included text as the snapshot. If excluded text changed too,
        // native innerText cannot tell us which part supplied the rendered difference.
        const text = node?.isConnected && liveEntryText(node, excluded, omitted) === rawEntryText(entry) && renderedElement(entry)
            ? node.innerText : undefined;
        cache.set(entry, typeof text === 'string' ? { text, omitted: JSON.stringify(omitted) } : undefined);
    }
    return cache.get(entry);
}

function liveEntryText(node, excluded, omitted) {
    if (!excluded || !node.querySelector(excluded)) return node.textContent;
    return [...node.childNodes].map((child) => {
        if (child.nodeType === 3) return child.textContent;
        if (child.nodeType !== 1) return '';
        if (!child.matches(excluded)) return liveEntryText(child, excluded, omitted);
        omitted.push(child.textContent);
        return '';
    }).join('');
}

function rawEntryText(entry) {
    return entry.parts.map((part) => typeof part === 'string' ? part : rawEntryText(part)).join('');
}

function entrySpacingTransition({ before, after }) {
    return spacingTransition(before.rawText, after.rawText) || spacingTransition(rawEntryText(before), rawEntryText(after));
}

function spacingTransition(before, after) {
    if (!/\S/.test(before) || !spacingOnly(before, after)) return;
    const old = before.match(/\s+|\S+/g), next = after.match(/\s+|\S+/g);
    let start = 0, end = 0;
    while (start < Math.min(old.length, next.length) && old[start] === next[start]) start++;
    while (end < Math.min(old.length, next.length) - start && old.at(-1 - end) === next.at(-1 - end)) end++;
    // Keep the exact changed whitespace and an adjacent word on either side as context.
    const from = Math.max(0, start - 1), keepSuffix = Math.max(0, end - 1);
    return { type: 'spacing', before: old.slice(from, old.length - keepSuffix).join(''),
        after: next.slice(from, next.length - keepSuffix).join('') };
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
    if (!before || !after) return false;
    const differs = (from, to) => Object.entries(from).some(([key, hint]) => ['text', 'html', 'value'].includes(hint?.type)
        && (!Object.hasOwn(to, key) || hint.type !== to[key]?.type || hint.value !== to[key]?.value));
    return differs(before, after) || differs(after, before);
}

function inputOrderChanged(before, after) {
    return !!before && !!after && Object.entries(after).some(([key, next]) => {
        if (next?.type !== 'order' || !Object.hasOwn(before, key)) return false;
        const old = before[key];
        return old?.type === 'order' && old.members === next.members && old.value !== next.value;
    });
}

// An order hint can name a moved item, but its claim must agree with both submitted snapshots.
function inputMove(before, after, allowBoundary) {
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
    a.splice(from, 1);
    b.splice(to, 1);
    if (!a.every((item, index) => item === b[index])) return;

    const offset = to - from;
    const groups = rowGroups(key, next.moved, a, before, after);
    let boundaryGroups;
    if (allowBoundary && Math.abs(offset) === 1 && !groups.length
        && hasNoRowText(old, next.moved, before) && hasNoRowText(next, next.moved, after)) {
        const crossed = a.splice(Math.min(from, to), 1)[0];
        boundaryGroups = rowGroups(key, crossed, [...a, next.moved], before, after);
    }
    return { offset, groups, boundaryGroups };
}

function hasNoRowText(order, row, values) {
    const html = new Map();
    return order.fieldsByRow?.[row]?.every((name) => rowFieldText(values[name], html)?.label === '');
}

function isEmptyLayout(entry) {
    return !entry.text && !entry.media?.some(Boolean)
        && !/^(?:a|button|input|select|textarea|form|details|img|video|audio|iframe|canvas|svg|object|embed)$/.test(entry.tag)
        && entry.children.every(isEmptyLayout);
}

function rowGroups(key, row, siblings, before, after) {
    const { fieldsByRow } = after[key], oldFields = before[key].fieldsByRow;
    if ([row, ...siblings].some((item) => !oldFields?.[item] || !fieldsByRow?.[item])) return [];
    const groups = [], html = new Map(), previousNames = new Set(oldFields[row]);
    let peers;
    function submittedLabels(names, values) {
        const labels = new Set();
        function collect(entry, cache) {
            // A sibling can supply an exact element's text, even from inside a longer HTML field.
            labels.add(normalizedText(entryText(entry, cache)));
            for (const child of entry.children) collect(child, cache);
        }
        for (const name of names) {
            const field = rowFieldText(values[name], html);
            if (!field) return null; // An unreadable sibling field cannot establish uniqueness.
            if (field.entry) collect(field.entry, field.cache);
            else labels.add(field.label);
        }
        return labels;
    }
    function shared(label, blocks) {
        // Check each sibling in each submission, never a pool of different rows or snapshots.
        peers ??= siblings.flatMap((row) => [submittedLabels(oldFields[row], before), submittedLabels(fieldsByRow[row], after)]);
        return peers.some((peer) => !peer || peer.has(label) || (blocks.length && blocks.every((block) => peer.has(block))));
    }
    for (const name of fieldsByRow[row]) {
        const hint = after[name], previous = before[name];
        if (!previousNames.has(name) || !hint || previous?.type !== hint.type || previous?.value !== hint.value) continue;
        const field = rowFieldText(hint, html);
        if (!field?.label) continue;
        const { entry, cache, label } = field;
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
    return groups;
}

function rowFieldText(hint, html) {
    if (typeof hint?.value !== 'string') return;
    if (hint.type === 'text') return { label: normalizedText(hint.value) };
    if (hint.type !== 'html') return;
    if (!html.has(hint.value)) {
        try {
            const doc = new DOMParser().parseFromString(hint.value, 'text/html');
            const entry = contentSnapshot(doc, doc, [], doc.body), cache = new Map();
            html.set(hint.value, { entry, cache, label: normalizedText(entryText(entry, cache)) });
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
        const oldText = oldDoc ? entryText(oldContent) : old.value;
        const newText = newDoc ? entryText(newContent) : next.value;
        const a = normalizedText(oldText), b = normalizedText(newText);
        if (a !== b) changes.push({ ...textTransition(a, b), type: 'text', fullBefore: a, fullAfter: b });
        if (!oldDoc) {
            const hint = spacingTransition(oldText, newText);
            if (hint) changes.push(hint);
            continue;
        }
        if (!oldContent || !newContent || (a !== b && !spacingOnly(oldText, newText))) continue;
        // Reuse structural comparison for spacing and markup intent rather than searching raw HTML.
        for (const change of changedCandidates(oldContent, newContent)) {
            if (change.spacing) {
                const hint = entrySpacingTransition(change);
                if (hint) changes.push(hint);
                continue;
            }
            if (a !== b) continue;
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
                const previous = normalizedText(entryText(change.before)), value = normalizedText(entryText(change.after));
                if (previous === value && markupChanged(change.before, change.after, entryText)) {
                    changes.push({ type: 'markup', before: previous, after: value, oldTag: change.before.tag, newTag: change.after.tag });
                }
                (change.before.media || []).forEach((value, index) => {
                    const current = change.after.media?.[index];
                    if (value && current && value !== current) changes.push({ type: 'media', before: value, after: current });
                });
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
    return textOccurrences(text, value, 1) > 0;
}

function textOccurrences(text, value, limit = Infinity) {
    if (!value) return 0;
    text = normalizedText(text);
    // Avoid matching a changed word merely inside a longer, unrelated word.
    let count = 0;
    let start = text.indexOf(value);
    while (start !== -1) {
        const end = start + value.length;
        if (wordBoundary(text, start) && wordBoundary(text, end)) {
            if (++count === limit) break;
        }
        start = text.indexOf(value, start + 1);
    }
    return count;
}

function wordBoundary(text, index) {
    // Inspect complete neighboring code points, including letters represented by a surrogate pair.
    return !/[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0, index - 2), index))
        || !/^[\p{L}\p{N}_]/u.test(text.slice(index, index + 2));
}

function replacesSubmittedText(a, b, before, after) {
    if (!before || !after || a.length - before.length !== b.length - after.length) return false;
    for (let start = a.indexOf(before); start !== -1; start = a.indexOf(before, start + 1)) {
        if (b.startsWith(after, start) && wordBoundary(a, start) && wordBoundary(b, start)
            && wordBoundary(a, start + before.length) && wordBoundary(b, start + after.length)
            && a.slice(0, start) === b.slice(0, start) && a.slice(start + before.length) === b.slice(start + after.length)) return true;
    }
    return false;
}

function matchesTransition(before, after, hint, compareSpan = false) {
    const a = normalizedText(before), b = normalizedText(after);
    if (a === b) return false;
    // A complete value can contain the old value or extend past the narrowed text change.
    if ((a === hint.before && b === hint.after) || (a === hint.fullBefore && b === hint.fullAfter)) return true;
    if (compareSpan) {
        // The same changed words can overlap ("docs" → "docs now") within stable surrounding copy.
        const span = textTransition(a, b);
        if (span.before === hint.before && span.after === hint.after) return true;
        // Punctuation or a suffix may change the narrowed span, but not the exact field substitution.
        if (replacesSubmittedText(a, b, hint.fullBefore, hint.fullAfter)) return true;
    }
    // Otherwise the old value must lose an occurrence and the new value gain one.
    return (hint.before ? textOccurrences(a, hint.before) > textOccurrences(b, hint.before) : !a)
        && (hint.after ? textOccurrences(b, hint.after) > textOccurrences(a, hint.after) : !b);
}

function markupChanged(before, after, textOf) {
    // Same-tag wrapping moves unchanged text into or out of descendants; a media URL or copy edit cannot confirm it.
    return before.tag !== after.tag || ((before.children.length || after.children.length) && before.text !== after.text
        && normalizedText(textOf(before)) === normalizedText(textOf(after)));
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
    candidate.matches = [];
    if (candidate.spacing) {
        const authored = hints.filter((hint) => hint.type === 'spacing');
        const transition = authored.length && entrySpacingTransition(candidate);
        candidate.matches = authored.filter((hint) => transition?.before === hint.before && transition?.after === hint.after);
        return candidate.matches.length ? 2 : 0;
    }
    let strength = 0;
    for (const hint of hints) {
        if (hint.type === 'spacing') continue;
        let support = 0;
        if (candidate.kind === 'attributes') {
            if (!['text', 'attribute'].includes(hint.type)) continue;
            const before = new Map(candidate.before.attributes), after = new Map(candidate.after.attributes);
            for (const name of new Set([...before.keys(), ...after.keys()])) {
                if (hint.type === 'attribute' && name !== hint.name) continue;
                const a = before.get(name), b = after.get(name);
                if (JSON.stringify(a) === JSON.stringify(b)) continue;
                // Attribute matching uses the actual value, not its name or another element's text.
                const oldValue = typeof a === 'string' ? a : JSON.stringify(a) || '';
                const newValue = typeof b === 'string' ? b : JSON.stringify(b) || '';
                if (matchesTransition(oldValue, newValue, hint)) {
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
        } else if (hint.type === 'markup') {
            if (candidate.before?.tag === hint.oldTag && candidate.after?.tag === hint.newTag
                && markupChanged(candidate.before, candidate.after, textOf)
                && matchesValue(textOf(candidate.before), hint.before) && matchesValue(textOf(candidate.after), hint.after)) {
                support = hint.before && hint.after ? 2 : 1;
            }
        } else if (hint.type === 'text') {
            const paired = !!(hint.before && hint.after);
            const direct = paired && matchesTransition(candidate.before?.text || '', candidate.after?.text || '', hint, true);
            // A descendant can change in the opposite direction without canceling the element's own edit.
            if (direct || matchesTransition(textOf(candidate.before), textOf(candidate.after), hint, paired)) {
                support = paired ? 2 : 1;
                if (direct) candidate.directInput = true;
            }
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
