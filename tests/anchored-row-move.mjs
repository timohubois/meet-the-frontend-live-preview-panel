import { browserBundle, runChromiumTests, testInChromium } from './helpers/chromium.mjs';

async function checkCases() {
    const { createPreviewComparison, createPreviewScroll, resolveRowRegions } = window.previewScroll;
    const excluded = ['meta', 'script', 'style', 'input[type="hidden"]'];
    const titles = {
        A: 'First authored heading', B: 'Second authored heading', C: 'Third authored heading',
        D: 'Fourth authored heading', E: 'Fifth authored heading',
    };
    const detailTitle = 'Another authored box from the second row';
    const inlineCopy = (changed) => '<span>Alpha</span>' + (changed ? '\n' : '') + '<div style="display:inline">Beta</div>';
    const spacingCopy = (changed) => '<div class="spacing">' + inlineCopy(changed) + '</div>';
    const image = (color) => '<img src="data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="' + color + '"/></svg>',
    ) + '">';
    const path = (letter) => 'acf[field_rows][row-' + letter.toLowerCase() + ']';
    const layout = (letter) => path(letter) + '[acf_fc_layout]';
    const title = (letter) => path(letter) + '[title]';
    const field = 'acf-layout-order:acf[field_rows]';
    function values(order, moved) {
        return {
            [field]: {
                type: 'row-order',
                value: JSON.stringify([...order].map(layout)),
                members: JSON.stringify([...order].sort().map(layout)),
                moved: moved && layout(moved),
                fieldsByRow: Object.fromEntries([...order].map((letter) => [layout(letter), [title(letter)]])),
            },
            ...Object.fromEntries([...order].map((letter) => [title(letter), { type: 'text', value: titles[letter] }])),
            submission: [
                ['post_title', 'Local fixture'],
                ['single_value', 'original'],
                ...[...order].flatMap((letter) => [
                    [layout(letter), 'content'],
                    [path(letter) + '[hidden_setting]', 'enabled'],
                    [title(letter), titles[letter]],
                ]),
                ['other[]', '1'],
                ['other[]', '2'],
            ],
        };
    }
    const marker = (letter, changed) => (changed ? 'f' : 'a').repeat(63) + 'ABCD'.indexOf(letter);
    function markup(order, changed, scenario) {
        const marked = scenario.startsWith('marked ');
        const useText = scenario === 'marked stale snapshot uses text';
        const rowMarker = (letter, index) => marked ? ' data-mtflpp-evidence-row="' + marker(letter, changed) + ':' + index + '"' : '';
        return (
            '<div style="height:1000px">Above</div><div id="rows">' +
            [...order]
                .map((letter) => {
                    const text = scenario === 'second media-only swap' && ['C', 'D'].includes(letter)
                        ? 'Shared caption ' + image(letter === 'C' ? 'red' : 'blue')
                        : (marked && !useText) || scenario === 'resolved vendor row' ? 'Shared heading' : titles[scenario === 'duplicate output' && letter === 'D' ? 'A' : letter];
                    const other =
                        letter === 'A' && changed
                            ? '<div class="upped"><div><span>New render ornament</span></div></div>'
                            : '<div class="standard"><span>Render ornament</span></div>';
                    const hidden = scenario === 'hidden source' && letter === 'A' ? ' hidden' : '';
                    let heading = '<h2>' + text + '</h2>';
                    if (letter === 'A') {
                        if (scenario === 'closed disclosure witness') heading = '<details><summary>More</summary>' + heading + '</details>';
                        if (scenario === 'visible disclosure summary') heading = '<details><summary>' + heading + '</summary>More</details>';
                        if (scenario === 'until-found witness') heading = '<div hidden="until-found">' + heading + '</div>';
                        if (scenario === 'spacing edit inside moved row') heading += spacingCopy(changed);
                    }
                    const id = scenario.startsWith('unexplained') ? ' id="row-' + letter + '"' : '';
                    const media = scenario.startsWith('crossed media') && ['A', 'B'].includes(letter)
                        ? image((letter === 'A') !== (changed && scenario === 'crossed media swapped independently') ? 'red' : 'blue')
                            + image(letter === 'A' ? 'green' : 'purple') : '';
                    const row = '<section data-row="' + letter + '"' + id + hidden + rowMarker(letter, 0) + '>' + heading + media + other + '</section>';
                    if (marked && !useText && letter === 'A') {
                        if (changed && scenario === 'marked duplicate render') return row + row;
                        const split = row + '<section' + rowMarker(letter, 1) + '><p>Shared copy</p></section>';
                        return scenario === 'marked hidden target' && changed ? '<details><summary>More</summary>' + split + '</details>' : split;
                    }
                    if (!scenario.startsWith('split ') || letter !== 'B') return row;
                    const detail = '<section data-detail="B"><h2>' +
                        (scenario === 'split unverified sibling' ? 'No field witness' : detailTitle) + '</h2></section>';
                    return scenario === 'split internal reorder' && changed ? detail + row : row + detail;
                })
                .join('') +
            '</div><aside>' +
            (changed ? '<form><button>Rendered dialog</button></form>' : 'Details') +
            (scenario === 'second collection swap' ? '<ol>' + (changed ? ['Y', 'X'] : ['X', 'Y']).map((item) =>
                '<li>Independent ' + item + '</li>').join('') + '</ol>' : '') +
            (scenario.startsWith('unexplained') ? '<ol>' + [...order].map((letter, i) => {
                const number = scenario === 'unexplained renumbered index' ? (i + 1) + '. ' : '';
                return '<li><a href="#row-' + letter + '">' + number + 'Section ' + letter + '</a></li>';
            }).join('') + '</ol>' : '') +
            (scenario.startsWith('second linked collection') ? '<ul>' + (changed ? ['two', 'one'] : ['one', 'two']).map((target, i) => {
                const id = scenario === 'second linked collection with stable slots' ? ' id="slot-' + i + '"' : '';
                return '<li' + id + '><a href="/' + target + '">Read more</a></li>';
            }).join('') + '</ul>' : '') +
            '</aside><div style="height:1000px">After</div>' +
            (scenario === 'spacing edit outside moved collection' ? spacingCopy(changed).repeat(2) : '')
        );
    }
    async function doc(order, changed, scenario, script, capture = true) {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'width:640px;height:300px';
        const content = markup(order, changed, scenario);
        const doc = new DOMParser().parseFromString(
            '<!doctype html><html><head><meta name="meet-the-frontend-live-preview-panel" content="fixture"><style>section{height:260px}</style></head><body>' +
                (scenario === 'outside comparison root' ? '<main>Unchanged main</main><aside>' + content + '</aside>' : '<main>' + content + '</main>') +
                '</body></html>',
            'text/html',
        );
        let i = changed ? 100 : 0;
        for (const node of doc.querySelectorAll('html,body,body *')) node.setAttribute('data-mtflpp-node', String(++i));
        if (capture) doc.querySelector('meta').setAttribute('data-mtflpp-source', JSON.stringify(doc.documentElement.outerHTML));
        if (script) {
            const node = doc.createElement('script');
            node.textContent = script;
            doc.body.append(node);
        }
        return new Promise((resolve) => {
            frame.onload = () => {
                frame.contentWindow.matchMedia = () => ({ matches: true });
                resolve(frame.contentDocument);
            };
            frame.srcdoc = doc.documentElement.outerHTML;
            document.body.append(frame);
        });
    }
    const cases = [
        'markup churn down',
        'markup churn up',
        'across two rows',
        'split crossed row',
        'split moved row',
        'split internal reorder',
        'split unverified sibling',
        'split runtime detaches sibling',
        'unrelated authored edit',
        'authored edit in moved row',
        'unhinted hidden setting edit',
        'change a concurrent gallery',
        'other repeated input reshuffled',
        'stale move hint',
        'ambiguous rendered row',
        'duplicate output',
        'duplicate live witness',
        'runtime-only order',
        'runtime relocated witness',
        'hidden source',
        'hidden live',
        'closed disclosure witness',
        'visible disclosure summary',
        'until-found witness',
        'missing live row',
        'runtime rewritten witness',
        'runtime changed row copy',
        'second output move',
        'second opaque output move',
        'second media-only swap',
        'crossed media swapped independently',
        'crossed media stays with rows',
        'unexplained index reorder',
        'unexplained renumbered index',
        'second linked collection swaps destinations',
        'second linked collection with stable slots',
        'second collection swap',
        'disabled rows crossed',
        'disabled row value changed',
        'disabled rows independently reshuffled',
        'outside comparison root',
        'missing captured HTML',
        'missing submitted input',
        'unstable crossed row',
        'equivalent rich text serialization',
        'real rich text markup edit',
        'spacing edit inside moved row',
        'spacing edit outside moved collection',
        'reordered across non-row input',
        'CSS order disagrees',
        'resolved vendor row',
        'marked split row with duplicate text',
        'marked stale snapshot',
        'marked stale snapshot uses text',
        'marked duplicate render',
        'marked wrong live node',
        'marked hidden target',
        'marked CSS order disagrees',
        'marked concurrent edit',
    ];
    const results = [];
    for (const name of cases) {
        try {
            const up = name === 'markup churn up',
                across = name === 'across two rows',
                mediaSwap = name === 'second media-only swap';
            const from = mediaSwap ? 'ABCDE' : up ? 'BACD' : 'ABCD',
                to = mediaSwap ? 'BACDE' : up ? 'ABCD' : across ? 'BCAD' : 'BACD';
            const moved = name === 'split moved row' ? 'B' : 'A';
            const beforeValues = values(from),
                afterValues = values(to, name === 'stale move hint' ? 'D' : moved);
            if (name.startsWith('split ')) for (const values of [beforeValues, afterValues]) {
                const fieldName = path('B') + '[box_title]';
                values[field].fieldsByRow[layout('B')].push(fieldName);
                values[fieldName] = { type: 'text', value: detailTitle };
                values.submission.splice(values.submission.findIndex(([key]) => key === title('B')) + 1, 0, [fieldName, detailTitle]);
            }
            if (name.startsWith('disabled row')) {
                const disabled = (letter, value = 'unchanged') => [
                    [layout(letter), 'content'], [path(letter) + '[acf_fc_layout_disabled]', '1'], [path(letter) + '[hidden_setting]', value],
                ];
                beforeValues.submission.splice(5, 0, ...disabled('X'), ...disabled('Y'));
                const x = disabled('X', name === 'disabled row value changed' ? 'edited' : 'unchanged'), y = disabled('Y');
                afterValues.submission.splice(2, 0, ...(name === 'disabled rows independently reshuffled' ? [...y, ...x] : [...x, ...y]));
            }
            if (name === 'resolved vendor row') for (const values of [beforeValues, afterValues]) {
                values[field].fieldsByRow = Object.fromEntries([...from].map((letter) => [layout(letter), []]));
            }
            if (name.startsWith('marked ')) {
                for (const [values, changed] of [[beforeValues, false], [afterValues, true]]) {
                    if (name !== 'marked stale snapshot uses text') {
                        values[field].fieldsByRow = Object.fromEntries([...from].map((letter) => [layout(letter), []]));
                    }
                    values[field].rowMarkers = Object.fromEntries([...from].map((letter) =>
                        [layout(letter), marker(letter, changed && !name.startsWith('marked stale snapshot'))]));
                }
            }
            const entries = afterValues.submission;
            if (['unrelated authored edit', 'marked concurrent edit'].includes(name)) entries[1][1] = 'another';
            if (name === 'authored edit in moved row') entries.find(([name]) => name === title('A'))[1] = 'changed';
            if (name === 'unhinted hidden setting edit') entries.find(([name]) => name === path('A') + '[hidden_setting]')[1] = 'disabled';
            if (name === 'change a concurrent gallery') {
                beforeValues.gallery = { type: 'gallery-order', value: '1,2', members: '1,2' };
                afterValues.gallery = { type: 'gallery-order', value: '2,1', members: '1,2' };
            }
            if (name === 'other repeated input reshuffled')
                [entries[entries.length - 1], entries[entries.length - 2]] = [entries.at(-2), entries.at(-1)];
            if (name === 'missing submitted input') delete afterValues.submission;
            if (name === 'reordered across non-row input') {
                beforeValues.submission.splice(5, 0, ['interleaved', 'same']);
                afterValues.submission.splice(8, 0, ['interleaved', 'same']);
            }
            if (name === 'equivalent rich text serialization' || name === 'real rich text markup edit') {
                const key = title('A'),
                    old = '<h2>' + titles.A + '</h2>';
                const next = name === 'equivalent rich text serialization' ? old.replace('<h2>', '<h2 >') : '<h2 class="authored">' + titles.A + '</h2>';
                for (const [values, text] of [
                    [beforeValues, old],
                    [afterValues, next],
                ]) {
                    values[key] = { type: 'html', value: text };
                    values.submission.find(([name]) => name === key)[1] = text;
                }
            }
            if (name.startsWith('spacing edit')) {
                const inside = name === 'spacing edit inside moved row', key = inside ? path('A') + '[copy]' : 'single_value';
                for (const [values, changed] of [[beforeValues, false], [afterValues, true]]) {
                    const text = inlineCopy(changed);
                    values[key] = { type: 'html', value: text };
                    if (inside) values.submission.splice(values.submission.findIndex(([name]) => name === title('A')) + 1, 0, [key, text]);
                    else values.submission[1][1] = text;
                }
            }
            if (mediaSwap) for (const values of [beforeValues, afterValues]) for (const letter of ['C', 'D']) {
                values[title(letter)].value = 'Shared caption';
                values.submission.find(([key]) => key === title(letter))[1] = 'Shared caption';
            }
            if (name === 'unstable crossed row') for (const values of [beforeValues, afterValues]) values[title('B')].value = 'not rendered';
            if (name === 'second opaque output move')
                for (const values of [beforeValues, afterValues]) for (const letter of ['C', 'D']) values[title(letter)].value = '';
            const scripts = {
                'duplicate live witness':
                    "const h=document.createElement('h2');h.textContent=document.querySelector('[data-row=A] h2').textContent;document.body.append(h)",
                'runtime-only order': "document.querySelector('[data-row=A]').before(document.querySelector('[data-row=B]'))",
                'runtime relocated witness': "document.querySelector('[data-row=B]').append(document.querySelector('[data-row=A] h2'))",
                'hidden live': "document.querySelector('[data-row=A]').hidden=true",
                'CSS order disagrees': "document.querySelector('#rows').style.cssText='display:flex;flex-direction:column-reverse'",
                'marked CSS order disagrees': "document.querySelector('#rows').style.cssText='display:flex;flex-direction:column-reverse'",
                'marked wrong live node': "document.querySelector('[data-row=A]').setAttribute('data-mtflpp-node','duplicate')",
                'missing live row': "document.querySelector('[data-row=A]').remove()",
                'split runtime detaches sibling': "document.querySelector('[data-row=D]').append(document.querySelector('[data-detail=B]'))",
                'runtime rewritten witness': "document.querySelector('[data-row=A] h2').textContent='Not the same row'",
                'runtime changed row copy': "document.querySelector('[data-row=A]').append(document.createTextNode('different story'))",
                'ambiguous rendered row': "const row=document.querySelector('[data-row=A]');row.after(row.cloneNode(true))",
            };
            const before = await doc(from, false, name);
            const output = name === 'runtime-only order' ? from : mediaSwap ? 'BADCE'
                : ['second output move', 'second opaque output move'].includes(name) ? 'BADC' : to;
            const after = await doc(output, true, name, scripts[name], name !== 'missing captured HTML');
            if (name.startsWith('spacing edit') && (before.querySelector('.spacing').innerText !== 'AlphaBeta'
                || after.querySelector('.spacing').innerText !== 'Alpha Beta')) throw Error('The edit must change visible spacing');
            const vendorRegions = ({ sourceDocument, document }) => new Map([...from].map((letter) => {
                const selector = `[data-row=${letter}]`;
                return [layout(letter), [[sourceDocument.querySelector(selector), document.querySelector(selector)]]];
            }));
            const comparison = createPreviewComparison(excluded, name === 'resolved vendor row' ? vendorRegions : resolveRowRegions),
                scrolling = createPreviewScroll();
            const { submission: oldRequest, ...oldHints } = beforeValues;
            const { submission: nextRequest, ...nextHints } = afterValues;
            comparison.capture(before, oldHints, oldRequest);
            comparison.capture(after, nextHints, nextRequest);
            const target = comparison.findChange(before, after);
            const shouldFollow = [
                'markup churn down', 'markup churn up', 'across two rows', 'equivalent rich text serialization', 'visible disclosure summary',
                'split crossed row', 'split moved row', 'split unverified sibling', 'crossed media stays with rows', 'disabled rows crossed',
                'resolved vendor row', 'marked split row with duplicate text', 'marked stale snapshot uses text',
            ].includes(name);
            const baseline = createPreviewComparison(excluded);
            baseline.capture(before, oldHints);
            baseline.capture(after, nextHints);
            const earlierTarget = baseline.findChange(before, after);
            if (shouldFollow && earlierTarget) throw Error('The fixture must exercise the fallback, not an existing target');
            const expected = shouldFollow ? after.querySelector(`[data-row=${moved}] h2`) : earlierTarget;
            if (target !== expected || (!shouldFollow && name !== 'real rich text markup edit' && target)) {
                throw Error('Unexpected target: ' + target?.outerHTML.slice(0, 170));
            }
            before.defaultView.scrollTo(0, 100);
            scrolling.remember(before);
            await scrolling.restore(after, target);
            const y = after.defaultView.scrollY;
            if (expected ? y <= 100 : y !== 100) throw Error('Unexpected scroll position: ' + y);
            if (shouldFollow) {
                const { top, bottom } = target.getBoundingClientRect();
                if (top < 0 || bottom > after.defaultView.innerHeight) throw Error('Target was not revealed');
            }
            if (after.querySelector('details')?.open) throw Error('Following must not open a disclosure with a visible or rejected witness');
            if (name === 'until-found witness' && !after.querySelector('[hidden="until-found"]')) throw Error('A hidden witness must stay hidden');
            results.push({ name });
        } catch (error) {
            results.push({ name, error: error.message });
        } finally {
            document.querySelectorAll('iframe').forEach((frame) => frame.remove());
        }
    }
    return results;
}
testInChromium('a submitted row rotation follows verified rendered text through markup churn', async (t) => {
    const bundle = await browserBundle(t, new URL('./browser/preview-scroll.js', import.meta.url), 'previewScroll');
    await runChromiumTests(t, { head: `<script src="${bundle}"></script>`, script: `(${checkCases.toString()})()`, count: 59 });
});
