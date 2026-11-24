import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createPreviewViewport } from '../src/panel/viewport.js';
import { sourceForVm } from './helpers/modules.mjs';
import { runChromiumTests, withChromiumPage } from './helpers/chromium.mjs';

function fixture(saved = {}, width = 480, height = 248, motion = false, scrollbar = 0, dpr = 1, onChange) {
    const observers = [], frames = new Map();
    let nextFrame = 0;
    function makeWindow(name) {
        const mediaQueries = [], resizeListeners = new Set();
        return {
            devicePixelRatio: dpr, mediaQueries, resizeListeners,
            addEventListener(type, callback) { if (type === 'resize') resizeListeners.add(callback); },
            removeEventListener(type, callback) { if (type === 'resize') resizeListeners.delete(callback); },
            resize() { for (const callback of [...resizeListeners]) callback(); },
            setPixelRatio(value) {
                this.devicePixelRatio = value;
                for (const query of [...mediaQueries]) if (query.media.startsWith('(resolution:')) {
                    for (const callback of [...query.listeners]) callback();
                }
            },
            performance: { now: () => 0 },
            requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
            cancelAnimationFrame(id) { frames.delete(id); },
            matchMedia(media) {
                const listeners = new Set();
                const query = {
                    media, matches: motion, listeners,
                    addEventListener(type, callback) { if (type === 'change') listeners.add(callback); },
                    removeEventListener(type, callback) { if (type === 'change') listeners.delete(callback); },
                };
                mediaQueries.push(query);
                return query;
            },
            ResizeObserver: class {
                constructor(callback) { this.window = name; this.callback = callback; observers.push(this); }
                observe(element) { this.element = element; this.connected = true; }
                disconnect() { this.connected = false; }
            },
        };
    }
    const mainWindow = makeWindow('editor'), pipWindow = makeWindow('pip');
    const canvas = {
        style: {}, scrollTop: 0, scrollLeft: 0,
        get clientWidth() { return container.clientWidth - (this.style.overflowY === 'scroll' ? scrollbar : 0); },
        get clientHeight() { return container.clientHeight - (this.style.overflowX === 'scroll' ? scrollbar : 0); },
    };
    const space = { style: {} };
    const container = {
        ownerDocument: { defaultView: mainWindow }, clientWidth: width, clientHeight: height,
        querySelector: (selector) => selector === '.mtflpp-canvas' ? canvas : space,
    };
    const stage = { style: {} }, dimensions = { textContent: '' };
    const readout = { dataset: {}, querySelector: () => dimensions };
    const viewport = createPreviewViewport(container, stage, readout, saved, onChange);
    viewport.layout();
    return {
        viewport, container, canvas, space, stage, dimensions, observers, mainWindow, pipWindow, frames,
        advance(time) {
            const id = [...frames.keys()].at(-1), callback = frames.get(id);
            frames.delete(id);
            callback(time);
        },
    };
}

const views = [
    { device: 'desktop', label: 'Desktop', width: 1280, height: 800 },
    { device: 'tablet', label: 'Tablet', width: 768, height: 1024 },
    { device: 'tablet', label: 'Tablet', tabletOrientation: 'landscape', width: 1024, height: 768 },
    { device: 'mobile', label: 'Phone', width: 390, height: 844 },
    { device: 'mobile', label: 'Phone', mobileOrientation: 'landscape', width: 844, height: 390 },
];
const fits = ['automatic', 'window', 'width', 'custom'];
const expectedScale = (fit, aw, ah, width, height, dpr = 1) => {
    if (fit === 'custom') return 1 / dpr;
    const widthFirst = fit === 'width';
    return Math.min(fit === 'automatic' ? 1 / dpr : Infinity, aw / width, widthFirst ? Infinity : ah / height);
};

for (const [name, width, height] of [['floating', 480, 248], ['expanded', 1240, 636], ['fullscreen', 1280, 708], ['PiP', 640, 448]]) {
    for (const view of views) for (const fit of fits) for (const dpr of [0.75, 1, 1.25, 2]) {
        test(`${name}: ${view.width}×${view.height}, ${fit}, DPR ${dpr} zoom with fixed geometry`, () => {
            const h = fixture({ ...view, fit }, width, height, false, 0, dpr);
            const scale = expectedScale(fit, width, height, view.width, view.height, dpr);
            const top = Math.max(0, (height - view.height * scale) / 2);
            assert.equal(h.stage.style.width, `${view.width}px`);
            assert.equal(h.stage.style.height, `${view.height}px`);
            assert.equal(h.stage.style.transform, `scale(${scale})`);
            assert.equal(h.stage.style.left, `${Math.max(0, (width - view.width * scale) / 2)}px`);
            assert.equal(h.stage.style.top, `${top}px`);
            assert.equal(h.space.style.width, `${Math.max(width, view.width * scale)}px`);
            assert.equal(h.space.style.height, `${Math.max(height, top + view.height * scale)}px`);
            const navigable = ['width', 'custom'].includes(fit);
            assert.equal(h.canvas.tabIndex, navigable && (view.height * scale > height + 0.01 || view.width * scale > width + 0.01) ? 0 : -1);
            assert.equal(h.dimensions.textContent, `${view.label} (${view.width} × ${view.height}) · ${h.viewport.zoomPercent}%`);
            assert.equal(h.viewport.zoomPercent, Math.round(scale * dpr * 100));
        });
    }
}

for (const dpr of [0.75, 1, 1.25, 2]) {
    test(`fixed 80% remains 80% at DPR ${dpr}, through resizing, device changes and rotation`, () => {
        const h = fixture({ device: 'mobile' }, 900, 1200, false, 15, dpr);
        h.viewport.setZoom(80);
        assert.equal(h.viewport.fit, 'custom');
        assert.equal(h.viewport.customZoom, 80);
        assert.equal(h.viewport.zoomPercent, 80);
        assert.equal(h.stage.style.transform, `scale(${0.8 / dpr})`);
        h.container.clientWidth = 240;
        h.container.clientHeight = 180;
        h.viewport.layout();
        assert.equal(h.stage.style.transform, `scale(${0.8 / dpr})`, 'Do not silently shrink manual zoom.');
        assert.equal(h.stage.style.width, '390px');
        assert.equal(h.stage.style.height, '844px');
        assert.equal(h.canvas.tabIndex, 0);
        h.viewport.rotate();
        assert.equal(h.stage.style.width, '844px');
        assert.equal(h.stage.style.height, '390px');
        h.viewport.select('desktop');
        assert.equal(h.viewport.zoomPercent, 80);
        assert.equal(h.stage.style.width, '1280px');
        assert.equal(h.stage.style.height, '800px');
    });
}

test('fixed zoom reserves both native gutters when one scrollbar creates overflow on the other axis', () => {
    const h = fixture({ fit: 'custom', customZoom: 40 }, 520, 300, false, 15);
    assert.equal(h.canvas.style.overflowX, 'scroll');
    assert.equal(h.canvas.style.overflowY, 'scroll');
    assert.equal(h.canvas.clientWidth, 505);
    assert.equal(h.canvas.clientHeight, 285);
    assert.equal(h.space.style.width, '512px');
    assert.equal(h.space.style.height, '320px');
    assert.equal(h.canvas.tabIndex, 0);
    h.container.clientWidth = 900;
    h.container.clientHeight = 700;
    h.viewport.layout();
    assert.equal(h.canvas.style.overflowX, 'hidden');
    assert.equal(h.canvas.style.overflowY, 'hidden');
    assert.equal(h.canvas.tabIndex, -1);
});

test('manual zoom preserves logical canvas navigation on both axes and resets it for fitting changes', () => {
    const h = fixture({ fit: 'custom', customZoom: 100 }, 480, 248);
    h.canvas.scrollLeft = 200;
    h.canvas.scrollTop = 300;
    h.viewport.setZoom(80);
    assert.equal(h.canvas.scrollLeft, 160);
    assert.equal(h.canvas.scrollTop, 240);
    h.container.clientWidth = 600;
    h.viewport.layout();
    assert.equal(h.canvas.scrollLeft, 160);
    assert.equal(h.canvas.scrollTop, 240);
    h.mainWindow.setPixelRatio(2);
    assert.equal(h.canvas.scrollLeft, 80);
    assert.equal(h.canvas.scrollTop, 120);
    assert.equal(h.viewport.zoomPercent, 80);
    h.viewport.setFit('window');
    assert.equal(h.canvas.scrollLeft, 0);
    assert.equal(h.canvas.scrollTop, 0);
    assert.equal(h.canvas.tabIndex, -1);
    assert.equal(h.viewport.customZoom, 80, 'Fitting keeps the custom value for later reuse.');
});

