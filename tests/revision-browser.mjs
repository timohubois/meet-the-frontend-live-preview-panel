import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { previewSourceForVm } from './helpers/modules.mjs';
import { panelStrings } from './helpers/panel-strings.mjs';

const source = await previewSourceForVm(new URL('../src/screens/revision-browser.js', import.meta.url));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const url = (id) => `http://site.local/?preview=true&mtflpp_saved=1&mtflpp_revision=${id}&mtflpp_token=token-${id}`;
const revision = (id, address = url(id)) => ({
    id, get: (key) => ({ mtflppPreviewUrl: address, dateShort: `Date ${id}`, author: { name: `Author ${id}` } })[key],
});

function fixture({ visible = true, selected = revision(11), isolated = false, excludedSelectors = [], deferRestore = false } = {}) {
    const timers = new Map(), listeners = new Map(), events = new Map(), reports = [], allFrames = [], scrolls = [];
    const adjacent = [], classes = new Set(['mtflpp-launcher']);
    const attributes = new Map();
    const button = { setAttribute: (key, value) => attributes.set(key, value) };
    const container = {
        classList: { replace(from, to) { classes.delete(from); classes.add(to); } },
        append: (element) => assert.equal(element, button),
    };
    const doc = {
        getElementById: (id) => id === 'mtflpp-toggle' ? container : null,
        createElement: (tag) => { assert.equal(tag, 'button'); return button; },
    };
    const captures = [], comparisons = [], restorations = [], viewportChanges = [];
    let options, comparisonSelectors, nextTimer = 0, title = '', clears = 0, returned = 0;
    const children = [];
    const stage = {
        ownerDocument: {
            createElement() {
                const attributes = new Map();
                const frame = {
                    setAttribute: (name, value) => attributes.set(name, value),
                    removeAttribute: (name) => attributes.delete(name),
                    classList: { remove() {} },
                    remove() { const at = children.indexOf(frame); if (at !== -1) children.splice(at, 1); },
                };
                allFrames.push(frame);
                return frame;
            },
        },
        append: (frame) => children.push(frame),
    };
    const view = {
        stage, visible, followChanges: true,
        setVisible(value) { this.visible = value; },
        setTitle(value) { title = value; },
        report(text, state, detail) { reports.push({ text, state, ...detail }); },
        clearPreview() { children.splice(0); clears++; },
        returnToEditor() { returned++; },
    };
    const model = {
        get: (key) => key === 'to' ? selected : null,
        on: (event, callback) => listeners.set(event, callback),
        off: (event, callback) => { assert.equal(listeners.get(event), callback); listeners.delete(event); },
    };
    const context = {
        URL, console,
        window: { crossOriginIsolated: isolated, location: { origin: 'http://site.local' }, addEventListener: (event, callback) => events.set(event, callback) },
        setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
        clearTimeout: (id) => timers.delete(id),
        fetch() { throw new Error('Revision browsing must not fetch a write endpoint.'); },
    };
    const strings = {
        title: 'Revision preview', previewRevision: 'Preview revision', revisionLabel: '%1$s — %2$s', currentVersion: 'Current version',
        updating: 'Updating', current: 'Loaded', stale: 'Pending', unavailable: 'Unavailable',
        failed: 'Failed', originMismatch: panelStrings.originMismatch,
    };
    context.imports = {
        '../panel/window.js': { createPreviewPanel: (strings, callbacks) => {
            options = callbacks; title = callbacks.postTitle; return view;
        } },
        '../preview/scroll.js': { createPreviewScroll: () => ({
            remember: (doc) => scrolls.push(['remember', doc]),
            restore(doc, target, canFollow) {
                scrolls.push(['restore', doc, target]);
                const restoration = { doc, target, canFollow };
                restorations.push(restoration);
                if (deferRestore && target) return new Promise((resolve) => { restoration.resolve = resolve; });
                return target;
            },
            keepInView: (target, options) => viewportChanges.push({ target, ...options }),
        }) },
        '../preview/comparison.js': { createPreviewComparison: (selectors) => {
            comparisonSelectors = selectors;
            const values = new WeakMap();
            return {
                capture(doc, submitted) {
                    values.set(doc, submitted);
                    captures.push({ doc, values: submitted, containment: doc.documentElement.style.getPropertyValue('overscroll-behavior') });
                },
                findChange(previous, next) {
                    comparisons.push({ previous, next, before: values.get(previous), after: values.get(next),
                        previousMounted: children.some((frame) => frame.contentDocument === previous) });
                    return values.has(previous) && values.has(next) ? 'target' : null;
                },
            };
        } },
    };
    const init = vm.runInNewContext(`${source}\ninitRevisionPreview`, context);
    init({ postId: 1, currentPreviewUrl: url(1), strings, comparisonExcludedSelectors: excludedSelectors }, model, {
        ownerDocument: doc, after: (element) => adjacent.push(element),
    });
    return {
        view, options, adjacent, classes, attributes, container, button, reports, children, allFrames, timers, scrolls, captures, comparisons, restorations, comparisonSelectors, listeners,
        viewportChanges,
        get title() { return title; }, get clears() { return clears; }, get returned() { return returned; },
        get last() { return reports.at(-1); },
        select(next) { selected = next; listeners.get('update:revisions')?.(); },
        async runTimers(delay = 250) {
            for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
            await flush();
        },
        async load(frame = allFrames.at(-1), marked = true) {
            const declarations = new Map();
            frame.contentDocument = marked === null ? null : {
                querySelector: () => marked ? { content: new URL(frame.src).searchParams.get('mtflpp_token') } : null,
                documentElement: { style: {
                    setProperty: (name, value, priority) => declarations.set(name, { value, priority }),
                    getPropertyValue: (name) => declarations.get(name)?.value ?? '',
                    getPropertyPriority: (name) => declarations.get(name)?.priority ?? '',
                } },
            };
            frame.onload?.(); await flush();
        },
        hide: (persisted = false) => events.get('pagehide')({ persisted }),
    };
}

