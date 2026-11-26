import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import vm from 'node:vm';
import { BroadcastChannel, locks } from 'node:worker_threads';
import { sourceForVm } from './helpers/modules.mjs';
import { panelStrings } from './helpers/panel-strings.mjs';

const source = await sourceForVm(new URL('../src/preview/live-preview.js', import.meta.url));
const settle = () => new Promise(setImmediate);
let nextSite = 0;

// Use native lock queues and cross-context messages; only the panel and frame are fakes.
function fixture(t) {
    const endpoint = `/ownership-test-${process.pid}-${++nextSite}`;
    return ({
        site = endpoint, userId = 1, broadcast = true, pending = false, error, hasPreview = false, followChanges = true,
        excludedSelectors = [], prepare, frameError, holdFrame = false, secureContext = true,
    } = {}) => {
        const write = Promise.withResolvers(), started = Promise.withResolvers();
        const reports = [], timers = new Map();
        let delivery;
        const frames = { loads: 0, cancels: 0, clears: 0, accepts: 0, hasPreview,
            load(...args) {
                this.loads++;
                this.lastLoad = args;
                if (frameError) throw frameError;
                if (holdFrame) {
                    delivery = Promise.withResolvers();
                    return delivery.promise;
                }
            },
            async reveal() {
                const [, isCurrent, , , beforeReveal] = this.lastLoad;
                const frame = delivery;
                const pending = beforeReveal?.();
                if (pending) await pending;
                if (isCurrent()) this.accepts++;
                frame.resolve();
            },
            cancel() { this.cancels++; delivery?.resolve(); },
            clear() { this.clears++; delivery?.resolve(); },
        };
        let callbacks, channel, exit, comparisonSelectors, frameReport, writes = 0, now = 0;
        const view = { visible: true, followChanges, setTitle() {}, returnToEditor() {},
            setVisible(value) { this.visible = value; },
            report(text, state, details) { reports.push({ text, state, ...details }); },
        };
        const session = vm.runInNewContext(`"use strict";\n${source}\ncreateLivePreview`, {
            AbortController, navigator: { locks }, performance: { now: () => now },
            window: { isSecureContext: secureContext, addEventListener: (name, callback) => { exit = callback; },
                BroadcastChannel: broadcast ? class extends BroadcastChannel {
                    constructor(name) { super(name); channel = this; }
                } : undefined,
            },
            setTimeout(callback, delay) { timers.set(callback, now + delay); return callback; },
            clearTimeout: (callback) => timers.delete(callback),
            imports: {
                '../panel/window.js': { createPreviewPanel: (strings, options) => { callbacks = options; return view; } },
                '../preview/scroll.js': { createPreviewScroll: () => ({}) },
                '../preview/frame.js': { createPreviewFrame: (view, scrolling, strings, report, selectors) => {
                    comparisonSelectors = selectors; frameReport = report; return frames;
                } },
            },
        })({ endpoint: site, postId: 12, userId, available: true, strings: panelStrings, comparisonExcludedSelectors: excludedSelectors }, {
            idle: Promise.resolve(), saving: false,
            preparePreview() {
                writes++; started.resolve();
                if (prepare) return prepare();
                return write.promise.then((result) => {
                    if (error) throw error;
                    return result;
                });
            },
        });
        if (!pending) write.resolve({ url: '/preview' });
        t.after(async () => {
            callbacks.onClose();
            write.resolve({ url: '/preview' });
            exit?.({ persisted: false });
            await session.pending;
            await settle();
        });
        return { session, callbacks, channel, view, reports, timers, frames, comparisonSelectors, started: started.promise,
            advance(ms) {
                now += ms;
                for (const [callback, deadline] of [...timers]) if (deadline <= now && timers.delete(callback)) callback();
            },
            frameReady: () => frameReport('', 'ready'),
            release: () => write.resolve({ url: '/preview' }), get writes() { return writes; },
        };
    };
}

test('only accepted preview generations pass their own input hints to frame loading', { timeout: 5000 }, async (t) => {
    const old = Promise.withResolvers();
    const oldValues = { content: { type: 'html', value: '<p>Old submission</p>' } };
    const newValues = { content: { type: 'html', value: '<p>Latest submission</p>' } };
    let writes = 0;
    const h = fixture(t)({ prepare: () => ++writes === 1 ? old.promise
        : Promise.resolve({ url: '/latest', comparisonValues: newValues }) });
    h.session.start();
    await h.started;
    h.session.changed();
    h.advance(100);
    old.resolve({ url: '/stale', comparisonValues: oldValues });
    await h.session.pending;
    assert.equal(h.frames.loads, 0, 'A completed but stale write cannot establish the displayed baseline.');
    h.advance(174);
    assert.equal(h.session.pending, null, 'An early write completion must still respect the latest edit deadline.');
    h.advance(1);
    await h.session.pending;
    assert.equal(h.frames.loads, 1);
    assert.equal(h.frames.lastLoad[0], '/latest');
    assert.equal(h.frames.lastLoad[3], newValues);
});