test('fixed 100% can overflow both axes while Auto limits the width, without changing the internal viewport', () => {
    const h = fixture({ device: 'mobile' }, 240, 248);
    assert.ok(h.viewport.zoomPercent < 100);
    h.viewport.setZoom(100);
    assert.equal(h.viewport.fit, 'custom');
    assert.equal(h.viewport.zoomPercent, 100);
    assert.equal(h.stage.style.transform, 'scale(1)');
    assert.equal(h.canvas.tabIndex, 0);
    assert.equal(h.stage.style.height, '844px');
    h.viewport.setFit('automatic');
    assert.ok(h.viewport.zoomPercent < 100);
    assert.equal(h.stage.style.height, '844px');
});

test('manual zoom validates saved and new values without coercion or silent clamping', () => {
    for (const value of [undefined, null, {}, '80', 0, 9, 401, NaN, Infinity, 80.5]) {
        const h = fixture({ fit: 'custom', customZoom: value });
        assert.equal(h.viewport.customZoom, 100);
        h.viewport.setZoom(80);
        h.viewport.setZoom(value);
        assert.equal(h.viewport.customZoom, 80);
        assert.equal(h.viewport.zoomPercent, 80);
    }
    for (const value of [10, 400]) {
        const h = fixture({ fit: 'custom', customZoom: value });
        assert.equal(h.viewport.zoomPercent, value);
    }
});

test('computed zoom and DPR notify controls only when their displayed values change', () => {
    let changes = 0;
    const h = fixture({}, 480, 248, false, 0, 1, () => changes++);
    assert.equal(changes, 1);
    h.viewport.layout();
    assert.equal(changes, 1);
    h.container.clientHeight = 300;
    h.viewport.layout();
    assert.equal(h.viewport.zoomPercent, 38);
    assert.equal(changes, 2);
    h.mainWindow.setPixelRatio(2);
    assert.equal(h.viewport.zoomPercent, 75);
    assert.equal(changes, 3);
    assert.equal(h.viewport.dpr, 2);
});

test('fixed percentage uses the displaying PiP window DPR and rebinds on return', () => {
    const h = fixture({ device: 'mobile', fit: 'custom', customZoom: 80 }, 900, 1200, false, 0, 1);
    h.viewport.beforeMove();
    h.pipWindow.devicePixelRatio = 2;
    h.container.ownerDocument = { defaultView: h.pipWindow };
    h.viewport.afterMove();
    assert.equal(h.viewport.dpr, 2);
    assert.equal(h.stage.style.transform, 'scale(0.4)');
    assert.equal(h.viewport.zoomPercent, 80);
    h.viewport.beforeMove();
    h.container.ownerDocument = { defaultView: h.mainWindow };
    h.viewport.afterMove();
    assert.equal(h.viewport.dpr, 1);
    assert.equal(h.stage.style.transform, 'scale(0.8)');
    assert.equal(h.viewport.zoomPercent, 80);
});

test('Automatic is the default and allows blank canvas on all four sides without upscaling', () => {
    const h = fixture({ device: 'mobile' }, 900, 1200);
    assert.equal(h.viewport.fit, 'automatic');
    assert.equal(h.stage.style.transform, 'scale(1)');
    assert.equal(h.stage.style.left, '255px');
    assert.equal(h.stage.style.top, '178px');
    assert.equal(h.stage.style.width, '390px');
    assert.equal(h.stage.style.height, '844px');
    assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
    assert.equal(h.viewport.zoomPercent, 100);
});

test('Automatic corrects DPR before deciding whether a 1:1 mobile viewport fits', () => {
    const h = fixture({ device: 'mobile' }, 900, 744, false, 0, 2);
    assert.equal(h.stage.style.transform, 'scale(0.5)');
    assert.equal(h.stage.style.width, '390px');
    assert.equal(h.stage.style.height, '844px');
    assert.equal(h.stage.style.left, '352.5px');
    assert.equal(h.stage.style.top, '161px');
    assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
    assert.equal(h.viewport.zoomPercent, 100);
});

for (const [device, orientation, scale, percent, overflow] of [
    ['mobile', 'portrait', 300 / 844, 71, false],
    ['tablet', 'portrait', 300 / 1024, 59, false],
    ['desktop', 'landscape', 440 / 1280, 69, false],
    ['tablet', 'landscape', 300 / 768, 78, false],
    ['mobile', 'landscape', 0.5, 100, false],
]) test(`Auto fits the whole ${device} ${orientation} viewport without canvas navigation`, () => {
    const h = fixture({ device, [`${device}Orientation`]: orientation }, 440, 300, false, 15, 2);
    assert.equal(h.stage.style.transform, `scale(${scale})`);
    assert.equal(h.viewport.zoomPercent, percent);
    assert.equal(h.viewport.fit, 'automatic', 'The internal strategy must never select an explicit override.');
    assert.equal(h.canvas.style.overflowX, 'hidden');
    assert.equal(h.canvas.style.overflowY, overflow ? 'scroll' : 'hidden');
    assert.equal(h.canvas.tabIndex, overflow ? 0 : -1);
});

test('portrait Auto fits the available height without an outer scrollbar', () => {
    const h = fixture({ device: 'mobile' }, 320, 339, false, 15);
    assert.equal(h.stage.style.transform, `scale(${339 / 844})`);
    assert.equal(h.stage.style.width, '390px');
    assert.equal(h.stage.style.height, '844px');
    assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
    assert.equal(h.viewport.zoomPercent, 40);
    assert.equal(h.canvas.tabIndex, -1);
    assert.equal(h.canvas.style.overflowY, 'hidden');
    assert.equal(h.canvas.style.overflowX, 'hidden');
});

test('portrait Auto never reserves a vertical gutter in a narrow panel', () => {
    const h = fixture({ device: 'mobile' }, 200, 300, false, 15, 2);
    assert.equal(h.stage.style.transform, `scale(${300 / 844})`);
    assert.equal(h.viewport.zoomPercent, 71);
    assert.equal(h.canvas.tabIndex, -1);
    assert.equal(h.space.style.width, '200px');
});

test('portrait Auto reserves no scrollbar when both dimensions fit at exactly 100%', () => {
    const h = fixture({ device: 'mobile' }, 195, 422, false, 15, 2);
    assert.equal(h.stage.style.transform, 'scale(0.5)');
    assert.equal(h.viewport.zoomPercent, 100);
    assert.equal(h.canvas.style.overflowY, 'hidden');
    assert.equal(h.canvas.tabIndex, -1);
});

test('portrait Auto stays stable when the panel is just below a 100% fit', () => {
    const h = fixture({ device: 'mobile' }, 200, 415, false, 15, 2);
    const before = { ...h.stage.style };
    for (let i = 0; i < 10; i++) h.observers[0].callback([]);
    assert.deepEqual(h.stage.style, before);
    assert.equal(h.canvas.style.overflowY, 'hidden');
    assert.equal(h.viewport.zoomPercent, 98);
    assert.equal(h.canvas.tabIndex, -1, 'Whole-screen fitting never needs a canvas keyboard stop.');
});

test('explicit width fitting preserves logical canvas navigation across panel and DPR changes, but resets on rotation', () => {
    const h = fixture({ device: 'mobile', fit: 'width' }, 320, 248, false, 15);
    h.canvas.scrollTop = 100 * 305 / 390;
    h.container.clientWidth = 280;
    h.viewport.layout();
    assert.ok(Math.abs(h.canvas.scrollTop - 100 * 265 / 390) < 0.001);
    h.mainWindow.setPixelRatio(2);
    assert.ok(Math.abs(h.canvas.scrollTop - 100 * 265 / 390) < 0.001);
    assert.equal(h.viewport.zoomPercent, Math.round(265 / 390 * 200));
    assert.equal(h.viewport.fit, 'width');
    h.viewport.rotate();
    assert.equal(h.canvas.scrollTop, 0);
    assert.equal(h.canvas.tabIndex, -1);
    assert.equal(h.stage.style.width, '844px');
    assert.equal(h.stage.style.height, '390px');
});

test('DPR changes relayout the camera and rearm exactly one resolution listener without resizing the panel', () => {
    const h = fixture({ device: 'mobile' }, 900, 1200);
    for (const dpr of [2, 1.25, 0.75, 1]) {
        h.mainWindow.setPixelRatio(dpr);
        assert.equal(h.stage.style.transform, `scale(${1 / dpr})`);
        assert.equal(h.stage.style.width, '390px');
        assert.equal(h.stage.style.height, '844px');
        assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
        assert.equal(h.viewport.zoomPercent, 100);
        const active = h.mainWindow.mediaQueries.filter((query) => query.media.startsWith('(resolution:') && query.listeners.size);
        assert.equal(active.length, 1);
        assert.equal(active[0].media, `(resolution: ${dpr}dppx)`);
    }
});

