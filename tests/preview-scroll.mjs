import { browserBundle, runChromiumTests, testInChromium } from './helpers/chromium.mjs';

async function browserTests() {
    const { createPreviewScroll, createPreviewComparison, visibleTarget } = window.previewScroll;
    const results = [];
    // Model the PHP configuration; editor-extensions.php separately verifies the complete shipped policy.
    const defaults = ['script', 'style', 'noscript', 'template', 'link', 'meta', 'nav',
        '[role="navigation"]', '[aria-live]', 'input[type="hidden"]', 'table.xdebug-error'];
    async function check(name, run, excludedSelectors = defaults) {
        const frames = [];
        const documentFor = async (content, { captured = false, script = '', offset = 0, reducedMotion = true } = {}) => {
            const frame = document.createElement('iframe');
            frame.style.cssText = 'width:640px;height:320px;border:0';
            frames.push(frame);
            const loaded = new Promise((resolve) => { frame.onload = resolve; });
            let html = `<!doctype html><html><head><meta name="meet-the-frontend-live-preview-panel" content="source-token"><style>p{height:100px;margin:0}img{width:20px;height:20px}</style></head><body><main>${content}</main><script>${script}</script></body></html>`;
            if (captured) {
                // Model the PHP wire format; the PHP fixture separately verifies the actual buffer/HTML API.
                const source = new DOMParser().parseFromString(html, 'text/html');
                for (const node of source.querySelectorAll('*')) {
                    if (!['base', 'head', 'link', 'meta', 'script', 'style', 'title'].includes(node.localName)) {
                        node.setAttribute('data-mtflpp-node', String(++offset));
                    }
                }
                const original = `<!doctype html>${source.documentElement.outerHTML}`;
                source.querySelector('meta').setAttribute('data-mtflpp-source', JSON.stringify(original));
                html = `<!doctype html>${source.documentElement.outerHTML}`;
            }
            frame.srcdoc = html;
            document.body.append(frame);
            await loaded;
            // Keep positioning assertions synchronous; motion-specific tests set their preference explicitly.
            const win = frame.contentWindow;
            const matchMedia = win.matchMedia.bind(win);
            win.matchMedia = (query) => query === '(prefers-reduced-motion: reduce)'
                ? { matches: reducedMotion } : matchMedia(query);
            return frame.contentDocument;
        };
        const comparison = createPreviewComparison(excludedSelectors), scrolling = createPreviewScroll();
        // Exercise the same composition as frame.js without exposing comparison state through scrolling.
        const frame = {
            comparison, scrolling, capture: comparison.capture, remember: scrolling.remember,
            findTarget(previous, next, values) {
                comparison.capture(previous);
                comparison.capture(next, values);
                return visibleTarget(comparison.findChange(previous, next));
            },
            restore(doc, element, values) {
                comparison.capture(doc, values);
                return scrolling.restore(doc, element);
            },
        };
        try { await run(frame, documentFor); results.push({ name }); }
        catch (error) { results.push({ name, error: error.message }); }
        finally { frames.forEach((frame) => frame.remove()); }
    }
    const content = (text = 'Original paragraph', imageClass = 'lazyload') =>
        `<img class="${imageClass}" data-src="/avatar.jpg"><p>Unchanged introduction</p><p>Unchanged middle</p><p id="edited">${text}</p><p>End</p>`;
    const equal = (actual, expected, message) => { if (actual !== expected) throw new Error(message); };
    await check('edited block text wins over incidental lazy-loading classes', async (scrolling, doc) => {
        const previous = await doc(content());
        await scrolling.restore(previous);
        previous.querySelector('img').className = 'lazyloaded';
        const next = await doc(content('Changed paragraph', 'ls-is-cached lazyloaded'));
        const target = scrolling.findTarget(previous, next);
        equal(target, next.querySelector('#edited'), 'Follow the edited paragraph, not the unchanged avatar.');
        await scrolling.restore(next, target);
        if (next.defaultView.scrollY <= 0) throw new Error('Reveal the off-screen change.');
    });
    await check('content changes win over incidental ancestor presentation changes', async (scrolling, doc) => {
        const previous = await doc(content());
        await scrolling.restore(previous);
        const next = await doc(content('Changed paragraph'));
        next.documentElement.style.scrollPaddingTop = '32px';
        equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'A runtime root style must not hide the actual content change.');
    });
    await check('presentation-only edits still reveal the changed element', async (scrolling, doc) => {
        const previous = await doc(content());
        const next = await doc(content());
        next.querySelector('#edited').classList.add('has-text-align-right');
        equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'Keep support for genuine block class/style changes.');
    });
    await check('normalized lazy media sources do not mask an edited image', async (scrolling, doc) => {
        const previous = await doc(content());
        const next = await doc(content());
        next.querySelector('img').setAttribute('src', '/avatar.jpg');
        equal(scrolling.findTarget(previous, next), null, 'Resolving the declared lazy source is not an edit.');
        const edited = await doc(content());
        edited.querySelector('img').setAttribute('data-src', '/changed.jpg');
        equal(scrolling.findTarget(previous, edited), edited.querySelector('img'), 'Actual image-source edits still count.');
    });
    await check('deletions reveal surviving content and unchanged documents preserve their position', async (scrolling, doc) => {
        const previous = await doc(content());
        const next = await doc(content(), { reducedMotion: false });
        equal(scrolling.findTarget(previous, next), null, 'Unchanged output must not invent a target.');
        // Use a fresh document because snapshots are intentionally cached at load.
        const deleted = await doc(content().replace('<p id="edited">Original paragraph</p>', ''));
        equal(scrolling.findTarget(previous, deleted), deleted.querySelector('p:last-child'), 'Deletion lands on the next surviving content.');
        previous.defaultView.scrollTo(0, 60);
        scrolling.remember(previous);
        next.documentElement.style.scrollBehavior = 'smooth';
        await scrolling.restore(next);
        equal(next.defaultView.scrollY, 60, 'Without a target, restore the last position instantly despite author smooth scrolling.');
    });
    const section = (heading, text = 'Repeated paragraph') => `<section><h2>${heading}</h2><p>${text}</p></section>`;
    await check('nested section insertion follows the new section, not a reused wrapper', async (scrolling, doc) => {
        const previous = await doc(section('First') + section('Last'));
        const next = await doc(section('First') + section('Inserted') + section('Last'));
        equal(scrolling.findTarget(previous, next), next.querySelectorAll('section')[1], 'Unchanged surrounding sections identify the complete insertion.');
    });
    await check('nested section deletion follows the surviving section boundary', async (scrolling, doc) => {
        const previous = await doc(section('First') + section('Removed') + section('Last'));
        const next = await doc(section('First') + section('Last'));
        equal(scrolling.findTarget(previous, next), next.querySelectorAll('section')[1], 'A deletion should not be mistaken for an edit to the surviving heading.');
    });
    await check('deleting the last section follows the preceding section, not its last descendant', async (scrolling, doc) => {
        const previous = await doc(section('First') + section('Removed'));
        const next = await doc(section('First'));
        equal(scrolling.findTarget(previous, next), next.querySelector('section'), 'Keep the deletion fallback at the sibling section level.');
    });
    await check('deleting the only nested child stays within its surviving container', async (scrolling, doc) => {
        const previous = await doc('<section><p>Removed</p></section>' + section('Unrelated'));
        const next = await doc('<section></section>' + section('Unrelated'));
        equal(scrolling.findTarget(previous, next), next.querySelector('section'), 'Do not jump into unrelated content outside the emptied section.');
    });
    await check('reordering sections without an identifiable edited section preserves position', async (scrolling, doc) => {
        const previous = await doc(section('First') + section('Second') + section('Third'));
        const next = await doc(section('Second') + section('Third') + section('First'));
        equal(scrolling.findTarget(previous, next), null, 'The output alone cannot identify which of the reordered sections the user moved.');
        previous.defaultView.scrollTo(0, 100);
        scrolling.remember(previous);
        await scrolling.restore(next);
        equal(next.defaultView.scrollY, 100, 'An ambiguous reorder must not reset the reader position.');
    });
    await check('repeated paragraphs are matched within their unchanged section context', async (scrolling, doc) => {
        const previous = await doc(section('First') + section('Second') + section('Third'));
        const next = await doc(section('First') + section('Second', 'Edited paragraph') + section('Third'));
        equal(scrolling.findTarget(previous, next), next.querySelectorAll('section p')[1], 'Repeated text in other sections must not capture the edit.');
    });
    await check('indistinguishable repeated insertions do not invent an insertion position', async (scrolling, doc) => {
        const previous = await doc(section('Repeated') + section('Repeated'));
        const next = await doc(section('Repeated') + section('Repeated') + section('Repeated'));
        equal(scrolling.findTarget(previous, next), null, 'Identical output cannot distinguish an insertion at the start, middle or end.');
    });
    await check('indistinguishable repeated deletions do not invent a deletion position', async (scrolling, doc) => {
        const previous = await doc(section('Repeated') + section('Repeated') + section('Repeated'));
        const next = await doc(section('Repeated') + section('Repeated'));
        equal(scrolling.findTarget(previous, next), null, 'Do not assume that the last identical section was deleted.');
    });
    await check('unchanged separators locate insertions and deletions of otherwise repeated sections', async (scrolling, doc) => {
        const previous = await doc(section('Repeated') + section('Separator') + section('Last'));
        const inserted = await doc(section('Repeated') + section('Separator') + section('Repeated') + section('Last'));
        equal(scrolling.findTarget(previous, inserted), inserted.querySelectorAll('section')[2], 'Separated repeats still have an identifiable insertion boundary.');
        const deleted = await doc(section('Repeated') + section('Separator') + section('Last'));
        equal(scrolling.findTarget(inserted, deleted), deleted.querySelectorAll('section')[2], 'Separated repeats still have an identifiable deletion boundary.');
    });
    await check('separate visible text changes are ambiguous rather than following the first one', async (scrolling, doc) => {
        const previous = await doc(section('Status', 'Generated value 1') + section('Middle') + section('Article', 'Original text'));
        const next = await doc(section('Status', 'Generated value 2') + section('Middle') + section('Article', 'Edited text'));
        equal(scrolling.findTarget(previous, next), null, 'Without editor-to-output mapping, either visible change could be unrelated runtime output.');
    });
    await check('an insertion and a separate edit remain separate across unchanged sections', async (scrolling, doc) => {
        const previous = await doc(section('First') + section('Middle') + section('Last', 'Original text'));
        const next = await doc(section('Inserted') + section('First') + section('Middle') + section('Last', 'Edited text'));
        equal(scrolling.findTarget(previous, next), null, 'Align unchanged sections rather than treating the whole remainder as one replacement.');
    });
    await check('hidden runtime text does not mask the visible edit', async (scrolling, doc) => {
        const previous = await doc('<div hidden>Generated value 1</div>' + content());
        const next = await doc('<div hidden>Generated value 2</div>' + content('Changed paragraph'));
        equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'A hidden change must not promote the entire main element to a target.');
    });
    await check('hidden-only changes fall back to their nearest visible container', async (scrolling, doc) => {
        const previous = await doc('<div hidden>Generated value 1</div>' + content());
        const next = await doc('<div hidden>Generated value 2</div>' + content());
        equal(scrolling.findTarget(previous, next), next.querySelector('main'), 'When only hidden content changed, use its visible context rather than widget-specific knowledge.');
    });
    for (const captured of [false, true]) {
        const mode = captured ? 'captured source' : 'DOM fallback';
        await check(`${mode}: hidden edits reveal the nearest visible container without opening the widget`, async (scrolling, doc) => {
            const markup = (text) => `${content()}<section id="context"><button data-action="toggle">Open article</button>
                <div hidden><div><p>${text}</p></div></div><p>Visible context</p></section>`;
            const previous = await doc(markup('Before'), { captured });
            const next = await doc(markup('After'), { captured });
            const container = next.querySelector('#context');
            const original = container.outerHTML;
            let clicks = 0;
            container.querySelector('button').addEventListener('click', () => { clicks++; });
            const target = scrolling.findTarget(previous, next);
            equal(target, container, 'No ID, ARIA relationship or theme attribute is required.');
            await scrolling.restore(next, target);
            equal(container.outerHTML, original, 'Leave widget markup and hidden state unchanged.');
            equal(clicks, 0, 'Do not simulate interaction to force the region open.');
            if (next.defaultView.scrollY <= 0) throw new Error('Reveal the offscreen container.');
        });
        await check(`${mode}: control attributes and duplicate widget IDs do not determine the container fallback`, async (scrolling, doc) => {
            const markup = (text) => `<section id="context"><button aria-controls="panel">One</button><button aria-controls="panel">Two</button>
                <div id="panel" hidden><p>${text}</p></div><div id="panel" hidden>Unchanged duplicate</div></section>`;
            const previous = await doc(markup('Before'), { captured });
            const next = await doc(markup('After'), { captured });
            equal(scrolling.findTarget(previous, next), next.querySelector('#context'), 'Follow the changed node ancestry, not a relationship lookup.');
        });
        await check(`${mode}: direct visible edits take precedence over hidden-container fallbacks`, async (scrolling, doc) => {
            const noise = (text) => `<section><h2>Unchanged status</h2><div hidden>${text}</div></section>`;
            const previous = await doc(noise('Generated before') + content(), { captured });
            const next = await doc(noise('Generated after') + content('Changed paragraph'), { captured });
            equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'A hidden change must not compete with an identifiable visible edit.');
        });
        await check(`${mode}: hidden insertions and deletions do not compete with a direct visible edit`, async (scrolling, doc) => {
            const previous = await doc('<div hidden>Generated value</div>' + content(), { captured });
            const deleted = await doc(content('Changed paragraph'), { captured });
            equal(scrolling.findTarget(previous, deleted), deleted.querySelector('#edited'), 'A hidden deletion must not promote an unchanged neighboring paragraph.');
            const inserted = await doc('<div hidden>Generated again</div>' + content('Changed again'), { captured });
            equal(scrolling.findTarget(deleted, inserted), inserted.querySelector('#edited'), 'A hidden insertion must remain a lower-priority container fallback.');
        });
        await check(`${mode}: separate hidden changes with different visible containers preserve position`, async (scrolling, doc) => {
            const region = (heading, text) => `<section><h2>${heading}</h2><div hidden><p>${text}</p></div></section>`;
            const previous = await doc(region('First', 'Before one') + section('Middle') + region('Last', 'Before two'), { captured });
            const next = await doc(region('First', 'After one') + section('Middle') + region('Last', 'After two'), { captured });
            equal(scrolling.findTarget(previous, next), null, 'Do not guess between competing container fallbacks.');
        });
        await check(`${mode}: hidden insertions and deletions use their local visible container`, async (scrolling, doc) => {
            const markup = (inside) => `<section id="context"><h2>Context</h2><div hidden>${inside}</div></section>`;
            const previous = await doc(markup(''), { captured });
            const inserted = await doc(markup('<p>Inserted text</p>'), { captured });
            equal(scrolling.findTarget(previous, inserted), inserted.querySelector('#context'), 'A hidden insertion still has visible context.');
            const deleted = await doc(markup(''), { captured });
            equal(scrolling.findTarget(inserted, deleted), deleted.querySelector('#context'), 'A hidden deletion stays within the surviving local context.');
        });
    }
    for (const captured of [false, true]) {
        await check(`deleted item follows its visible viewport without moving hidden overflow, captured=${captured}`, async (frame, doc) => {
            const markup = (middle) => `<div style="height:700px"></div>
                <div id="viewport" style="width:250px;overflow:hidden"><div id="track" style="display:flex;transform:translateX(0)">
                  ${[1, ...(middle ? [2] : []), 3].map((i) => `<figure id="item-${i}" style="flex:0 0 240px;height:130px;margin:0"><img src="/image-${i}.jpg"></figure>`).join('')}
                </div></div><div style="height:700px"></div>`;
            const before = await doc(markup(true), { captured }), after = await doc(markup(false), { captured });
            frame.capture(before);
            frame.capture(after);
            const viewport = after.querySelector('#viewport'), next = after.querySelector('#item-3');
            const target = frame.comparison.findChange(before, after);
            equal(target, next, 'Comparison identifies the surviving next item, independently of clipping.');
            equal(visibleTarget(target), viewport, 'Use the clipping viewport itself even if a sliver of the next item is visible.');
            const track = after.querySelector('#track'), style = track.getAttribute('style');
            await frame.scrolling.restore(after, target);
            equal(after.defaultView.scrollY > 0, true, 'Reveal the gallery in the page.');
            equal(viewport.scrollLeft, 0, 'Do not programmatically move the widget viewport.');
            equal(track.getAttribute('style'), style, 'Do not change the selected item or position the track.');
            equal(visibleTarget(after.querySelector('#item-1')), after.querySelector('#item-1'), 'An already displayable item stays precise.');
        });
        for (const alreadyVisible of [false, true]) {
            await check(`an emptied container follows only if off-screen, visible=${alreadyVisible}, captured=${captured}`, async (frame, doc) => {
                const markup = (image) => `<style>body{margin:0}</style><div style="height:${alreadyVisible ? 740 : 1200}px"></div>
                    <section id="gallery">${image}</section><div style="height:900px"></div>`;
                const before = await doc(markup('<img src="/last.jpg" alt="Last image">'), { captured });
                const after = await doc(markup(''), { captured });
                frame.capture(before);
                frame.capture(after);
                before.defaultView.scrollTo(0, 500);
                frame.scrolling.remember(before);
                const target = frame.comparison.findChange(before, after);
                equal(target, after.querySelector('#gallery'), 'Follow the surviving location when the last image is deleted.');
                equal(target.getBoundingClientRect().height, 0, 'The empty location is a position, not a visible box.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 500, alreadyVisible, 'Leave a visible deletion anchor alone.');
                const { top } = target.getBoundingClientRect();
                equal(top >= 0 && top < after.defaultView.innerHeight, true, 'An off-screen deletion anchor is still brought into view.');
            });
        }
        await check(`custom disclosure falls back to its edited item after refresh, captured=${captured}`, async (frame, doc) => {
            const markup = (id, text) => `<style>[aria-hidden="true"]{display:none}</style><div style="height:700px"></div>
                <ul><li><h3>First item</h3></li><li id="item"><h3><button aria-expanded="false" aria-controls="${id}">Edited item</button></h3>
                  <div id="${id}" aria-hidden="true"><p id="edited">${text}</p></div></li></ul><div style="height:700px"></div>`;
            const open = "document.querySelector('button').setAttribute('aria-expanded', 'true'); document.querySelector('#old-panel').setAttribute('aria-hidden', 'false');";
            const before = await doc(markup('old-panel', 'Original'), { captured, script: open });
            const after = await doc(markup('new-panel', 'Revised'), { captured });
            equal(before.querySelector('#old-panel').getClientRects().length > 0, true, 'The previous preview had the widget open.');
            equal(after.querySelector('#new-panel').getClientRects().length, 0, 'The refreshed widget starts closed.');
            const values = (value) => ({ body: { type: 'text', value } });
            frame.capture(before, values('Original'));
            frame.capture(after, values('Revised'));
            const target = frame.comparison.findChange(before, after), item = after.querySelector('#item');
            let clicks = 0;
            item.querySelector('button').addEventListener('click', () => clicks++);
            equal(target, after.querySelector('#edited'), 'Identify the edited body even though its ID and open state changed across refresh.');
            equal(visibleTarget(target), item, 'Follow the visible item, not the whole list.');
            const original = item.outerHTML;
            await frame.scrolling.restore(after, target);
            equal(after.defaultView.scrollY > 0, true, 'Bring the edited item into the viewport.');
            equal(item.outerHTML, original, 'Do not change the widget’s disclosure state.');
            equal(clicks, 0, 'Do not simulate interactions with custom controls.');
        });
    }
    for (const overflow of ['clip', 'auto']) {
        await check(`follow respects ${overflow} without mistaking an ordinary scrollport for a widget`, async (frame, doc) => {
            const after = await doc(`<div style="height:700px"></div><div id="viewport" style="width:200px;overflow:${overflow}">
                <div style="display:flex"><div style="flex:0 0 200px">First</div><div id="edited" style="flex:0 0 200px">Edited</div></div>
                </div><div style="height:700px"></div>`);
            const target = after.querySelector('#edited'), viewport = after.querySelector('#viewport');
            const scrollable = overflow === 'auto';
            if (!after.defaultView.CSS.supports('overflow', overflow)) return;
            equal(visibleTarget(target), scrollable ? target : viewport, 'Only a scrollable target stays precise.');
            await frame.scrolling.restore(after, target);
            equal(after.defaultView.scrollY > 0, true, 'Reveal the target or its clipping context.');
            equal(viewport.scrollLeft, scrollable ? 200 : 0, 'Keep ordinary scrollports functional without trying to pan a hard clip.');
        });
    }
    for (const property of ['scroll-padding-right', 'scroll-margin-right']) {
        await check(`a hidden viewport with ${property} is followed without panning its contents`, async (frame, doc) => {
            const inset = `${property}:45px`;
            const after = await doc(`<div style="height:700px"></div>
                <div id="viewport" style="width:250px;overflow:hidden;${property.startsWith('scroll-padding') ? inset : ''}">
                  <div style="width:600px;height:120px;position:relative">
                    <div id="edited" style="position:absolute;left:145px;width:100px;height:100px;${property.startsWith('scroll-margin') ? inset : ''}">Edited</div>
                  </div>
                </div><div style="height:700px"></div>`);
            const target = after.querySelector('#edited'), viewport = after.querySelector('#viewport');
            equal(target.getBoundingClientRect().right <= viewport.getBoundingClientRect().right, true, 'The box already fits; native alignment can still move it.');
            equal(visibleTarget(target), viewport, 'Prefer the viewport rather than triggering native alignment inside it.');
            await frame.scrolling.restore(after, target);
            equal(after.defaultView.scrollY > 0, true, 'Follow the widget on the page.');
            equal(viewport.scrollLeft, 0, 'Leave its internal scroll position alone.');
        });
    }
    await check('visible scroll targets do not query their descendants', async (frame, doc) => {
        const document = await doc(content() + '<section id="target"><h2>Heading</h2><p>Content</p></section>');
        const target = document.querySelector('#target');
        const query = target.querySelectorAll;
        let queries = 0;
        target.querySelectorAll = function (...args) {
            queries++;
            return query.apply(this, args);
        };
        equal(visibleTarget(target), target, 'The visible identified element remains the target.');
        equal(queries, 0, 'Do not collect descendants when the target itself is visible.');
        await frame.scrolling.restore(document, target);
        equal(queries, 0, 'Scroll restoration must use the same fast path.');
        if (document.defaultView.scrollY <= 0) throw new Error('The visible target is still revealed.');
    });
    for (const style of ['display:contents', 'visibility:hidden']) {
        await check(`scroll targets with ${style} still reveal their first visible descendant`, async (frame, doc) => {
            const document = await doc(content() + `<section id="target" style="${style}"><div hidden><p>Hidden</p></div><h2 id="visible" style="visibility:visible">First visible</h2><p style="visibility:visible">Second visible</p></section>`);
            const target = document.querySelector('#target');
            equal(visibleTarget(target), document.querySelector('#visible'), 'Skip hidden descendants and retain document order.');
            await frame.scrolling.restore(document, target);
            if (document.defaultView.scrollY <= 0) throw new Error('The visible descendant is still revealed.');
        });
    }
    await check('hidden scroll targets without visible descendants still reveal their nearest visible ancestor', async (frame, doc) => {
        const document = await doc(content() + '<section id="context"><h2>Closed widget</h2><div id="target" hidden><p>Hidden</p></div></section>');
        const target = document.querySelector('#target');
        equal(visibleTarget(target), document.querySelector('#context'), 'Retain the nearest visible ancestor fallback.');
        await frame.scrolling.restore(document, target);
        if (document.defaultView.scrollY <= 0) throw new Error('The visible ancestor is still revealed.');
    });
    await check('boxless inserted wrappers reveal their visible content instead of main', async (scrolling, doc) => {
        const previous = await doc(section('First') + section('Last'));
        const next = await doc(section('First') + '<section style="display:contents"><h2>Inserted</h2><p>New content</p></section>' + section('Last'));
        equal(scrolling.findTarget(previous, next), next.querySelectorAll('section')[1].querySelector('h2'), 'A display:contents wrapper can be followed through its own visible descendants.');
    });
    await check('inserted empty layout elements are still detectable', async (scrolling, doc) => {
        const previous = await doc(section('First') + section('Last'));
        const next = await doc(section('First') + '<div style="height:80px"></div>' + section('Last'));
        equal(scrolling.findTarget(previous, next), next.querySelector('main > div'), 'Structure-only edits do not require text or media.');
    });
    await check('independent presentation changes are also ambiguous', async (scrolling, doc) => {
        const previous = await doc(section('First') + section('Middle') + section('Last'));
        const next = await doc(section('First') + section('Middle') + section('Last'));
        next.querySelector('section').className = 'runtime-ready';
        next.querySelectorAll('section')[2].className = 'has-text-align-right';
        equal(scrolling.findTarget(previous, next), null, 'Do not guess which of multiple presentation-only changes came from the editor.');
    });
    for (const captured of [false, true]) {
        const mode = captured ? 'captured source' : 'DOM fallback';
        const diagnostic = (value) => `<table class="xdebug-error xe-warning"><tr><th>Warning: missing asset</th></tr>${
            Array.from({ length: 6 }, (_, index) => `<tr><td>${index}</td><td>${value}-${index}</td></tr>`).join('')
        }</table>`;
        await check(`${mode}: Xdebug timings do not veto the edited paragraph`, async (scrolling, doc) => {
            const previous = await doc(content() + diagnostic('0.1234'), { captured });
            const next = await doc(content('Changed paragraph') + diagnostic('0.5678'), { captured });
            const warning = next.querySelector('table.xdebug-error');
            const html = warning.outerHTML;
            const target = scrolling.findTarget(previous, next);
            equal(target, next.querySelector('#edited'), 'Per-request diagnostic rows are not a second author edit.');
            await scrolling.restore(next, target);
            equal(warning.outerHTML, html, 'Comparison must not suppress or rewrite the warning.');
            if (!warning.getClientRects().length) throw new Error('Leave the diagnostic output visible.');
        });
        await check(`${mode}: diagnostic-only changes preserve positioning`, async (scrolling, doc) => {
            const previous = await doc(content() + diagnostic('0.1234'), { captured });
            const next = await doc(content() + diagnostic('0.5678'), { captured });
            previous.defaultView.scrollTo(0, 60);
            scrolling.remember(previous);
            const target = scrolling.findTarget(previous, next);
            equal(target, null, 'A changing warning is not content to follow.');
            await scrolling.restore(next, target);
            equal(next.defaultView.scrollY, 60, 'Keep the reader position for diagnostic-only updates.');
        });
        await check(`${mode}: diagnostic noise does not hide a presentation-only edit`, async (scrolling, doc) => {
            const previous = await doc(content() + diagnostic('0.1234'), { captured });
            const next = await doc(content().replace('id="edited"', 'id="edited" class="has-text-align-right"')
                + diagnostic('0.5678'), { captured });
            equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'Exclude diagnostics before deciding whether content or presentation changed.');
        });
        await check(`${mode}: ordinary table edits still count and retain ambiguity`, async (scrolling, doc) => {
            const table = (value) => `<table class="article-data xe-warning"><tr><td>${value}</td></tr><tr><td>Unchanged row</td></tr></table>`;
            const previous = await doc(content() + table('Original value'), { captured });
            const next = await doc(content() + table('Edited value'), { captured });
            equal(scrolling.findTarget(previous, next), next.querySelector('td'), 'Normal data tables, even with a warning class, are author content.');
            const separate = await doc(content('Changed paragraph') + table('Edited value'), { captured });
            equal(scrolling.findTarget(previous, separate), null, 'Two genuine edits must not become a guessed target.');
        });
    }
    for (const captured of [false, true]) {
        const mode = captured ? 'captured source' : 'DOM fallback';
        await check(`${mode}: configured exclusions cover complete runtime subtrees`, async (scrolling, doc) => {
            const runtime = (value) => `<section data-vendor-runtime><p>${value} one</p><p>${value} two</p></section>`;
            const previous = await doc(content() + runtime('Before'), { captured });
            const next = await doc(content('Changed paragraph') + runtime('After'), { captured });
            equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'A configured runtime region must not compete with the author edit.');
            equal(next.querySelector('[data-vendor-runtime]').textContent, 'After oneAfter two', 'Exclusions must leave rendered output intact.');
        }, [...defaults, '[data-vendor-runtime]']);
        await check(`${mode}: replacement policies do not restore built-in navigation exclusions`, async (scrolling, doc) => {
            const previous = await doc('<nav><p id="edited">Before</p></nav><aside class="runtime"><p>Noise one</p></aside>', { captured });
            const next = await doc('<nav><p id="edited">After</p></nav><aside class="runtime"><p>Noise two</p></aside>', { captured });
            equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'Use the complete configured policy, not additional exclusions merged with hidden defaults.');
        }, ['.runtime']);
        await check(`${mode}: an empty policy deliberately removes every exclusion`, async (scrolling, doc) => {
            const previous = await doc('<nav><p id="edited">Before</p></nav>', { captured });
            const next = await doc('<nav><p id="edited">After</p></nav>', { captured });
            equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'Empty lists must not be replaced with defaults or passed as invalid empty CSS.');
        }, []);
        await check(`${mode}: callers may remove the shipped Xdebug exclusion`, async (scrolling, doc) => {
            const table = (text) => `<table class="xdebug-error"><tr><td>${text}</td></tr></table>`;
            const previous = await doc(content() + table('Before'), { captured });
            const next = await doc(content() + table('After'), { captured });
            equal(scrolling.findTarget(previous, next), next.querySelector('td'), 'Xdebug is default configuration, not a special case in the matcher.');
        }, defaults.filter((selector) => selector !== 'table.xdebug-error'));
        await check(`${mode}: invalid selectors do not disable valid exclusions or scrolling`, async (scrolling, doc) => {
            const previous = await doc(content() + '<nav><p>Before</p></nav>', { captured });
            const next = await doc(content('Changed paragraph') + '<nav><p>After</p></nav>', { captured });
            const target = scrolling.findTarget(previous, next);
            equal(target, next.querySelector('#edited'), 'Reject malformed contributions without losing the valid policy.');
            await scrolling.restore(next, target);
            if (next.defaultView.scrollY <= 0) throw new Error('Invalid selectors must not prevent revealing the change.');
        }, ['nav', '[broken', null, 42, '', '  ']);
    }
    await check('long pages retain section context for a late nested edit', async (scrolling, doc) => {
        const sections = Array.from({ length: 1500 }, (_, index) => section(`Section ${index}`));
        const previous = await doc(sections.join(''));
        sections[1490] = section('Section 1490', 'Edited near the end');
        const next = await doc(sections.join(''));
        equal(scrolling.findTarget(previous, next), next.querySelectorAll('section p')[1490], 'Long pages must not lose the late edit among repeated paragraphs.');
    });
    await check('captured source excludes script initialization text and class noise', async (scrolling, doc) => {
        const previous = await doc(section('Status', 'Server status') + content(), {
            captured: true, script: `document.querySelector('section p').textContent = 'Runtime status 1'; document.body.className = 'runtime-one';`,
        });
        const next = await doc(section('Status', 'Server status') + content('Changed paragraph'), {
            captured: true, script: `document.querySelector('section p').textContent = 'Runtime status 2'; document.body.className = 'runtime-two';`,
        });
        equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'Compare response content rather than initialization mutations already present at load.');
    });
    await check('unchanged captured source ignores runtime-only changes and response-local marker numbering', async (scrolling, doc) => {
        const previous = await doc(content(), { captured: true, script: `document.querySelector('#edited').textContent = 'Runtime 1';` });
        const next = await doc(content(), { captured: true, offset: 20, script: `document.querySelector('#edited').textContent = 'Runtime 2';` });
        equal(scrolling.findTarget(previous, next), null, 'Neither runtime output nor annotation IDs are editor changes.');
    });
    await check('source-only presentation edits remain detectable despite unrelated runtime styles', async (scrolling, doc) => {
        const previous = await doc(content(), { captured: true });
        const next = await doc(content().replace('id="edited"', 'id="edited" class="has-text-align-right"'), {
            captured: true, script: `document.body.style.backgroundColor = 'red';`,
        });
        equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'The actual response class change takes precedence over initialization styling.');
    });
    await check('source identities locate live elements moved and wrapped by scripts', async (scrolling, doc) => {
        const previous = await doc(content(), { captured: true });
        const next = await doc(content('Changed paragraph'), {
            captured: true, script: `const wrapper = document.createElement('aside'); document.body.prepend(wrapper); wrapper.append(document.querySelector('#edited'));`,
        });
        equal(scrolling.findTarget(previous, next), next.querySelector('aside > #edited'), 'Do not depend on a live child-index path surviving theme initialization.');
    });
    await check('source elements replaced without their identities do not invent a live target', async (scrolling, doc) => {
        const previous = await doc(content(), { captured: true });
        const next = await doc(content('Changed paragraph'), {
            captured: true, script: `document.querySelector('#edited').outerHTML = '<p id="replacement">Script-generated replacement</p>';`,
        });
        equal(scrolling.findTarget(previous, next), null, 'A missing source element must not promote an unrelated ancestor.');
    });
    await check('cloned source identities are ambiguous instead of selecting the first clone', async (scrolling, doc) => {
        const previous = await doc(content(), { captured: true });
        const next = await doc(content('Changed paragraph'), {
            captured: true, script: `const node = document.querySelector('#edited'); node.after(node.cloneNode(true));`,
        });
        equal(scrolling.findTarget(previous, next), null, 'Multiple live copies cannot identify which instance should be revealed.');
    });
    await check('capture availability changes establish a new baseline without mixed-source comparisons', async (scrolling, doc) => {
        const captured = await doc(content(), { captured: true });
        const fallback = await doc(content('Changed paragraph'));
        equal(scrolling.findTarget(captured, fallback), null, 'Do not compare old source HTML against a new live DOM.');
        const capturedAgain = await doc(content('Another change'), { captured: true });
        equal(scrolling.findTarget(fallback, capturedAgain), null, 'Do not compare an old live DOM against new source HTML.');
        const next = await doc(content('Final change'), { captured: true });
        equal(scrolling.findTarget(capturedAgain, next), next.querySelector('#edited'), 'Following resumes once both snapshots use the same representation.');
    });
    await check('malformed or mismatched source data uses the existing DOM fallback', async (scrolling, doc) => {
        const previous = await doc(content());
        for (const payload of ['invalid JSON', JSON.stringify({ html: 'wrong shape' }), JSON.stringify('<main>Missing authorization marker</main>')]) {
            const next = await doc(content('Changed paragraph'));
            next.querySelector('meta').setAttribute('data-mtflpp-source', payload);
            equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'Invalid source data must not break an otherwise usable HTML preview.');
        }
    });
    await check('long captured pages retain live identity mapping for a late nested edit', async (scrolling, doc) => {
        const sections = Array.from({ length: 1500 }, (_, index) => section(`Section ${index}`));
        const previous = await doc(sections.join(''), { captured: true });
        sections[1490] = section('Section 1490', 'Edited near the end');
        const next = await doc(sections.join(''), { captured: true });
        equal(scrolling.findTarget(previous, next), next.querySelectorAll('section p')[1490], 'Source parsing and live lookup must work on long pages too.');
    });
    await check('large captured pages retain clean-source comparison instead of reverting to runtime noise', async (scrolling, doc) => {
        const padding = `<!--${' '.repeat(4 * 1024 * 1024)}-->`;
        const previous = await doc(padding + content(), {
            captured: true, script: 'document.querySelector("p").textContent = "Runtime before";',
        });
        await scrolling.restore(previous);
        const next = await doc(padding + content('Changed paragraph'), {
            captured: true, script: 'document.querySelector("p").textContent = "Runtime after";',
        });
        equal(scrolling.findTarget(previous, next), next.querySelector('#edited'), 'Payload size must not silently reintroduce frontend initialization noise.');
    });
    await check('reading captured snapshots never executes their scripts a second time', async (scrolling, doc) => {
        window.mtflppSourceScriptRuns = 0;
        const script = 'parent.mtflppSourceScriptRuns += 1;';
        const previous = await doc(content(), { captured: true, script });
        const next = await doc(content('Changed paragraph'), { captured: true, script });
        equal(window.mtflppSourceScriptRuns, 2, 'Normal iframe initialization still executes once per page.');
        const target = scrolling.findTarget(previous, next);
        await scrolling.restore(next, target);
        equal(window.mtflppSourceScriptRuns, 2, 'Parsing and caching the source must not execute it.');
        delete window.mtflppSourceScriptRuns;
    });
    // All author evidence is tied to the actual before/after submissions, not the latest UI state.
    const hints = (value, type = 'text') => ({ field: { type, value } });
    const orderHints = (...values) => ({ attachments: {
        type: 'order', value: JSON.stringify(values), members: JSON.stringify(values.sort()),
    } });
    const follow = (scrolling, before, after, oldValues, newValues) => {
        scrolling.capture(before, oldValues);
        return scrolling.findTarget(before, after, newValues);
    };
    for (const captured of [false, true]) {
        const mode = captured ? 'collaborative captured source' : 'collaborative DOM';
        const options = { captured };
        const clock = (value) => `<aside><p>Request time ${value}</p></aside>`;
        await check(`${mode}: a paired input transition outranks changing diagnostics without their exclusion`, async (scrolling, doc) => {
            const table = (value) => `<table class="xdebug-error"><tr><td>${value}</td></tr></table>`;
            const before = await doc(content('Hello') + table('0.123'), options);
            const after = await doc(content('Welcome') + table('0.456'), options);
            equal(follow(scrolling, before, after, hints('Hello'), hints('Welcome')), after.querySelector('#edited'), 'Combine author intent with output differences, without vendor-specific matching.');
        }, defaults.filter((selector) => selector !== 'table.xdebug-error'));
        await check(`${mode}: unchanged input values are not author evidence`, async (scrolling, doc) => {
            const before = await doc(content('Hello') + clock(1), options);
            const after = await doc(content('Welcome') + clock(2), options);
            equal(follow(scrolling, before, after, hints('Welcome'), hints('Welcome')), null, 'Do not use every payload value as a search term.');
        });
        await check(`${mode}: repeated paired transitions retain ambiguity`, async (scrolling, doc) => {
            const before = await doc(section('One', 'Hello') + section('Separator') + section('Two', 'Hello'), options);
            const after = await doc(section('One', 'Welcome') + section('Separator') + section('Two', 'Welcome'), options);
            equal(follow(scrolling, before, after, hints('Hello'), hints('Welcome')), null, 'Exact input text is not proof of a unique output location.');
        });
        await check(`${mode}: whole-field HTML intent narrows to the edited paragraph`, async (scrolling, doc) => {
            const old = '<p>Introduction</p><p id="edited">Original paragraph</p><p>Conclusion</p>';
            const next = old.replace('Original', 'Changed');
            const before = await doc(old + clock(1), options), after = await doc(next + clock(2), options);
            equal(follow(scrolling, before, after, hints(old, 'html'), hints(next, 'html')), after.querySelector('#edited'), 'Do not scroll to the whole article because the submitted value contains it.');
        });
        await check(`${mode}: entities and inline markup normalize into useful text evidence`, async (scrolling, doc) => {
            const old = '<p>Tom &amp; <strong>bright</strong> friends</p>', next = old.replace('bright', 'cheerful');
            const before = await doc(old + clock(1), options), after = await doc(next + clock(2), options);
            equal(follow(scrolling, before, after, hints(old, 'html'), hints(next, 'html')), after.querySelector('strong'), 'Markup and entity serialization must not block the transition.');
        });
        for (const [label, beforeHtml, afterHtml, shouldFollow] of [
            ['ordinary trailing space', '<p id="edited">Safely manage content</p>', '<p id="edited">Safely manage content </p>', false],
            ['collapsed inline spacing', '<p id="edited"><strong>Step 3: </strong><em>Safely</em></p>',
                '<p id="edited"><strong>Step 3: </strong> <em>Safely</em></p>', false],
            ['space between inline elements', '<p id="edited"><strong>Step 3:</strong><em>Safely</em></p>',
                '<p id="edited"><strong>Step 3:</strong> <em>Safely</em></p>', true],
            ['space at an inline edge', '<p><strong id="edited">Step 3:</strong><em>Safely</em></p>',
                '<p><strong id="edited">Step 3: </strong><em>Safely</em></p>', true],
            ['space in preformatted text', '<pre id="edited">Step 3: Safely</pre>', '<pre id="edited">Step 3:  Safely</pre>', true],
            ['space preserved by CSS', '<p id="edited" style="white-space: pre-wrap">Step 3: Safely</p>',
                '<p id="edited" style="white-space: pre-wrap">Step 3:  Safely</p>', true],
            ['non-breaking space', '<p id="edited">Safely manage content</p>', '<p id="edited">Safely manage content&nbsp;</p>', true],
        ]) {
            await check(`${mode}: ${label} follows only if it changes the rendered text`, async (scrolling, doc) => {
                const spacer = '<div style="height:800px"></div>';
                const before = await doc(spacer + beforeHtml, options), after = await doc(spacer + afterHtml, options);
                const target = follow(scrolling, before, after, hints(beforeHtml, 'html'), hints(afterHtml, 'html'));
                equal(target, shouldFollow ? after.querySelector('#edited') : null, 'Distinguish painted whitespace from collapsed whitespace.');
                if (label === 'space between inline elements') {
                    await scrolling.scrolling.restore(after, target);
                    equal(after.defaultView.scrollY > 0, true, 'Reveal the identified off-screen change.');
                }
            });
        }
        await check(`${mode}: paired spacing evidence outranks unrelated text`, async (scrolling, doc) => {
            const markup = (space) => `<pre id="edited">Step 3:${space}Safely</pre>`;
            const old = markup(' '), next = markup('  ');
            const before = await doc(old + clock(1), options), after = await doc(next + clock(2), options);
            equal(follow(scrolling, before, after, hints(`<p>Intro</p>${old}<p>End</p>`, 'html'),
                hints(`<p>Intro</p>${next}<p>End</p>`, 'html')), after.querySelector('#edited'), 'Match the exact space transition within the submitted HTML.');
        });
        await check(`${mode}: paired spacing evidence also works for plain text fields`, async (scrolling, doc) => {
            const old = 'Step 3: Safely', next = 'Step 3:  Safely';
            const output = (value, time) => `<pre id="edited">Read more: ${value} manage content</pre>${clock(time)}`;
            const before = await doc(output(old, 1), options), after = await doc(output(next, 2), options);
            equal(follow(scrolling, before, after, hints(old), hints(next)), after.querySelector('#edited'), 'Keep adjacent words as context even when the preview adds text.');
        });
        await check(`${mode}: unrelated spacing cannot borrow a normal text hint`, async (scrolling, doc) => {
            const before = await doc(content('Original') + '<pre>Original and Changed</pre>', options);
            const after = await doc(content('Changed') + '<pre>Original  and Changed</pre>', options);
            equal(follow(scrolling, before, after, hints('Original'), hints('Changed')), after.querySelector('#edited'),
                'Containing both submitted words does not connect a separate spacing edit to the text change.');
        });
        await check(`${mode}: spacing without editor evidence does not break a content tie`, async (scrolling, doc) => {
            const before = await doc('<pre>Step 3: Safely</pre>' + clock(1), options);
            const after = await doc('<pre>Step 3:  Safely</pre>' + clock(2), options);
            equal(scrolling.findTarget(before, after), null, 'Both are visible changes; do not guess which one the editor made.');
        });
        await check(`${mode}: unchanged excluded text does not hide a rendered space edit`, async (scrolling, doc) => {
            const markup = (space) => `<pre id="edited">Step 3:${space}Safely<span aria-live="polite">Ready</span></pre>`;
            const before = await doc(markup(' '), options), after = await doc(markup('  '), options);
            equal(scrolling.findTarget(before, after), after.querySelector('#edited'), 'Compare the live DOM and snapshot with the same exclusions.');
        });
        await check(`${mode}: excluded spacing cannot make a collapsed edit look visible`, async (scrolling, doc) => {
            const markup = (space, end) => `<p id="edited"><span aria-live="polite" style="white-space:pre">Ready${space}now</span> — Step 3${end}</p>`;
            const before = await doc(markup(' ', ''), options), after = await doc(markup('  ', ' '), options);
            equal(scrolling.findTarget(before, after), null, 'The only rendered difference is in an excluded region.');
        });
        await check(`${mode}: a later script mutation cannot become spacing evidence for the frozen snapshot`, async (scrolling, doc) => {
            const old = '<pre id="edited">Step 3: Safely</pre>', next = '<pre id="edited">Step 3:  Safely</pre>';
            const before = await doc(old, options), after = await doc(next, options);
            scrolling.capture(before, hints(old, 'html'));
            before.querySelector('#edited').textContent = 'Step 3:   Safely';
            equal(scrolling.findTarget(before, after, hints(next, 'html')), null, 'Do not validate the old whitespace against replacement text.');
        });
        const form = (changed, id, heading = 'Contact') => `<form${id ? ` id="${id}"` : ''}><h2>${heading}</h2>${changed
            ? '<fieldset><legend>Register for events</legend><input type="date"></fieldset><button>Register</button>'
            : '<label>Your email <input type="email"></label><label>Message <textarea></textarea></label><button>Send</button>'}</form>`;
        await check(`${mode}: a local replacement follows its surviving container`, async (frame, doc) => {
            const spacer = '<div style="height:700px"></div>';
            const before = await doc(spacer + form(false, 'changed') + form(false, 'unchanged'), options);
            const after = await doc(spacer + form(true, 'changed') + form(false, 'unchanged'), options);
            frame.capture(before, hints('old-choice', 'value'));
            frame.capture(after, hints('new-choice', 'value'));
            const target = frame.comparison.findChange(before, after);
            equal(target, after.querySelector('#changed'), 'Use the one surviving form, not an arbitrary new field or the whole page.');
            await frame.scrolling.restore(after, target);
            equal(after.defaultView.scrollY > 0, true, 'Reveal the offscreen form.');
        });
        for (const scenario of ['one replacement', 'labels only', 'two replacements']) {
            await check(`${mode}: form field groups, ${scenario}`, async (frame, doc) => {
                const oldGroups = [['first', 'last', 'email'], ['address', 'postal'], ['phone', 'country']];
                const newGroups = [['first', 'last'], ['company', 'email'], ['website', 'date']];
                const grouped = (id, groups, prefix = '') => `<form id="${id}">${groups.map((fields) => `<div>${fields.map((field) =>
                    `<label>${prefix}${field}<input name="${field}"></label>`).join('')}</div>`).join('')}</form>`;
                const spacer = '<div style="height:700px"></div>';
                const unchanged = grouped('other', oldGroups);
                const before = await doc(spacer + grouped('edited', oldGroups) + unchanged, options);
                const after = await doc(spacer + (scenario === 'labels only' ? grouped('edited', oldGroups, 'Your ') : grouped('edited', newGroups))
                    + (scenario === 'two replacements' ? grouped('other', newGroups) : unchanged), options);
                const target = follow(frame, before, after, hints('old-choice', 'value'), hints('new-choice', 'value'));
                equal(target, scenario === 'one replacement' ? after.querySelector('#edited') : null,
                    'Named fields added and removed across groups identify one form, not separate or label-only edits.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY > 0, scenario === 'one replacement', 'Reveal only a reliably identified form.');
            });
        }
        for (const separated of [false, true]) {
            await check(`${mode}: separate replacements stay ambiguous, separated=${separated}`, async (frame, doc) => {
                const markup = (changed) => `<section><h1>Forms</h1>${form(changed, separated ? 'one' : '')}
                    ${separated ? '<hr>' : ''}${form(changed, separated ? 'two' : '', 'Sign up')}</section>`;
                const before = await doc(markup(false), options), after = await doc(markup(true), options);
                equal(follow(frame, before, after, hints('old-choice', 'value'), hints('new-choice', 'value')), null,
                    'Two changed regions are not one target even if nothing aligns between them.');
            });
        }
        for (const formatted of [false, true]) for (const hinted of [false, true]) {
            await check(`${mode}: adjacent text edits require a specific hint, formatted=${formatted}, hinted=${hinted}`, async (frame, doc) => {
                const markup = (status, article) => `<div style="height:800px"></div>
                    <section id="region"><p>Current status: ${status}</p><p>${article}</p></section><div style="height:900px"></div>`;
                const before = await doc(markup('pending', 'Existing article copy'), options);
                const after = await doc(markup('ready', formatted ? 'Updated <em>article</em> copy' : 'Updated article copy'), options);
                frame.capture(before, hinted ? hints('Existing article copy') : undefined);
                frame.capture(after, hinted ? hints('Updated article copy') : undefined);
                before.defaultView.scrollTo(0, 200);
                frame.scrolling.remember(before);
                const target = frame.comparison.findChange(before, after);
                equal(target, hinted ? after.querySelector('#region p:last-child') : null,
                    'Keep adjacent changes ambiguous unless author evidence identifies a specific edit.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 200, !hinted, 'Do not jump to a common region just because both paragraphs changed.');
            });
        }
        await check(`${mode}: an unaligned replacement at the content root keeps position`, async (frame, doc) => {
            const before = await doc('<p>One</p><p>Two</p>', options);
            const after = await doc('<h2>Three</h2><section>Four</section>', options);
            equal(follow(frame, before, after, hints('old-choice', 'value'), hints('new-choice', 'value')), null,
                'The whole preview is not a local replacement target.');
        });
        const rowOrder = (items, moved, title = (item) => `Section ${item}`) => ({
            ...Object.fromEntries(items.map((item) => [`title:${item}`, { type: 'text', value: title(item) }])),
            rows: { ...orderHints(...items).attachments, type: 'row-order', moved,
                fieldsByRow: Object.fromEntries(items.map((item) => [item, [`title:${item}`]])) },
        });
        for (const [order, moved] of [[['B', 'A', 'C', 'D'], 'A'], [['B', 'A', 'C', 'D'], 'B'], [['D', 'A', 'B', 'C'], 'D']]) {
            await check(`${mode}: an authored move follows section ${moved} in ${order.join('')}`, async (frame, doc) => {
                const markup = (items) => `<div style="height:800px"></div>${items.map((item) =>
                    `<section id="section-${item}" style="height:500px">Section ${item}</section>`).join('')}`;
                const before = await doc(markup(['A', 'B', 'C', 'D']), options);
                const after = await doc(markup(order), options);
                const target = follow(frame, before, after, rowOrder(['A', 'B', 'C', 'D']), rowOrder(order, moved));
                equal(target, after.querySelector(`#section-${moved}`), 'Follow the row the editor moved, not the displaced neighbor.');
                frame.scrolling.remember(before);
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY > 0, true, 'Reveal an off-screen destination.');
            });
        }
        for (const scenario of captured ? ['up', 'down two', 'video poster', 'missing label', 'shared submitted label',
            'shared attachment ID', 'duplicate rendered label', 'changed attachment', 'changed label', 'conflicting text',
            'relocated image', 'rewritten live alt', 'runtime-only move', 'not a spacer'] : ['up']) {
            await check(`${mode}: an image can identify a moved row (${scenario})`, async (frame, doc) => {
                const label = 'Attachment A';
                const image = `<img alt="${label}" data-src="/custom-derivative.webp">`;
                const poster = scenario === 'video poster' ? '<iframe data-src="https://example.test/embed/sample?autoplay=1"></iframe>' : '';
                const A = `<section id="media-row">${scenario === 'not a spacer' ? '' : image}${poster}</section>`;
                const B = `<section><h2>Section B</h2>${scenario === 'duplicate rendered label'
                    ? `<img alt="${label}" src="/different.webp">` : ''}</section>`;
                const markup = (order) => '<div style="height:850px"></div>' + order.map((row) => ({ A, B,
                    C: `<section><h2>${label}</h2></section>` })[row]).join('') + '<div id="outside" style="height:850px"></div>';
                const oldOrder = scenario === 'down two' ? ['A', 'B', 'C'] : ['B', 'A', 'C'];
                const nextOrder = scenario === 'down two' ? ['B', 'C', 'A'] : ['A', 'B', 'C'];
                const before = await doc(markup(oldOrder), options);
                const after = await doc(markup(scenario === 'runtime-only move' ? oldOrder : nextOrder), { ...options, script: {
                    'relocated image': "document.querySelector('#outside').append(document.querySelector('#media-row img'))",
                    'rewritten live alt': "document.querySelector('#media-row img').alt = 'Different attachment'",
                    'runtime-only move': "const row = document.querySelector('#media-row'); row.previousElementSibling.before(row);",
                }[scenario] });
                const title = (row) => row === 'A' ? (scenario === 'conflicting text' ? label : '') : `Section ${row}`;
                const old = rowOrder(oldOrder, undefined, title), next = rowOrder(nextOrder, 'A', title);
                for (const values of [old, next]) {
                    values.rows.fieldsByRow.A.push('media:A');
                    values['media:A'] = { type: 'row-image', value: '101', alt: scenario === 'missing label' ? '' : label };
                    if (['shared submitted label', 'shared attachment ID'].includes(scenario)) {
                        values.rows.fieldsByRow.B.push('media:B');
                        values['media:B'] = { type: 'row-image', value: scenario === 'shared attachment ID' ? '101' : '202',
                            alt: scenario === 'shared submitted label' ? label : 'Different alt' };
                    }
                }
                if (scenario === 'changed attachment') next['media:A'].value = '303';
                if (scenario === 'changed label') next['media:A'].alt = 'New alt';
                before.defaultView.scrollTo(0, 110);
                frame.scrolling.remember(before);
                const target = follow(frame, before, after, old, next);
                const expected = captured && ['up', 'down two', 'video poster'].includes(scenario) ? after.querySelector('#media-row') : null;
                equal(target, expected, 'Only a stable submitted image label belonging to one confirmed row can locate the move.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 110, !expected, 'An unresolved image move must retain position.');
            });
        }
        for (const scenario of captured ? [
            'down', 'up', 'margin-only spacer', 'different-sized blank sibling', 'identical blank outside swap', 'duplicate rendered witness', 'duplicate submitted witness',
            'reversed source', 'reversed live order', 'reversed visual order', 'rewritten live heading', 'no live box', 'live exclusion', 'more than one swap',
            'unrelated source styling', 'nonempty moved row', 'image-only row', 'wrong move distance',
        ] : ['down']) {
            await check(`${mode}: an adjacent empty-row boundary (${scenario})`, async (frame, doc) => {
                const up = scenario === 'up', crossed = '<section id="crossed"><h2>Section B</h2></section>';
                const spacing = scenario === 'margin-only spacer' ? 'margin-top:160px' : 'height:160px';
                const blank = `<div id="blank" style="${spacing}">${scenario === 'image-only row' ? '<img src="data:," alt="">' : ''}</div>`;
                const extra = (changed) => `<div style="height:800px;${changed ? 'background:red' : ''}"></div>`;
                const earlier = '<div style="height:900px"></div>';
                const suffix = (changed) => {
                    const peers = section(scenario === 'duplicate rendered witness' ? 'Section B' : 'Section C') + section('Section D');
                    return (scenario === 'different-sized blank sibling' ? '<div style="height:190px"></div>' : '')
                        + (scenario === 'identical blank outside swap' ? '<div style="height:160px"></div>' : '')
                        + (changed && scenario === 'more than one swap' ? section('Section D') + section('Section C') : peers)
                        + extra(changed && scenario === 'unrelated source styling');
                };
                const markup = (after) => {
                    const blankFirst = after === up;
                    return earlier + (blankFirst !== (scenario === 'reversed source') ? blank + crossed : crossed + blank) + suffix(after);
                };
                const initialize = {
                    'reversed live order': "document.querySelector('#crossed').before(document.querySelector('#blank'))",
                    'reversed visual order': "document.querySelector('#blank').style.transform = 'translateY(-240px)'",
                    'rewritten live heading': "document.querySelector('#crossed h2').textContent = 'Other section'",
                    'no live box': "document.querySelector('#blank').style.display = 'none'",
                    'live exclusion': "document.querySelector('#blank').setAttribute('role', 'navigation')",
                };
                const before = await doc(markup(false), options);
                const after = await doc(markup(true), { ...options, script: initialize[scenario] });
                const oldOrder = up ? ['B', 'A', 'C', 'D'] : ['A', 'B', 'C', 'D'];
                const nextOrder = up ? ['A', 'B', 'C', 'D'] : scenario === 'wrong move distance' ? ['B', 'C', 'A', 'D'] : ['B', 'A', 'C', 'D'];
                const title = (item) => item === 'A' && scenario !== 'nonempty moved row' ? ''
                    : item === 'C' && scenario === 'duplicate submitted witness' ? 'Section B' : `Section ${item}`;
                before.defaultView.scrollTo(0, 110);
                frame.scrolling.remember(before);
                const target = follow(frame, before, after, rowOrder(oldOrder, undefined, title), rowOrder(nextOrder, 'A', title));
                const boundary = captured && ['down', 'up', 'margin-only spacer', 'different-sized blank sibling', 'identical blank outside swap'].includes(scenario)
                    ? after.querySelector(up ? '#crossed' : '#blank') : null;
                equal(target, boundary, 'Only a confirmed, visible pair can locate the new boundary.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 110, !boundary, 'Do not jump without a boundary.');
            });
        }
        for (const scenario of captured ? ['down two', 'up three', 'wrong crossed order', 'missing middle text',
            'duplicate middle text', 'changed middle section', 'live order mismatch', 'visual order mismatch'] : ['down two']) {
            await check(`${mode}: a spacer moved across multiple rows (${scenario})`, async (frame, doc) => {
                const start = ['A', 'B', 'C', 'D', 'E'];
                const end = scenario === 'down two' ? ['B', 'C', 'A', 'D', 'E'] : ['B', 'C', 'D', 'A', 'E'];
                const up = scenario === 'up three';
                const title = (item) => item === 'A' || (item === 'C' && scenario === 'missing middle text') ? '' : `Section ${item}`;
                const markup = (items, updated) => '<div style="height:900px"></div>' + items.map((item) => {
                    if (item === 'A') return '<div id="blank" style="height:160px"></div>';
                    const heading = item === 'E' && scenario === 'duplicate middle text' ? 'Section C' : `Section ${item}`;
                    const style = updated && item === 'C' && scenario === 'changed middle section' ? ' style="background:red"' : '';
                    return `<section id="row-${item}"${style}><h2>${heading}</h2></section>`;
                }).join('') + '<div style="height:800px"></div>';
                const oldOrder = up ? end : start, newOrder = up ? start : end;
                const sourceOrder = scenario === 'wrong crossed order' ? ['B', 'D', 'C', 'A', 'E'] : newOrder;
                const script = scenario === 'live order mismatch'
                    ? "document.querySelector('#row-C').before(document.querySelector('#row-D'))"
                    : scenario === 'visual order mismatch' ? "document.querySelector('#row-C').style.transform = 'translateY(-120px)'" : '';
                const before = await doc(markup(oldOrder, false), options);
                const after = await doc(markup(sourceOrder, true), { ...options, script });
                before.defaultView.scrollTo(0, 110);
                frame.scrolling.remember(before);
                const target = follow(frame, before, after, rowOrder(oldOrder, undefined, title), rowOrder(newOrder, 'A', title));
                const boundary = captured && (scenario === 'down two' || up) ? after.querySelector(up ? '#row-B' : '#blank') : null;
                equal(target, boundary, 'Every crossed row must confirm the same move to locate the new boundary.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 110, !boundary, 'Scroll only when the destination is verified.');
            });
        }
        if (captured) for (const [scenario, oldOrder, newOrder, targetIndex] of [
            ['down', 'XABCY', 'XBCAY', 3],
            ['up', 'XBCAY', 'XABCY', 2],
            ['across another spacer', 'AXBCY', 'XBCAY', null],
            ['only across another spacer', 'AXBCY', 'XABCY', null],
        ]) {
            await check(`${mode}: identical spacers in a move ${scenario}`, async (frame, doc) => {
                const isSpacer = (row) => 'AXY'.includes(row);
                const title = (row) => isSpacer(row) ? '' : `Section ${row}`;
                const markup = (order) => `<div style="height:900px"></div><div id="rows">${[...order].map((row) =>
                    isSpacer(row) ? '<div style="margin-top:160px"></div>' : section(title(row))).join('')}</div><div style="height:800px"></div>`;
                const before = await doc(markup(oldOrder), options), after = await doc(markup(newOrder), options);
                before.defaultView.scrollTo(0, 110);
                frame.scrolling.remember(before);
                const target = follow(frame, before, after, rowOrder([...oldOrder], undefined, title), rowOrder([...newOrder], 'A', title));
                const boundary = targetIndex === null ? null : after.querySelector('#rows').children[targetIndex];
                equal(target, boundary, 'Identical spacers outside the verified range must not veto its unique destination.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 110, !boundary, 'Only follow an identifiable change to the rendered gap.');
            });
        }
        await check(`${mode}: a boxless moved row follows its eligible off-screen heading, not its fixed navigation`, async (frame, doc) => {
            const spacer = '<div style="height:900px"></div>';
            const row = '<section style="display:contents"><nav style="position:fixed;top:0;right:0">Navigation</nav><h2 id="heading">Section A</h2></section>';
            const before = await doc(spacer + row + section('Section B') + spacer, options);
            const after = await doc(spacer + section('Section B') + row + spacer, options);
            frame.capture(before, rowOrder(['A', 'B']));
            frame.capture(after, rowOrder(['B', 'A'], 'A'));
            const heading = after.querySelector('#heading'), target = frame.comparison.findChange(before, after);
            equal(target, heading, 'Comparison, not generic presentation, must select the eligible child.');
            equal(heading.getBoundingClientRect().top > after.defaultView.innerHeight, true, 'The heading starts off-screen.');
            equal(await frame.scrolling.restore(after, target), heading, 'Keep the heading as the scroll anchor.');
            const { top, bottom } = heading.getBoundingClientRect();
            equal(top >= 0 && bottom <= after.defaultView.innerHeight, true, 'Reveal the heading in the page.');
        });
        if (captured) for (const [scenario, initialize, policy, expected] of [
            ['live navigation role', "toolbar.setAttribute('role', 'navigation')", defaults, 'heading'],
            ['relocated inside navigation', 'menu.append(toolbar)', defaults, 'heading'],
            ['all children inside navigation', 'menu.append(toolbar, heading)', defaults, null],
            ['custom live exclusion', "toolbar.setAttribute('data-runtime', '')", ['[data-runtime]'], 'heading'],
            ['explicit empty policy', "toolbar.setAttribute('role', 'navigation')", [], 'toolbar'],
        ]) {
            await check(`${mode}: boxless row with ${scenario}`, async (frame, doc) => {
                const row = '<section style="display:contents"><span id="toolbar" style="position:fixed;top:0">Jump links</span><h2 id="heading">Section A</h2><nav id="menu">Menu</nav></section>';
                const initialized = { ...options, script: `const [toolbar, heading, menu] = document.querySelectorAll('#toolbar, #heading, #menu'); ${initialize};` };
                const before = await doc(row + section('Section B'), initialized), after = await doc(section('Section B') + row, initialized);
                frame.capture(before, rowOrder(['A', 'B']));
                frame.capture(after, rowOrder(['B', 'A'], 'A'));
                equal(frame.comparison.findChange(before, after), expected && after.getElementById(expected),
                    'Only a rendered child still in the row and eligible under the configured live policy can identify its position.');
            }, policy);
        }
        if (captured) await check(`${mode}: a boxless row cannot follow a mapped child outside the moved section`, async (frame, doc) => {
            const row = '<section style="display:contents"><nav>Navigation</nav><h2 id="heading">Section A</h2></section>';
            const relocated = { ...options, script: "document.body.append(document.querySelector('#heading'));" };
            const before = await doc(row + section('Section B'), relocated);
            const after = await doc(section('Section B') + row, relocated);
            equal(follow(frame, before, after, rowOrder(['A', 'B']), rowOrder(['B', 'A'], 'A')), null,
                'Neither a relocated heading nor an excluded child identifies the position of this row.');
        });
        for (const wrapped of [true, false]) {
            await check(`${mode}: unchanged formatted row text can anchor the move (wrapped=${wrapped})`, async (frame, doc) => {
                const text = '<h2>Unique <span>heading</span></h2><p>Body paragraph.</p>';
                const moved = `<section id="formatted">${wrapped ? `<div>${text}</div>` : text}<a href="#cta">Learn more</a></section>`;
                const before = await doc(moved + section('Section B'), options);
                const after = await doc(section('Section B') + moved, options);
                const oldValues = rowOrder(['A', 'B']), values = rowOrder(['B', 'A'], 'A');
                oldValues['title:A'] = values['title:A'] = { type: 'html', value: '<h2>Unique <em>heading</em></h2>\n<p>Body paragraph.</p>' };
                equal(follow(frame, before, after, oldValues, values), after.querySelector('#formatted'),
                    'Use the submitted blocks together, even when the template adds other content.');
            });
        }
        await check(`${mode}: a link-only rich-text paragraph is not required evidence for the move`, async (frame, doc) => {
            const text = '<h2>Unique heading</h2><p>Body paragraph.</p><p><a href="#details">Read the case study</a></p>';
            const moved = `<section id="formatted">${text}<span>Template label</span></section>`;
            const before = await doc(moved + section('Section B'), options);
            const after = await doc(section('Section B') + moved, options);
            const oldValues = rowOrder(['A', 'B']), values = rowOrder(['B', 'A'], 'A');
            oldValues['title:A'] = values['title:A'] = { type: 'html', value: text };
            equal(follow(frame, before, after, oldValues, values), after.querySelector('#formatted'),
                'Use the heading and body together without requiring the standalone action text.');
        });
        for (const hint of [{ type: 'text', value: 'Unique heading' }, { type: 'html', value: '<h2>Unique heading</h2><p>Body paragraph.</p>' }]) {
            await check(`${mode}: ${hint.type} from a linked card can anchor the move`, async (frame, doc) => {
                const moved = '<section id="card"><a href="#details"><h2>Unique heading</h2><p>Body paragraph.</p><span>Learn more</span></a></section>';
                const before = await doc(moved + section('Section B'), options);
                const after = await doc(section('Section B') + moved, options);
                const oldValues = rowOrder(['A', 'B']), values = rowOrder(['B', 'A'], 'A');
                oldValues['title:A'] = values['title:A'] = hint;
                equal(follow(frame, before, after, oldValues, values), after.querySelector('#card'),
                    'The heading and body inside a linked card are content, not an action label.');
            });
        }
        for (const scenario of ['row move', 'duplicate submitted text', 'duplicate rendered text', 'changed number', 'no native variant',
            ...(captured ? ['spacer move'] : [])]) {
            await check(`${mode}: a WYSIWYG row with native formatting evidence (${scenario})`, async (frame, doc) => {
                const submitted = `<h2>Managing content</h2>\nUse the editor's <em>layout</em> options...\n\nTry "Preview" -- Acme (tm) in 12x24 at 1.25% with a 9" margin and <code>1x2...</code>.`;
                // Model the result of wpautop(wptexturize($submitted)) in WordPress's default locale.
                const formatted = '<h2>Managing content</h2><p>Use the editor&#8217;s <em>layout</em> options&#8230;</p>'
                    + '<p>Try &#8220;Preview&#8221; &#8212; Acme &#8482; in 12&#215;24 at 1.25% with a 9&#8243; margin and <code>1x2...</code>.</p>';
                const rendered = scenario === 'changed number' ? formatted.replace('1.25%', '125%') : formatted;
                const moved = `<section id="rich-text">${rendered}</section>`;
                const blank = '<div style="margin-top:160px"></div>';
                const tail = scenario === 'duplicate rendered text' ? `<aside>${formatted}</aside>` : section('Section C');
                const prefix = '<div style="height:900px"></div>';
                const before = await doc(prefix + blank + moved + tail, options);
                const after = await doc(prefix + moved + blank + tail, options);
                const old = rowOrder(['B', 'A', 'C']), next = rowOrder(['A', 'B', 'C'], scenario === 'spacer move' ? 'B' : 'A');
                old['title:A'] = { type: 'html', value: submitted, formatted };
                next['title:A'] = scenario === 'no native variant' ? { type: 'html', value: submitted } : old['title:A'];
                old['title:B'].value = next['title:B'].value = '';
                if (scenario === 'duplicate submitted text') old['title:C'] = next['title:C'] = { type: 'html', value: formatted };
                const richText = after.querySelector('#rich-text');
                const expected = scenario === 'row move' ? richText : scenario === 'spacer move' ? richText.nextElementSibling : null;
                equal(follow(frame, before, after, old, next), expected,
                    'Typography may corroborate a unique row; it must not hide a real value difference or make repeated text unique.');
            });
        }
        await check(`${mode}: a typography-only text edit remains an edit`, async (frame, doc) => {
            const before = await doc('<p id="edit">Wait...</p>' + section('Unchanged'), options);
            const after = await doc('<p id="edit">Wait…</p>' + section('Unchanged'), options);
            equal(follow(frame, before, after, hints('Wait...'), hints('Wait…')), after.querySelector('#edit'),
                'Keep real punctuation changes in the rendered comparison.');
        });
        await check(`${mode}: a single block from a longer field cannot anchor a row move`, async (frame, doc) => {
            const moved = '<section><h2>Unique heading</h2><p>Unrelated content.</p></section>';
            const before = await doc(moved + section('Section B'), options);
            const after = await doc(section('Section B') + moved, options);
            const oldValues = rowOrder(['A', 'B']), values = rowOrder(['B', 'A'], 'A');
            oldValues['title:A'] = values['title:A'] = { type: 'html', value: '<h2>Unique heading</h2><p>Body paragraph.</p>' };
            equal(follow(frame, before, after, oldValues, values), null, 'One matching fragment does not tie both text blocks to the row.');
        });
        await check(`${mode}: a move hint must explain the rendered reorder`, async (frame, doc) => {
            const before = await doc(section('Section A') + section('Section B') + section('Section C'), options);
            const after = await doc(section('Section B') + section('Section C') + section('Section A'), options);
            equal(follow(frame, before, after, rowOrder(['A', 'B', 'C']), rowOrder(['B', 'A', 'C'], 'A')), null,
                'Do not follow a rendered move of a different distance.');
        });
        await check(`${mode}: a stale move hint cannot follow another reorder`, async (frame, doc) => {
            const before = await doc(section('Section A') + section('Section B'), options);
            const after = await doc(section('Section B') + section('Section A'), options);
            const values = rowOrder(['A', 'B'], 'A');
            equal(follow(frame, before, after, values, values), null, 'The submitted order must actually change.');
        });
        await check(`${mode}: a move hint cannot distinguish identical rendered rows`, async (frame, doc) => {
            const before = await doc(section('Repeat') + section('Other') + section('Repeat'), options);
            const after = await doc(section('Other') + section('Repeat') + section('Repeat'), options);
            const title = (row) => row === 'B' ? 'Other' : 'Repeat';
            equal(follow(frame, before, after, rowOrder(['A', 'B', 'C'], undefined, title), rowOrder(['B', 'A', 'C'], 'A', title)), null,
                'Do not infer the identity of identical sections from their positions.');
        });
        await check(`${mode}: reversed rendered order must not follow the displaced row`, async (frame, doc) => {
            const before = await doc(section('Section C') + section('Section B') + section('Section A'), options);
            const after = await doc(section('Section C') + section('Section A') + section('Section B'), options);
            equal(follow(frame, before, after, rowOrder(['A', 'B', 'C']), rowOrder(['B', 'A', 'C'], 'A')), null,
                'The section displaced in the matching direction does not contain the moved row’s title.');
        });
        for (const shared of ['both', 'before', 'after']) {
            await check(`${mode}: a reversed row cannot borrow a sibling’s submitted heading (${shared})`, async (frame, doc) => {
                const a = section('Description only'), b = section('Overview');
                const before = await doc(b + a, options), after = await doc(a + b, options);
                const old = rowOrder(['A', 'B'], undefined, () => 'Overview'), next = rowOrder(['B', 'A'], 'A', () => 'Overview');
                for (const [side, document, values] of [['before', before, old], ['after', after, next]]) {
                    if (shared !== 'both' && side !== shared) {
                        delete values['title:B'];
                        values.rows.fieldsByRow.B = [];
                    }
                    frame.capture(document, values);
                    // The snapshot owns its row membership even if a contributor reuses the array.
                    values.rows.fieldsByRow.B.length = 0;
                }
                equal(frame.comparison.findChange(before, after), null, 'Only B renders the heading; its text is not an identity for A.');
            });
        }
        for (const [sameRow, complete] of [[false, false], [true, false], [true, true]]) {
            await check(`${mode}: grouped move witnesses, one other row supplies both=${sameRow}, rendered whole=${complete}`, async (frame, doc) => {
                const blocks = '<h2>Overview</h2><p>What to expect.</p>';
                const card = `<section id="card"><a href="#details">${blocks}${complete ? '' : '<span>Learn more</span>'}</a></section>`;
                const before = await doc(card + section('Other') + section('Last'), options);
                const after = await doc(section('Other') + card + section('Last'), options);
                const old = rowOrder(['A', 'B', 'C']), next = rowOrder(['B', 'A', 'C'], 'A');
                for (const values of [old, next]) {
                    values['title:A'] = { type: 'html', value: blocks };
                    values['title:B'].value = 'Overview';
                    const peer = sameRow ? 'B' : 'C';
                    values.rows.fieldsByRow[peer].unshift(`body:${peer}`);
                    values[`body:${peer}`] = { type: 'html', value: complete
                        ? '<div><em>What to expect.</em><p>Other copy.</p></div>'
                        : '<p>Other copy.</p><p>What to <em>expect.</em></p>' };
                }
                equal(follow(frame, before, after, old, next), sameRow ? null : after.querySelector('#card'),
                    'Check the entire witness against each submitted sibling, even when its text comes from separate fields.');
            });
        }
        for (const scenario of ['unique link', 'editor wrapped link', 'shared in earlier submission', 'shared in later submission', 'duplicate in preview',
            'different destination', 'different label', 'part of a longer field', 'placeholder', 'relocated link']) {
            await check(`${mode}: follow a link-only rich-text row (${scenario})`, async (frame, doc) => {
                const link = (href, label = 'Test it yourself') => `<a class="button" href="${href}">${label}</a>`;
                const href = scenario === 'placeholder' ? '#' : '/check?site=example&amp;view=full';
                const authored = link(href), rendered = link(scenario === 'different destination' ? '/other' : href,
                    scenario === 'different label' ? 'Other action' : 'Test <em>it</em> yourself');
                const linkRow = (id, action) => `<section id="${id}"><div><p>${action}</p></div></section>`;
                const other = link('/other-check', 'Test <em>it</em> yourself');
                const rows = { A: linkRow('moved', rendered), B: linkRow('neighbor', other), C: section('Second neighbor') };
                const markup = (order) => `<div style="height:900px"></div>${order.map((row) => rows[row]).join('')}`
                    + `<aside id="outside">${scenario === 'duplicate in preview' ? authored : ''}</aside><div style="height:900px"></div>`;
                const from = ['A', 'B', 'C'], to = ['B', 'C', 'A'];
                const before = await doc(markup(from), options), after = await doc(markup(to), { ...options,
                    script: scenario === 'relocated link' ? "document.querySelector('#outside').append(document.querySelector('#moved a'));" : '' });
                const old = rowOrder(from), next = rowOrder(to, 'A');
                const rest = scenario === 'part of a longer field' ? '<p>More text</p>' : '';
                old['title:A'] = next['title:A'] = { type: 'html', value: authored + rest, formatted: `<p>${authored}</p>${rest}` };
                if (scenario === 'editor wrapped link') old['title:A'] = { type: 'html', value: `<p>${authored}</p>` };
                old['title:B'] = next['title:B'] = { type: 'html', value: other };
                const peer = { type: 'html', value: `<p>Other copy with ${authored}</p>` };
                if (scenario === 'shared in earlier submission') old['title:B'] = peer;
                if (scenario === 'shared in later submission') next['title:B'] = peer;
                before.defaultView.scrollTo(0, 100);
                frame.scrolling.remember(before);
                const target = follow(frame, before, after, old, next);
                const expected = ['unique link', 'editor wrapped link'].includes(scenario) ? after.querySelector('#moved') : null;
                equal(target, expected, 'Only the unchanged, unique label and destination identify the moved section.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 100, !expected, 'Reveal that section or keep the previous position.');
            });
        }
        for (const scenario of captured ? ['three identical links', 'up past two rows', 'opaque widget', 'unrendered setting', 'cross an unlabelled row', 'two rows',
            'opaque neighbors', 'only stationary witness', 'wrong collection', 'shifted slots', 'reversed peer', 'conflicting field', 'changed subtree',
            'changed presentation', 'duplicate section', 'runtime reorder', 'relocated witness', 'rewritten live links', 'hidden section'] : ['three identical links']) {
            await check(`${mode}: identify the move from the rendered collection (${scenario})`, async (frame, doc) => {
                const button = '<a href="/speed">Test it yourself</a>', field = [button, button, button].join('\n\n');
                const widget = ['opaque widget', 'unrendered setting'].includes(scenario);
                const content = widget ? '<canvas width="300" height="200"></canvas>' : `<div>${`<p>${button}</p>`.repeat(3)}</div>`;
                const order = scenario === 'two rows' ? ['A', 'B'] : ['A', 'B', 'C', 'D'];
                const moved = scenario === 'two rows' ? ['B', 'A'] : ['B', 'C', 'A', 'D'];
                const [from, to] = scenario === 'up past two rows' ? [moved, order] : [order, moved];
                const rows = { A: `<section id="moved">${content}</section>`, B: section('Section B'), C: section('Section C'), D: section('Section D') };
                if (scenario === 'duplicate section') rows.D = `<section>${content}</section>`;
                if (scenario === 'hidden section') rows.A = `<section hidden>${content}</section>`;
                if (scenario === 'cross an unlabelled row') rows.C = '<div style="height:40px"></div>';
                if (scenario === 'opaque neighbors') for (const row of ['B', 'C', 'D']) rows[row] = `<div data-preset="${row}"></div>`;
                if (scenario === 'reversed peer') [rows.B, rows.D] = [rows.D, rows.B];
                const markup = (items, changed) => `<div style="height:900px">${scenario === 'conflicting field' ? 'Label elsewhere' : ''}</div><div id="rows">`
                    + (scenario === 'shifted slots' ? '<hr>' : '') + items.map((row) => {
                        if (changed && row === 'C' && scenario === 'changed subtree') return section('Section C', 'Different content');
                        if (changed && row === 'C' && scenario === 'changed presentation') return rows.C.replace('<section', '<section class="updated"');
                        return rows[row];
                    }).join('') + '</div><div style="height:900px"></div>';
                const before = await doc(markup(from, false), options), after = await doc(markup(to, true), { ...options,
                    script: {
                        'runtime reorder': "document.querySelector('#rows').prepend(document.querySelector('#moved'))",
                        'relocated witness': "document.querySelector('#moved').append(document.querySelector('#rows h2'))",
                        'rewritten live links': "document.querySelectorAll('#moved a').forEach(a => a.href = '/different-story')",
                    }[scenario] });
                const old = rowOrder(from), next = rowOrder(to, 'A');
                for (const values of [old, next]) {
                    values['title:A'] = { type: 'html', value: widget ? '' : field };
                    if (scenario === 'unrendered setting') values['title:A'] = { type: 'text', value: 'Ocean preset' };
                    if (scenario === 'conflicting field') values['title:A'] = { type: 'text', value: 'Label elsewhere' };
                    if (scenario === 'cross an unlabelled row') values['title:C'].value = '';
                    if (scenario === 'only stationary witness') values['title:B'].value = values['title:C'].value = '';
                    if (scenario === 'wrong collection') for (const row of ['B', 'C', 'D']) values[`title:${row}`].value = `Unrelated ${row}`;
                }
                before.defaultView.scrollTo(0, 100);
                frame.scrolling.remember(before);
                const expected = captured && ['three identical links', 'up past two rows', 'opaque widget', 'unrendered setting', 'cross an unlabelled row', 'two rows'].includes(scenario);
                const target = follow(frame, before, after, old, next);
                equal(target, expected ? after.querySelector('#moved') : null, 'Require one identifiable section in the same verified collection move.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 100, !expected, 'Do not guess a destination from the slot number alone.');
            });
        }
        if (captured) for (const [side, named, change] of [
            ['after', false, 'rewrite'], ['before', false, 'rewrite'], ['after', true, 'rewrite'],
            ['after', false, 'swap unlabelled rows'], ['before', false, 'swap unlabelled rows'],
            ['after', true, 'hide original'], ['after', false, 'hide original'],
        ]) {
            await check(`${mode}: a reused heading is not a row witness (${change}, ${side}, moved row named=${named})`, async (frame, doc) => {
                const from = ['A', 'B', 'C'], to = ['B', 'C', 'A'];
                const titles = { A: 'Forecast widget', B: 'River report', C: 'Harbor report' };
                const markup = (order) => `<div style="height:900px"></div><div>${order.map((id) => section(titles[id])).join('')}</div>`;
                const value = (id) => (!named && id === 'A') || (change === 'swap unlabelled rows' && id === 'C') ? '' : titles[id];
                const before = await doc(markup(from), options), after = await doc(markup(to), options);
                frame.capture(before, rowOrder(from, undefined, value));
                // A renderer can rewrite the same headings, even in the old frame after capture.
                const live = side === 'after' ? after : before, order = side === 'after' ? from : to;
                const shown = change === 'swap unlabelled rows' ? (side === 'after' ? ['B', 'A', 'C'] : ['C', 'B', 'A']) : order;
                live.querySelectorAll('section h2').forEach((heading, i) => {
                    if (change === 'hide original') {
                        const replacement = live.createElement('h2');
                        heading.hidden = true;
                        heading.after(replacement);
                        heading = replacement;
                    }
                    heading.textContent = titles[shown[i]];
                });
                frame.capture(after, rowOrder(to, 'A', value));
                before.defaultView.scrollTo(0, 73);
                frame.scrolling.remember(before);
                const target = frame.comparison.findChange(before, after);
                equal(target, null, 'The captured move must not nominate a section displaying a different story.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY, 73, 'Keep the reader in place when the live witness changed.');
            });
        }
        if (captured) for (const [html, expected] of [
            ['<div>Riv<em>er</em> report</div><div>to<span>day</span><aside aria-live="polite">Loading</aside></div>', true],
            ['River reporttoday', false],
        ]) {
            await check(`${mode}: rewritten peer markup retains its label=${expected}`, async (frame, doc) => {
                const sections = { A: '<section id="moved"><canvas></canvas></section>',
                    B: '<section><div id="label"><p>River report</p><p>today</p></div></section>' };
                const markup = (order) => `<div style="height:900px"></div><div>${order.map((id) => sections[id]).join('')}</div>`;
                const from = ['A', 'B'], to = ['B', 'A'], title = (id) => id === 'B' ? 'River report today' : '';
                const before = await doc(markup(from), options), after = await doc(markup(to), options);
                after.querySelector('#label').innerHTML = html;
                equal(follow(frame, before, after, rowOrder(from, undefined, title), rowOrder(to, 'A', title)),
                    expected ? after.querySelector('#moved') : null, 'Keep HTML word boundaries and ignore excluded live descendants.');
            });
        }
        await check(`${mode}: a textarea can supply the other row’s link`, async (frame, doc) => {
            const link = '<a href="/guide">Get help</a>', rows = { A: section('Forecast widget'), B: `<section>${link}</section>` };
            const from = ['A', 'B'], to = ['B', 'A'];
            // This template renders its rows in reverse order and only B outputs the link.
            const markup = (order) => `<div style="height:900px"></div><div>${order.slice().reverse().map((id) => rows[id]).join('')}</div>`;
            const before = await doc(markup(from), options), after = await doc(markup(to), options);
            const old = rowOrder(from), next = rowOrder(to, 'A');
            for (const values of [old, next]) {
                values['title:A'] = { type: 'html', value: link };
                values['title:B'] = { type: 'text', value: `Details: ${link}` };
            }
            equal(follow(frame, before, after, old, next), null, 'Shared markup cannot identify A, even when only one link is rendered.');
        });
        if (captured) for (const sameLabel of [false, true]) {
            await check(`${mode}: a replaced link is stale, not missing evidence (same label=${sameLabel})`, async (frame, doc) => {
                const link = '<a href="/forecast">Forecast</a>', a = `<section>${link}</section>`, b = section('Section B');
                const before = await doc(`<div>${a}${b}</div>`, options), after = await doc(`<div>${b}${a}</div>`, options);
                after.querySelector('a').outerHTML = sameLabel ? link : '<a href="/harbor">Harbor</a>';
                const old = rowOrder(['A', 'B']), next = rowOrder(['B', 'A'], 'A');
                old['title:A'] = next['title:A'] = { type: 'html', value: link };
                equal(follow(frame, before, after, old, next), null, 'A neighbor must not override the loss of the mapped link.');
            });
        }
        for (const named of captured ? [false, true] : [true]) for (const pinned of [true, false]) {
            await check(`${mode}: a CSS ${pinned ? 'pinned' : 'reversed'} row move (named=${named})`, async (frame, doc) => {
                const from = ['A', 'B', 'C'], to = ['B', 'C', 'A'];
                const markup = (order) => `<div style="height:800px"></div><div style="display:flex;flex-direction:column-reverse">`
                    + order.map((id) => `<section id="${id}" style="height:160px;order:${pinned ? from.indexOf(id) : 0}">Section ${id}</section>`).join('')
                    + '</div><div style="height:800px"></div>';
                const before = await doc(markup(from), options), after = await doc(markup(to), options);
                const title = (id) => !named && id === 'A' ? '' : `Section ${id}`;
                before.defaultView.scrollTo(0, 73);
                frame.scrolling.remember(before);
                const target = follow(frame, before, after, rowOrder(from, undefined, title), rowOrder(to, 'A', title));
                equal(target, pinned ? null : after.querySelector('#A'), 'Only an actual change in the position of the row should follow.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 73, pinned, 'Keep the reader’s offset if CSS kept the row in place.');
            });
        }
        for (const [scenario, markup, expected] of [
            ['visible heading inside a hidden wrapper', '<div style="visibility:hidden"><h2 style="visibility:visible">Section A</h2></div>', true],
            ['heading inherits hidden visibility', '<div style="visibility:hidden"><h2>Section A</h2></div>', false],
            ['visible text inside a hidden inline wrapper', '<h2>Section <span style="visibility:hidden"><b style="visibility:visible">A</b></span></h2>', true],
            ['part of the heading is hidden', '<h2>Section <span style="visibility:hidden">A</span></h2>', false],
            ['visible heading inside a display:none wrapper', '<div style="display:none"><h2 style="visibility:visible">Section A</h2></div>', false],
        ]) {
            await check(`${mode}: moved row with ${scenario}`, async (frame, doc) => {
                const row = `<section id="row-A">${markup}</section>`, peer = section('Section B');
                const before = await doc(row + peer, options), after = await doc(peer + row, options);
                frame.capture(before, rowOrder(['A', 'B']));
                frame.capture(after, rowOrder(['B', 'A'], 'A'));
                equal(frame.comparison.findChange(before, after), expected ? after.querySelector('#row-A') : null,
                    'Only visible text or text in a native disclosure can identify the row.');
            });
        }
        await check(`${mode}: moving a named row inside native disclosures can still reveal it`, async (frame, doc) => {
            const a = section('Section A'), b = section('Section B');
            const markup = (rows) => `<details><summary>Reports</summary><div hidden="until-found">${rows}</div></details>`;
            const before = await doc(markup(a + b), options), after = await doc(markup(b + a), options);
            frame.capture(before, rowOrder(['A', 'B']));
            frame.capture(after, rowOrder(['B', 'A'], 'A'));
            const target = frame.comparison.findChange(before, after);
            equal(target, after.querySelector('section:last-child'), 'A discoverable heading can still identify its row.');
            await frame.scrolling.restore(after, target);
            equal(after.querySelector('details').open && !after.querySelector('[hidden]'), true, 'Leave activation to native disclosure presentation.');
        });
        const speedLink = { type: 'html', value: '<a href="/speed">Test it yourself</a>' };
        const guideLink = { type: 'html', value: '<a href="/guide">Read the guide</a>' };
        const formattedLink = { type: 'html', value: `<a href="/guide">What's next?</a>`, formatted: '<p><a href="/guide">What’s next?</a></p>' };
        const photo = { type: 'row-image', value: '42', alt: 'Mountain' };
        const heading = '<h2>Overview</h2>', photoHtml = '<img alt="Mountain">';
        for (const [scenario, fields, peers, content, neighbor, expected] of [
            ['repeated headline and unique link', ['Overview', speedLink], ['Overview'], heading + speedLink.value, heading, true],
            ['shared first link and unique second link', [guideLink, speedLink], [guideLink], speedLink.value, guideLink.value, true],
            ['peer shares only the formatted spelling', [formattedLink, speedLink], [{ type: 'html', value: formattedLink.formatted }],
                speedLink.value, formattedLink.value, true],
            ['unrendered first link and unique second link', [guideLink, speedLink], [], speedLink.value, heading, true],
            ['unique text and duplicated rendered link', ['Overview', speedLink], [], heading + speedLink.value, speedLink.value, true],
            ['rewritten heading and intact link', ['Overview', speedLink], [], heading + speedLink.value, '<p>Other</p>', true],
            ['unique text and conflicting link', ['Overview', speedLink], [], heading, speedLink.value, false],
            ['two links point to different sections', [speedLink, guideLink], [], speedLink.value, guideLink.value, false],
            ['image agrees with link', [photo, speedLink], [], photoHtml + speedLink.value, heading, true],
            ['image conflicts with link', [photo, speedLink], [], speedLink.value, photoHtml, !captured],
            ['unmatched link cannot distinguish identical image content', [photo, speedLink], [], photoHtml, '<img alt="Valley">', false],
        ]) {
            await check(`${mode}: mixed row fields (${scenario})`, async (frame, doc) => {
                const moved = `<section id="moved">${content}</section>`, other = `<section>${neighbor}</section>`;
                const markup = (rows) => `<div style="height:900px"></div>${rows}<div style="height:900px"></div>`;
                const init = scenario === 'rewritten heading and intact link' ? { ...options,
                    script: "document.querySelector('#moved h2').textContent = 'Client heading'" } : options;
                const before = await doc(markup(moved + other), init), after = await doc(markup(other + moved), init);
                const old = rowOrder(['A', 'B']), next = rowOrder(['B', 'A'], 'A');
                for (const values of [old, next]) for (const [row, hints] of [['A', fields], ['B', peers]]) {
                    values.rows.fieldsByRow[row] = hints.map((hint, i) => {
                        const name = `field:${row}:${i}`;
                        values[name] = typeof hint === 'string' ? { type: 'text', value: hint } : hint;
                        return name;
                    });
                }
                before.defaultView.scrollTo(0, 100);
                frame.scrolling.remember(before);
                const target = follow(frame, before, after, old, next);
                equal(target, expected ? after.querySelector('#moved') : null, 'Missing or repeated evidence is not a conflict; contradictory matches are.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === 100, !expected, 'Follow the moved section or preserve the previous position.');
            });
        }
        const actions = '<p><a href="#details">Learn more</a></p><p><a href="#contact">Contact us</a></p>', captions = 'Learn more Contact us';
        for (const [submitted, rendered] of [[actions, actions], [actions, captions], [captions, actions]]) {
            await check(`${mode}: grouped action captions, submitted links=${submitted === actions}, rendered links=${rendered === actions}`, async (frame, doc) => {
                const a = section('Description only'), b = `<section><h2>Section B</h2><div>${rendered}</div></section>`;
                const before = await doc(b + a, options), after = await doc(a + b, options);
                const old = rowOrder(['A', 'B']), next = rowOrder(['B', 'A'], 'A');
                old['title:A'] = next['title:A'] = { type: submitted === actions ? 'html' : 'text', value: submitted };
                equal(follow(frame, before, after, old, next), null, 'Wrapping two action labels does not make them substantive row text.');
            });
        }
        for (const action of ['<a href="#details"><span>Learn more</span></a>', '<button>Learn more</button>', '<div role="button">Learn more</div>',
            '<a href="#details"><h2>Card heading</h2><p>Card description.</p><span>Learn more</span></a>',
            '<a href="#details"><h2>Card heading</h2><p>Card description.</p><p>Learn more</p></a>']) {
            await check(`${mode}: action text alone cannot confirm which row moved (${action})`, async (frame, doc) => {
                const a = '<section aria-label="Learn more"><span>Section A content</span></section>';
                const b = `<section><h2>Unrelated section</h2>${action}</section>`;
                const before = await doc(b + a, options);
                const after = await doc(a + b, options);
                const title = (row) => row === 'A' ? 'Learn more' : 'Unrelated section';
                equal(follow(frame, before, after, rowOrder(['A', 'B'], undefined, title), rowOrder(['B', 'A'], 'A', title)), null,
                    'Do not use an incidental action label to follow the displaced section in reverse order.');
            });
        }
        await check(`${mode}: a row move must not follow an unrelated list with the same rotation`, async (frame, doc) => {
            const markup = (items) => `<div id="other">${items.map((item) => section(item)).join('')}</div>`;
            const before = await doc(markup(['List X', 'List Y']), options);
            const after = await doc(markup(['List Y', 'List X']), options);
            equal(follow(frame, before, after, rowOrder(['A', 'B']), rowOrder(['B', 'A'], 'A')), null,
                'A local region is not a fallback when the dropped row has no rendered match.');
        });
        await check(`${mode}: a row move must not follow an unrelated text update`, async (frame, doc) => {
            const before = await doc(section('Section A') + section('Unrelated update', 'Before'), options);
            const after = await doc(section('Section A') + section('Unrelated update', 'After'), options);
            equal(follow(frame, before, after, rowOrder(['A', 'B']), rowOrder(['B', 'A'], 'A')), null,
                'An unrelated update is not evidence of a rendered move.');
        });
        await check(`${mode}: a title repeated outside the reordered rows is not a unique anchor`, async (frame, doc) => {
            const other = section('Section A', 'Unrelated paragraph');
            const before = await doc(section('Section A') + section('Section B') + other, options);
            const after = await doc(section('Section B') + section('Section A') + other, options);
            equal(follow(frame, before, after, rowOrder(['A', 'B']), rowOrder(['B', 'A'], 'A')), null,
                'The heading alone cannot link the moved row to one section across the page.');
        });
        if (captured) await check(`${mode}: a row move hint cannot confirm a runtime-only reorder`, async (frame, doc) => {
            const markup = section('Section A') + section('Section B');
            const before = await doc(markup, options);
            const after = await doc(markup, { ...options, script: 'const main = document.querySelector("main"); main.append(main.firstElementChild);' });
            equal(follow(frame, before, after, rowOrder(['A', 'B']), rowOrder(['B', 'A'], 'A')), null,
                'A captured source that did not reorder must take precedence over a frontend script.');
        });
        await check(`${mode}: a gallery reorder follows its region without moving the track`, async (frame, doc) => {
            const markup = (images) => `<div style="height:700px"></div><div id="gallery" style="width:250px;overflow:hidden">
                <div id="track" style="display:flex;transform:translateX(0)">${images.map((i) =>
                    `<figure style="flex:0 0 240px;height:130px;margin:0"><img src="/image-${i}.jpg"></figure>`).join('')}</div>
                </div><div style="height:700px"></div>`;
            const before = await doc(markup([1, 2, 3, 4]), options), after = await doc(markup([2, 3, 1, 4]), options);
            frame.capture(before, captured ? undefined : orderHints('1', '2', '3', '4'));
            frame.capture(after, captured ? undefined : orderHints('2', '3', '1', '4'));
            const target = frame.comparison.findChange(before, after), gallery = after.querySelector('#gallery');
            equal(target, after.querySelector('#track'), 'The order changed in one region; no single moved image is established.');
            const style = target.getAttribute('style');
            await frame.scrolling.restore(after, target);
            equal(after.defaultView.scrollY > 0, true, 'Reveal the gallery on the page.');
            equal(gallery.scrollLeft, 0, 'Do not change the widget’s horizontal offset.');
            equal(target.getAttribute('style'), style, 'Do not move the track.');
        });
        const validGalleryChanges = ['reorder no text', 'already visible', 'paragraph only', 'duplicate headings',
            'add image', 'remove image', 'fill empty gallery', 'empty gallery', 'single list', 'vertical viewport', 'hidden slide clones'];
        for (const scenario of captured ? [...validGalleryChanges, 'unrelated section', 'independent divs', 'page-wide target', 'second edited field',
            'wrong permutation', 'wrong removal', 'reused source', 'repeated members', 'runtime only', 'no rendered change',
            'cloned live region', 'relocated track', 'reverted order', 'reverted single list', 'discarded addition']
            : ['reorder no text', 'add image', 'remove image']) {
            await check(`${mode}: gallery changes follow a verified local region (${scenario})`, async (frame, doc) => {
                const oldOrder = scenario === 'repeated members' ? ['a', 'b', 'a', 'd'] : scenario === 'fill empty gallery' ? [] : ['a', 'b', 'c', 'd'];
                const newOrder = ['add image', 'reused source', 'discarded addition'].includes(scenario) ? ['a', 'e', 'b', 'c', 'd']
                    : scenario === 'remove image' || scenario === 'wrong removal' ? ['a', 'c', 'd']
                        : scenario === 'fill empty gallery' ? ['e'] : scenario === 'empty gallery' ? [] : [oldOrder[1], oldOrder[0], ...oldOrder.slice(2)];
                function track(row, kind, order) {
                    return `<div style="width:160px;overflow:auto"><div id="${row}-${kind}" style="display:flex;transform:translateX(-12px)">
                        ${order.map((image) => `<figure style="flex:0 0 140px;height:60px;margin:0"${image === 'c' ? ' class="active"' : ''}>
                            <img data-src="/${row}/${kind}/${image === 'e' && scenario === 'reused source' ? 'a' : image}.jpg" alt="Repeated alt"></figure>`).join('\n')}
                    </div></div>`;
                }
                function markup(changed) {
                    const edit = changed && !['runtime only', 'no rendered change'].includes(scenario);
                    if (scenario === 'page-wide target') return '<div style="height:800px"></div>' + track('B', 'main', edit ? newOrder : oldOrder)
                        + track('B', 'thumbs', edit ? newOrder : oldOrder) + '<div style="height:650px"></div>';
                    const independent = scenario === 'independent divs';
                    const rows = independent ? ['A', 'B'] : ['A', 'B', 'C'];
                    const tag = independent ? 'div' : 'section';
                    return '<div style="height:800px"></div><article>' + rows.map((row) => {
                        const other = (scenario === 'unrelated section' || independent) && row === 'A';
                        const order = edit && (row === 'B' || other) ? newOrder : oldOrder;
                        const copy = scenario === 'paragraph only' ? '<p>Copy surrounding the gallery.</p>'
                            : scenario === 'duplicate headings' ? '<h2>Same heading on every gallery</h2>' : '';
                        const thumbs = edit && row === 'B' && scenario === 'wrong permutation' ? [...oldOrder].reverse()
                            : edit && row === 'B' && scenario === 'wrong removal' ? ['a', 'b', 'd'] : order;
                        const gallery = `<div id="gallery-${row}">${track(row, 'main', order)}${['single list', 'reverted single list', 'independent divs'].includes(scenario)
                            ? '' : track(row, 'thumbs', thumbs)}</div>`;
                        const wrapped = scenario === 'vertical viewport' ? `<div class="gallery-scrollport" style="height:80px;overflow-y:auto">${gallery}</div>` : gallery;
                        return `<${tag}>${copy}${wrapped}</${tag}>`;
                    }).join(independent ? '<div style="height:600px"><p>Unrelated page copy.</p></div>' : '') + '</article><div style="height:650px"></div>';
                }
                const gallery = (order) => ({ ...orderHints(...order).attachments, type: 'gallery-order' });
                const old = { 'images:A': gallery(oldOrder), 'images:B': gallery(oldOrder) };
                const next = { ...old, 'images:B': gallery(newOrder) };
                if (scenario === 'second edited field') next['images:A'] = gallery(newOrder);
                const before = await doc(markup(false), options);
                const after = await doc(markup(true), { ...options, script: ({
                    'relocated track': 'document.querySelector("main").append(document.querySelector("#B-main"))',
                    'cloned live region': 'document.querySelector("main").append(document.querySelector("#gallery-B").cloneNode(true))',
                    'runtime only': 'for (const el of document.querySelectorAll("#B-main,#B-thumbs")) el.prepend(el.children[1])',
                    'reverted order': 'for (const el of document.querySelectorAll("#B-main,#B-thumbs")) el.prepend(el.children[1])',
                    'reverted single list': 'const el = document.querySelector("#B-main"); el.prepend(el.children[1]);',
                    'discarded addition': 'for (const el of document.querySelectorAll("#B-main,#B-thumbs")) el.children[1].remove();',
                    'hidden slide clones': 'for (const el of document.querySelectorAll("#B-main,#B-thumbs")) { const clone = el.lastElementChild.cloneNode(true); clone.setAttribute("aria-hidden", "true"); el.prepend(clone); }',
                })[scenario] });
                const slider = after.querySelector('#B-main');
                const initial = scenario === 'already visible' ? after.querySelector('#gallery-B').getBoundingClientRect().top - 70 : 100;
                before.defaultView.scrollTo(0, initial);
                frame.scrolling.remember(before);
                slider.parentElement.scrollLeft = 30;
                const horizontal = slider.parentElement.scrollLeft;
                const vertical = slider.closest('.gallery-scrollport');
                if (vertical) vertical.scrollTop = 30;
                const active = slider.querySelector('.active');
                const expected = validGalleryChanges.includes(scenario)
                    ? vertical ?? (scenario === 'single list' ? slider.parentElement : after.querySelector('#gallery-B')) : null;
                const target = follow(frame, before, after, old, next);
                equal(target, expected, 'Require one local region with the exact submitted change in the rendered lists.');
                await frame.scrolling.restore(after, target);
                equal(after.defaultView.scrollY === Math.round(initial), !expected || scenario === 'already visible',
                    'Reveal only an off-screen confirmed region.');
                equal(slider.parentElement.scrollLeft, horizontal, 'Keep the horizontal offset.');
                if (vertical) equal(vertical.scrollTop, 30, 'Keep the vertical widget offset.');
                equal(slider.style.transform, 'translateX(-12px)', 'Keep the track transform.');
                equal(slider.querySelector('.active'), active, 'Leave the active slide to the widget.');
            });
        }
        await check(`${mode}: a reorder with repeated entries still identifies its container`, async (frame, doc) => {
            const markup = (items) => `<ol>${items.map((item) => `<li>${item}</li>`).join('')}</ol>`;
            const before = await doc(markup(['A', 'A', 'B', 'C']), options);
            const after = await doc(markup(['A', 'B', 'A', 'C']), options);
            equal(follow(frame, before, after, hints('aabc', 'value'), hints('abac', 'value')), after.querySelector('ol'),
                'A changed sequence of the same items establishes their location, not which copy moved.');
        });
        for (const [separator, ids] of [['<hr>', false], ['', true], ['', false]]) {
            await check(`${mode}: separate reorders do not collapse to one region, separator=${!!separator}, IDs=${ids}`, async (frame, doc) => {
                const markup = (reordered) => `<section>
                    <ol${ids ? ' id="first"' : ''}>${reordered ? '<li>B</li><li>A</li>' : '<li>A</li><li>B</li>'}</ol>${separator}
                    <ol${ids ? ' id="second"' : ''}>${reordered ? '<li>D</li><li>C</li>' : '<li>C</li><li>D</li>'}</ol></section>`;
                const before = await doc(markup(false), options), after = await doc(markup(true), options);
                equal(follow(frame, before, after, hints('old-order', 'value'), hints('new-order', 'value')), null,
                    'Do not scroll to a common ancestor of independent sequences, even without an unchanged sibling.');
            });
        }
        await check(`${mode}: conditional output does not require a literal checkbox match`, async (scrolling, doc) => {
            const before = await doc(section('First') + section('Last'), options);
            const after = await doc(section('First') + section('Conditional') + section('Last'), options);
            equal(follow(scrolling, before, after, hints(false, 'value'), hints(true, 'value')), after.querySelectorAll('section')[1], 'Structural evidence remains usable without a text match.');
        });
        await check(`${mode}: strong hidden author intent outranks unrelated visible output`, async (scrolling, doc) => {
            const region = (text) => `<section id="context"><h2>Closed widget</h2><div hidden><p>${text}</p></div></section>`;
            const before = await doc(region('Hello') + clock(1), options), after = await doc(region('Welcome') + clock(2), options);
            equal(follow(scrolling, before, after, hints('Hello'), hints('Welcome')), after.querySelector('#context'), 'Identify first, then use visible ancestry; never open the widget.');
            equal(after.querySelector('[hidden]').hidden, true, 'Preserve native hidden state.');
        });
        await check(`${mode}: authored class intent can outrank unrelated content differences`, async (scrolling, doc) => {
            const old = '<p class="has-text-align-left">Article</p>', next = old.replace('left', 'right');
            const before = await doc(old + clock(1), options), after = await doc(next + clock(2), options);
            equal(follow(scrolling, before, after, hints(old, 'html'), hints(next, 'html')), after.querySelector('p'), 'Input evidence can strengthen presentation changes, not only text changes.');
        });
        await check(`${mode}: authored ARIA labels survive generated identity churn`, async (scrolling, doc) => {
            const region = (id, label) => `<button aria-controls="${id}" aria-label="${label}">Open</button><div id="${id}">Panel</div>`;
            const before = await doc(region('uuid-one', 'Read article'), options), after = await doc(region('uuid-two', 'Read story'), options);
            equal(follow(scrolling, before, after, hints('Read article'), hints('Read story')), after.querySelector('button'), 'Do not ignore all accessibility attributes.');
        });
        await check(`${mode}: meaningful ARIA remains evidence without editor hints`, async (scrolling, doc) => {
            const region = (id, label) => `<button aria-controls="${id}" aria-label="${label}">Open</button><div id="${id}">Panel</div>`;
            const before = await doc(region('uuid-one', 'Read article'), options), after = await doc(region('uuid-two', 'Read story'), options);
            equal(scrolling.findTarget(before, after), after.querySelector('button'), 'Revision-like callers still detect an unambiguous label change.');
        });
        await check(`${mode}: authored accessibility state changes are not blanket-normalized`, async (scrolling, doc) => {
            const before = await doc('<button aria-expanded="false">Open</button>', options);
            const after = await doc('<button aria-expanded="true">Open</button>', options);
            equal(scrolling.findTarget(before, after), after.querySelector('button'), 'An actual response ARIA-state change is eligible.');
        });
        await check(`${mode}: authored ID transitions remain eligible`, async (scrolling, doc) => {
            const before = await doc('<p id="old-anchor">Article</p>', options), after = await doc('<p id="new-anchor">Article</p>', options);
            equal(follow(scrolling, before, after, hints('old-anchor'), hints('new-anchor')), after.querySelector('p'), 'Generated-reference normalization must not discard an explicitly authored ID.');
        });
        await check(`${mode}: formatting-only HTML changes have input evidence`, async (scrolling, doc) => {
            const old = '<p><strong>Hello</strong></p>', next = '<p><em>Hello</em></p>';
            const before = await doc(old + clock(1), options), after = await doc(next + clock(2), options);
            equal(follow(scrolling, before, after, hints(old, 'html'), hints(next, 'html')), after.querySelector('em'), 'Identical text does not mean an unchanged editor value.');
        });
        await check(`${mode}: changed media markup strengthens the actual image candidate`, async (scrolling, doc) => {
            const old = '<img src="/before.jpg">', next = '<img src="/after.jpg">';
            const before = await doc(old + clock(1), options), after = await doc(next + clock(2), options);
            equal(follow(scrolling, before, after, hints(old, 'html'), hints(next, 'html')), after.querySelector('img'), 'Do not search attachment IDs as visible text.');
        });
        for (const [old, next] of [['catapult', 'dogmatic'], ['bobcat.', 'bobdog.']]) {
            await check(`${mode}: ${old} → ${next} is not an exact word transition`, async (scrolling, doc) => {
                const before = await doc(content(old) + clock(1), options), after = await doc(content(next) + clock(2), options);
                equal(follow(scrolling, before, after, hints('cat'), hints('dog')), null, 'A substring inside another word is weak evidence, not confirmation.');
            });
        }
        await check(`${mode}: newly submitted textual fields can support an insertion`, async (scrolling, doc) => {
            const before = await doc(section('First') + section('Last') + clock(1), options);
            const after = await doc(section('First') + section('Added text') + section('Last') + clock(2), options);
            equal(follow(scrolling, before, after, {}, hints('Added text')), after.querySelectorAll('section')[1], 'New repeater fields need not exist in the previous submission.');
        });
        for (const noiseFirst of [false, true]) {
            await check(`${mode}: insertion evidence stays with its matching sibling, noise first=${noiseFirst}`, async (scrolling, doc) => {
                const before = await doc(section('First') + section('Last'), options);
                const noise = '<aside id="noise"><p>Runtime advertisement</p></aside>';
                const authored = '<section id="authored"><p>Added text</p></section>';
                const after = await doc(section('First') + (noiseFirst ? noise + authored : authored + noise) + section('Last'), options);
                equal(follow(scrolling, before, after, {}, hints('Added text')), after.querySelector('#authored'), 'Only the added sibling containing the submitted value has input support.');
            });
        }
        for (const hidden of [false, true]) {
            await check(`${mode}: equally supported inserted siblings remain ambiguous, hidden first=${hidden}`, async (scrolling, doc) => {
                const before = await doc(section('First') + section('Last'), options);
                const copies = `<section id="one" ${hidden ? 'hidden' : ''}><p>Added text</p></section><section id="two"><p>Added text</p></section>`;
                const after = await doc(section('First') + copies + section('Last'), options);
                scrolling.capture(before, {});
                scrolling.capture(after, hints('Added text'));
                equal(scrolling.comparison.findChange(before, after), null, 'Neither sibling order nor visibility establishes which authored copy to follow.');
            });
        }
        await check(`${mode}: a grouped insertion without literal hints retains its first local target`, async (scrolling, doc) => {
            const before = await doc(section('First') + section('Last'), options);
            const after = await doc(section('First') + section('Added one') + section('Added two') + section('Last'), options);
            equal(follow(scrolling, before, after, hints(false, 'value'), hints(true, 'value')), after.querySelectorAll('section')[1], 'Do not turn one unsupported insertion range into competing sibling candidates.');
        });
        await check(`${mode}: removed textual fields can support a deletion boundary`, async (scrolling, doc) => {
            const before = await doc(section('First') + section('Removed text') + section('Last') + clock(1), options);
            const after = await doc(section('First') + section('Last') + clock(2), options);
            equal(follow(scrolling, before, after, hints('Removed text'), {}), after.querySelectorAll('section')[1], 'Keep the local surviving boundary for a confirmed deletion.');
        });
        await check(`${mode}: ancestor text noise does not broaden the confirmed leaf target`, async (scrolling, doc) => {
            const before = await doc('<div>Request 1<p id="edited">Hello</p></div>', options);
            const after = await doc('<div>Request 2<p id="edited">Welcome</p></div>', options);
            equal(follow(scrolling, before, after, hints('Hello'), hints('Welcome')), after.querySelector('#edited'), 'Keep the smallest candidate explaining the same input transition.');
        });
    }
    await check('runtime-only reorders cannot nominate a region with unchanged captured source', async (frame, doc) => {
        const markup = '<ol><li>One</li><li>Two</li><li>Three</li></ol>';
        const before = await doc(markup, { captured: true });
        const after = await doc(markup, { captured: true, script: "const items = document.querySelector('ol'); items.append(items.firstElementChild);" });
        frame.capture(before, { ...hints('old-choice', 'value'), ...orderHints('1', '2', '3') });
        frame.capture(after, { ...hints('new-choice', 'value'), ...orderHints('2', '3', '1') });
        equal(frame.comparison.findChange(before, after), null, 'Changed editor values cannot override unchanged source.');
    });
    await check('a browser-only reorder cannot veto a source-confirmed reorder in another region', async (frame, doc) => {
        const markup = (reordered) => `<section>
            <ol id="edited">${reordered ? '<li>B</li><li>A</li>' : '<li>A</li><li>B</li>'}</ol>
            <ol id="runtime"><li>C</li><li>D</li></ol></section>`;
        const before = await doc(markup(false), { captured: true });
        const after = await doc(markup(true), { captured: true,
            script: "const list = document.querySelector('#runtime'); list.append(list.firstElementChild);" });
        frame.capture(before, hints('old-order', 'value'));
        frame.capture(after, hints('new-order', 'value'));
        equal(frame.comparison.findChange(before, after), after.querySelector('#edited'),
            'Follow the collection that reordered in the source, not incidental frontend movement.');
    });
    await check('a DOM-only reorder without a changed input keeps position', async (frame, doc) => {
        const before = await doc('<ol><li>One</li><li>Two</li></ol>');
        const after = await doc('<ol><li>Two</li><li>One</li></ol>');
        equal(frame.findTarget(before, after), null, 'Without clean source or known edit intent the change could be frontend movement.');
    });
    await check('different membership of a hidden field does not corroborate a DOM-only reorder', async (frame, doc) => {
        const before = await doc('<ol><li>One</li><li>Two</li></ol>');
        const after = await doc('<ol><li>Two</li><li>One</li></ol>');
        frame.capture(before, orderHints('1', '1', '2'));
        frame.capture(after, orderHints('2', '2', '1'));
        equal(frame.comparison.findChange(before, after), null, 'A change in duplicate counts is not a reorder.');
    });
    await check('an unrelated browser clock cannot outrank a source-confirmed choice change', async (scrolling, doc) => {
        const markup = (align) => `<section id="edited" data-align="${align}">Article</section><p id="clock">Time 1</p>`;
        const before = await doc(markup('left'), { captured: true });
        const after = await doc(markup('right'), { captured: true, script: "document.querySelector('#clock').textContent = 'Time 2';" });
        equal(follow(scrolling, before, after, hints('left', 'value'), hints('right', 'value')), after.querySelector('#edited'),
            'A choice does not supply evidence for a separate browser-rendered text change.');
    });
    for (const captured of [true, false]) {
        for (const type of ['value', 'selection']) {
            await check(`unrelated live text does not follow changes in ${type}, clean source on both sides=${captured}`, async (scrolling, doc) => {
                const markup = '<section>Article</section><p id="clock">Time 1</p>';
                const before = await doc(markup, { captured: true });
                const after = await doc(markup, { captured, script: "document.querySelector('#clock').textContent = 'Time 2';" });
                equal(follow(scrolling, before, after, hints(1, type), hints(2, type)), null,
                    'A changed choice or selection is not evidence that a browser clock represents authored output.');
            });
        }
    }
    await check('a revision selection does not confirm a browser-only structural change', async (scrolling, doc) => {
        const before = await doc('<section>Article</section>', { captured: true });
        const after = await doc('<section>Article</section>', { captured: true,
            script: "document.querySelector('section').append(document.createElement('aside'));" });
        equal(follow(scrolling, before, after, hints(1, 'selection'), hints(2, 'selection')), null,
            'Selecting a revision with identical clean HTML does not confirm browser-only insertions.');
    });
    await check('live DOM evidence confirms script-rendered content even when source text is unchanged', async (scrolling, doc) => {
        const before = await doc('<p id="edited">Placeholder</p><p>Clock 1</p>', { captured: true, script: "document.querySelector('#edited').textContent = 'Hello';" });
        const after = await doc('<p id="edited">Placeholder</p><p>Clock 2</p>', { captured: true, script: "document.querySelector('#edited').textContent = 'Welcome';" });
        scrolling.capture(before, hints('Hello'));
        equal(scrolling.findTarget(before, after, hints('Welcome')), after.querySelector('#edited'), 'Capture is not a gate excluding browser-rendered author output.');
    });
    for (const [prefix, suffix] of [['', ''], ['Guide: ', ''], ['Guide: ', '.'], ['Guide: ', ' | Archive']]) {
        await check(`a submitted title extension identifies the browser-rendered heading, surrounding copy=${prefix}…${suffix}`, async (scrolling, doc) => {
            const markup = '<h2 id="edited">Placeholder</h2>';
            const before = await doc(markup, { captured: true,
                script: `document.querySelector('#edited').textContent = '${prefix}Read the docs${suffix}';` });
            const after = await doc(markup, { captured: true, script: `
                const heading = document.querySelector('#edited');
                heading.textContent = '${prefix}Read the docs now${suffix}';
                heading.insertAdjacentHTML('afterend', '<aside id="ad">Advertisement</aside>');
            ` });
            equal(follow(scrolling, before, after, hints('Read the docs'), hints('Read the docs now')), after.querySelector('#edited'),
                'The actual overlapping text change outranks a separate DOM-only insertion, even with surrounding copy.');
        });
    }
    await check('unchanged input hints do not legitimize runtime-only DOM mutations', async (scrolling, doc) => {
        const before = await doc(content(), { captured: true, script: "document.querySelector('#edited').textContent = 'Hello';" });
        const after = await doc(content(), { captured: true, script: "document.querySelector('#edited').textContent = 'Welcome';" });
        scrolling.capture(before, hints('Welcome'));
        equal(scrolling.findTarget(before, after, hints('Welcome')), null, 'A stable field is not evidence for a changing runtime widget.');
    });
    await check('input and live DOM can identify a genuinely replaced source node', async (scrolling, doc) => {
        const before = await doc('<p>Hello</p>', { captured: true });
        const after = await doc('<p>Welcome</p>', { captured: true, script: "document.querySelector('p').outerHTML = '<p id=\"replacement\">Welcome</p>';" });
        scrolling.capture(before, hints('Hello'));
        equal(scrolling.findTarget(before, after, hints('Welcome')), after.querySelector('#replacement'), 'Independent author/DOM correspondence may identify a replacement without guessing a source path.');
    });
    await check('cloned source identities plus repeated input matches still preserve position', async (scrolling, doc) => {
        const before = await doc(content('Hello'), { captured: true });
        const after = await doc(content('Welcome'), { captured: true, script: "const p = document.querySelector('#edited'); p.after(p.cloneNode(true));" });
        scrolling.capture(before, hints('Hello'));
        equal(scrolling.findTarget(before, after, hints('Welcome')), null, 'Do not turn exact text into invented certainty between live clones.');
    });
    await check('correlated source and DOM agreement is not an extra vote breaking a real text tie', async (scrolling, doc) => {
        const before = await doc('<p id="one">Hello</p><p id="two">Placeholder</p>', { captured: true, script: "document.querySelector('#two').textContent = 'Hello';" });
        const after = await doc('<p id="one">Welcome</p><p id="two">Placeholder</p>', { captured: true, script: "document.querySelector('#two').textContent = 'Welcome';" });
        scrolling.capture(before, hints('Hello'));
        equal(scrolling.findTarget(before, after, hints('Welcome')), null, 'Repeated output remains ambiguous even when one copy is server-rendered.');
    });
    await check('capture transitions may use independently paired DOM and input evidence', async (scrolling, doc) => {
        const before = await doc(content('Hello'), { captured: true });
        const after = await doc(content('Welcome'));
        scrolling.capture(before, hints('Hello'));
        equal(scrolling.findTarget(before, after, hints('Welcome')), after.querySelector('#edited'), 'Compare DOM to DOM, never captured HTML to DOM, across availability changes.');
    });
    await check('source-only author evidence remains useful when scripts transform its text', async (scrolling, doc) => {
        const script = "document.querySelector('#edited').textContent = 'Transformed output';";
        const before = await doc(content('Hello'), { captured: true, script });
        const after = await doc(content('Welcome'), { captured: true, script });
        scrolling.capture(before, hints('Hello'));
        equal(scrolling.findTarget(before, after, hints('Welcome')), after.querySelector('#edited'), 'DOM agreement is corroboration, not a requirement.');
    });
    await check('a unique transition inside an otherwise unaligned region can identify its live node', async (scrolling, doc) => {
        const before = await doc('<section><p>Hello</p><p>Other before</p></section>', { captured: true });
        const after = await doc('<section><h2>Other after</h2><p id="edited">Welcome</p><div>New structure</div></section>', { captured: true });
        scrolling.capture(before, hints('Hello'));
        equal(scrolling.findTarget(before, after, hints('Welcome')), after.querySelector('#edited'), 'Keep ambiguous rendered regions available for collaborative evidence.');
    });
    for (const captured of [false, true]) {
        const mode = captured ? 'captured' : 'DOM';
        await check(`${mode}: adding and removing an authored attribute can strengthen a candidate`, async (scrolling, doc) => {
            const old = '<p>Article</p>', next = '<p class="has-text-align-right">Article</p>';
            const before = await doc(old + '<p>Clock 1</p>', { captured });
            const after = await doc(next + '<p>Clock 2</p>', { captured });
            scrolling.capture(before, hints(old, 'html'));
            equal(scrolling.findTarget(before, after, hints(next, 'html')), after.querySelector('p'), 'An absent old attribute is a real state, not missing evidence.');
            const removed = await doc(old + '<p>Clock 3</p>', { captured });
            equal(scrolling.findTarget(after, removed, hints(old, 'html')), removed.querySelector('p'), 'Removing a value is eligible too.');
        });
        await check(`${mode}: wrapping existing text with formatting retains author evidence`, async (scrolling, doc) => {
            const old = '<p>Hello</p>', next = '<p><strong>Hello</strong></p>';
            const before = await doc(old + '<p>Clock 1</p>', { captured });
            const after = await doc(next + '<p>Clock 2</p>', { captured });
            scrolling.capture(before, hints(old, 'html'));
            equal(scrolling.findTarget(before, after, hints(next, 'html')), after.querySelector('p'), 'Changing the text-node structure can be the actual formatting edit.');
        });
        await check(`${mode}: filling an existing empty element still has author evidence`, async (scrolling, doc) => {
            const before = await doc('<p id="edited"></p><p>Clock 1</p>', { captured });
            const after = await doc('<p id="edited">Welcome</p><p>Clock 2</p>', { captured });
            scrolling.capture(before, hints(''));
            equal(scrolling.findTarget(before, after, hints('Welcome')), after.querySelector('#edited'), 'An empty old value need not be an insertion.');
        });
        await check(`${mode}: snapshots freeze their own submission values`, async (scrolling, doc) => {
            const before = await doc(content('Hello') + '<p>Clock 1</p>', { captured });
            const after = await doc(content('Welcome') + '<p>Clock 2</p>', { captured });
            const oldValues = hints('Hello');
            scrolling.capture(before, oldValues);
            oldValues.field.value = 'Welcome';
            equal(scrolling.findTarget(before, after, hints('Welcome')), after.querySelector('#edited'), 'Later mutations cannot rewrite the displayed baseline.');
        });
        await check(`${mode}: descendant text cannot cancel a corroborated edit to the parent’s own text`, async (scrolling, doc) => {
            const before = await doc('<section>cats <span>dogs</span></section><p id="echo">cats</p>', { captured });
            const after = await doc('<section>dogs <span>cats</span></section><p id="echo">dogs</p>', { captured });
            equal(follow(scrolling, before, after, hints('cats'), hints('dogs')), null,
                'Both the section’s own text and the echo independently match the edit, so neither should win.');
        });
        await check(`${mode}: changed parent and child text remain genuinely competing evidence`, async (scrolling, doc) => {
            const before = await doc('<div>Hello<p>Hello</p></div>', { captured });
            const after = await doc('<div>Welcome<p>Welcome</p></div>', { captured });
            scrolling.capture(before, hints('Hello'));
            equal(scrolling.findTarget(before, after, hints('Welcome')), null, 'Do not minimize away an independently changed parent text node.');
        });
    }
    for (const captured of [false, true]) {
        await check(`unaligned existing values are not an input transition, captured=${captured}`, async (scrolling, doc) => {
            const before = await doc(section('One', 'Hello') + section('Two', 'Welcome'), { captured });
            const after = await doc(section('Two', 'Welcome') + section('One', 'Hello'), { captured });
            scrolling.capture(before, hints('Hello'));
            equal(scrolling.findTarget(before, after, hints('Welcome')), null, 'Do not match old/new strings merely because both exist in a reordered region.');
        });
    }
    for (const captured of [false, true]) {
        for (const nested of [false, true]) {
            for (const generatedIds of [false, true]) {
                await check(`attribute-only reorders do not invent an input transition, captured=${captured}, nested=${nested}, generated IDs=${generatedIds}`, async (scrolling, doc) => {
                    const item = (id, style) => nested
                        ? `<section id="${id}"><p class="${style}">Repeated content</p></section>`
                        : `<p id="${id}" class="${style}">Repeated content</p>`;
                    const first = item('one', 'old-style'), second = item('two', 'new-style');
                    const before = await doc(first + second, { captured });
                    const after = await doc(generatedIds ? item('three', 'new-style') + item('four', 'old-style') : second + first, { captured });
                    scrolling.capture(before, hints(first, 'html'));
                    equal(scrolling.findTarget(before, after, hints(first.replace('old-style', 'new-style'), 'html')), null, 'Existing presentation values only traded positions; reference churn does not prove an authored transition.');
                });
            }
        }
        await check(`reference-only reorders do not invent an authored ID transition, captured=${captured}`, async (scrolling, doc) => {
            const first = '<p id="old-anchor">Repeated content</p>', second = '<p id="new-anchor">Repeated content</p>';
            const before = await doc(first + second, { captured }), after = await doc(second + first, { captured });
            scrolling.capture(before, hints(first, 'html'));
            equal(scrolling.findTarget(before, after, hints(second, 'html')), null, 'Preserved authored references also distinguish a permutation from an applied edit.');
        });
        await check(`a genuine attribute edit among equal-content siblings remains identifiable, captured=${captured}`, async (scrolling, doc) => {
            const old = '<p id="edited" class="old-style">Repeated content</p>';
            const changed = old.replace('old-style', 'new-style');
            const sibling = '<p id="unchanged" class="new-style">Repeated content</p>';
            const before = await doc(old + sibling, { captured }), after = await doc(changed + sibling, { captured });
            scrolling.capture(before, hints(old, 'html'));
            equal(scrolling.findTarget(before, after, hints(changed, 'html')), after.querySelector('#edited'), 'Do not blanket-reject attribute changes on repeated content.');
        });
        await check(`an attribute-only reorder does not veto an independent paired text edit, captured=${captured}`, async (scrolling, doc) => {
            const first = '<p id="one" class="old-style">Repeated content</p>';
            const second = '<p id="two" class="new-style">Repeated content</p>';
            const before = await doc(first + second + '<p id="edited">Hello</p>', { captured });
            const after = await doc(second + first + '<p id="edited">Welcome</p>', { captured });
            scrolling.capture(before, hints('Hello'));
            equal(scrolling.findTarget(before, after, hints('Welcome')), after.querySelector('#edited'), 'An actual loss/gain transition can still identify the edited node.');
        });
    }
    await check('unapplied formatting intent does not confirm an unchanged paragraph inside a reorder', async (scrolling, doc) => {
        const before = await doc(section('One', 'Hello') + section('Two', 'Welcome'), { captured: true });
        const after = await doc(section('Two', 'Welcome') + section('One', 'Hello'), { captured: true });
        scrolling.capture(before, hints('<p>Hello</p>', 'html'));
        equal(scrolling.findTarget(before, after, hints('<p><strong>Hello</strong></p>', 'html')), null, 'Input intent must correspond to an actual output transition.');
    });
    await check('an unapplied wrapping hint cannot confirm an unrelated live text change', async (scrolling, doc) => {
        const markup = '<p>For cats, price 10</p>';
        const before = await doc(markup, { captured: true });
        const after = await doc(markup, { captured: true, script: "document.querySelector('p').textContent = 'For cats, price 11';" });
        equal(follow(scrolling, before, after, hints('<p>cats</p>', 'html'), hints('<p><strong>cats</strong></p>', 'html')), null,
            'Finding the same word in a paragraph whose formatting did not change cannot confirm a wrapping edit.');
    });
    await check('a real browser-rendered wrapping edit can still be corroborated', async (scrolling, doc) => {
        const markup = '<p id="edited">cats</p><p id="price">For cats, price 10</p>';
        const before = await doc(markup, { captured: true });
        const after = await doc(markup, { captured: true, script: `
            document.querySelector('#edited').innerHTML = '<strong>cats</strong>';
            document.querySelector('#price').textContent = 'For cats, price 11';
        ` });
        equal(follow(scrolling, before, after, hints('<p>cats</p>', 'html'), hints('<p><strong>cats</strong></p>', 'html')),
            after.querySelector('#edited'), 'An observed formatting change can follow the author even when it was rendered by a script.');
    });
    await check('an unapplied image edit cannot confirm an unrelated live media rotation', async (scrolling, doc) => {
        const markup = '<img id="banner" src="/banner-one.jpg" width="100" height="100">';
        const before = await doc(markup, { captured: true });
        const after = await doc(markup, { captured: true, script: "document.querySelector('#banner').src = '/banner-two.jpg';" });
        equal(follow(scrolling, before, after, hints('<img src="/old.jpg">', 'html'), hints('<img src="/new.jpg">', 'html')), null,
            'An image URL change requires matching media evidence, not merely the same empty tag.');
    });
    for (const captured of [false, true]) {
        await check(`unchanged words cannot confirm an unrelated text edit, captured=${captured}`, async (scrolling, doc) => {
            const output = (title, price) => `<h2 id="edited">${title}</h2><p id="price">For cats and dogs, price ${price}</p>`;
            const before = await doc(output('CATS', 10), { captured });
            const after = await doc(output('DOGS', 11), { captured });
            equal(follow(scrolling, before, after, hints('cats'), hints('dogs')), null,
                'The price changed, but neither of the hinted words changed in the price text.');
        });
        await check(`unchanged words cannot confirm an unrelated attribute edit, captured=${captured}`, async (scrolling, doc) => {
            const output = (title, price) => `<h2 id="edited">${title}</h2><p title="For cats and dogs, price ${price}">Price information</p>`;
            const before = await doc(output('CATS', 10), { captured });
            const after = await doc(output('DOGS', 11), { captured });
            equal(follow(scrolling, before, after, hints('cats'), hints('dogs')), after.querySelector('#edited'),
                'Unchanged words in an attribute cannot outrank a real content change.');
        });
        await check(`a complete link destination can extend its old value, captured=${captured}`, async (scrolling, doc) => {
            const link = (href) => `<a id="edited" href="${href}">Documentation</a>`;
            const old = link('/docs'), next = link('/docs/start');
            const before = await doc(old + '<p>Time 1</p>', { captured });
            const after = await doc(next + '<p>Time 2</p>', { captured });
            equal(follow(scrolling, before, after, hints(old, 'html'), hints(next, 'html')), after.querySelector('#edited'),
                'An exact before/after value change still corroborates an edit when the new value contains the old one.');
        });
        await check(`a real transition can have additional unchanged copies, captured=${captured}`, async (scrolling, doc) => {
            const output = (animal, time) => `<h2 id="edited">${animal} live here; cats and dogs are welcome.</h2><p>Time ${time}</p>`;
            const before = await doc(output('cats', 1), { captured });
            const after = await doc(output('dogs', 2), { captured });
            equal(follow(scrolling, before, after, hints('cats'), hints('dogs')), after.querySelector('#edited'),
                'An old occurrence is lost and a new one gained, even though both words remain.');
        });
    }
    await check('visibility cannot resolve repeated, equally corroborated author transitions', async (scrolling, doc) => {
        const before = await doc('<section><div hidden>Hello</div></section><p>Hello</p>', { captured: true });
        const after = await doc('<section><div hidden>Welcome</div></section><p>Welcome</p>', { captured: true });
        scrolling.capture(before, hints('Hello'));
        equal(scrolling.findTarget(before, after, hints('Welcome')), null, 'Identification remains ambiguous even when only one matching element is visible.');
    });
    await check('nonliteral input intent can support transformed DOM-only content', async (scrolling, doc) => {
        const before = await doc('<section></section>', { captured: true });
        const after = await doc('<section></section>', { captured: true, script: "document.querySelector('section').innerHTML = '<p id=\"conditional\">Conditional result</p>';" });
        scrolling.capture(before, hints(false, 'value'));
        equal(scrolling.findTarget(before, after, hints(true, 'value')), after.querySelector('#conditional'), 'Known author intent and structural DOM output collaborate without a literal boolean search.');
    });
    await check('nonliteral input intent does not turn an unrelated runtime class into sufficient evidence', async (scrolling, doc) => {
        const before = await doc(content(), { captured: true, script: "document.body.className = 'runtime-before';" });
        const after = await doc(content(), { captured: true, script: "document.body.className = 'runtime-after';" });
        scrolling.capture(before, hints(false, 'value'));
        equal(scrolling.findTarget(before, after, hints(true, 'value')), null, 'Author intent alone does not identify an animation class.');
    });
    await check('native-navigation baselines do not retain unrelated editor values', async (scrolling, doc) => {
        const old = await doc(content('Hello'), { captured: true });
        scrolling.capture(old, hints('Hello'));
        const navigated = await doc(content('Other page'), { captured: true });
        scrolling.capture(navigated);
        const next = await doc(content('Welcome') + '<p>Another changed value</p>', { captured: true });
        equal(scrolling.findTarget(navigated, next, hints('Welcome')), null, 'A document without submitted values cannot inherit the prior page intent.');
    });
    await check('comparison exposes only capture and single-element identification; scrolling owns no snapshots', async (frame, doc) => {
        equal(Object.keys(frame.comparison).sort().join(','), 'capture,findChange', 'No snapshot/candidate API escapes.');
        equal(Object.keys(frame.scrolling).sort().join(','), 'keepInView,remember,restore', 'Scroll presentation has no comparison lifecycle.');
        const before = await doc(content('Hello'), { captured: true });
        const after = await doc(content('Welcome'), { captured: true });
        equal(frame.comparison.findChange(before, after), null, 'Only explicit frame capture may establish a baseline.');
        equal(frame.comparison.capture(before, hints('Hello')), undefined, 'Capture does not expose a snapshot tree.');
        equal(frame.comparison.capture(after, hints('Welcome')), undefined, 'Capture remains a lifecycle operation.');
        equal(frame.comparison.findChange(before, after), after.querySelector('#edited'), 'Return an actual live element, not a result collection.');
    });
    await check('comparison returns the hidden changed element; scrolling alone reveals its ancestor', async (frame, doc) => {
        const markup = (text) => `${content()}<section id="context"><h2>Closed widget</h2><div hidden><p id="hidden-change">${text}</p></div></section>`;
        const before = await doc(markup('Hello'), { captured: true });
        const after = await doc(markup('Welcome'), { captured: true });
        frame.comparison.capture(before, hints('Hello'));
        frame.comparison.capture(after, hints('Welcome'));
        const identified = frame.comparison.findChange(before, after);
        equal(identified, after.querySelector('#hidden-change'), 'Identification must not substitute a visible ancestor.');
        const container = after.querySelector('#context'), original = container.outerHTML;
        await frame.scrolling.restore(after, identified);
        if (after.defaultView.scrollY <= 0) throw new Error('Scroll presentation should reveal the offscreen ancestor.');
        equal(container.outerHTML, original, 'Neither owner opens or rewrites the hidden widget.');
    });
    await check('comparison resolves deletion to a surviving element, not a deletion instruction', async (frame, doc) => {
        const before = await doc(section('First') + section('Removed') + section('Last'), { captured: true });
        const after = await doc(section('First') + section('Last'), { captured: true });
        frame.comparison.capture(before);
        frame.comparison.capture(after);
        equal(frame.comparison.findChange(before, after), after.querySelectorAll('section')[1], 'Scrolling never interprets deleted entries or sibling arrays.');
    });
    await check('comparison does not scroll, restore styles or reveal hidden ancestors', async (frame, doc) => {
        const before = await doc(content('Hello'), { captured: true });
        const after = await doc(content('Welcome'), { captured: true });
        frame.comparison.capture(before, hints('Hello'));
        frame.comparison.capture(after, hints('Welcome'));
        after.defaultView.scrollTo(0, 40);
        const html = after.documentElement.outerHTML;
        const position = after.defaultView.scrollY;
        frame.comparison.findChange(before, after);
        equal(after.defaultView.scrollY, position, 'Identification must not change viewport position.');
        equal(after.documentElement.outerHTML, html, 'Identification is read-only.');
    });
    await check('scroll restoration does not parse captured source or freeze an editor baseline', async (frame, doc) => {
        const document = await doc(content(), { captured: true });
        let reads = 0;
        const marker = document.querySelector('meta');
        marker.getAttribute = () => { reads++; throw new Error('Source access is not scroll presentation.'); };
        await frame.scrolling.restore(document, document.querySelector('#edited'));
        equal(reads, 0, 'No comparison source is read during restoration.');
        if (document.defaultView.scrollY <= 0) throw new Error('Scroll presentation works independently of comparison.');
    });
    for (const captured of [false, true]) {
        await check(`following resumes from a fresh baseline after uncaptured previews, captured=${captured}`, async (frame, doc) => {
            const old = await doc(content('Older following output'), { captured });
            frame.capture(old, hints('Older following output'));
            const disabled = await doc(content('Output while following is disabled'));
            disabled.defaultView.scrollTo(0, 60);
            frame.remember(disabled);
            const baseline = await doc(content('Fresh following baseline'), { captured });
            frame.capture(baseline, hints('Fresh following baseline'));
            const target = frame.comparison.findChange(disabled, baseline);
            equal(target, null, 'Neither an uncaptured document nor an older following snapshot supplies a baseline.');
            await frame.scrolling.restore(baseline, target);
            equal(baseline.defaultView.scrollY, 60, 'The first following load retains the remembered position.');
            baseline.querySelector('#edited').textContent = 'Later frontend mutation';
            const next = await doc(content('Next authored change'), { captured });
            frame.capture(next, hints('Next authored change'));
            const change = frame.comparison.findChange(baseline, next);
            equal(change, next.querySelector('#edited'), 'Subsequent updates follow against the frozen new baseline.');
            await frame.scrolling.restore(next, change);
        });
    }
    for (const captured of [false, true]) {
        for (const custom of [false, true]) {
            await check(`boxless insertions preserve their comparison-eligible descendant, captured=${captured}, custom policy=${custom}`, async (frame, doc) => {
                const before = await doc(section('First') + section('Last'), { captured });
                const excluded = custom ? '<div class="runtime" id="excluded">Runtime content</div>' : '<nav id="excluded">Navigation</nav>';
                const after = await doc(section('First') + `<section id="wrapper" style="display:contents">${excluded}<p id="authored">Added text</p></section>` + section('Last'), { captured });
                frame.comparison.capture(before);
                frame.comparison.capture(after);
                const identified = frame.comparison.findChange(before, after);
                equal(identified, after.querySelector('#authored'), 'Keep the eligible mapped child instead of returning an undifferentiated boxless wrapper.');
                equal(visibleTarget(identified), after.querySelector('#authored'), 'Scroll presentation must not reintroduce an excluded descendant.');
            }, custom ? ['.runtime'] : defaults);
        }
    }
    await check('boxless source wrappers retain independently mapped children moved by frontend scripts', async (frame, doc) => {
        const before = await doc(section('First') + section('Last'), { captured: true });
        const after = await doc(section('First') + '<section id="inserted" style="display:contents"><h2 id="moved">Inserted</h2></section>' + section('Last'), {
            captured: true, script: "const aside = document.createElement('aside'); document.body.append(aside); aside.append(document.querySelector('#moved'));",
        });
        frame.comparison.capture(before);
        frame.comparison.capture(after);
        equal(frame.comparison.findChange(before, after), after.querySelector('aside > #moved'), 'Do not lose source/live correspondence when reducing to one element.');
    });
    for (const captured of [false, true]) {
        await check(`native reveal preserves comparison identity and frozen snapshots, captured=${captured}`, async (frame, doc) => {
            const markup = (text) => `${content()}<details><summary>Disclosure</summary><section hidden="until-found"><p id="native">${text}</p></section></details><p>End</p>`;
            const before = await doc(markup('Before native edit'), { captured });
            const after = await doc(markup('After native edit'), { captured });
            frame.comparison.capture(before);
            frame.comparison.capture(after);
            const target = after.querySelector('#native');
            equal(frame.comparison.findChange(before, after), target, 'Keep the original hidden changed element.');
            let notifications = 0, scrolls = 0;
            target.parentElement.addEventListener('beforematch', (event) => {
                notifications++;
                equal(event.bubbles, true, 'beforematch bubbles.');
                equal(event.cancelable, false, 'beforematch is a notification, not a cancellation API.');
                equal(event.target.getAttribute('hidden'), 'until-found', 'Notify before removing the attribute.');
            });
            const scroll = target.scrollIntoView;
            target.scrollIntoView = function (...args) { scrolls++; return scroll.apply(this, args); };
            await frame.scrolling.restore(after, target);
            equal(after.querySelector('details').open, true, 'Open the enclosing native body.');
            equal(target.parentElement.hasAttribute('hidden'), false, 'Remove only discoverable hiding.');
            equal(target.checkVisibility({ visibilityProperty: true }), true, 'The actual text must render, not just have a rectangle.');
            equal(notifications, 1, 'Notify once.');
            equal(scrolls, 1, 'Scroll once after activation.');
            equal(frame.comparison.findChange(before, after), target, 'Presentation must not alter captured comparison evidence.');
        });
    }
    await check('nested details open only the required ancestry and retain native named exclusivity', async (frame, doc) => {
        const after = await doc(`${content()}<details name="exclusive" open id="peer"><summary>Peer</summary><p>Peer body</p></details><section><details name="exclusive" id="outer"><summary>Outer</summary><details id="inner"><summary>Inner</summary><p id="native">Changed body</p></details></details></section><details id="unrelated"><summary>Unrelated</summary><p>Other</p></details>`);
        await frame.scrolling.restore(after, after.querySelector('#native'));
        equal(after.querySelector('#outer').open, true, 'Open the outer native container.');
        equal(after.querySelector('#inner').open, true, 'Open the inner native container.');
        equal(after.querySelector('#peer').open, false, 'Let the browser enforce its named group across non-siblings.');
        equal(after.querySelector('#unrelated').open, false, 'Leave other disclosures alone.');
        equal(after.querySelector('#native').checkVisibility(), true, 'Nested body renders.');
    });
    for (const target of ['#summary-child', '#disclosure']) {
        await check(`visible disclosure target ${target} does not open its own body`, async (frame, doc) => {
            const after = await doc(`${content()}<details id="disclosure"><summary><span id="summary-child">Edited heading</span></summary><p>Unchanged body</p></details>`);
            await frame.scrolling.restore(after, after.querySelector(target));
            equal(after.querySelector('details').open, false, 'An already visible heading/wrapper needs no opening.');
        });
    }
    await check('until-found owner microtasks settle before one final scroll, without focus or navigation changes', async (frame, doc) => {
        const after = await doc(`${content()}<button id="focus">Focused control</button><section hidden="until-found" id="outer"><section hidden="UNTIL-FOUND" id="inner"><p id="native">Changed body</p></section></section>`);
        const focus = after.querySelector('#focus');
        focus.focus({ preventScroll: true });
        const url = after.URL, history = after.defaultView.history.length;
        const order = [];
        for (const id of ['inner', 'outer']) after.querySelector(`#${id}`).addEventListener('beforematch', (event) => {
            if (event.target.id !== id) return;
            order.push(id);
            Promise.resolve().then(() => { event.target.dataset.settled = 'yes'; });
        });
        const target = after.querySelector('#native');
        const scroll = target.scrollIntoView;
        target.scrollIntoView = function (...args) {
            equal(after.querySelector('#inner').dataset.settled, 'yes', 'Flush inner owner microtasks.');
            equal(after.querySelector('#outer').dataset.settled, 'yes', 'Flush outer owner microtasks.');
            return scroll.apply(this, args);
        };
        await frame.scrolling.restore(after, target);
        equal(order.join(','), 'inner,outer', 'Reveal from the inner path outward.');
        equal(after.activeElement, focus, 'Do not force focus.');
        equal(after.URL, url, 'Do not navigate to a fragment.');
        equal(after.defaultView.history.length, history, 'Do not add history entries.');
        equal(target.checkVisibility(), true, 'Both discoverable containers reveal their body.');
    });
    await check('ordinary hidden and custom widget controls retain the existing fallback', async (frame, doc) => {
        const after = await doc(`${content()}<section id="context"><button aria-controls="panel" aria-expanded="false">Open</button><div id="panel" hidden aria-hidden="true"><details><summary>Native inner</summary><p id="native">Changed body</p></details></div></section>`);
        let clicks = 0;
        after.querySelector('button').addEventListener('click', () => clicks++);
        await frame.scrolling.restore(after, after.querySelector('#native'));
        equal(clicks, 0, 'Never guess or click a custom widget control.');
        equal(after.querySelector('#panel').hidden, true, 'Do not remove ordinary hidden.');
        equal(after.querySelector('#panel').getAttribute('aria-hidden'), 'true', 'Do not override author accessibility state.');
        equal(after.querySelector('button').getAttribute('aria-expanded'), 'false', 'Do not invent ARIA activation.');
        equal(after.querySelector('details').open, false, 'Do not activate native content behind unsupported hiding.');
        equal(visibleTarget(after.querySelector('#native')), after.querySelector('#context'), 'Use the existing visible context.');
    });
    for (const hiding of ['hidden', 'style="display:none"']) {
        await check(`unreachable native content preserves its visible exclusive peer, ${hiding}`, async (frame, doc) => {
            const after = await doc(`${content()}<details name="shared" open id="peer"><summary>Visible peer</summary><p>Visible body</p></details><section id="context"><div ${hiding}><section hidden="until-found" id="discoverable"><details name="shared" id="unreachable"><summary>Hidden disclosure</summary><p id="native">Changed body</p></details></section></div></section>`);
            let notifications = 0;
            after.querySelector('#discoverable').addEventListener('beforematch', () => { notifications++; });
            await frame.scrolling.restore(after, after.querySelector('#native'));
            equal(after.querySelector('#peer').open, true, 'Keep the visible exclusive peer open.');
            equal(after.querySelector('#unreachable').open, false, 'Do not open an unreachable disclosure.');
            equal(after.querySelector('#discoverable').getAttribute('hidden'), 'until-found', 'Preserve unreachable discoverable state too.');
            equal(notifications, 0, 'Do not notify owners when unsupported hiding prevents reveal.');
            equal(visibleTarget(after.querySelector('#native')), after.querySelector('#context'), 'Use the existing visible-container fallback.');
        });
    }
    await check('until-found hiding remains revealable when author CSS uses display none', async (frame, doc) => {
        const after = await doc(`${content()}<style>[hidden]{display:none!important}</style><section hidden="until-found"><details><summary>Inner</summary><p id="native">Changed body</p></details></section>`);
        await frame.scrolling.restore(after, after.querySelector('#native'));
        equal(after.querySelector('[hidden]'), null, 'The discoverable attribute itself is supported hiding.');
        equal(after.querySelector('details').open, true, 'Reveal supported nested native containers.');
        equal(after.querySelector('#native').checkVisibility(), true, 'The actual target renders.');
    });
    await check('until-found handlers may replace hiding with ordinary hidden without it being removed', async (frame, doc) => {
        const after = await doc(`${content()}<section id="context"><div hidden="until-found" id="panel"><p id="native">Changed body</p></div></section>`);
        after.querySelector('#panel').addEventListener('beforematch', (event) => event.target.setAttribute('hidden', ''));
        await frame.scrolling.restore(after, after.querySelector('#native'));
        equal(after.querySelector('#panel').getAttribute('hidden'), '', 'Respect the owner state after notification.');
        equal(visibleTarget(after.querySelector('#native')), after.querySelector('#context'), 'Fall back instead of forcing visibility.');
    });
    await check('a beforematch handler removing the target prevents subsequent native activation', async (frame, doc) => {
        const after = await doc(`${content()}<details><summary>Outer</summary><div hidden="until-found"><p id="native">Changed body</p></div></details>`);
        const target = after.querySelector('#native');
        target.parentElement.addEventListener('beforematch', () => target.remove());
        await frame.scrolling.restore(after, target);
        equal(after.querySelector('details').open, false, 'Do not continue opening a stale path.');
        equal(visibleTarget(target), null, 'A detached target must not be scrolled.');
    });
    await check('reparenting during beforematch does not open unrelated ancestors', async (frame, doc) => {
        const after = await doc(`${content()}<details><summary>Outer</summary><div hidden="until-found"><p id="native">Changed body</p></div></details><section id="destination"></section>`);
        const target = after.querySelector('#native');
        target.parentElement.addEventListener('beforematch', () => after.querySelector('#destination').append(target));
        await frame.scrolling.restore(after, target);
        equal(after.querySelector('details').open, false, 'Do not open ancestors that no longer contain the target.');
    });
    await check('null or ineligible follow targets open nothing', async (frame, doc) => {
        const after = await doc(`${content()}<details><summary>Disclosure</summary><div hidden="until-found"><p id="native">Changed body</p></div></details>`);
        await frame.scrolling.restore(after);
        await frame.scrolling.restore(after, after.querySelector('#native'), () => false);
        equal(after.querySelector('details').open, false, 'Disabled/baseline/ambiguous following must not reveal.');
        equal(after.querySelector('[hidden]').getAttribute('hidden'), 'until-found', 'Keep discoverable hiding untouched too.');
    });
    for (const reason of ['canceled', 'superseded']) {
        await check(`a ${reason} deferred reveal never performs a late scroll`, async (frame, doc) => {
            const after = await doc(`${content()}<details><summary>Disclosure</summary><p id="native">Changed body</p></details>`);
            const target = after.querySelector('#native');
            let eligible = true, scrolls = 0;
            target.scrollIntoView = () => { scrolls++; };
            const pending = frame.scrolling.restore(after, target, () => eligible);
            if (reason === 'canceled') eligible = false;
            else await frame.scrolling.restore(after);
            await pending;
            equal(scrolls, 0, 'Discard the deferred scroll after cancellation/new restoration.');
            equal(after.querySelector('details').open, false, 'Cancel before any deferred opening too.');
        });
    }
    await check('initial rendering can apply discoverable hiding before the reveal inspection', async (frame, doc) => {
        const after = await doc(`${content()}<section id="panel"><p id="native">Changed body</p></section>`);
        const panel = after.querySelector('#panel');
        let notifications = 0;
        panel.addEventListener('beforematch', () => { notifications++; });
        after.defaultView.setTimeout(() => panel.setAttribute('hidden', 'until-found'), 0);
        await frame.scrolling.restore(after, after.querySelector('#native'));
        equal(notifications, 1, 'Inspect discoverable hiding after the initial rendering opportunity.');
        equal(panel.hasAttribute('hidden'), false, 'Reveal the initialized container before scrolling.');
    });
    await check('mixed until-found outer and details inner containers both reveal', async (frame, doc) => {
        const after = await doc(`${content()}<section hidden="until-found"><details><summary>Inner</summary><p id="native">Changed body</p></details></section>`);
        const target = after.querySelector('#native');
        await frame.scrolling.restore(after, target);
        equal(after.querySelector('details').open, true, 'Open the inner native body.');
        equal(after.querySelector('[hidden]'), null, 'Reveal the outer discoverable container.');
        equal(target.checkVisibility(), true, 'The mixed nested target must render.');
    });
    await check('cancellation inside beforematch preserves the remaining hidden state', async (frame, doc) => {
        const after = await doc(`${content()}<details><summary>Outer</summary><div hidden="until-found"><p id="native">Changed body</p></div></details>`);
        let eligible = true;
        after.querySelector('[hidden]').addEventListener('beforematch', () => { eligible = false; });
        await frame.scrolling.restore(after, after.querySelector('#native'), () => eligible);
        equal(after.querySelector('[hidden]').getAttribute('hidden'), 'until-found', 'Stop mutation when the owner cancels following.');
        equal(after.querySelector('details').open, false, 'Do not continue opening ancestors after cancellation.');
    });
    for (const { name, top, height = 40, header = '', headerHeight = 0, delta = 0 } of [
        { name: 'an edit already in view keeps the restored scroll position', top: 190 },
        { name: 'a tall edit already filling the viewport keeps the restored position', top: -100, height: 600 },
        { name: 'an edit clipped by the bottom edge scrolls only enough to fit', top: 290, delta: 10 },
        { name: 'an edit clipped by the top edge scrolls only enough to fit', top: -10, delta: -10 },
        { name: 'a sticky header covering part of an edit needs only a nudge', top: 38, header: 'sticky', headerHeight: 48, delta: -10 },
        { name: 'an edit fully covered by a fixed header still uses the nearest edge', top: 4, header: 'fixed', delta: -44 },
    ]) {
        await check(name, async (frame, doc) => {
            const headerMarkup = header ? `<div style="position:${header};inset:0 0 auto;height:48px;z-index:1">Header</div>` : '';
            const before = await doc('<div style="height:1600px"></div>');
            const after = await doc(`<style>body{margin:0}</style>${headerMarkup}<div style="height:${500 + top - headerHeight}px"></div>
                <div id="edited" style="height:${height}px;line-height:20px">Changed</div><div style="height:900px"></div>`);
            before.defaultView.scrollTo(0, 500);
            frame.scrolling.remember(before);
            const target = after.querySelector('#edited'), scroll = target.scrollIntoView;
            const calls = [];
            target.scrollIntoView = function (options) { calls.push(options.block); return scroll.call(this, options); };
            equal(await frame.scrolling.restore(after, target), target, 'Retain the edit as the breakpoint anchor even without scrolling.');
            equal(after.defaultView.scrollY, 500 + delta, 'Preserve the reader’s position or move by only the clipped distance.');
            equal(calls.join(','), delta ? 'nearest' : '', 'Skip alignment when visible; otherwise request one nearest-edge scroll.');
            equal(target.getAttribute('style'), `height:${height}px;line-height:20px`, 'Leave theme styling unchanged.');
        });
    }
    await check('an edit barely clipped by a nested scrollport nudges only that scrollport', async (frame, doc) => {
        const after = await doc(`<div style="height:60px"></div><div id="port" style="height:100px;overflow:auto">
            <div style="height:70px"></div><div id="edited" style="height:40px">Edited</div><div style="height:300px"></div>
            </div><div style="height:700px"></div>`);
        await frame.scrolling.restore(after, after.querySelector('#edited'));
        equal(after.querySelector('#port').scrollTop, 10, 'Reveal the last 10 pixels without centering inside the scrollport.');
        equal(after.defaultView.scrollY, 0, 'Do not move the page when the scrollport is already visible.');
    });
    await check('a fully visible fragment inside a hard clip does not move the page', async (frame, doc) => {
        const before = await doc('<div style="height:1600px"></div>');
        const after = await doc(`<style>body{margin:0}</style><div style="height:590px"></div>
            <div id="clip" style="height:80px;overflow:clip">
                <div id="edited" style="height:140px;position:relative;top:-70px">Edited</div>
            </div><div style="height:900px"></div>`);
        before.defaultView.scrollTo(0, 550);
        frame.scrolling.remember(before);
        const target = after.querySelector('#edited'), clip = after.querySelector('#clip');
        equal(await frame.scrolling.restore(after, target), target, 'Keep the visible edit as the breakpoint anchor.');
        equal(clip.getBoundingClientRect().top, 40, 'The entire reachable fragment stays in view.');
        equal(after.defaultView.scrollY, 550, 'Do not align the part of the edit that scrolling cannot show.');
    });
    await check('a header nudge does not shift a nested scrollport that already shows the edit', async (frame, doc) => {
        const after = await doc(`<style>body{margin:0}</style><div style="position:fixed;inset:0 0 auto;height:48px;z-index:1"></div>
            <div style="height:520px"></div><div id="port" style="height:100px;overflow:auto">
            <div style="height:60px"></div><div id="edited" style="height:40px">Edited</div><div style="height:300px"></div>
            </div><div style="height:900px"></div>`);
        const root = after.documentElement, port = after.querySelector('#port'), target = after.querySelector('#edited');
        root.setAttribute('style', 'scroll-padding-top: 12px');
        after.defaultView.scrollTo(0, 500);
        port.scrollTop = 50;
        frame.scrolling.remember(after);
        await frame.scrolling.restore(after, target);
        equal(after.defaultView.scrollY, 482, 'Move the page only enough to clear the fixed header.');
        equal(port.scrollTop, 50, 'Do not apply the page header inset to inner scrollports.');
        equal(root.getAttribute('style'), 'scroll-padding-top: 12px', 'Restore the exact viewport styles.');
    });
    for (const { name, height, expectedTop, header = '' } of [
        { name: 'short change lands in the upper third of the usable viewport', height: 40, expectedTop: 100 },
        { name: 'upper-third alignment respects header clearance and author offsets', height: 40, expectedTop: 123,
            header: '<div style="position:fixed;inset:0 0 auto;height:48px">Header</div>' },
        { name: 'near-full-height change moves up only as far as it fits', height: 260, expectedTop: 20 },
        { name: 'oversized change still shows its beginning', height: 340, expectedTop: 20 },
    ]) {
        await check(name, async (frame, doc) => {
            const targetStyle = `height:${height}px;line-height:20px;${header ? 'scroll-margin: 8px 0 12px;' : ''}`;
            const after = await doc(`${header}<div style="height:600px"></div><div id="edited" style="${targetStyle}">Changed</div><div style="height:600px"></div>`);
            const rootStyle = header ? 'scroll-padding: 32px 0 16px;' : null;
            if (rootStyle) after.documentElement.setAttribute('style', rootStyle);
            const target = after.querySelector('#edited');
            await frame.scrolling.restore(after, target);
            const top = target.getBoundingClientRect().top;
            if (Math.abs(top - expectedTop) > 1) throw new Error(`Expected top ${expectedTop}px, got ${top}px.`);
            equal(after.documentElement.getAttribute('style'), rootStyle, 'Restore the exact viewport styles.');
            equal(target.getAttribute('style'), targetStyle, 'Restore the exact target styles.');
        });
    }
    await check('upper-third bias leaves nested scrollport alignment unchanged', async (frame, doc) => {
        const after = await doc('<div style="height:600px"></div><div id="scroller" style="height:120px;overflow:auto"><div style="height:300px"></div><div id="edited" style="height:40px;line-height:20px">Changed</div><div style="height:300px"></div></div><div style="height:600px"></div>');
        const scroller = after.querySelector('#scroller');
        const target = after.querySelector('#edited');
        await frame.scrolling.restore(after, target);
        equal(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top, 50, 'Center the target with its existing clearance inside the nested scrollport.');
    });
    for (const scrolledAway of [false, true]) {
        await check(`breakpoint following ${scrolledAway ? 'does not pull back a nested scrollport the user left' : 'reveals a newly clipped nested target'}`, async (frame, doc) => {
            const after = await doc(`<style>
                * { overflow-anchor: none; }
                #scroller { height: 120px; overflow: auto; }
                #inside { height: ${scrolledAway ? 150 : 0}px; }
                @media (max-width: 400px) {
                    ${scrolledAway ? '#outside { height: 650px; }' : '#inside { height: 150px; }'}
                }
            </style><div id="outside"></div><div id="scroller"><div id="inside"></div><p id="edited">Changed</p>
            <div style="height:500px"></div></div><div style="height:800px"></div>`);
            const scroller = after.querySelector('#scroller'), target = after.querySelector('#edited');
            const anchor = await frame.scrolling.restore(after, target);
            const targetVisible = () => {
                const { left, top } = target.getBoundingClientRect();
                return after.elementFromPoint(left + 10, top + 10) === target;
            };
            if (scrolledAway) scroller.scrollTop = 0;
            equal(targetVisible(), !scrolledAway, 'Set the real visibility inside the nested scrollport.');
            const win = after.defaultView;
            const pending = frame.scrolling.keepInView(anchor, {
                canvasTarget: () => ({ visible: true, reveal() {} }),
                whenSettled: () => {},
                canFollow: () => true,
            });
            win.frameElement.style.width = '390px';
            await pending;
            equal(targetVisible(), !scrolledAway, 'Honor nested clipping before and after reflow.');
            if (scrolledAway) {
                equal(win.scrollY, 0, 'Do not move the page back to a change the user left.');
                equal(scroller.scrollTop, 0, 'Do not override the nested scroll position either.');
            }
        });
    }
    for (const mode of ['hard clip', 'inner scrollport', 'limited scroll range', 'clip margin',
        'fixed header', 'transparent header', 'above the header', 'narrow header', 'wide target', 'wide target reflows', 'transparent ancestor']) {
        await check(`breakpoint following accounts for ${mode}`, async (frame, doc) => {
            const wide = mode === 'wide target' || mode === 'wide target reflows';
            const transparentHeader = mode === 'transparent header';
            const usesHeader = wide || transparentHeader || ['fixed header', 'above the header', 'narrow header'].includes(mode);
            const transparent = mode === 'transparent ancestor';
            const limited = mode === 'limited scroll range';
            const wrapsScrollable = limited || mode === 'inner scrollport';
            const spacerHeight = { 'clip margin': 125, 'wide target reflows': 520, 'transparent ancestor': 520 }[mode] ?? 170;
            const after = await doc(`<style>
                * { overflow-anchor: none; }
                #outside, #after { height: 650px; }
                #spacer { height: 0; }
                #edited { position: relative; height: 30px; ${mode === 'above the header' ? 'z-index: 2;' : ''} }
                #cover { display: none; }
                ${wide ? '#edited { width: 1000px; }' : ''}
                ${usesHeader || transparent ? '' : '#clip { display: flow-root; height: 120px; overflow: clip; }'}
                ${mode === 'clip margin' ? '#clip { overflow-clip-margin: 45px; }' : ''}
                ${wrapsScrollable ? '#inner { height: 120px; overflow: auto; }' : ''}
                @media (max-width: 400px) {
                    ${usesHeader ? '#cover { display: block; position: fixed; inset: 0 0 auto; height: 135px; background: white; z-index: 1; }' : ''}
                    ${transparentHeader ? '#cover { height: 180px; opacity: 0; }' : ''}
                    ${!usesHeader || mode === 'wide target reflows' ? `#spacer { height: ${spacerHeight}px; }` : ''}
                    ${transparent ? '#inner { opacity: 0; pointer-events: none; }' : ''}
                    ${mode === 'narrow header' ? '#cover { left: 80px; right: auto; width: 230px; }' : ''}
                    ${limited ? '#inner { margin-top: 105px; } #after { height: 0; }' : ''}
                }
            </style><div id="cover"></div><div id="outside"></div><div id="clip"><div id="inner"><div id="spacer"></div>
                <p id="edited">Changed</p><div id="after"></div></div></div><div style="height:800px"></div>`);
            const win = after.defaultView, target = after.querySelector('#edited');
            if (mode === 'clip margin' && !win.CSS.supports('overflow-clip-margin', '45px')) return;
            const targetVisible = () => {
                const { left, top } = target.getBoundingClientRect();
                return after.elementFromPoint(left + 10, top + 10) === target;
            };
            const anchor = await frame.scrolling.restore(after, target);
            equal(targetVisible(), true, 'The change was on screen before reflow.');
            const offset = win.scrollY;
            let reveals = 0;
            const scroll = target.scrollIntoView;
            target.scrollIntoView = function (options) { reveals++; return scroll.call(this, options); };
            const pending = frame.scrolling.keepInView(anchor, {
                canvasTarget: () => ({ visible: true, reveal() {} }),
                whenSettled: () => {},
                canFollow: () => true,
            });
            win.frameElement.style.width = '390px';
            await pending;
            if (transparentHeader) {
                const cover = after.querySelector('#cover');
                equal(win.getComputedStyle(cover).opacity, '0', 'The header is fully transparent.');
                equal(targetVisible(), false, 'A transparent header can still intercept the hit test.');
            } else {
                equal(targetVisible(), mode !== 'hard clip' && !limited && !transparent, 'Keep the target on screen only if it can be revealed.');
            }
            const shouldReveal = wide || mode === 'fixed header' || mode === 'inner scrollport';
            equal(reveals, Number(shouldReveal), 'Scroll only when needed and possible.');
            if (!shouldReveal) equal(win.scrollY, offset, 'Do not jump the page for this layout.');
            if (limited) equal(after.querySelector('#inner').scrollTop, 0, 'Do not try an inner scroll that cannot expose the target.');
        });
    }
    for (const scenario of ['moved', 'still visible', 'scrolled away', 'hidden', 'collapsed', 'replaced', 'invalidated',
        'moved across two quick switches', 'scrolled while the camera settled']) {
        await check(`viewport change when the follow target is ${scenario}`, async (frame, doc) => {
            const after = await doc(`<style>
                html { overflow-anchor: none; scroll-behavior: smooth; }
                #spacer { height: 700px; }
                @media (max-width: 400px) {
                    #spacer { height: ${scenario === 'still visible' ? 730 : 1400}px; }
                    ${scenario === 'hidden' ? '#edited { display: none; }' : ''}
                    ${scenario === 'collapsed' ? '#edited { height: 0; overflow: hidden; }' : ''}
                }
            </style><div id="spacer"></div><p id="edited">Changed</p><div style="height:900px"></div>`);
            const target = after.querySelector('#edited');
            const anchor = await frame.scrolling.restore(after, target);
            equal(anchor, target, 'Remember the element actually followed.');
            const win = after.defaultView;
            if (scenario === 'scrolled away') win.scrollTo({ top: 0, behavior: 'instant' });
            const offset = win.scrollY;
            let corrections = 0;
            const scroll = win.Element.prototype.scrollIntoView;
            win.Element.prototype.scrollIntoView = function (options) {
                corrections++;
                equal(this, target, 'Only the same DOM element can be followed again.');
                equal(options.behavior, 'instant', 'Do not start a second smooth animation on resize.');
                return scroll.call(this, options);
            };
            let eligible = true;
            const rapid = scenario === 'moved across two quick switches';
            const interrupted = scenario === 'scrolled while the camera settled';
            const options = {
                canvasTarget: () => ({ visible: true, reveal() {} }),
                whenSettled: () => interrupted ? new Promise((resolve) => win.setTimeout(() => {
                    win.scrollTo({ top: 0, behavior: 'instant' });
                    resolve();
                }, 20)) : undefined,
                canFollow: () => eligible,
            };
            const pending = frame.scrolling.keepInView(anchor, options);
            if (rapid) {
                win.frameElement.style.width = '400px';
                equal(target.getBoundingClientRect().top >= win.innerHeight, true, 'The intermediate breakpoint has already moved the target.');
            }
            const next = rapid ? frame.scrolling.keepInView(anchor, options) : null;
            win.frameElement.style.width = '390px';
            if (scenario === 'replaced') target.replaceWith(target.cloneNode(true));
            if (scenario === 'invalidated') eligible = false;
            await Promise.all([pending, next]);
            equal(win.innerWidth, 390, 'Use a real responsive breakpoint in the iframe.');
            const shouldReveal = rapid || scenario === 'moved';
            equal(corrections, Number(shouldReveal), 'Adjust only if the same target moved out of view without user intervention.');
            if (shouldReveal) {
                const { top, bottom } = target.getBoundingClientRect();
                equal(top >= 0 && bottom <= win.innerHeight, true, 'The moved element is back on screen.');
            } else {
                equal(win.scrollY, interrupted ? 0 : offset, 'Respect the last page scroll offset.');
            }
        });
    }
    await check('following requests smooth scrolling even when the theme does not', async (frame, doc) => {
        const after = await doc(content(), { reducedMotion: false });
        after.documentElement.style.scrollBehavior = 'auto';
        const target = after.querySelector('#edited');
        let behavior;
        const scroll = target.scrollIntoView;
        target.scrollIntoView = function (options) { behavior = options.behavior; return scroll.call(this, options); };
        await frame.scrolling.restore(after, target);
        equal(behavior, 'smooth', 'Request native smooth following rather than inheriting the theme setting.');
    });
    await check('reduced-motion following does not inherit author smooth scrolling', async (frame, doc) => {
        const after = await doc(content(), { reducedMotion: true });
        after.documentElement.style.scrollBehavior = 'smooth';
        const target = after.querySelector('#edited');
        let behavior;
        const scroll = target.scrollIntoView;
        target.scrollIntoView = function (options) { behavior = options.behavior; return scroll.call(this, options); };
        await frame.scrolling.restore(after, target);
        equal(behavior, 'instant', 'Request instant following when reduced motion is preferred.');
        if (after.defaultView.scrollY <= 0) throw new Error('The reduced-motion follow must be immediate.');
    });
    return results;
}

testInChromium('preview scrolling matches changed sections conservatively', async (t) => {
    const bundle = await browserBundle(t, new URL('./browser/preview-scroll.js', import.meta.url), 'previewScroll');
    await runChromiumTests(t, {
        head: `<script src="${bundle}"></script>`, script: `(${browserTests.toString()})()`, count: 573, virtualTimeBudget: 30000,
    });
});