for (const matches of [true, false]) {
    test(`a native commit followed by a companion signal ${matches ? 'keeps an identical' : 'rejects a stale'} candidate at the edit deadline`, async (t) => {
        let checks = 0;
        const h = fixture(t)({holdFrame: true, prepare: () => Promise.resolve({
            url: '/preview', stillMatches: () => { checks++; return matches; },
        })});
        h.session.start();
        await h.started;
        await settle();
        assert.equal(h.frames.loads, 1);
        h.session.recheck();
        h.advance(25);
        h.session.relatedChange();
        assert.equal(checks, 0, 'Do not read form state during capture-phase event dispatch.');
        const pending = h.session.pending;
        const reveal = h.frames.reveal();
        await settle();
        assert.equal(h.frames.accepts, 0, 'A loaded iframe must wait for the check before becoming visible.');
        h.advance(274);
        assert.equal(checks, 0, 'Let late related updates settle until the existing edit deadline.');
        assert.equal(h.writes, 1);
        h.advance(1);
        await reveal;
        await pending;
        assert.equal(checks, 1);
        assert.equal(h.frames.accepts, matches ? 1 : 0);
        await settle();
        assert.equal(h.writes, matches ? 1 : 2);
    });
}

test('a companion signal without a pending native commit still invalidates the frame', async (t) => {
    let checks = 0;
    const h = fixture(t)({holdFrame: true, prepare: () => Promise.resolve({
        url: '/preview', stillMatches: () => { checks++; return true; },
    })});
    h.session.start();
    await h.started;
    await settle();
    const current = h.frames.lastLoad[1];
    h.session.relatedChange();
    assert.equal(current(), false);
    assert.equal(h.reports.at(-1).state, 'stale');
    h.advance(275);
    await settle();
    assert.equal(checks, 0);
    assert.equal(h.writes, 2);
    await h.frames.reveal();
    await h.session.pending;
});

test('a manual refresh supersedes a pending commit check', async (t) => {
    let checks = 0;
    const h = fixture(t)({holdFrame: true, prepare: () => Promise.resolve({
        url: '/preview', stillMatches: () => { checks++; return true; },
    })});
    h.session.start();
    await h.started;
    await settle();
    h.session.recheck();
    const priorReveal = h.frames.reveal();
    h.callbacks.onRefresh();
    await priorReveal;
    await settle();
    assert.equal(h.writes, 2);
    assert.equal(h.frames.accepts, 0, 'The manual request supersedes the waiting frame.');
    assert.equal(checks, 0);
    await h.frames.reveal();
    await h.session.pending;
    assert.equal(h.frames.accepts, 1);
});

test('an expired edit deadline starts the newest write as soon as the current write drains', async (t) => {
    const h = fixture(t)({ pending: true });
    h.session.start(); await h.started;
    h.session.changed();
    h.advance(300); await settle();
    assert.equal(h.writes, 1, 'An expired timer cannot start a concurrent write.');
    const first = h.session.pending;
    h.release(); await first; await h.session.pending;
    assert.equal(h.writes, 2, 'No second debounce is needed after the first write drains.');
    assert.equal(h.frames.loads, 1);
    assert.equal(h.timers.size, 0);
});

test('each edit restarts the debounce, but manual refresh does not wait for it', async (t) => {
    const h = fixture(t)();
    h.session.start(); await h.started; await h.session.pending;
    h.session.changed();
    h.advance(200);
    h.session.changed();
    h.advance(274);
    assert.equal(h.session.pending, null);
    h.advance(1);
    await h.session.pending;
    assert.equal(h.writes, 2, 'Only the last edit starts a write.');

    h.session.changed();
    h.callbacks.onRefresh(); await h.session.pending;
    assert.equal(h.writes, 3, 'An explicit refresh runs without advancing the clock.');
    h.advance(275);
    assert.equal(h.session.pending, null, 'Manual refresh consumes the pending edit.');
});