test('window resize is a fallback when a DPR change does not dispatch a resolution event', () => {
    const h = fixture({ device: 'mobile' }, 900, 1200);
    h.mainWindow.devicePixelRatio = 2;
    h.mainWindow.resize();
    assert.equal(h.stage.style.transform, 'scale(0.5)');
    assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
    assert.equal(h.viewport.zoomPercent, 100);
    assert.equal(h.mainWindow.resizeListeners.size, 1);
});

test('DPR changes update width-fit reporting without changing its CSS zoom or logical canvas navigation', () => {
    const h = fixture({ device: 'mobile', fit: 'width' });
    h.canvas.scrollTop = 200 * 480 / 390;
    const before = h.canvas.scrollTop;
    h.mainWindow.setPixelRatio(2);
    assert.equal(h.stage.style.transform, `scale(${480 / 390})`);
    assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
    assert.equal(h.viewport.zoomPercent, 246);
    assert.equal(h.canvas.scrollTop, before);
});

test('PiP uses its own DPR and removes resolution listeners from the previous window', () => {
    const h = fixture({ device: 'mobile' }, 900, 1200, false, 0, 2);
    h.pipWindow.devicePixelRatio = 1.25;
    h.viewport.beforeMove();
    h.mainWindow.setPixelRatio(1);
    h.mainWindow.resize();
    assert.equal(h.mainWindow.resizeListeners.size, 0);
    assert.equal(h.stage.style.transform, 'scale(0.5)', 'A detached window must no longer drive layout.');
    h.container.ownerDocument = { defaultView: h.pipWindow };
    h.viewport.afterMove();
    assert.equal(h.stage.style.transform, 'scale(0.8)');
    h.pipWindow.setPixelRatio(2);
    assert.equal(h.stage.style.transform, 'scale(0.5)');
    h.viewport.beforeMove();
    assert.ok(h.pipWindow.mediaQueries.every((query) => !query.listeners.size));
    assert.equal(h.pipWindow.resizeListeners.size, 0);
    h.container.ownerDocument = { defaultView: h.mainWindow };
    h.viewport.afterMove();
    assert.equal(h.stage.style.transform, 'scale(1)');
    assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
    assert.equal(h.viewport.zoomPercent, 100);
});

test('unavailable or invalid DPR values safely fall back to one', () => {
    const h = fixture({ device: 'mobile' }, 900, 1200);
    for (const value of [undefined, null, 0, -1, NaN, Infinity, '2']) {
        h.mainWindow.devicePixelRatio = value;
        h.viewport.layout();
        assert.equal(h.stage.style.transform, 'scale(1)');
        assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
        assert.equal(h.viewport.zoomPercent, 100);
    }
});

test('Fit to window and Fit to width can both enlarge beyond 100%, without changing iframe height', () => {
    const h = fixture({ device: 'mobile' }, 900, 1200);
    h.viewport.setFit('window');
    assert.equal(h.stage.style.transform, `scale(${1200 / 844})`);
    assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
    assert.equal(h.viewport.zoomPercent, 142);
    h.viewport.setFit('width');
    assert.equal(h.stage.style.transform, `scale(${900 / 390})`);
    assert.equal(h.stage.style.height, '844px');
    assert.equal(h.stage.style.top, '0px');
    assert.equal(h.canvas.tabIndex, 0);
    assert.equal(h.dimensions.textContent, `Phone (390 × 844) · ${h.viewport.zoomPercent}%`);
    assert.equal(h.viewport.zoomPercent, 231);
});

test('Fit to width reserves a native scrollbar before measuring the available preview width', () => {
    const h = fixture({ device: 'mobile', fit: 'width' }, 480, 248, false, 15);
    assert.equal(h.canvas.style.overflowY, 'scroll');
    assert.equal(h.stage.style.transform, `scale(${465 / 390})`);
    assert.equal(h.space.style.width, '465px');
    assert.equal(h.stage.style.height, '844px');
    h.viewport.setFit('automatic');
    assert.equal(h.canvas.style.overflowY, 'hidden', 'Auto fits the complete screen without vertical canvas navigation.');
    assert.equal(h.space.style.width, '480px');
    assert.equal(h.stage.style.transform, `scale(${248 / 844})`, 'Unlike explicit Fill width, Auto keeps the full viewport visible.');
    assert.equal(h.canvas.tabIndex, -1);
    h.viewport.rotate();
    assert.equal(h.canvas.style.overflowY, 'hidden');
    assert.equal(h.space.style.width, '480px');
    assert.equal(h.canvas.tabIndex, -1);
});

test('scrollbar reservation is stable at the height limit instead of toggling the scrollbar in a resize loop', () => {
    const h = fixture({ fit: 'width' }, 400, 249, false, 15);
    const before = { ...h.stage.style };
    for (let i = 0; i < 10; i++) h.observers[0].callback([]);
    assert.deepEqual(h.stage.style, before);
    assert.equal(h.canvas.style.overflowY, 'scroll');
});

test('canvas navigation retains its logical position across zoom-only panel resizes, and resets on mode/device changes', () => {
    const h = fixture({ device: 'mobile', fit: 'width' });
    h.canvas.scrollTop = 200 * 480 / 390;
    h.container.clientWidth = 600;
    h.viewport.layout();
    assert.ok(Math.abs(h.canvas.scrollTop - 200 * 600 / 390) < 0.001);
    assert.equal(h.stage.style.width, '390px');
    assert.equal(h.stage.style.height, '844px');
    h.viewport.rotate();
    assert.equal(h.canvas.scrollTop, 0);
    h.canvas.scrollTop = 50;
    h.viewport.setFit('automatic');
    assert.equal(h.canvas.scrollTop, 0);
});

test('orientation is independent per device and never changes panel dimensions or fitting', () => {
    const h = fixture({ device: 'tablet', fit: 'width' });
    h.viewport.rotate();
    assert.equal(h.viewport.orientation, 'landscape');
    assert.equal(h.stage.style.width, '1024px');
    h.viewport.select('mobile');
    assert.equal(h.viewport.orientation, 'portrait');
    h.viewport.rotate();
    assert.equal(h.stage.style.width, '844px');
    h.viewport.select('tablet');
    assert.equal(h.viewport.orientation, 'landscape');
    h.viewport.rotate();
    assert.equal(h.stage.style.width, '768px');
    h.viewport.select('mobile');
    assert.equal(h.viewport.orientation, 'landscape');
    h.viewport.select('desktop');
    assert.equal(h.viewport.orientation, 'landscape');
    h.viewport.rotate();
    assert.equal(h.viewport.orientation, 'landscape');
    assert.equal(h.stage.style.width, '1280px');
    h.viewport.select('mobile');
    assert.equal(h.viewport.orientation, 'landscape');
    h.viewport.select('desktop');
    assert.equal(h.viewport.orientation, 'landscape');
    h.viewport.rotate();
    assert.equal(h.stage.style.width, '1280px');
    assert.equal(h.viewport.fit, 'width');
    assert.equal(h.container.clientWidth, 480);
    assert.equal(h.container.clientHeight, 248);
});

test('desktop stays in landscape and ignores rotation and old orientation preferences', () => {
    for (const desktopOrientation of [undefined, 'portrait', 'landscape']) {
        const h = fixture({ desktopOrientation, fit: 'width' }, 480, 248, true);
        assert.equal(h.viewport.orientation, 'landscape');
        assert.equal(h.stage.style.width, '1280px');
        assert.equal(h.stage.style.height, '800px');
        h.canvas.scrollTop = 50;
        const before = { ...h.stage.style };
        const dimensions = h.dimensions.textContent;
        h.viewport.rotate();
        h.viewport.rotate({ animate: true });
        assert.equal(h.viewport.orientation, 'landscape');
        assert.deepEqual(h.stage.style, before);
        assert.equal(h.dimensions.textContent, dimensions);
        assert.equal(h.canvas.scrollTop, 50, 'Reselecting desktop must not reset canvas navigation.');
        assert.equal(h.frames.size, 0, 'Desktop rotation must not start an animation.');
    }
});

test('invalid preferences and actions cannot create arbitrary dimensions or fitting modes', () => {
    for (const value of [null, false, {}, [], '__proto__', 'constructor', 'fit', '100', 100]) {
        const h = fixture({ device: value, fit: value, desktopOrientation: value, tabletOrientation: value, mobileOrientation: value });
        h.viewport.select(value);
        h.viewport.setFit(value);
        assert.equal(h.viewport.device, 'desktop');
        assert.equal(h.viewport.fit, 'automatic');
        h.viewport.select('tablet');
        assert.equal(h.viewport.orientation, 'portrait');
    }
});