test('the revision launcher uses a native text button next to the return link', () => {
    const h = fixture({ visible: false });
    assert.equal(h.options.inlineLauncher, h.button);
    assert.equal(h.options.canRememberVisibility, false);
    assert.deepEqual(h.adjacent, [h.container]);
    assert.deepEqual([...h.classes], ['mtflpp-inline-launcher']);
    assert.equal(h.button.type, 'button');
    assert.equal(h.button.className, 'button-link');
    assert.equal(h.button.textContent, 'Preview revision');
    assert.equal(h.attributes.get('aria-controls'), 'mtflpp-panel');
});

test('revision selection intent follows accepted frames, not canceled selections or native navigation', async () => {
    const h = fixture();
    await h.load();
    assert.equal(h.captures[0].values.revision.type, 'selection');
    assert.equal(h.captures[0].values.revision.value, 11);
    h.select(revision(12)); await h.runTimers();
    const canceled = h.allFrames.at(-1).onload;
    h.select(revision(13)); await h.runTimers();
    canceled();
    await h.load();
    assert.deepEqual(h.captures.map((entry) => entry.values.revision.value), [11, 13]);
    assert.equal(h.comparisons[0].before.revision.value, 11);
    assert.equal(h.comparisons[0].after.revision.value, 13);
    await h.load();
    assert.equal(h.captures.at(-1).values, undefined, 'Native navigation cannot inherit the old selection hints.');
});

test('frame capture precedes comparison and deletion analysis runs before the old iframe is removed', async () => {
    const h = fixture();
    await h.load();
    const previous = h.children[0].contentDocument;
    h.select(revision(12));
    await h.runTimers();
    await h.load();
    const comparison = h.comparisons[0];
    assert.equal(comparison.previous, previous);
    assert.equal(comparison.previousMounted, true, 'Deletion evidence must still see the previous document.');
    assert.equal(comparison.before.revision.value, 11);
    assert.equal(comparison.after.revision.value, 12, 'The next baseline must exist before comparison.');
    const restored = h.scrolls.filter(([operation]) => operation === 'restore').at(-1);
    assert.deepEqual(restored, ['restore', comparison.next, 'target']);
    assert.equal(restored.length, 3, 'Scrolling still receives one identified element, not comparison state.');
    assert.equal(h.restorations.at(-1).canFollow(), true, 'The frame owns deferred reveal eligibility.');
    assert.equal(h.children.length, 1);
});