test('manual refresh requested during a write runs as soon as that write drains', async (t) => {
    const h = fixture(t)({ pending: true });
    h.session.start(); await h.started;
    const first = h.session.pending;
    h.callbacks.onRefresh();
    assert.equal(h.session.pending, first, 'The current write must be allowed to finish.');
    h.release(); await first; await h.session.pending;
    assert.equal(h.writes, 2, 'Explicit refresh runs next without advancing the clock.');
    assert.equal(h.frames.loads, 1);
});

test('pausing cancels an expired edit deadline even if a write is still draining', async (t) => {
    const h = fixture(t)({ pending: true });
    h.session.start(); await h.started;
    h.session.changed();
    h.advance(300);
    const drain = h.session.pause();
    assert.ok(drain, 'Pause still exposes the ongoing write.');
    h.release(); await drain; await h.session.pending;
    h.advance(275);
    assert.equal(h.writes, 1);
    assert.equal(h.frames.loads, 0);
});

for (const failedEdit of [false, true]) {
    test(`the enable refresh seeds the live baseline without following, after ${failedEdit ? 'a failed edit' : 'a ready preview'}`, async (t) => {
        let text = 'Current preview', attempts = 0;
        const h = fixture(t)({ hasPreview: true, followChanges: false, prepare: () => {
            if (++attempts === 2 && failedEdit) throw new Error('Temporary preview failure');
            return Promise.resolve({ url: '/preview', comparisonValues: { content: { type: 'text', value: text } } });
        } });
        const update = async () => {
            h.advance(275);
            await h.session.pending;
        };
        h.session.start(); await h.started; await h.session.pending;
        h.frameReady();
        if (failedEdit) {
            h.session.changed(); await update();
            assert.equal(h.reports.at(-1).state, 'error');
            assert.equal(h.reports.at(-1).canRefresh, true);
        }
        h.view.followChanges = true;
        const before = h.writes;
        h.callbacks.onRefresh(false); await h.session.pending;
        assert.equal(h.writes, before + 1, 'Enabling uses one normal preview refresh.');
        assert.equal(h.frames.lastLoad[2](), false, 'A baseline refresh must not inherit old edit-following intent.');
        assert.equal(h.frames.lastLoad[3].content.value, 'Current preview');
        assert.equal(h.timers.size, 0, 'Do not queue another refresh after the baseline succeeds.');
        h.frameReady();
        text = 'First edit after the baseline is ready';
        h.session.changed(); await update();
        assert.equal(h.frames.lastLoad[2](), true, 'The first subsequent edit can follow normally.');
        assert.equal(h.frames.lastLoad[3].content.value, text);
    });
}

test('live comparison receives the complete PHP exclusion policy, including an empty list', async (t) => {
    const open = fixture(t);
    for (const excludedSelectors of [[], ['.vendor-runtime']]) {
        const h = open({ excludedSelectors });
        assert.equal(h.comparisonSelectors, excludedSelectors);
    }
});

for (const hasPreview of [false, true]) {
    test(`an edit lock pauses ${hasPreview ? 'a retained preview' : 'an initial preview'} until WordPress takeover reloads the editor`, { timeout: 5000 }, async (t) => {
        const open = fixture(t);
        const error = Object.assign(new Error('Take over editing to continue.'), { code: 'mtflpp_post_locked' });
        const h = open({ error, hasPreview });
        h.session.start(); await h.started; await h.session.pending; await settle();
        const report = h.reports.at(-1);
        assert.equal(report.state, 'paused');
        assert.equal(report.reason, 'post-locked');
        assert.equal(report.text, error.message);
        assert.equal(report.canRetry, false);
        assert.equal(report.canRefresh, false);
        assert.equal(report.hasPreview, hasPreview);
        assert.ok(h.frames.cancels > 0);
        assert.equal(h.frames.clears, 0, 'Keep the last good frame instead of clearing it.');
        h.session.changed();
        assert.equal(h.timers.size, 0, 'Edits must not keep retrying while WordPress holds the lock.');
        assert.equal(h.writes, 1);

        const other = open({ userId: 2 });
        other.session.start(); await other.started;
        assert.equal(other.writes, 1, 'Pausing must release local preview ownership.');
        other.callbacks.onClose(); await other.session.pending; await settle();

        h.callbacks.onClose(); // The old document is discarded by WordPress’s native takeover navigation.
        const reloaded = open();
        reloaded.session.start(); await reloaded.started; await reloaded.session.pending;
        assert.equal(reloaded.writes, 1, 'The reloaded editor must start its open preview without a manual retry.');
        assert.equal(reloaded.frames.loads, 1);
        assert.equal(h.writes, 1, 'The previous locked session must remain stopped.');
    });
}