for (const fit of fits) {
    test(`resizing a panel only changes zoom, never the selected dimensions: ${fit}`, () => {
        const h = fixture({ device: 'mobile', fit });
        for (const [width, height] of [[900, 1200], [600, 400], [320, 280]]) {
            h.container.clientWidth = width;
            h.container.clientHeight = height;
            h.viewport.layout();
            assert.equal(h.stage.style.transform, `scale(${expectedScale(fit, width, height, 390, 844)})`);
            assert.equal(h.stage.style.height, '844px');
            assert.equal(h.stage.style.width, '390px');
        }
    });
}

test('hidden panels establish CSS viewport geometry immediately and wait for measurement before computing zoom', () => {
    const h = fixture({ device: 'mobile' }, 0, 0);
    assert.deepEqual(h.stage.style, { width: '390px', height: '844px' });
    h.container.clientWidth = 480;
    h.container.clientHeight = 248;
    h.viewport.layout();
    assert.equal(h.stage.style.width, '390px');
    assert.ok(!JSON.stringify(h.stage.style).includes('NaN'));
});

test('orientation motion animates only zoom; CSS dimensions immediately match the selected orientation', () => {
    const h = fixture({ device: 'mobile' }, 480, 248, true);
    h.viewport.rotate({ animate: true });
    assert.equal(h.stage.style.width, '844px');
    assert.equal(h.stage.style.height, '390px');
    h.advance(100);
    assert.equal(h.stage.style.width, '844px');
    assert.equal(h.stage.style.height, '390px');
    assert.equal(h.dimensions.textContent, `Phone (844 × 390) · ${h.viewport.zoomPercent}%`);
    h.viewport.layout();
    assert.equal(h.frames.size, 0);
    assert.equal(h.stage.style.transform, `scale(${480 / 844})`);
    h.viewport.select('desktop', { animate: true });
    h.viewport.beforeMove();
    assert.equal(h.frames.size, 0);
    h.container.ownerDocument = { defaultView: h.pipWindow };
    h.viewport.afterMove();
    assert.equal(h.stage.style.width, '1280px');
    assert.equal(h.stage.style.height, '800px');
});

test('a tracked canvas pan waits for the final camera paint or a superseding layout', async () => {
    const h = fixture({ device: 'mobile', fit: 'width' }, 600, 160, true);
    h.canvas.scrollTop = 100 * (600 / 390);
    h.viewport.rotate({ animate: true, keepPan: true });
    let settled = false;
    const done = h.viewport.whenSettled().then(() => { settled = true; });
    h.advance(100);
    await Promise.resolve();
    assert.equal(settled, false);
    h.advance(200);
    await done;
    assert.ok(Math.abs(h.canvas.scrollTop - 100 * (600 / 844)) < 0.01, 'Keep the same iframe-space pan at the new scale.');
    h.viewport.rotate({ animate: true });
    const canceled = h.viewport.whenSettled();
    assert.equal(h.viewport.canvasWasPanned(), false, 'Do not interpret a camera paint as user input.');
    h.canvas.scrollTop = 25;
    assert.equal(h.viewport.canvasWasPanned(), true, 'A scrollbar change is distinct from the last paint.');
    h.viewport.finishMotion();
    await canceled;
    assert.ok(h.canvas.scrollTop > 0, 'Finishing motion preserves the new logical pan.');
    assert.equal(h.viewport.whenSettled(), undefined);
});

test('reduced motion skips camera animation without changing fixed viewport dimensions', () => {
    const h = fixture({ device: 'mobile' });
    h.viewport.rotate({ animate: true });
    assert.equal(h.frames.size, 0);
    assert.equal(h.stage.style.width, '844px');
    assert.equal(h.stage.style.height, '390px');
});

test('viewport observers rebind after adoption without losing fitting or orientation', () => {
    const h = fixture({ device: 'tablet', tabletOrientation: 'landscape', fit: 'width' });
    h.viewport.beforeMove();
    assert.equal(h.observers[0].connected, false);
    h.container.ownerDocument = { defaultView: h.pipWindow };
    h.viewport.afterMove();
    assert.equal(h.observers[1].window, 'pip');
    assert.equal(h.viewport.device, 'tablet');
    assert.equal(h.viewport.orientation, 'landscape');
    assert.equal(h.viewport.fit, 'width');
    assert.equal(h.stage.style.width, '1024px');
    assert.equal(h.stage.style.height, '768px');
    h.viewport.beforeMove();
    h.container.ownerDocument = { defaultView: h.mainWindow };
    h.viewport.afterMove();
    assert.equal(h.observers[2].window, 'editor');
    assert.equal(h.observers.filter(({ connected }) => connected).length, 1);
});