test('breakpoint following uses only the current iframe’s last revealed target', async () => {
    const h = fixture();
    const viewport = { canFollow: () => true };
    await h.load();
    h.options.beforeViewportChange(viewport);
    assert.equal(h.viewportChanges.length, 0, 'The baseline has not followed a target.');
    h.select(revision(12)); await h.runTimers(); await h.load();
    h.options.beforeViewportChange(viewport);
    const { target, canFollow } = h.viewportChanges[0];
    assert.equal(target, 'target');
    assert.equal(canFollow(), true);
    h.view.followChanges = false;
    assert.equal(canFollow(), false, 'Disabling following also cancels a pending check.');
    h.view.followChanges = true;
    const frame = h.children[0];
    frame.contentDocument = null;
    assert.equal(canFollow(), false, 'Native navigation invalidates the target even before load.');
    await h.load();
    h.options.beforeViewportChange(viewport);
    assert.equal(h.viewportChanges.length, 1, 'Native navigation does not carry a target forward.');
});

test('verified iframe scrolling is contained after capture on initial, replacement and native loads', async () => {
    const h = fixture();
    await h.load();
    h.select(revision(12)); await h.runTimers(); await h.load();
    await h.load();
    assert.equal(h.captures.length, 3);
    for (const { doc, containment } of h.captures) {
        assert.equal(containment, '', 'Capture the original root style before adding preview-only containment.');
        assert.equal(doc.documentElement.style.getPropertyValue('overscroll-behavior'), 'contain');
        assert.equal(doc.documentElement.style.getPropertyPriority('overscroll-behavior'), 'important');
    }
});

test('disabled following skips snapshots and comparison while preserving preview scrolling', async () => {
    const h = fixture({ visible: false });
    h.view.followChanges = false;
    h.options.onOpen(); await h.load();
    h.select(revision(12)); await h.runTimers(); await h.load();
    await h.load(); // Native iframe navigation must not create a snapshot either.
    assert.equal(h.captures.length, 0);
    assert.equal(h.comparisons.length, 0);
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').length, 2);
    assert.equal(h.last.state, 'ready');
    assert.equal(h.children[0].src, url(12));
    assert.equal(h.children[0].contentDocument.documentElement.style.getPropertyValue('overscroll-behavior'), 'contain');
    assert.equal(h.children[0].contentDocument.documentElement.style.getPropertyPriority('overscroll-behavior'), 'important');
});

test('the enable refresh establishes a fresh baseline before the first later revision selection', async () => {
    const h = fixture({ visible: false });
    h.view.followChanges = false;
    h.options.onOpen(); await h.load();
    h.select(revision(12)); await h.runTimers(); await h.load();
    const uncaptured = h.children[0].contentDocument;
    h.view.followChanges = true;
    h.options.onRefresh(false); await h.load();
    assert.equal(h.captures.length, 1);
    assert.equal(h.captures[0].values.revision.value, 12);
    assert.notEqual(h.captures[0].doc, uncaptured, 'Do not reconstruct the old baseline from runtime-mutated output.');
    assert.equal(h.comparisons.length, 0, 'Enabling establishes a baseline without following a change.');
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').at(-1)[2], undefined);
    h.select(revision(13)); await h.runTimers(); await h.load();
    assert.deepEqual(h.captures.map(({ values }) => values.revision.value), [12, 13]);
    assert.equal(h.comparisons[0].before.revision.value, 12);
    assert.equal(h.comparisons[0].after.revision.value, 13);
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').at(-1)[2], 'target');
});

test('an enable refresh preserves position even when the previous document already has a snapshot', async () => {
    const h = fixture(); await h.load();
    h.view.followChanges = false;
    h.view.followChanges = true;
    h.options.onRefresh(false); await h.load();
    assert.deepEqual(h.captures.map(({ values }) => values.revision.value), [11, 11]);
    assert.equal(h.comparisons.length, 0, 'A baseline refresh must not follow incidental frontend changes.');
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').at(-1)[2], undefined);
    h.select(revision(12)); await h.runTimers(); await h.load();
    assert.equal(h.comparisons[0].before.revision.value, 11);
    assert.equal(h.comparisons[0].after.revision.value, 12);
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').at(-1)[2], 'target');
});