for (const [code, reason, detail] of [
    ['mtflpp_preview_origin_mismatch', 'origin-mismatch', panelStrings.originMismatch.replace('%s', 'https://other.example/news/page/')],
    ['mtflpp_preview_unsupported_url', 'unsupported-url', panelStrings.failed],
]) {
    test(`a blocked preview URL stops live updates without clearing the last preview (${reason})`, { timeout: 5000 }, async (t) => {
        const open = fixture(t);
        const frameError = Object.assign(new Error(detail), { code });
        const h = open({ frameError, hasPreview: true });
        h.session.start(); await h.started; await h.session.pending; await settle();
        const report = h.reports.at(-1);
        assert.equal(report.state, 'error');
        assert.equal(report.reason, reason);
        assert.equal(report.text, detail);
        assert.equal(report.canRetry, false);
        assert.equal(report.canRefresh, false);
        assert.equal(report.hasPreview, true);
        assert.equal(h.frames.clears, 0);
        h.session.changed();
        assert.equal(h.timers.size, 0);
        const next = open(); next.session.start(); await next.started;
        assert.equal(next.writes, 1, 'The blocked preview must release preview ownership.');
    });
}

test('an insecure editor still receives browser guidance rather than an address mismatch', (t) => {
    const h = fixture(t)({ secureContext: false });
    h.session.start();
    assert.equal(h.reports.at(-1).reason, 'browser');
    assert.equal(h.reports.at(-1).text, panelStrings.browser);
    assert.equal(h.writes, 0);
});

for (const broadcast of [false, true]) {
    test(`a refused lock never starts writes, with messaging=${broadcast}`, { timeout: 5000 }, async (t) => {
        const open = fixture(t), owner = open(), other = open({ broadcast });
        owner.session.start(); await owner.started;
        other.session.start(); await settle();
        assert.equal(other.writes, 0);
        assert.equal(other.reports.at(-1).reason, broadcast ? 'other-tab' : 'manual');
    });
}

test('users contend for the same post, while separate sites do not', { timeout: 5000 }, async (t) => {
    const open = fixture(t), owner = open(), otherUser = open({ userId: 2 }), otherSite = open({ site: '/another-site' });
    owner.session.start(); await owner.started;
    otherUser.session.start(); otherSite.session.start(); await otherSite.started;
    assert.equal(otherUser.writes, 0);
    assert.equal(otherSite.writes, 1);
});

for (const takeover of [false, true]) {
    test(`${takeover ? 'cooperative handover' : 'closing'} retains ownership until the write drains`, { timeout: 5000 }, async (t) => {
        const open = fixture(t), owner = open({ broadcast: takeover, pending: true }), other = open();
        owner.session.start(); await owner.started;
        other.session.start(); await settle();
        const message = takeover ? once(owner.channel, 'message') : Promise.resolve();
        other.callbacks.onRetry(true);
        if (!takeover) owner.callbacks.onClose();
        await message; await settle();
        assert.equal(other.writes, 0, 'A second tab must not write while the old PHP operation is pending.');
        if (takeover) assert.equal(owner.reports.at(-1).reason, 'handed-off');
        owner.release(); await other.started;
        assert.equal(other.writes, 1);
        assert.equal(owner.writes, 1, 'The previous owner must not resume after handover.');
    });
}

for (const cancel of ['close', 'timeout']) {
    test(`${cancel} cancels a queued takeover without stealing or writing later`, { timeout: 5000 }, async (t) => {
        const open = fixture(t), owner = open({ broadcast: false }), other = open();
        owner.session.start(); await owner.started;
        other.callbacks.onRetry(true); other.callbacks.onRetry(true); await settle();
        assert.equal((await locks.query()).pending.length, 1, 'Repeated clicks queue only one takeover.');
        if (cancel === 'close') other.callbacks.onClose();
        else [...other.timers].find(([, delay]) => delay === 15000)[0]();
        await settle();
        assert.equal(other.timers.size, 0, 'Cancellation must finish and clear its timeout.');
        assert.equal(owner.writes, 1, 'Cancelling must leave the current owner alone.');
        if (cancel === 'timeout') assert.equal(other.reports.at(-1).reason, 'busy');
        owner.callbacks.onClose(); await settle();
        const next = open(); next.session.start(); await next.started;
        assert.equal(other.writes, 0, 'An obsolete request must never acquire ownership later.');
    });
}