async function browserTests({ source, css }) {
    const createPreviewViewport = new Function(`${source}\nreturn createPreviewViewport;`)();
    const results = [];
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const close = (actual, expected, label) => check(Math.abs(actual - expected) <= 1, `${label}: ${actual}, expected ${expected}`);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    const sizes = [[480, 340], [1240, 728], [1280, 800], [640, 540]];
    const variants = [['desktop', 'landscape', 1280, 800], ['tablet', 'portrait', 768, 1024], ['tablet', 'landscape', 1024, 768], ['mobile', 'portrait', 390, 844], ['mobile', 'landscape', 844, 390]];
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    for (const [pw, ph] of sizes) for (const [device, orientation, width, height] of variants) for (const fit of ['automatic', 'window', 'width', 'custom']) {
        const name = `${pw}×${ph}: ${device} ${orientation}, ${fit} fixed viewport`;
        const panel = document.createElement('section');
        panel.className = 'mtflpp-panel';
        panel.dir = pw === 480 ? 'rtl' : 'ltr';
        panel.dataset.hasPreview = 'false';
        panel.style.cssText = `position:relative;width:${pw}px;height:${ph}px`;
        panel.innerHTML = '<header class="mtflpp-header"></header><div class="mtflpp-viewport"><div class="mtflpp-canvas" role="region" aria-label="Preview canvas" tabindex="-1"><div class="mtflpp-canvas-space"><div class="mtflpp-stage"><iframe class="mtflpp-frame" title="Test preview"></iframe></div></div></div></div><footer class="mtflpp-devicebar" style="height:48px"><span class="mtflpp-dimensions"><span class="mtflpp-dimensions-text"></span></span></footer>';
        document.body.append(panel);
        const container = panel.querySelector('.mtflpp-viewport'), stage = panel.querySelector('.mtflpp-stage');
        const canvas = panel.querySelector('.mtflpp-canvas');
        const viewport = createPreviewViewport(container, stage, panel.querySelector('.mtflpp-dimensions'), { device, fit, [`${device}Orientation`]: orientation });
        try {
            const frame = panel.querySelector('iframe');
            frame.contentDocument.open();
            frame.contentDocument.write('<!doctype html><style>html,body{margin:0}main{height:100vh}article{height:200vh}p{margin:0;font:16px/1.5 sans-serif}footer{position:fixed;bottom:0;height:30px;width:100%;background:blue}</style><main><p>Fixed viewport text wrapping must never change when only zoom or panel size changes. Fixed viewport text wrapping must never change when only zoom or panel size changes.</p></main><article></article><footer></footer><script>window.initialViewport=[innerWidth,innerHeight]</script>');
            frame.contentDocument.close();
            check(frame.contentWindow.initialViewport[0] === width && frame.contentWindow.initialViewport[1] === height, 'Frontend initialization must see the selected viewport, even while loading.');
            close(frame.contentWindow.innerWidth, width, 'A loading page must bootstrap at the selected CSS width');
            close(frame.contentWindow.innerHeight, height, 'A loading page must bootstrap at the selected CSS height');
            check(getComputedStyle(canvas).visibility === 'hidden', 'Do not expose a loading canvas to interaction.');
            canvas.focus();
            check(document.activeElement !== canvas, 'A loading canvas must not accept keyboard focus.');
            panel.dataset.hasPreview = 'true';
            viewport.layout();
            await settle();
            const cssState = () => ({
                width: frame.contentWindow.innerWidth, height: frame.contentWindow.innerHeight,
                vh: frame.contentDocument.querySelector('main').getBoundingClientRect().height,
                textHeight: frame.contentDocument.querySelector('p').getBoundingClientRect().height,
                tablet: frame.contentWindow.matchMedia('(min-width:768px)').matches,
                tall: frame.contentWindow.matchMedia('(min-height:800px)').matches,
                landscape: frame.contentWindow.matchMedia('(min-aspect-ratio:1/1)').matches,
            });
            const initial = cssState();
            close(initial.width, width, 'Real CSS viewport width');
            close(initial.height, height, 'Real CSS viewport height');
            close(initial.vh, height, '100vh stays fixed');
            close(frame.contentDocument.querySelector('footer').getBoundingClientRect().bottom, height, 'Fixed bottom stays in the selected viewport');
            check(initial.tablet === (width >= 768) && initial.tall === (height >= 800) && initial.landscape === (width >= height), 'Width, height and aspect-ratio media queries must use the selected CSS viewport.');
            const widthFirst = fit === 'width';
            const scale = fit === 'custom' ? 1 / devicePixelRatio
                : Math.min(fit === 'automatic' ? 1 / devicePixelRatio : Infinity, canvas.clientWidth / width, widthFirst ? Infinity : canvas.clientHeight / height);
            const rect = stage.getBoundingClientRect(), bounds = canvas.getBoundingClientRect();
            close(rect.width, width * scale, 'Painted width');
            close(rect.height, height * scale, 'Painted height');
            check(panel.querySelector('.mtflpp-dimensions').textContent === `${{ desktop: 'Desktop', tablet: 'Tablet', mobile: 'Phone' }[device]} (${width} × ${height}) · ${viewport.zoomPercent}%`, 'The readout reports fixed CSS dimensions and current zoom.');
            check(viewport.zoomPercent === Math.round(scale * devicePixelRatio * 100), 'Publish the computed DPR-corrected zoom for the single Zoom control.');
            const overflowX = fit === 'custom' && rect.width > canvas.clientWidth + 0.01;
            const overflowY = (widthFirst || fit === 'custom') && rect.height > canvas.clientHeight + 0.01;
            check(canvas.tabIndex === (overflowX || overflowY ? 0 : -1), 'Only a navigable canvas needs an extra keyboard stop.');
            if (overflowX) {
                check(canvas.scrollWidth > canvas.clientWidth, 'Fixed zoom needs a real horizontal navigation range.');
                canvas.scrollLeft = canvas.scrollWidth;
                close(stage.getBoundingClientRect().right, bounds.left + canvas.clientWidth, 'The right edge must be reachable');
                canvas.scrollLeft = 0;
                close(stage.getBoundingClientRect().left, bounds.left, 'The left edge must be reachable');
            } else check(canvas.scrollWidth === canvas.clientWidth, 'No phantom horizontal overflow.');
            if (overflowY) {
                check(canvas.scrollHeight > canvas.clientHeight, 'Width fitting must expose a real canvas scroll range.');
                canvas.focus({ preventScroll: true });
                check(document.activeElement === canvas && getComputedStyle(canvas).outlineStyle !== 'none', 'The canvas needs keyboard focus and a visible focus indicator.');
                canvas.scrollTop = canvas.scrollHeight;
                close(stage.getBoundingClientRect().bottom, bounds.top + canvas.clientHeight, 'The bottom of the complete viewport must be reachable');
                canvas.scrollTop = 0;
                close(stage.getBoundingClientRect().top, bounds.top, 'The top must remain reachable');
            } else {
                check(rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1, 'A non-overflowing viewport must fit vertically.');
                check(canvas.scrollHeight === canvas.clientHeight, 'No phantom vertical overflow.');
            }
            const pan = canvas.scrollTop;
            frame.contentWindow.scrollTo(0, height / 2);
            check(frame.contentWindow.scrollY > 0, 'The page must still scroll inside its iframe.');
            check(canvas.scrollTop === pan, 'Scrolling the page must not pan the surrounding canvas.');
            const pageScroll = frame.contentWindow.scrollY;
            canvas.scrollTop = canvas.scrollHeight;
            check(frame.contentWindow.scrollY === pageScroll, 'Panning the canvas must not scroll the page.');
            viewport.setFit(fit === 'window' ? 'width' : 'window');
            await settle();
            check(JSON.stringify(cssState()) === JSON.stringify(initial), 'Switching fitting must preserve viewport dimensions, vh, text wrapping and all media queries.');
            check(frame.contentWindow.scrollY === pageScroll, 'Switching fitting preserves page scrolling.');
            panel.style.width = `${pw + 131}px`;
            panel.style.height = `${ph + 97}px`;
            viewport.layout();
            await settle();
            check(JSON.stringify(cssState()) === JSON.stringify(initial), 'Panel resizing must only change zoom, not iframe layout.');
            results.push({ name });
        } catch (error) { results.push({ name, error: error.stack }); }
        finally { viewport.beforeMove(); panel.remove(); }
    }
    style.remove();
    return results;
}

test('Chromium verifies fixed geometry, zoom and independent scrolling in all 80 viewport/presentation variants', async (t) => {
    const source = await sourceForVm(new URL('../src/panel/viewport.js', import.meta.url));
    const css = await readFile(new URL('../src/panel/panel.css', import.meta.url), 'utf8');
    await runChromiumTests(t, { script: `(${browserTests.toString()})(${JSON.stringify({ source, css })})`, count: 80 });
});

async function browserBreakpointTests({ viewportSource, scrollSource, css }) {
    const { createPreviewViewport, createPreviewScroll } = new Function(
        `${viewportSource}\n${scrollSource}\nreturn { createPreviewViewport, createPreviewScroll };`,
    )();
    const results = [];
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    for (const [fit, move] of [
        ['automatic', 'page'], ['window', 'page'], ['width', 'canvas'], ['custom', 'canvas'],
        ['custom', 'both'], ['custom', 'panned away'], ['custom', 'still visible'],
        ['custom', 'header over canvas'], ['custom', 'off-center header over canvas'],
    ]) {
        const name = `${fit}: ${move} on breakpoint change`;
        const panel = document.createElement('section');
        panel.className = 'mtflpp-panel';
        panel.style.cssText = 'left:0;top:0;width:420px;height:250px';
        panel.innerHTML = '<header class="mtflpp-header"></header><div class="mtflpp-viewport"><div class="mtflpp-canvas"><div class="mtflpp-canvas-space"><div class="mtflpp-stage"><iframe class="mtflpp-frame"></iframe></div></div></div></div><footer class="mtflpp-devicebar"><span class="mtflpp-dimensions"></span></footer>';
        document.body.append(panel);
        const container = panel.querySelector('.mtflpp-viewport'), stage = panel.querySelector('.mtflpp-stage');
        const canvas = panel.querySelector('.mtflpp-canvas'), frame = panel.querySelector('iframe');
        const rotate = fit === 'width';
        const offCenter = move === 'off-center header over canvas';
        const narrowHeader = move === 'header over canvas' || offCenter;
        const viewport = createPreviewViewport(container, stage, panel.querySelector('.mtflpp-dimensions'), {
            device: rotate ? 'mobile' : 'desktop', mobileOrientation: rotate ? 'landscape' : 'portrait', fit, customZoom: offCenter ? 300 : 200,
        });
        try {
            const doc = frame.contentDocument, win = frame.contentWindow;
            const samePosition = move === 'still visible' || narrowHeader;
            const shift = samePosition ? 0 : move === 'canvas' ? 300 : 1100;
            const shiftX = fit === 'custom' && !samePosition ? 315 : 40;
            doc.open();
            doc.write(`<!doctype html><style>
                html { overflow-anchor: none; } body { margin: 0; } #spacer { height: 800px; }
                #edited { margin: 0 0 0 40px; width: ${narrowHeader ? 300 : 30}px; height: 30px; }
                @media (max-width: 400px) {
                    #spacer { height: ${800 + shift}px; } #edited { margin-left: ${shiftX}px; }
                    ${narrowHeader ? `header { position: fixed; left: ${offCenter ? 35 : 70}px; top: 0;
                        width: ${offCenter ? 150 : 250}px; height: 350px; background: white; }` : ''}
                }
            </style><header></header><div id="spacer"></div><p id="edited">Edit</p><div style="height:1800px"></div>`);
            doc.close();
            win.matchMedia = () => ({ matches: true }); // Position the initial follow instantly.
            const target = doc.querySelector('#edited');
            const scrolling = createPreviewScroll();
            const anchor = await scrolling.restore(doc, target);
            const touchesCanvas = () => {
                const inner = target.getBoundingClientRect(), outer = frame.getBoundingClientRect(), clip = canvas.getBoundingClientRect();
                const scale = outer.height / win.innerHeight;
                const offsetY = inner.top + inner.height / 2;
                const y = outer.top + offsetY * scale;
                const samples = narrowHeader ? [inner.left + 15, inner.left + inner.width / 2, inner.right - 10]
                    : [inner.left + inner.width / 2];
                return inner.top >= 0 && inner.bottom <= win.innerHeight && y >= clip.top && y < clip.top + canvas.clientHeight
                    && samples.some((offsetX) => {
                        const x = outer.left + offsetX * scale;
                        return x >= clip.left && x < clip.left + canvas.clientWidth && doc.elementFromPoint(offsetX, offsetY) === target;
                    });
            };
            if (fit === 'custom') {
                const scale = frame.getBoundingClientRect().height / win.innerHeight;
                canvas.scrollTop = move === 'panned away' ? 0 : target.getBoundingClientRect().top * scale - 40;
                if (narrowHeader) canvas.scrollLeft = (offCenter ? 40 : 85) * scale;
            }
            const oldPage = win.scrollY, oldPan = canvas.scrollTop, oldPanX = canvas.scrollLeft;
            check(touchesCanvas() === (move !== 'panned away'), 'Set up whether the original target is on screen.');
            const pending = scrolling.keepInView(anchor, {
                canvasTarget: (bounds) => viewport.canvasTarget(frame, bounds),
                whenSettled: viewport.whenSettled,
                canFollow: () => true,
            });
            const options = { keepPan: !!pending };
            if (rotate) viewport.rotate(options);
            else viewport.select('mobile', options);
            await pending;
            check(win.innerWidth === 390, 'The iframe must use the new breakpoint.');
            check(touchesCanvas() === (move !== 'panned away'), 'Only a previously visible change should be on screen.');
            check((win.scrollY !== oldPage) === ['page', 'both'].includes(move), 'Do not scroll the webpage for canvas-only clipping.');
            if (move === 'canvas') check(canvas.scrollTop > oldPan, 'Pan vertically when the edit moves below the panel.');
            if (move === 'canvas' || move === 'both') {
                check((canvas.scrollLeft > 0) === (fit === 'custom'), 'Only custom zoom needs to pan horizontally.');
            }
            if (move === 'still visible') check(canvas.scrollTop === oldPan, 'Keep the canvas pan if the change is still visible.');
            if (narrowHeader) check(offCenter ? canvas.scrollLeft > oldPanX : canvas.scrollLeft < oldPanX,
                'Pan to the nearer exposed side rather than scrolling the page.');
            if (move === 'panned away') check(!pending && canvas.scrollTop === 0, 'Do not follow a change clipped by the old canvas.');
            results.push({ name });
        } catch (error) { results.push({ name, error: error.stack }); }
        finally { viewport.beforeMove(); panel.remove(); }
    }
    return results;
}