test('toggling following without accepting disabled output keeps the current frozen baseline', async () => {
    const h = fixture(); await h.load();
    h.view.followChanges = false;
    h.view.followChanges = true;
    h.select(revision(12)); await h.runTimers(); await h.load();
    assert.equal(h.captures.length, 2);
    assert.equal(h.comparisons[0].before.revision.value, 11);
    assert.equal(h.comparisons[0].after.revision.value, 12);
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').at(-1)[2], 'target');
});

test('enabling following during a disabled load establishes a baseline even without captured source', async () => {
    const h = fixture({ visible: false });
    h.view.followChanges = false;
    h.options.onOpen(); await h.load();
    h.select(revision(12)); await h.runTimers();
    assert.equal(new URL(h.children.at(-1).src).searchParams.has('mtflpp_source'), false);
    h.view.followChanges = true;
    await h.load();
    assert.equal(h.captures.length, 1);
    assert.equal(h.captures[0].values.revision.value, 12);
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').at(-1)[2], null);
    h.select(revision(13)); await h.runTimers(); await h.load();
    assert.equal(h.comparisons.at(-1).before.revision.value, 12);
    assert.equal(h.comparisons.at(-1).after.revision.value, 13);
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').at(-1)[2], 'target');
});

test('disabling following during an initial load skips snapshots even when source was requested', async () => {
    const h = fixture();
    assert.equal(new URL(h.children[0].src).searchParams.get('mtflpp_source'), '1');
    h.view.followChanges = false;
    await h.load();
    assert.equal(h.captures.length, 0);
    assert.equal(h.comparisons.length, 0);
    assert.equal(h.last.state, 'ready');
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').length, 1);
});

test('a disabled replacement cannot reuse an earlier following baseline', async () => {
    const h = fixture(); await h.load();
    h.select(revision(12)); await h.runTimers();
    h.view.followChanges = false;
    await h.load();
    assert.equal(h.captures.length, 1, 'Do not snapshot the disabled replacement.');
    assert.equal(h.comparisons.length, 0);
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').at(-1)[2], undefined);
    h.view.followChanges = true;
    h.select(revision(13)); await h.runTimers(); await h.load();
    assert.equal(h.captures.length, 2);
    assert.equal(h.comparisons[0].before, undefined, 'The displayed uncaptured document has no comparison baseline.');
    assert.equal(h.scrolls.filter(([operation]) => operation === 'restore').at(-1)[2], null);
});

test('read-only comparison receives the complete PHP exclusion policy, including an empty list', () => {
    for (const excludedSelectors of [[], ['.vendor-runtime']]) {
        const h = fixture({ visible: false, excludedSelectors });
        assert.equal(h.comparisonSelectors, excludedSelectors);
    }
});

test('disabled change following leaves iframe navigation on the native preview URL', async () => {
    const h = fixture({ visible: false });
    h.view.followChanges = false;
    h.options.onOpen();
    assert.equal(h.children[0].src, url(11));
    await h.load();
    assert.equal(h.last.state, 'ready');
});

test('revision browsing loads the native To source without editor APIs or Web Locks', async () => {
    const h = fixture();
    assert.equal(h.children.length, 1);
    assert.equal(h.children[0].src, `${url(11)}&mtflpp_source=1`);
    await h.load();
    assert.equal(h.last.state, 'ready');
    assert.equal(h.last.hasPreview, true);
    assert.equal(h.title, 'Date 11 — Author 11');
    assert.equal(h.children[0].referrerPolicy, 'same-origin');
});

for (const isolated of [false, true]) {
    test(`preview documents opt into matching isolation only for isolated editors: ${isolated}`, async () => {
        const h = fixture({ isolated });
        const address = new URL(h.children[0].src);
        assert.equal(address.searchParams.get('mtflpp_isolated'), isolated ? '1' : null);
        assert.equal(address.searchParams.get('mtflpp_token'), 'token-11');
        assert.equal(address.searchParams.get('mtflpp_source'), '1');
        await h.load();
        assert.equal(h.last.state, 'ready');
    });
}

