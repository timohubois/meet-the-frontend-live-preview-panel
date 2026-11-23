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
        excludedSelectors = [], prepare, frameError, secureContext = true,
    } = {}) => {
        const write = Promise.withResolvers(), started = Promise.withResolvers();
        const reports = [], timers = new Map();
        const frames = { loads: 0, cancels: 0, clears: 0, hasPreview,
            load(...args) {
                this.loads++;
                this.lastLoad = args;
                if (frameError) throw frameError;
            },
            cancel() { this.cancels++; }, clear() { this.clears++; },
        };
        let callbacks, channel, exit, comparisonSelectors, frameReport, writes = 0;
        const view = { visible: true, followChanges, setTitle() {}, returnToEditor() {},
            setVisible(value) { this.visible = value; },
            report(text, state, details) { reports.push({ text, state, ...details }); },
        };
        const session = vm.runInNewContext(`"use strict";\n${source}\ncreateLivePreview`, {
            AbortController, navigator: { locks },
            window: { isSecureContext: secureContext, addEventListener: (name, callback) => { exit = callback; },
                BroadcastChannel: broadcast ? class extends BroadcastChannel {
                    constructor(name) { super(name); channel = this; }
                } : undefined,
            },
            setTimeout(callback, delay) { timers.set(callback, delay); return callback; },
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
    old.resolve({ url: '/stale', comparisonValues: oldValues });
    await h.session.pending;
    assert.equal(h.frames.loads, 0, 'A completed but stale write cannot establish the displayed baseline.');
    for (const [callback, delay] of [...h.timers]) if (delay === 1000) {
        h.timers.delete(callback);
        callback();
    }
    await h.session.pending;
    assert.equal(h.frames.loads, 1);
    assert.equal(h.frames.lastLoad[0], '/latest');
    assert.equal(h.frames.lastLoad[3], newValues);
});

for (const failedEdit of [false, true]) {
    test(`the enable refresh seeds the live baseline without following, after ${failedEdit ? 'a failed edit' : 'a ready preview'}`, async (t) => {
        let text = 'Current preview', attempts = 0;
        const h = fixture(t)({ hasPreview: true, followChanges: false, prepare: () => {
            if (++attempts === 2 && failedEdit) throw new Error('Temporary preview failure');
            return Promise.resolve({ url: '/preview', comparisonValues: { content: { type: 'text', value: text } } });
        } });
        const update = async () => {
            for (const [callback, delay] of [...h.timers]) if (delay === 1000) {
                h.timers.delete(callback);
                callback();
            }
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
        const error = Object.assign(new Error('Take over editing to continue.'), { code: 'aflpp_post_locked' });
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
    ['aflpp_preview_origin_mismatch', 'origin-mismatch', panelStrings.originMismatch.replace('%s', 'https://other.example')],
    ['aflpp_preview_unsupported_url', 'unsupported-url', panelStrings.failed],
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