test('Chromium keeps followed changes in the panel across breakpoints in all zoom modes', async (t) => {
    const [viewportSource, scrollSource, css] = await Promise.all([
        sourceForVm(new URL('../src/panel/viewport.js', import.meta.url)),
        sourceForVm(new URL('../src/preview/scroll.js', import.meta.url)),
        readFile(new URL('../src/panel/panel.css', import.meta.url), 'utf8'),
    ]);
    await runChromiumTests(t, { script: `(${browserBreakpointTests.toString()})(${JSON.stringify({ viewportSource, scrollSource, css })})`, count: 9 });
});

test('trusted Chromium verifies independent scrolling and DPR-corrected physical pixel geometry', { timeout: 30000 }, async (t) => {
    const modules = new Map(await Promise.all(['panel/viewport.js', 'preview/frame.js', 'preview/comparison.js', 'preview/scroll.js'].map(async (path) =>
        [`/src/${path}`, await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')])));
    const css = await readFile(new URL('../src/panel/panel.css', import.meta.url), 'utf8');
    const page = '<!doctype html><meta name="meet-the-frontend-live-preview-panel" content="trusted-scroll"><style>html,body{margin:0}html{overscroll-behavior:auto!important}main{height:300vh}</style><main>Scrollable page</main>';
    const html = `<!doctype html><style>body{margin:0}${css}</style>
        <section class="mtflpp-panel" style="left:0;top:0;width:480px;height:340px">
            <header class="mtflpp-header"></header><div class="mtflpp-viewport">
                <div class="mtflpp-canvas" role="region" aria-label="Preview canvas" tabindex="-1">
                    <div class="mtflpp-canvas-space"><div class="mtflpp-stage"></div></div>
                </div>
            </div><footer class="mtflpp-devicebar" style="height:48px"><span class="mtflpp-dimensions"><span class="mtflpp-dimensions-text"></span></span></footer>
        </section><script type="module">
        import { createPreviewViewport } from '/src/panel/viewport.js';
        import { createPreviewFrame } from '/src/preview/frame.js';
        import { createPreviewScroll } from '/src/preview/scroll.js';
        const stage = document.querySelector('.mtflpp-stage');
        const reports = [];
        const preview = createPreviewFrame({stage,followChanges:false,clearPreview:()=>stage.replaceChildren()}, createPreviewScroll(), {title:'Test preview',failed:'Failed',browser:'Same-origin required',current:'Current'}, (text,state)=>reports.push({text,state}));
        await preview.load(new URL('/page?mtflpp_token=trusted-scroll', location.href).href, () => true);
        const canvas = document.querySelector('.mtflpp-canvas'), frame = document.querySelector('iframe');
        const viewport = createPreviewViewport(document.querySelector('.mtflpp-viewport'), stage, document.querySelector('.mtflpp-dimensions'), {device:'mobile',fit:'width'});
        viewport.layout();
        let wheels = 0;
        frame.contentDocument.addEventListener('wheel', (event) => { if (event.isTrusted) wheels++; }, {passive:true});
        Object.assign(window, {canvas,frame,viewport,preview,reports,createPreviewScroll});
        window.canvasInputState = () => ({pan:canvas.scrollTop,panX:canvas.scrollLeft,page:frame.contentWindow.scrollY,pageX:frame.contentWindow.scrollX,width:frame.contentWindow.innerWidth,height:frame.contentWindow.innerHeight,zoom:viewport.zoomPercent,wheels});
        </script>`;
    await withChromiumPage(html, async ({ args }) => {
        const pending = new Map();
        let chrome, sessionId, nextId = 0, buffer = '', stderr = '';
        const responses = new Map([...modules, ['/', html], ['/page', page],
            ['/unmarked', page.replace(/<meta[^>]+>/, '')], ['/plain', 'Native text output'],
            ['/rewrite', '<!doctype html><script>history.replaceState(null, "", "/unmarked")</script><main>Rewritten URL</main>']]);
        const server = createServer((request, response) => {
            const path = new URL(request.url, 'http://localhost').pathname;
            const redirect = {
                '/redirect-html': '/unmarked?private=not-for-display#fragment',
                '/redirect-html-rewrite': '/rewrite',
                '/redirect-marked': '/page?mtflpp_token=trusted-scroll',
                '/redirect-plain': '/plain',
                '/redirect-other-origin': `http://localhost:${server.address().port}/unmarked`,
            }[path];
            if (redirect) {
                response.writeHead(302, { Location: redirect }).end();
                return;
            }
            response.setHeader('Content-Type', path === '/plain' ? 'text/plain' : modules.has(path) ? 'text/javascript' : 'text/html');
            response.end(responses.get(path) ?? '');
        });
        const rejectPending = (error) => {
            for (const entry of pending.values()) entry.reject(error);
            pending.clear();
        };
        const abort = () => { rejectPending(t.signal.reason); chrome?.kill(); };
        t.signal.addEventListener('abort', abort, { once: true });
        try {
            // Match the existing native-save input test: an isolated local DevTools pipe,
            // rather than synthetic DOM keys (which cannot exercise native scrolling).
            chrome = spawn(process.env.CHROMIUM_BIN || 'chromium', [...args, '--disable-smooth-scrolling', '--remote-debugging-pipe'],
                { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
            chrome.stderr.on('data', (data) => { stderr += data; });
            chrome.on('error', rejectPending);
            chrome.on('exit', (code) => rejectPending(new Error(`Chromium exited (${code}).\n${stderr}`)));
            chrome.stdio[3].on('error', rejectPending);
            chrome.stdio[4].setEncoding('utf8');
            chrome.stdio[4].on('data', (data) => {
                buffer += data;
                let end;
                while ((end = buffer.indexOf('\0')) !== -1) {
                    const message = JSON.parse(buffer.slice(0, end));
                    buffer = buffer.slice(end + 1);
                    const entry = pending.get(message.id);
                    if (!entry) continue;
                    pending.delete(message.id);
                    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
                    else entry.resolve(message.result);
                }
            });
            const send = (method, params = {}, targetSession = sessionId) => new Promise((resolve, reject) => {
                const id = ++nextId;
                pending.set(id, { resolve, reject });
                chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId: targetSession })}\0`);
            });
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
            const { targetId } = await send('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/` });
            ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
            const evaluate = async (expression) => {
                const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
                assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
                return result.result.value;
            };
            for (let i = 0; i < 100 && !(await evaluate('typeof window.canvasInputState === "function"')); i++) await delay(10);
            assert.equal(await evaluate('typeof window.canvasInputState'), 'function', stderr);
            const waitFor = async (expression) => {
                for (let i = 0; i < 100; i++) {
                    if (await evaluate(expression)) return;
                    await delay(10);
                }
                assert.fail(`Browser state did not settle: ${expression}\n${JSON.stringify(await evaluate('({dpr:devicePixelRatio,transform:document.querySelector(".mtflpp-stage").style.transform,currentResolution:matchMedia(`(resolution: ${devicePixelRatio}dppx)`).matches,canvas:[canvas.clientWidth,canvas.clientHeight]})'))}`);
            };
            const key = async (name, code, settled) => {
                for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
                await waitFor(settled);
            };
            await evaluate('canvas.focus({preventScroll:true})');
            await key('PageDown', 34, 'canvas.scrollTop > 0');
            let state = await evaluate('canvasInputState()');
            assert.ok(state.pan > 0, 'PageDown must navigate the focused canvas.');
            assert.equal(state.page, 0, 'Canvas keys must not scroll the webpage.');
            await key('End', 35, 'Math.abs(canvas.scrollTop + canvas.clientHeight - canvas.scrollHeight) <= 1');
            assert.ok(await evaluate('Math.abs(canvas.scrollTop + canvas.clientHeight - canvas.scrollHeight) <= 1'), 'End must reach the bottom of the viewport.');
            await key('Home', 36, 'canvas.scrollTop === 0');
            assert.equal((await evaluate('canvasInputState()')).pan, 0, 'Home must return to the viewport top.');
            await evaluate('frame.contentWindow.focus()');
            await key('PageDown', 34, 'frame.contentWindow.scrollY > 0');
            state = await evaluate('canvasInputState()');
            assert.ok(state.page > 0, 'Keys inside the iframe must scroll its webpage normally.');
            assert.equal(state.pan, 0, 'Page keys must not pan the canvas.');
            const before = state.page;
            await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 120 });
            await waitFor(`frame.contentWindow.scrollY > ${before}`);
            state = await evaluate('canvasInputState()');
            assert.ok(state.page > before, 'Wheel input over the iframe must scroll the page.');
            assert.equal(state.pan, 0, 'Page wheel input must leave the canvas in place.');
            assert.equal(state.width, 390);
            assert.equal(state.height, 844);
            await evaluate(`Object.assign(document.querySelector('.mtflpp-panel').style, {width:'640px',height:'1300px'}); viewport.setFit('automatic'); viewport.layout()`);
            await waitFor('canvas.clientWidth === 640 && canvas.clientHeight >= 1200');
            const canvasSize = await evaluate('[canvas.clientWidth, canvas.clientHeight]');
            for (const dpr of [2, 1.25, 0.75, 1, 2]) await t.test(`DPR ${dpr}: 100% paints the viewport at 390×844 physical pixels`, async () => {
                // The panel stays fixed, so ResizeObserver cannot drive these updates.
                // Also exercise the window-resize fallback when returning from zoomed-out DPR.
                await send('Emulation.setDeviceMetricsOverride', {width:dpr === 1 ? 1281 : 1280,height:1400,deviceScaleFactor:dpr,mobile:false});
                // Headless Chromium needs a rendered frame to deliver resolution media events.
                await send('Page.captureScreenshot', {format:'png'});
                await waitFor(`Math.abs(document.querySelector('.mtflpp-stage').getBoundingClientRect().width - ${390 / dpr}) < 0.01`);
                const after = await evaluate(`({...canvasInputState(), dpr:devicePixelRatio, readout:document.querySelector('.mtflpp-dimensions').textContent})`);
                assert.equal(after.dpr, dpr);
                assert.equal(after.width, 390);
                assert.equal(after.height, 844);
                assert.equal(after.page, state.page);
                assert.equal(after.readout, `Phone (390 × 844) · ${after.zoom}%`);
                assert.equal(after.zoom, 100);
                assert.deepEqual(await evaluate('[canvas.clientWidth, canvas.clientHeight]'), canvasSize, 'DPR changes must not resize the panel.');
                const rect = await evaluate(`(() => {const r=frame.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()`);
                const {data} = await send('Page.captureScreenshot', {format:'png',captureBeyondViewport:true,clip:rect});
                const png = Buffer.from(data, 'base64');
                assert.equal(png.readUInt32BE(16), 390, 'Native screenshot width must match the 1:1 pixel reference.');
                assert.equal(png.readUInt32BE(20), 844, 'Native screenshot height must match the 1:1 pixel reference.');
            });
            for (const fit of ['automatic', 'window', 'width']) {
                await evaluate(`viewport.setFit(${JSON.stringify(fit)})`);
                const after = await evaluate(`({...canvasInputState(), readout:document.querySelector('.mtflpp-dimensions').textContent, paintedZoom:Math.round(document.querySelector('.mtflpp-stage').getBoundingClientRect().width / 390 * devicePixelRatio * 100)})`);
                assert.equal(after.zoom, after.paintedZoom, 'The Zoom control consumes the same computed percentage as the painted preview.');
                assert.equal(after.readout, `Phone (390 × 844) · ${after.zoom}%`);
                assert.equal(after.width, 390);
                assert.equal(after.height, 844);
                assert.equal(after.page, state.page, 'Changing zoom must preserve the native page scroll position.');
            }
            await t.test('fixed 80% preserves CSS geometry and paints at 80% of the screen-pixel reference', async () => {
                await evaluate('viewport.setZoom(80)');
                await waitFor('Math.abs(frame.getBoundingClientRect().width - 156) < 0.01');
                const after = await evaluate('canvasInputState()');
                assert.equal(after.zoom, 80);
                assert.equal(after.width, 390);
                assert.equal(after.height, 844);
                assert.equal(after.page, state.page);
                const rect = await evaluate('(() => {const r=frame.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()');
                const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: rect });
                const png = Buffer.from(data, 'base64');
                assert.equal(png.readUInt32BE(16), 312);
                assert.ok(Math.abs(rect.height * 2 - 675.2) < 0.01, 'The painted viewport retains its exact subpixel height.');
                // Native screenshot crops quantize fractional clip bounds, unlike layout geometry.
                assert.ok(Math.abs(png.readUInt32BE(20) - 675.2) <= 2, `Captured height: ${png.readUInt32BE(20)}; CSS clip: ${JSON.stringify(rect)}`);
            });
            await t.test('explicit width fitting supports native canvas keys and wheel input independently of the webpage', async () => {
                await evaluate(`Object.assign(document.querySelector('.mtflpp-panel').style, {width:'480px',height:'340px'}); viewport.setFit('width'); viewport.layout(); canvas.focus({preventScroll:true})`);
                await waitFor('canvas.tabIndex === 0 && canvas.scrollHeight > canvas.clientHeight');
                const page = (await evaluate('canvasInputState()')).page;
                await key('PageDown', 34, 'canvas.scrollTop > 0');
                assert.equal((await evaluate('canvasInputState()')).page, page);
                await key('End', 35, 'Math.abs(canvas.scrollTop + canvas.clientHeight - canvas.scrollHeight) <= 1');
                await key('Home', 36, 'canvas.scrollTop === 0');
                // The native canvas scrollbar gutter navigates the viewport, not its webpage.
                await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 475, y: 100, deltaX: 0, deltaY: 60 });
                await waitFor('canvas.scrollTop > 0');
                assert.equal((await evaluate('canvasInputState()')).page, page);
                await key('Home', 36, 'canvas.scrollTop === 0');
                await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 100, deltaX: 0, deltaY: 120 });
                await waitFor(`frame.contentWindow.scrollY > ${page}`);
                const after = await evaluate('({...canvasInputState(), fit:viewport.fit})');
                assert.equal(after.pan, 0, 'Page-interior wheel input must not pan the width-fit canvas.');
                assert.equal(after.fit, 'width');
                assert.ok(after.zoom > 100);
                assert.equal(after.width, 390);
                assert.equal(after.height, 844);
            });
            for (const fit of ['automatic', 'width', 'custom']) for (const boundary of ['top', 'bottom']) {
                await t.test(`${fit}: trusted iframe wheel at the page ${boundary} stays out of the canvas`, async () => {
                    await evaluate(`viewport.${fit === 'custom' ? 'setZoom(100)' : `setFit('${fit}')`}; viewport.layout(); canvas.scrollTop = ${fit !== 'automatic' && boundary === 'top' ? 100 : 0}; frame.contentWindow.scrollTo(0, ${boundary === 'top' ? 0 : 'frame.contentDocument.documentElement.scrollHeight'})`);
                    await waitFor(`canvas.scrollTop === ${fit !== 'automatic' && boundary === 'top' ? 100 : 0} && ${boundary === 'top' ? 'frame.contentWindow.scrollY === 0' : 'frame.contentWindow.scrollY + frame.contentWindow.innerHeight >= frame.contentDocument.documentElement.scrollHeight'}`);
                    // Paint the new canvas position before sending actual input into the iframe.
                    await send('Page.captureScreenshot', { format: 'png' });
                    const before = await evaluate('canvasInputState()');
                    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 100, deltaX: 0, deltaY: boundary === 'top' ? -120 : 120 });
                    await waitFor(`canvasInputState().wheels > ${before.wheels}`);
                    await delay(150); // Observe the wheel's native default action, not just its delivery.
                    const after = await evaluate('canvasInputState()');
                    assert.equal(after.pan, before.pan, 'Reaching a webpage boundary must not pan its separate canvas.');
                    assert.equal(after.page, before.page, 'The page must remain at its own boundary.');
                    assert.equal(after.width, 390);
                    assert.equal(after.height, 844);
                    assert.equal(after.zoom, before.zoom);
                    assert.equal(await evaluate('viewport.fit'), fit);
                    assert.equal(await evaluate('frame.contentWindow.getComputedStyle(frame.contentDocument.documentElement).overscrollBehavior'), 'contain');
                });
            }
            await t.test('trusted arrow keys navigate both axes at fixed zoom without scrolling the page', async () => {
                await evaluate(`Object.assign(document.querySelector('.mtflpp-panel').style, {width:'480px',height:'340px'}); viewport.select('desktop'); viewport.setZoom(400); frame.contentWindow.scrollTo(0, 100); canvas.focus({preventScroll:true})`);
                await waitFor('canvas.scrollWidth > canvas.clientWidth && canvas.scrollHeight > canvas.clientHeight');
                const page = (await evaluate('canvasInputState()')).page;
                await key('ArrowRight', 39, 'canvas.scrollLeft > 0');
                await key('ArrowDown', 40, 'canvas.scrollTop > 0');
                let after = await evaluate('canvasInputState()');
                assert.ok(after.panX > 0 && after.pan > 0);
                assert.equal(after.page, page);
                assert.equal(after.pageX, 0);
                assert.equal(after.zoom, 400);
                assert.equal(after.width, 1280);
                assert.equal(after.height, 800);
                await delay(150); // Let native keyboard scrolling settle before checking wheel isolation.
                after = await evaluate('canvasInputState()');
                await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 120 });
                await waitFor(`frame.contentWindow.scrollY > ${page}`);
                const wheel = await evaluate('canvasInputState()');
                assert.equal(wheel.panX, after.panX);
                assert.equal(wheel.pan, after.pan);
                await evaluate(`Object.assign(document.querySelector('.mtflpp-panel').style, {width:'640px',height:'600px'}); viewport.layout()`);
                assert.equal((await evaluate('canvasInputState()')).zoom, 400, 'Panel resizing never changes fixed zoom.');
                await send('Emulation.setDeviceMetricsOverride', { width: 1281, height: 1400, deviceScaleFactor: 1, mobile: false });
                await send('Page.captureScreenshot', { format: 'png' });
                await waitFor('Math.abs(frame.getBoundingClientRect().width - 5120) < 0.01');
                assert.equal((await evaluate('canvasInputState()')).zoom, 400, 'A host DPR change preserves the selected manual percentage.');
            });
            await t.test('trusted wheel input takes priority over pending breakpoint following', async () => {
                await evaluate(`(async () => {
                    viewport.setFit('automatic');
                    viewport.select('desktop');
                    const doc = frame.contentDocument, win = frame.contentWindow;
                    const style = doc.createElement('style');
                    style.textContent = 'html{overflow-anchor:none} #edit{position:relative;top:600px;height:30px;margin:0} @media (max-width:400px){#edit{top:1600px}}';
                    doc.head.append(style);
                    const target = doc.createElement('p');
                    target.id = 'edit'; target.textContent = 'Changed';
                    doc.querySelector('main').append(target);
                    const scrolling = createPreviewScroll(), anchor = await scrolling.restore(doc, target);
                    const gate = {};
                    gate.promise = new Promise((resolve) => { gate.release = resolve; });
                    window.wheelFollow = { gate, oldScroll: win.scrollY };
                    const pending = scrolling.keepInView(anchor, {
                        canvas, canvasTarget: (bounds) => viewport.canvasTarget(frame,bounds),
                        canvasWasPanned: viewport.canvasWasPanned, finishMotion: viewport.finishMotion,
                        whenSettled: () => { wheelFollow.waiting = true; return gate.promise; },
                        canFollow: () => true,
                    });
                    viewport.select('mobile', { animate: true, keepPan: !!pending });
                    pending?.then(() => { wheelFollow.done = true; });
                })()`);
                await waitFor('wheelFollow.waiting');
                const { x, y } = await evaluate(`(() => {
                    const rect = frame.getBoundingClientRect(), clip = canvas.getBoundingClientRect();
                    return { x: Math.round((Math.max(rect.left, clip.left) + Math.min(rect.right, clip.right)) / 2),
                        y: Math.round((Math.max(rect.top, clip.top) + Math.min(rect.bottom, clip.bottom)) / 2) };
                })()`);
                // Assert cancellation on the trusted input itself, before its default action scrolls the page.
                await evaluate(`frame.contentDocument.addEventListener('wheel', (event) => {
                    if (event.isTrusted) { wheelFollow.delivered = true; event.preventDefault(); }
                }, {once:true,passive:false})`);
                await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120 });
                await waitFor('wheelFollow.delivered');
                await evaluate('wheelFollow.gate.release()');
                await waitFor('wheelFollow.done');
                assert.equal(await evaluate('frame.contentWindow.scrollY'), await evaluate('wheelFollow.oldScroll'),
                    'A pending reveal must not scroll after the user takes control.');
            });
            for (const path of ['unmarked', 'plain']) await t.test(`${path}: native output is displayed without scroll containment`, async () => {
                await evaluate(`preview.load(new URL('/${path}?mtflpp_token=trusted-scroll', location.href).href, () => true)`);
                const output = await evaluate(`(() => {
                    const frame = document.querySelector('iframe'), doc = frame.contentDocument;
                    return {type:doc.contentType,style:doc.documentElement.getAttribute('style'),text:doc.body.textContent,path:new URL(frame.src).pathname};
                })()`);
                assert.equal(output.path, `/${path}`);
                assert.equal(output.type, path === 'plain' ? 'text/plain' : 'text/html');
                assert.equal(output.style, null, 'Do not add preview-only root styles to unverified output.');
                if (path === 'plain') assert.equal(output.text, 'Native text output');
            });
            await t.test('only confirmed redirects to unmarked same-origin HTML expose a display path', async () => {
                const load = async (path) => {
                    await evaluate(`preview.load(new URL('/${path}?mtflpp_token=trusted-scroll', location.href).href, () => true)`);
                    assert.equal(await evaluate('reports.at(-1).state'), 'ready', 'Do not turn redirected output into an error.');
                    return evaluate('preview.redirectDestination');
                };
                assert.equal(await load('redirect-html'), '/unmarked', 'Exclude destination query values and fragments from the note.');
                const output = await evaluate(`(() => {
                    const frame = document.querySelector('iframe'), doc = frame.contentDocument;
                    return [doc.body.textContent, doc.documentElement.style.overscrollBehavior, new URL(frame.src).pathname];
                })()`);
                assert.deepEqual(output, ['Scrollable page', '', '/redirect-html'], 'Leave the native output and authorized request unchanged.');
                await evaluate(`document.querySelector('iframe').contentWindow.location.assign('/unmarked')`);
                await waitFor('!preview.redirectDestination');
                for (const path of ['unmarked', 'rewrite', 'redirect-marked', 'redirect-plain', 'redirect-other-origin']) {
                    assert.equal(await load(path), undefined, `No redirect notice for ${path}.`);
                }
                assert.equal(await load('redirect-html-rewrite'), '/rewrite', 'Report the redirect destination even if it rewrites its URL.');
                assert.equal(await evaluate(`new URL(document.querySelector('iframe').contentDocument.URL).pathname`), '/unmarked');
                await evaluate('preview.clear()');
                assert.equal(await evaluate('preview.redirectDestination'), undefined);
            });
        } finally {
            t.signal.removeEventListener('abort', abort);
            if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
                await new Promise((resolve) => { chrome.once('exit', resolve); chrome.kill(); });
            }
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