test('rapid slider changes cancel old loads, debounce and display only the latest revision', async () => {
    const h = fixture();
    const stale = h.children[0], oldLoad = stale.onload;
    h.select(revision(12)); h.select(revision(13)); h.select(revision(14));
    assert.equal(h.children.length, 0);
    oldLoad();
    assert.notEqual(h.last.state, 'ready');
    await h.runTimers();
    assert.equal(h.allFrames.length, 2);
    assert.equal(h.children[0].src, `${url(14)}&mtflpp_source=1`);
    await h.load();
    assert.equal(h.title, 'Date 14 — Author 14');
    assert.equal(h.timers.size, 0);
});

test('changing only the From side or comparison mode does not reload the To preview', async () => {
    const h = fixture(); await h.load();
    h.select(revision(11));
    await h.runTimers();
    assert.equal(h.allFrames.length, 1);
});

test('previous preview retains its identity while loading and after a failed replacement', async () => {
    const h = fixture(); await h.load();
    h.select(revision(12)); await h.runTimers();
    assert.equal(h.title, 'Date 11 — Author 11');
    h.allFrames.at(-1).onerror(); await flush();
    assert.equal(h.last.state, 'error');
    assert.equal(h.last.hasPreview, true);
    assert.equal(h.title, 'Date 11 — Author 11');
    h.options.onRetry(false); await h.load(); // The panel passes the takeover flag, not following intent.
    assert.equal(h.title, 'Date 12 — Author 12');
    assert.equal(h.comparisons.length, 1);
});

test('closing cancels pending loads; reopening uses the latest selection without touching visibility preferences', async () => {
    const h = fixture();
    h.options.onClose();
    assert.equal(h.view.visible, false);
    assert.equal(h.children.length, 0);
    assert.equal(h.timers.size, 0);
    h.select(revision(12)); await h.runTimers();
    assert.equal(h.allFrames.length, 1);
    h.options.onOpen(); await h.load();
    assert.equal(h.title, 'Date 12 — Author 12');
    assert.equal(h.view.visible, true);
});

test('remembered closed panels do not load until explicitly opened', async () => {
    const h = fixture({ visible: false });
    h.select(revision(12)); await h.runTimers();
    assert.equal(h.allFrames.length, 0);
    h.options.onOpen(); await h.load();
    assert.equal(h.children[0].src, `${url(12)}&mtflpp_source=1`);
});

test('only the actual parent entry uses the current saved-post URL', async () => {
    const h = fixture({ selected: revision(1, null) }); await h.load();
    assert.equal(h.children[0].src, `${url(1)}&mtflpp_source=1`);
    assert.equal(h.title, 'Current version — Date 1 — Author 1');
    h.select(revision(20, null)); await h.runTimers();
    assert.equal(h.children.length, 0);
    assert.equal(h.last.reason, 'unavailable');
    assert.equal(h.last.canRetry, false);
    assert.equal(h.last.canRefresh, false);
    assert.equal(h.last.hasPreview, false);
});

for (const [address, displayUrl] of [
    ['http://name:secret@other.example/news/page/?mtflpp_token=private-token&key=private-key#private-fragment', 'http://other.example/news/page/'],
    ['https://site.local/?mtflpp_token=token', 'https://site.local/'],
    ['http://site.local:8080/?mtflpp_token=token', 'http://site.local:8080/'],
]) {
    test(`revision preview explains a different address (${displayUrl}) without creating a frame`, async () => {
        const h = fixture({ selected: revision(11, address) }); await flush();
        assert.equal(h.allFrames.length, 0);
        assert.equal(h.last.state, 'error');
        assert.equal(h.last.reason, 'origin-mismatch');
        assert.equal(h.last.text, `WordPress provided this preview URL:\n${displayUrl}\n\nIt must use the same website address as the editor.`);
        assert.equal(h.last.canRetry, false);
        assert.equal(h.last.canRefresh, false);
    });
}

test('a revision from a different address leaves the last preview and its title intact', async () => {
    const h = fixture(); await h.load();
    const lastFrame = h.children[0];
    h.select(revision(12, 'https://other.example/?mtflpp_token=token')); await h.runTimers();
    assert.equal(h.allFrames.length, 1);
    assert.equal(h.children[0], lastFrame);
    assert.equal(h.title, 'Date 11 — Author 11');
    assert.equal(h.last.hasPreview, true);
    assert.equal(h.last.reason, 'origin-mismatch');
    h.select(revision(13)); await h.runTimers(); await h.load();
    assert.equal(h.last.state, 'ready');
    assert.equal(h.title, 'Date 13 — Author 13');
});

for (const [address, reason] of [
    ['not-a-url', ''],
    ['data:text/html,preview', 'unsupported-url'],
    ['file:///page.html', 'unsupported-url'],
    ['blob:http://site.local/preview?mtflpp_token=token', 'unsupported-url'],
]) {
    test(`an invalid revision preview URL does not claim an address mismatch (${address.split(':')[0]})`, async () => {
        const h = fixture({ selected: revision(11, address) }); await flush();
        assert.equal(h.allFrames.length, 0);
        assert.equal(h.last.state, 'error');
        assert.equal(h.last.reason, reason);
        assert.equal(h.last.text, 'Failed');
        assert.equal(h.last.canRetry, !reason);
        assert.equal(h.last.canRefresh, !reason);
    });
}

test('PiP adoption reloads the selected source and does not reopen a closed panel', async () => {
    const h = fixture(); await h.load();
    h.options.beforeMove(); assert.equal(h.children.length, 0);
    h.options.afterMove(); await h.load();
    assert.equal(h.children[0].src, `${url(11)}&mtflpp_source=1`);
    h.options.onClose(); h.options.afterMove();
    assert.equal(h.allFrames.length, 2);
});

for (const marked of [false, null]) {
    test(`${marked === null ? 'browser-native' : 'unmarked HTML'} output loads without HTML scroll enhancement`, async () => {
        const h = fixture(); await h.load(undefined, marked);
        assert.equal(h.last.state, 'ready');
        assert.equal(h.scrolls.length, 0);
        assert.equal(h.captures.length, 0);
        if (h.children[0].contentDocument) {
            assert.equal(h.children[0].contentDocument.documentElement.style.getPropertyValue('overscroll-behavior'), '');
        }
    });
}

test('a timed-out frame can be retried without accepting its stale load', async () => {
    const h = fixture();
    await h.runTimers(30000);
    assert.equal(h.last.state, 'error');
    assert.equal(h.children.length, 0);
    h.options.onRetry(); await h.load();
    assert.equal(h.last.state, 'ready');
});

for (const reason of ['selection', 'close', 'navigation', 'document replacement before load', 'follow disabled']) {
    test(`deferred reveal is no longer eligible after ${reason}`, async () => {
        const h = fixture({ deferRestore: true });
        await h.load();
        h.select(revision(12)); await h.runTimers(); await h.load();
        const pending = h.restorations.at(-1);
        assert.equal(pending.canFollow(), true);
        if (reason === 'selection') h.select(revision(13));
        if (reason === 'close') h.options.onClose();
        if (reason === 'navigation') await h.load();
        if (reason === 'document replacement before load') h.allFrames.at(-1).contentDocument = {};
        if (reason === 'follow disabled') h.view.followChanges = false;
        assert.equal(pending.canFollow(), false);
        const ready = h.reports.filter(({ state }) => state === 'ready').length;
        pending.resolve(); await flush();
        assert.equal(h.reports.filter(({ state }) => state === 'ready').length,
            ready + (reason === 'follow disabled' ? 1 : 0), 'Stale documents must not report ready after settling.');
    });
}

test('normal page exit detaches the native model listener, while bfcache preserves it', () => {
    const h = fixture();
    h.hide(true); assert.equal(h.listeners.size, 1);
    h.hide(false); assert.equal(h.listeners.size, 0);
    assert.equal(h.children.length, 0);
});
