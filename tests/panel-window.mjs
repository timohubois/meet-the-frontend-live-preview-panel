import assert from 'node:assert/strict';
import { getEventListeners, setMaxListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { sourceForVm } from './helpers/modules.mjs';
import { createPanelGeometry } from '../src/panel/geometry.js';
import { createPreviewViewport } from '../src/panel/viewport.js';
import { panelStrings, blockEditorStrings, acfStrings } from './helpers/panel-strings.mjs';
import test from 'node:test';
import vm from 'node:vm';

const source = await sourceForVm(new URL('../src/panel/window.js', import.meta.url));

// Exercise the view's lifecycle and launcher label with a simulated browser.
function fixture(open = false, {
    layout, position, rememberPosition, preferences: savedPreferences, labels = {},
    width = 1440, height = 1000, direction = 'ltr', lang = 'en-US', gutter = 20, scrollbar = 0, toolbarHeight = 32,
    nativeSaving = false, pip = false, pipApi, videoPip = false, stylesheets = [], publicRedirect, fetch,
} = {}) {
    const nodes = new Map();
    const preferences = new Map(savedPreferences ?? [
        ['panelOpen', open], ['layout', layout], ['position', position], ['rememberPosition', rememberPosition],
    ]);
    const writes = [];
    const target = (element) => Object.assign(new EventTarget(), element, {
        fire(type, properties = {}) {
            const event = Object.assign(new Event(type, { cancelable: true }), {
                button: 0, pointerId: 1, clientX: 100, clientY: 100, ...properties,
            });
            this.dispatchEvent(event);
            return event;
        },
    });
    const document = target({ pictureInPictureEnabled: videoPip, getElementById: (id) => node(id) });
    function node(key) {
        if (nodes.has(key)) return nodes.get(key);
        const captured = new Set();
        const classes = new Set();
        const element = target({
            key, ownerDocument: document, style: { setProperty() {}, removeProperty() {} }, dataset: {}, textContent: '',
            classList: {
                add: (name) => classes.add(name), remove: (name) => classes.delete(name),
                toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
                contains: (name) => classes.has(name),
            },
            setAttribute() {}, removeAttribute() {}, replaceChildren() {},
            append(child) { this.lastElementChild = child; },
            prepend(child) { this.firstElementChild = child; },
            focus() { document.activeElement = this; },
            contains: (other) => other === element || other?.key?.startsWith(`${key} `),
            setPointerCapture: (pointer) => captured.add(pointer),
            hasPointerCapture: (pointer) => captured.has(pointer),
            releasePointerCapture: (pointer) => captured.delete(pointer),
            querySelector: (selector) => node(`${key} ${selector}`),
            querySelectorAll: (selector) => selector === '[data-resize-edge]' ? ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].map((edge) => {
                const handle = node(`${key} .aflpp-edge-${edge}`);
                handle.dataset.resizeEdge = edge;
                return handle;
            }) : [],
        });
        nodes.set(key, element);
        return element;
    }
    document.documentElement = node('html');
    document.documentElement.lang = lang;
    Object.defineProperties(document.documentElement, {
        clientWidth: { get: () => window.innerWidth - scrollbar },
        clientHeight: { get: () => window.innerHeight },
    });
    document.documentElement.getBoundingClientRect = () => ({ left: direction === 'rtl' ? scrollbar : 0 });
    document.querySelector = (selector) => selector === '#wpbody-content > .wrap' ? node('wrap') : null;
    node('wrap').getBoundingClientRect = () => ({
        left: (direction === 'rtl' ? scrollbar + gutter : 180),
        right: (direction === 'rtl' ? scrollbar : 0) + window.innerWidth - scrollbar - (direction === 'rtl' ? 180 : gutter),
    });
    node('wpadminbar').getBoundingClientRect = () => ({ bottom: toolbarHeight });
    const styleNodes = stylesheets.map((style) => target({ ...style, cloneNode: () => target({ ...style }) }));
    document.querySelectorAll = (selector) => styleNodes.filter(({ id, href = '', rel, dataEmotion, dataWpHash }) => selector.split(', ').some((part) =>
        part === 'style[data-emotion]' ? dataEmotion !== undefined
            : part === 'style[data-wp-hash]' ? dataWpHash !== undefined
                : part.startsWith('#') ? id === part.slice(1) : rel === 'stylesheet' && href.includes('/load-styles.php')
    ));
    const copiedStyles = [];
    const detachedDocument = { documentElement: node('pip-html'), head: { append: (style) => copiedStyles.push(style) } };
    detachedDocument.body = { append: (panel) => { panel.ownerDocument = detachedDocument; } };
    document.body = { append: (panel) => { panel.ownerDocument = document; } };
    const detached = target({ document: detachedDocument, close() { this.fire('pagehide'); } });
    const requests = [];
    const launcherContainer = node('aflpp-toggle');
    const launcher = node('launcher-button');
    launcher.title = 'Live preview'; // Native Button's action label.
    launcherContainer.offsetWidth = 160;
    launcherContainer.offsetHeight = 40;
    const window = target({
        location: { origin: 'https://site.test' }, fetch,
        innerWidth: width, innerHeight: height, scrollX: 0, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        getComputedStyle: () => ({ direction, cursor: 'ew-resize', getPropertyValue: () => '' }),
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        ResizeObserver: class { observe() {} disconnect() {} },
        wp: { data: {
            select: () => ({ get: (scope, key) => preferences.get(key) }),
            dispatch: () => ({ setDefaults() {}, set: (scope, key, value) => {
                preferences.set(key, value);
                writes.push({ key, value });
            } }),
        } },
    });
    document.defaultView = window;
    detachedDocument.defaultView = detached;
    detached.ResizeObserver = window.ResizeObserver;
    detached.matchMedia = window.matchMedia;
    for (const selector of ['aflpp-panel .aflpp-viewport', 'aflpp-panel .aflpp-viewport .aflpp-canvas']) Object.defineProperties(node(selector), {
        clientWidth: { get: () => parseFloat(node('aflpp-panel').style.width) || 0 },
        clientHeight: { get: () => Math.max(0, (parseFloat(node('aflpp-panel').style.height) || 0) - 92) },
    });
    setMaxListeners(0, window); // Browser windows have no Node listener warning limit.
    if (pip) window.documentPictureInPicture = { requestWindow: async (options) => { requests.push(options); return detached; } };
    if (pipApi !== undefined) window.documentPictureInPicture = pipApi;
    const strings = new Proxy({ title: 'Live preview', preview: 'Preview', loading: 'Loading preview…', ...labels }, {
        get: (target, key) => target[key] ?? String(key),
    });
    let actions;
    let state;
    const focusCalls = [];
    const retryCalls = [];
    const refreshCalls = [];
    const controls = { closeMenu() {}, focus(action) { focusCalls.push(action); }, beforeMove() {}, remount() {}, update(next) { state = next; } };
    const createControls = (panel, labels, callbacks) => { actions = callbacks; return controls; };
    const imports = {
        '@wordpress/data': window.wp.data,
        '@wordpress/preferences': { store: { name: 'core/preferences' } },
        './geometry.js': { createPanelGeometry },
        './controls.js': { createPreviewControls: createControls, createPreviewLauncher: () => launcher },
        './viewport.js': { createPreviewViewport },
    };
    delete window.wp;
    const createPreviewPanel = vm.runInNewContext(`${source}\ncreatePreviewPanel`, { window, document, imports, URL });
    const view = createPreviewPanel(strings, {
        nativeSaving, publicRedirect, beforeMove() {}, afterMove() {},
        onOpen() { view.setVisible(true); }, onClose() { view.setVisible(false); }, onRetry(takeOver) { retryCalls.push(takeOver); },
        onRefresh(follow = true) { refreshCalls.push({ follow, enabled: preferences.get('scrollToChanges') }); },
    });
    const panel = node('aflpp-panel');
    return {
        view, launcher, launcherContainer, panel, node, actions, window, document, preferences, writes, detached, copiedStyles,
        requests, focusCalls, retryCalls, refreshCalls,
        get state() { return state; },
        rect: () => Object.fromEntries(['left', 'top', 'width', 'height'].map((key) => [key, parseFloat(panel.style[key])])),
        resizeTo(width, height) {
            const currentWidth = parseFloat(panel.style.width), currentHeight = parseFloat(panel.style.height);
            const dx = state.dock === 'left' ? width - currentWidth
                : (currentWidth - width) / (state.dock === 'center' ? 2 : 1);
            const grip = node('aflpp-panel .aflpp-resize');
            grip.fire('pointerdown');
            grip.fire('pointermove', { clientX: 100 + dx, clientY: 100 + currentHeight - height });
            grip.fire('pointerup');
        },
    };
}

for (const combined of [false, true]) {
    test(`PiP retains native control styles with ${combined ? 'concatenated' : 'standalone'} core CSS`, async () => {
        const core = combined
            ? { rel: 'stylesheet', href: '/wp-admin/load-styles.php?load%5Bchunk_0%5D=common,forms,wp-components' }
            : { id: 'wp-components-css', rel: 'stylesheet', href: '/wp-includes/css/dist/components/style.min.css' };
        const inline = { id: 'wp-components-inline-css' };
        const theme = { id: 'wp-theme-css', rel: 'stylesheet', href: '/wp-includes/css/dist/theme/design-tokens.min.css' };
        const themeInline = { id: 'wp-theme-inline-css' };
        const panel = { id: 'a-floating-live-preview-panel-css', rel: 'stylesheet', href: '/build/classic-editor.css' };
        const panelInline = { id: 'a-floating-live-preview-panel-inline-css' };
        const h = fixture(true, { pip: true, stylesheets: [
            theme, themeInline, core, inline,
            { id: 'unrelated-css', rel: 'stylesheet', href: '/unrelated.css' }, panel, panelInline,
        ] });
        assert.equal(h.state.canPip, true, 'Document PiP does not require video PiP support');
        await h.actions.popOut();
        assert.deepEqual(h.copiedStyles.map(({ id, href }) => ({ id, href })),
            [theme, themeInline, core, inline, panel, panelInline].map(({ id, href }) => ({ id, href })));
        assert.ok(h.copiedStyles.every((style) => getEventListeners(style, 'load').length === 1));
        assert.equal(h.panel.ownerDocument, h.detached.document);
        assert.equal(h.state.inPip, true);
        h.detached.close();
        assert.equal(h.panel.ownerDocument, h.document);
        assert.equal(h.state.mode, 'expand');
        assert.equal(h.writes.length, 0, 'PiP styling and document moves must not change layout preferences');
    });
}

for (const { direction, lang } of [{ direction: 'ltr', lang: 'en-US' }, { direction: 'rtl', lang: 'ar' }]) {
    test(`PiP preserves inherited ${direction} direction and ${lang} language`, async () => {
        const h = fixture(true, { pip: true, direction, lang });
        assert.equal(h.panel.dir, undefined, 'Direction is inherited, not set on the panel.');
        await h.actions.popOut();
        assert.equal(h.state.inPip, true);
        assert.equal(h.detached.document.documentElement.dir, direction);
        assert.equal(h.detached.document.documentElement.lang, lang);
        h.detached.close();
        assert.equal(h.panel.ownerDocument, h.document);
        assert.equal(h.document.documentElement.lang, lang);
        assert.equal(h.panel.dir, undefined, 'Moving back must not add panel-level direction overrides.');
        assert.equal(h.writes.length, 0, 'Document metadata must not change preferences.');
    });
}

for (const cssom of [false, true]) {
    test(`PiP copies runtime spinner styles and keyframes from ${cssom ? 'CSSOM-only' : 'text-backed'} stylesheets`, async () => {
        const rules = [
            '.native-spinner { color: #2271b1; overflow: visible; }',
            '.native-spinner path { fill: transparent; stroke: currentColor; animation: native-spin 1.4s linear infinite; }',
            '@keyframes native-spin { to { transform: rotate(360deg); } }',
        ];
        const runtime = {
            tagName: 'STYLE', dataEmotion: 'css', textContent: cssom ? '' : rules.join('\n'),
            sheet: { cssRules: rules.map((cssText) => ({ cssText })) },
        };
        const module = { tagName: 'STYLE', dataWpHash: 'native-module', textContent: '.native-module { margin: 0; }' };
        const h = fixture(true, { pip: true, stylesheets: [runtime, module, { tagName: 'STYLE', textContent: '.unrelated {}' }] });
        await h.actions.popOut();
        assert.equal(h.state.inPip, true);
        assert.deepEqual(h.copiedStyles.map(({ textContent }) => textContent), [rules.join('\n'), module.textContent]);
        assert.equal(runtime.textContent, cssom ? '' : rules.join('\n'), 'Never modify the editor stylesheet.');
        h.view.report('updating', 'loading', { hasPreview: true });
        assert.equal(h.state.busy, true, 'The copied spinner styles remain available for later refreshes.');
        h.detached.close();
        await h.actions.popOut();
        assert.deepEqual(h.copiedStyles.slice(2).map(({ textContent }) => textContent), [rules.join('\n'), module.textContent]);
    });
}

for (const scenario of [
    { name: 'no PiP API' },
    { name: 'video PiP only', videoPip: true },
    { name: 'null Document PiP API', pipApi: null },
    { name: 'incomplete Document PiP API', pipApi: {} },
    { name: 'non-callable requestWindow', pipApi: { requestWindow: true } },
]) {
    test(`PiP remains unavailable with ${scenario.name}`, async () => {
        const h = fixture(true, scenario);
        const before = h.rect();
        assert.equal(h.state.canPip, false);
        await h.actions.popOut();
        assert.equal(h.state.inPip, false);
        assert.equal(h.requests.length, 0);
        assert.deepEqual(h.rect(), before);
        assert.equal(h.writes.length, 0);
    });
}

test('PiP is transient and adds no navigation handling or automatic reopening', async () => {
    const h = fixture(true, { pip: true });
    await h.actions.popOut();
    assert.equal(h.requests.length, 1);
    assert.equal(h.state.inPip, true);
    assert.equal(getEventListeners(h.window, 'beforeunload').length, 0);
    assert.equal(h.writes.length, 0);
    h.detached.close();
    const next = fixture(true, { pip: true });
    assert.equal(next.state.inPip, false);
    assert.equal(next.requests.length, 0, 'opening PiP always needs an explicit user action');
    assert.equal(next.writes.length, 0);
});

test('rejected PiP leaves in-page geometry intact', async () => {
    const h = fixture(true, { pip: true });
    const before = h.rect();
    h.window.documentPictureInPicture.requestWindow = async () => { throw new Error('Rejected'); };
    await h.actions.popOut();
    assert.equal(h.state.inPip, false);
    assert.deepEqual(h.rect(), before);
    assert.equal(h.writes.length, 0);
});

test('an initially closed panel does not claim to load a preview on launcher hover', () => {
    const { view, launcher } = fixture();
    assert.equal(view.visible, false);
    assert.equal(launcher.title, 'Live preview');
});

test('launcher geometry and visibility apply to its floating surface while the native Button owns interactions', () => {
    const h = fixture();
    assert.equal(h.launcherContainer.hidden, false);
    assert.ok(parseFloat(h.launcherContainer.style.left) > 0);
    assert.equal(h.launcher.style.left, undefined, 'Do not position the Button separately from its floating surface.');
    for (const event of ['click', 'keydown', 'pointerdown']) {
        assert.equal(getEventListeners(h.launcher, event).length, 1);
        assert.equal(getEventListeners(h.launcherContainer, event).length, 0);
    }
    h.launcher.fire('click', { detail: 0 });
    assert.equal(h.launcherContainer.hidden, true, 'Do not leave an empty floating surface behind the open panel.');
    h.actions.close();
    assert.equal(h.launcherContainer.hidden, false);
    assert.equal(h.document.activeElement, h.launcher);
});

test('a native Save during startup does not override remembered panel visibility', () => {
    assert.equal(fixture(true, { nativeSaving: true }).view.visible, true);
    assert.equal(fixture(false, { nativeSaving: true }).view.visible, false);
});

test('closing a ready panel clears its frame without changing the launcher into a loading indicator', () => {
    const { view, launcher, launcherContainer, panel } = fixture(true);
    view.report(panelStrings.current, 'ready', { hasPreview: true });
    view.setVisible(false);
    view.clearPreview();
    assert.equal(panel.hidden, true);
    assert.equal(launcherContainer.hidden, false);
    assert.equal(launcher.title, 'Live preview');
});

test('pending, loading, ready and problem states keep refresh activity and accessible status in sync', () => {
    const h = fixture(true);
    const status = h.node('aflpp-panel [role="status"]');
    h.view.report('Loading preview…', 'loading', { hasPreview: false });
    assert.equal(status.textContent, 'Loading preview…');
    h.view.report(panelStrings.stale, 'stale', { hasPreview: true });
    assert.equal(status.textContent, 'Waiting to update preview…');
    assert.equal(h.state.busy, true, 'Show activity while changes wait for the debounced refresh.');
    assert.equal(h.state.canRefresh, false);
    assert.equal(h.state.empty, null, 'Keep the previous frame visible.');
    assert.equal(h.state.notice, null);
    h.view.report('Updating preview…', 'loading', { hasPreview: true });
    assert.equal(status.textContent, 'Updating preview…');
    assert.equal(h.state.busy, true);
    h.view.report(panelStrings.current, 'ready', { hasPreview: true, canRefresh: true });
    assert.equal(status.textContent, 'Preview updated');
    assert.equal(h.state.busy, false);
    h.view.report('Could not refresh', 'error', { hasPreview: true, canRetry: true });
    assert.match(status.textContent, /Could not refresh/);
    assert.equal(h.state.busy, false, 'A failed refresh must not leave the spinner running.');
    assert.equal(h.state.notice.heading, 'Could not refresh');
});

test('enabling following refreshes its baseline once without following, while disabling only saves the preference', () => {
    const h = fixture(true, { preferences: [['scrollToChanges', false]] });
    h.view.report(panelStrings.current, 'ready', { hasPreview: true, canRefresh: true });
    assert.equal(h.refreshCalls.length, 0, 'Restoring a preference must not request an extra refresh.');
    h.actions.follow();
    assert.equal(h.view.followChanges, true);
    assert.equal(h.state.followChanges, true);
    assert.deepEqual(h.refreshCalls, [{ follow: false, enabled: true }]);
    h.actions.follow();
    assert.equal(h.view.followChanges, false);
    assert.equal(h.preferences.get('scrollToChanges'), false);
    assert.equal(h.refreshCalls.length, 1, 'Disabling following must not reload the preview.');
    h.actions.follow();
    assert.deepEqual(h.refreshCalls, [{ follow: false, enabled: true }, { follow: false, enabled: true }]);
    h.actions.refresh();
    assert.deepEqual(h.refreshCalls.at(-1), { follow: true, enabled: true }, 'Manual refresh keeps its existing following behavior.');
});

for (const state of ['loading', 'stale', 'paused', 'conflict', 'error']) {
    test(`enabling following respects the existing refresh gate while ${state}`, () => {
        const h = fixture(true, { preferences: [['scrollToChanges', false]] });
        h.view.report('Not ready to refresh', state, { hasPreview: true, canRefresh: false });
        h.actions.follow();
        assert.equal(h.preferences.get('scrollToChanges'), true);
        assert.equal(h.refreshCalls.length, 0, 'An in-flight load or native recovery must not be restarted by a preference.');
    });
}

test('hidden-panel drain and error messages do not replace the launcher action label', () => {
    const { view, launcher } = fixture();
    view.report('Finishing preview before continuing…');
    assert.equal(launcher.title, 'Live preview');
    view.report('Reload the editor', 'error', { reason: 'reload', canRetry: false });
    assert.equal(launcher.title, 'Live preview');
});

const layout = (overrides = {}) => ({
    bounds: { x: 150, y: 180, width: 560, height: 420 }, dock: null, expanded: false, ...overrides,
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const inside = (h) => {
    const { left, top, width, height } = h.rect();
    assert.ok(left >= 0 && top >= 0 && width > 0 && height > 0);
    assert.ok(left + width <= h.window.innerWidth && top + height <= h.window.innerHeight);
};

test('compact geometry is restored without writing preferences on load', () => {
    const h = fixture(true, { layout: layout() });
    assert.deepEqual(h.rect(), { left: 150, top: 180, width: 560, height: 420 });
    assert.equal(h.state.dock, null);
    assert.equal(h.writes.length, 0);
});

test('remembering size and position defaults to on with a 480×393 bottom-right panel', () => {
    const h = fixture(true);
    assert.equal(h.state.rememberPosition, true);
    assert.deepEqual(h.rect(), { left: 940, top: 587, width: 480, height: 393 });
    assert.equal(h.actions.size, undefined, 'Named size presets are no longer actions.');
    assert.equal(h.state.dock, 'right');
    assert.equal(h.state.mode, 'expand');
    assert.equal(h.state.device, 'desktop');
    assert.equal(h.state.fit, 'automatic');
    assert.equal(h.node('aflpp-panel .aflpp-stage').style.width, '1280px');
    assert.equal(h.node('aflpp-panel .aflpp-stage').style.height, '800px');
    assert.equal(h.writes.length, 0);
});

test('the new default fits a small window temporarily without saving smaller dimensions', () => {
    const h = fixture(true, { width: 390, height: 300 });
    inside(h);
    assert.ok(h.rect().width < 480);
    assert.ok(h.rect().height < 393);
    h.window.innerWidth = 1440;
    h.window.innerHeight = 1000;
    h.window.fire('resize');
    assert.deepEqual(h.rect(), { left: 940, top: 587, width: 480, height: 393 });
    assert.equal(h.state.fit, 'automatic');
    assert.equal(h.preferences.get('layout'), undefined);
    assert.equal(h.writes.length, 0);
});

for (const position of ['left', 'center', 'right']) {
    test(`${position} preset persists while remembering is off, without persisting manual layout changes`, () => {
        const h = fixture(true, { rememberPosition: false });
        h.actions.dock(position);
        assert.equal(h.preferences.get('position'), position);
        h.resizeTo(640, 440);
        h.node('aflpp-panel .aflpp-resize').fire('keydown', { key: 'ArrowUp' });
        const move = h.node('aflpp-panel .aflpp-move-control');
        move.fire('keydown', { key: position === 'left' ? 'ArrowRight' : 'ArrowLeft' });
        move.fire('pointerdown');
        move.fire('pointermove', { clientY: 80 });
        move.fire('pointerup');
        assert.equal(h.state.dock, null);
        assert.equal(h.preferences.get('position'), position, 'Dragging must not erase the preferred preset.');
        h.actions.mode();
        const current = h.rect();
        h.actions.close();
        h.launcher.fire('click', { detail: 0 });
        assert.deepEqual(h.rect(), current, 'Closing and reopening without navigation keeps the current layout.');
        assert.equal(h.state.mode, 'compact');
        assert.equal(h.writes.some(({ key }) => key === 'layout'), false);

        const reopened = fixture(true, { preferences: h.preferences, width: 1000, height: 800 });
        assert.equal(reopened.state.rememberPosition, false);
        assert.equal(reopened.state.dock, position);
        assert.equal(reopened.state.mode, 'expand');
        assert.equal(reopened.rect().width, 480);
        assert.deepEqual(reopened.rect(), {
            left: position === 'left' ? 20 : position === 'center' ? 260 : 500,
            top: 387, width: 480, height: 393,
        });
        assert.equal(reopened.writes.length, 0);
    });

    for (const custom of [false, true]) {
        test(`${position} preset is inherited from an older ${custom ? 'dragged' : 'docked'} layout when remembering is disabled`, () => {
            const h = fixture(true, { layout: layout({ dock: custom ? null : position, anchor: position, expanded: true }) });
            const before = h.rect();
            h.actions.rememberPosition();
            assert.deepEqual(h.rect(), before, 'Disabling must not move, resize or collapse the current panel.');
            assert.equal(h.state.mode, 'compact');
            assert.equal(h.state.rememberPosition, false);
            assert.equal(h.preferences.get('layout'), undefined);
            assert.equal(h.preferences.get('position'), position);
            const reopened = fixture(true, { preferences: h.preferences });
            assert.equal(reopened.state.dock, position);
            assert.equal(reopened.rect().width, 480);
            assert.equal(reopened.state.mode, 'expand');
        });
    }
}

test('re-enabling remembers the current layout rather than restoring an older one', () => {
    const h = fixture(true, { rememberPosition: false, position: 'left', layout: layout({ expanded: true }) });
    assert.equal(h.state.dock, 'left', 'Disabled remembering ignores stale saved geometry.');
    assert.equal(h.rect().width, 480);
    assert.equal(h.state.mode, 'expand');
    h.resizeTo(640, 440);
    h.node('aflpp-panel .aflpp-move-control').fire('keydown', { key: 'ArrowRight', shiftKey: true });
    const compact = h.rect();
    h.actions.mode();
    const expanded = h.rect();
    h.actions.rememberPosition();
    assert.deepEqual(h.rect(), expanded, 'Re-enabling must not change the current presentation.');
    assert.equal(h.state.rememberPosition, true);
    assert.equal(h.preferences.get('layout').dock, null);
    assert.equal(h.preferences.get('layout').anchor, 'left');
    assert.equal(h.preferences.get('layout').expanded, true);
    const reopened = fixture(true, { preferences: h.preferences });
    assert.equal(reopened.state.mode, 'compact');
    reopened.actions.mode();
    assert.deepEqual(reopened.rect(), compact);
});

test('toggling layout remembering preserves preferred bounds during temporary viewport fitting and other preferences', () => {
    const saved = layout();
    const preferences = new Map([
        ['panelOpen', true], ['rememberVisibility', false], ['viewport', 'mobile'], ['scrollToChanges', false], ['layout', saved],
    ]);
    const h = fixture(true, { preferences, width: 390, height: 400 });
    const fitted = h.rect();
    h.actions.rememberPosition();
    h.actions.rememberPosition();
    assert.deepEqual(h.rect(), fitted);
    assert.deepEqual(plain(h.preferences.get('layout').bounds), saved.bounds, 'Save preferred bounds, not the smaller fitted rectangle.');
    for (const key of ['panelOpen', 'rememberVisibility', 'viewport', 'scrollToChanges']) {
        assert.equal(h.preferences.get(key), preferences.get(key));
        assert.equal(h.writes.some((write) => write.key === key), false);
    }
    h.window.innerWidth = 1440;
    h.window.innerHeight = 1000;
    h.window.fire('resize');
    assert.deepEqual(h.rect(), { left: 150, top: 180, width: 560, height: 420 });
});

test('reselecting a device rotates it; fitting and independent orientations persist without resizing the panel', () => {
    const h = fixture(true, { rememberPosition: false });
    const before = h.rect();
    h.actions.device('tablet');
    assert.equal(h.state.orientation, 'portrait', 'The first click selects without rotating.');
    h.actions.device('tablet');
    assert.equal(h.state.orientation, 'landscape');
    h.actions.fit('width');
    h.actions.device('mobile');
    assert.equal(h.state.orientation, 'portrait');
    h.actions.device('mobile');
    h.actions.device('tablet');
    assert.equal(h.state.orientation, 'landscape');
    assert.equal(h.state.fit, 'width');
    assert.deepEqual(h.rect(), before, 'Device, rotation and fitting never resize or move the panel.');
    assert.equal(h.writes.some(({ key }) => key === 'layout'), false);
    assert.equal(h.preferences.get('tabletOrientation'), 'landscape');
    assert.equal(h.preferences.get('mobileOrientation'), 'landscape');
    const reopened = fixture(true, { preferences: h.preferences });
    assert.equal(reopened.state.device, 'tablet');
    assert.equal(reopened.state.fit, 'width');
    assert.equal(reopened.state.orientation, 'landscape');
    reopened.actions.device('mobile');
    assert.equal(reopened.state.orientation, 'landscape');
    reopened.actions.device('mobile');
    assert.equal(reopened.state.orientation, 'portrait', 'Repeated activation rotates back.');
    reopened.actions.reset();
    assert.equal(reopened.state.fit, 'width', 'Reset size and position does not reset fitting.');
    assert.equal(reopened.state.orientation, 'portrait');
});

for (const legacy of [undefined, 'window', 'width', 'unknown']) {
    test(`legacy fitting ${String(legacy)} restores its intent without confusing the new uncapped window mode`, () => {
        const h = fixture(true, { preferences: [['fit', legacy]] });
        assert.equal(h.state.fit, legacy === 'width' ? 'width' : 'automatic');
        assert.equal(h.writes.length, 0, 'Restoring a preference must not write or resize saved geometry.');
        h.actions.fit('window');
        assert.equal(h.preferences.get('fitMode'), 'window');
        assert.equal(h.preferences.get('fit'), legacy, 'Do not reinterpret or overwrite the legacy key.');
        const reopened = fixture(true, { preferences: h.preferences });
        assert.equal(reopened.state.fit, 'window', 'A newly selected Fit to window must not migrate back to Automatic.');
        reopened.actions.fit('automatic');
        assert.equal(fixture(true, { preferences: reopened.preferences }).state.fit, 'automatic');
    });
}

for (const fit of ['automatic', 'window', 'width', 'custom']) {
    test(`the new ${fit} preference takes precedence over a legacy fitting value`, () => {
        const h = fixture(true, { preferences: [['fit', 'width'], ['fitMode', fit]] });
        h.view.report('Loaded', 'current', { hasPreview: true });
        assert.equal(h.state.fit, fit);
        assert.equal(h.node('aflpp-panel .aflpp-stage').style.height, '800px');
        assert.equal(h.writes.length, 0);
    });
}

test('fixed percentages persist independently of panel geometry, remembering and fitting', () => {
    const h = fixture(true, { rememberPosition: false });
    const before = h.rect();
    h.actions.device('mobile');
    h.actions.zoom(80);
    assert.equal(h.state.fit, 'custom');
    assert.equal(h.state.customZoom, 80);
    assert.equal(h.state.zoomPercent, 80);
    assert.equal(h.preferences.get('fitMode'), 'custom');
    assert.equal(h.preferences.get('customZoom'), 80);
    assert.deepEqual(h.rect(), before);
    assert.equal(h.writes.some(({ key }) => key === 'layout'), false);
    h.actions.reset();
    assert.equal(h.state.fit, 'custom');
    assert.equal(h.state.customZoom, 80);
    h.actions.fit('window');
    assert.equal(h.preferences.get('customZoom'), 80, 'Fitting does not discard the last custom percentage.');
    const reopened = fixture(true, { preferences: h.preferences });
    assert.equal(reopened.state.fit, 'window');
    assert.equal(reopened.state.customZoom, 80);
    reopened.actions.zoom(80);
    assert.equal(reopened.state.zoomPercent, 80);
    const fixed = fixture(true, { preferences: reopened.preferences });
    assert.equal(fixed.state.fit, 'custom');
    assert.equal(fixed.state.zoomPercent, 80);
    fixed.actions.zoom(100);
    assert.equal(fixed.state.fit, 'custom', '100% is fixed zoom, not Auto.');
    assert.equal(fixed.preferences.get('customZoom'), 100);
});

test('invalid or unchanged manual zoom never writes preferences', () => {
    const h = fixture(true, { preferences: [['fitMode', 'custom'], ['customZoom', 80]] });
    for (const value of [undefined, null, {}, '80', 0, 9, 401, NaN, Infinity, 80.5, 80]) h.actions.zoom(value);
    assert.equal(h.writes.length, 0);
    assert.equal(h.state.customZoom, 80);
    assert.equal(h.state.zoomPercent, 80);
});

test('the Zoom control receives live DPR changes without another user action', () => {
    const h = fixture(true);
    h.actions.device('mobile');
    h.actions.zoom(80);
    const writes = h.writes.length;
    h.window.devicePixelRatio = 2;
    h.window.fire('resize');
    assert.equal(h.state.dpr, 2);
    assert.equal(h.state.zoomPercent, 80);
    assert.equal(h.state.customZoom, 80);
    assert.equal(h.writes.length, writes, 'Detected DPR must not become a saved preference.');
});

test('hybrid Auto stays selected and never persists an internal fitting strategy during resize or DPR changes', () => {
    const h = fixture(true, { rememberPosition: false });
    h.actions.device('mobile');
    h.actions.fit('automatic');
    const preferred = plain([...h.preferences]);
    const writes = h.writes.length;
    h.window.devicePixelRatio = 2;
    h.window.fire('resize');
    h.window.innerWidth = 900;
    h.window.innerHeight = 650;
    h.window.fire('resize');
    assert.equal(h.state.fit, 'automatic');
    assert.equal(h.state.device, 'mobile');
    assert.equal(h.state.orientation, 'portrait');
    assert.equal(h.node('aflpp-panel .aflpp-stage').style.width, '390px');
    assert.equal(h.node('aflpp-panel .aflpp-stage').style.height, '844px');
    assert.equal(h.writes.length, writes);
    assert.deepEqual(plain([...h.preferences]), preferred);
});

test('invalid new fitting preferences fall back to Automatic', () => {
    for (const value of ['__proto__', {}, false, 100]) {
        const h = fixture(true, { preferences: [['fit', 'width'], ['fitMode', value]] });
        assert.equal(h.state.fit, 'automatic');
        assert.equal(h.writes.length, 0);
    }
});

test('an unavailable canvas returns focus to recovery without collapsing the iframe layout', () => {
    const h = fixture(true);
    const canvas = h.node('aflpp-panel .aflpp-canvas');
    assert.equal(h.panel.dataset.hasPreview, 'false');
    h.view.report('Loaded', 'current', { hasPreview: true });
    assert.equal(h.panel.dataset.hasPreview, 'true');
    canvas.closest = () => null;
    canvas.focus();
    h.view.report('Failed', 'error', { hasPreview: false });
    assert.equal(h.panel.dataset.hasPreview, 'false');
    assert.equal(canvas.hidden, undefined, 'Use CSS visibility, not display:none, while a page is loading.');
    assert.equal(h.focusCalls.at(-1), 'empty-title');
});

test('invalid viewport actions and unchanged fitting do not write preferences', () => {
    const h = fixture(true);
    for (const value of ['__proto__', 'constructor', null, {}, 100, '0', '300']) {
        h.actions.device(value);
        h.actions.fit(value);
    }
    h.actions.fit('automatic');
    assert.equal(h.writes.length, 0);
    assert.equal(h.state.device, 'desktop');
    assert.equal(h.state.fit, 'automatic');
});

test('desktop stays in landscape on reactivation, device switches and reopening, ignoring old orientation preferences', () => {
    for (const desktopOrientation of [undefined, 'portrait', 'landscape']) {
        const h = fixture(true, { preferences: [['desktopOrientation', desktopOrientation]] });
        const before = h.rect();
        assert.equal(h.state.orientation, 'landscape');
        h.actions.device('desktop');
        assert.equal(h.state.orientation, 'landscape');
        assert.equal(h.node('aflpp-panel .aflpp-stage').style.width, '1280px');
        assert.equal(h.node('aflpp-panel .aflpp-stage').style.height, '800px');
        assert.equal(h.writes.length, 0, 'Reactivating desktop must not write preferences.');
        h.actions.device('mobile');
        assert.equal(h.state.orientation, 'portrait');
        h.actions.device('mobile');
        assert.equal(h.state.orientation, 'landscape', 'Phone rotation remains available.');
        h.actions.device('desktop');
        assert.equal(h.state.orientation, 'landscape');
        const reopened = fixture(true, { preferences: h.preferences });
        assert.equal(reopened.state.device, 'desktop');
        assert.equal(reopened.state.orientation, 'landscape');
        reopened.actions.device('desktop');
        assert.equal(reopened.state.orientation, 'landscape');
        assert.equal(reopened.node('aflpp-panel .aflpp-stage').style.width, '1280px');
        assert.equal(reopened.writes.length, 0);
        assert.equal(h.writes.some(({ key }) => key === 'desktopOrientation'), false);
        assert.deepEqual(h.rect(), before);
    }
});

for (const fit of ['automatic', 'window', 'width']) test(`${fit} and fixed viewport geometry survive fullscreen and PiP round trips`, async () => {
    const h = fixture(true, { pip: true });
    h.actions.device('mobile');
    h.actions.device('mobile');
    h.actions.fit(fit);
    const stage = h.node('aflpp-panel .aflpp-stage');
    assert.equal(stage.style.width, '844px');
    assert.equal(stage.style.height, '390px');
    const preferred = plain([...h.preferences]);
    const writes = h.writes.length;
    h.document.fullscreenElement = h.panel;
    h.document.fire('fullscreenchange');
    assert.equal(h.state.fit, fit);
    assert.equal(stage.style.width, '844px');
    assert.equal(stage.style.height, '390px');
    assert.equal(h.state.orientation, 'landscape');
    h.document.fullscreenElement = null;
    h.document.fire('fullscreenchange');
    await h.actions.popOut();
    assert.equal(h.state.inPip, true);
    assert.equal(h.state.fit, fit);
    assert.equal(stage.style.width, '844px');
    assert.equal(stage.style.height, '390px');
    assert.equal(h.state.orientation, 'landscape');
    h.detached.close();
    assert.equal(h.state.inPage, true);
    assert.equal(h.state.device, 'mobile');
    assert.equal(h.state.fit, fit);
    assert.equal(stage.style.width, '844px');
    assert.equal(stage.style.height, '390px');
    assert.equal(h.state.orientation, 'landscape');
    assert.equal(h.writes.length, writes);
    assert.deepEqual(plain([...h.preferences]), preferred);
});

test('moving the closed launcher with remembering off keeps its preset for the next load', () => {
    const h = fixture(true, { rememberPosition: false });
    h.actions.dock('center');
    h.actions.close();
    h.launcher.fire('pointerdown');
    h.launcher.fire('pointermove', { clientX: 60, clientY: 80 });
    h.launcher.fire('pointerup');
    assert.equal(h.state.dock, null);
    const moved = h.rect();
    h.launcher.fire('click', { detail: 0 });
    assert.deepEqual(h.rect(), moved);
    assert.equal(h.preferences.get('layout'), undefined);
    const reopened = fixture(true, { preferences: h.preferences });
    assert.equal(reopened.state.dock, 'center');
    assert.equal(reopened.rect().left, 480);
});

for (const rememberPosition of [false, true]) {
    test(`reset saves the default preset without ${rememberPosition ? 'disabling' : 'enabling'} layout remembering`, () => {
        const h = fixture(true, { rememberPosition });
        h.actions.dock('left');
        h.resizeTo(640, 440);
        h.actions.mode();
        h.actions.reset();
        assert.deepEqual(h.rect(), { left: 940, top: 587, width: 480, height: 393 });
        assert.equal(h.state.rememberPosition, rememberPosition);
        assert.equal(h.preferences.get('position'), 'right');
        assert.equal(!!h.preferences.get('layout'), rememberPosition);
        const reopened = fixture(true, { preferences: h.preferences });
        assert.deepEqual(reopened.rect(), h.rect());
        assert.equal(reopened.state.rememberPosition, rememberPosition);
    });
}

for (const position of ['invalid', false, [], {}]) {
    test(`invalid position preference falls back safely: ${JSON.stringify(position)}`, () => {
        const h = fixture(true, { rememberPosition: false, position });
        assert.equal(h.state.dock, 'right');
        assert.equal(h.rect().width, 480);
        assert.equal(h.writes.length, 0);
    });
}

test('an invalid saved layout falls back to the preferred static position', () => {
    const h = fixture(true, { position: 'left', layout: layout({ expanded: 'invalid' }) });
    assert.equal(h.state.dock, 'left');
    assert.equal(h.rect().width, 480);
    assert.equal(h.state.mode, 'expand');
    assert.equal(h.writes.length, 0);
});

test('expanded mode survives reload and returns to the saved compact geometry', () => {
    const h = fixture(true, { layout: layout({ expanded: true }) });
    assert.equal(h.state.mode, 'compact');
    inside(h);
    h.actions.mode();
    assert.deepEqual(h.rect(), { left: 150, top: 180, width: 560, height: 420 });
    h.actions.mode();
    const reopened = fixture(true, { layout: h.preferences.get('layout') });
    assert.equal(reopened.state.mode, 'compact');
    reopened.actions.mode();
    assert.deepEqual(reopened.rect(), { left: 150, top: 180, width: 560, height: 420 });
});

for (const dock of ['left', 'center', 'right']) {
    test(`${dock} docking persists, tracks window size and survives expand/compact`, () => {
        const h = fixture(true);
        h.actions.dock(dock);
        assert.equal(h.preferences.get('layout').dock, dock);
        h.actions.mode();
        h.actions.mode();
        assert.equal(h.state.dock, dock);
        h.window.innerWidth = 1000;
        h.window.innerHeight = 800;
        const writes = h.writes.length;
        h.window.fire('resize');
        assert.equal(h.writes.length, writes, 'automatic fitting must not overwrite user choices');
        assert.equal(h.rect().left, dock === 'left' ? 20 : dock === 'center' ? 260 : 500);
        assert.equal(h.rect().top, 387);
        inside(h);
        const reopened = fixture(true, { preferences: h.preferences, width: 1000, height: 800 });
        assert.equal(reopened.state.dock, dock);
        assert.deepEqual(reopened.rect(), h.rect(), 'Restore responsive docking, not coordinates from the previous window.');
        assert.equal(reopened.writes.length, 0);
    });
}

test('keyboard moving becomes a remembered custom position, while resizing preserves docking', () => {
    const h = fixture(true);
    h.node('aflpp-panel .aflpp-resize').fire('keydown', { key: 'ArrowRight' });
    assert.equal(h.state.dock, 'right');
    assert.equal(h.rect().width, 470);
    assert.equal(h.rect().left + h.rect().width, 1420);
    h.node('aflpp-panel .aflpp-move-control').fire('keydown', { key: 'ArrowLeft' });
    assert.equal(h.state.dock, null);
    const reopened = fixture(true, { layout: h.preferences.get('layout') });
    assert.deepEqual(reopened.rect(), h.rect());
    assert.equal(reopened.state.dock, null);
});

test('pointer movement saves once on release, not during movement or a plain title click', () => {
    const h = fixture(true);
    const move = h.node('aflpp-panel .aflpp-move-control');
    move.fire('pointerdown');
    move.fire('pointerup');
    assert.equal(h.writes.length, 0);
    assert.equal(h.state.dock, 'right');
    move.fire('pointerdown');
    move.fire('pointermove', { clientX: 70, clientY: 80 });
    assert.equal(h.writes.length, 0);
    move.fire('pointerup');
    assert.equal(h.writes.length, 1);
    assert.equal(h.state.dock, null);
    assert.deepEqual(plain(h.preferences.get('layout').bounds), {
        x: h.rect().left, y: h.rect().top, width: h.rect().width, height: h.rect().height,
    });
});

for (const [edge, dx, dy, expected] of [
    ['n', 0, -20, { x: 150, y: 160, width: 560, height: 440 }],
    ['ne', 20, -20, { x: 150, y: 160, width: 580, height: 440 }],
    ['e', 20, 0, { x: 150, y: 180, width: 580, height: 420 }],
    ['se', 20, 20, { x: 150, y: 180, width: 580, height: 440 }],
    ['s', 0, 20, { x: 150, y: 180, width: 560, height: 440 }],
    ['sw', -20, 20, { x: 130, y: 180, width: 580, height: 440 }],
    ['w', -20, 0, { x: 130, y: 180, width: 580, height: 420 }],
    ['nw', -20, -20, { x: 130, y: 160, width: 580, height: 440 }],
]) test(`${edge} free border follows pointer input without changing untouched axes`, () => {
    const h = fixture(true, { layout: layout({ anchor: 'right' }) });
    const handle = h.node(`aflpp-panel .aflpp-edge-${edge}`);
    assert.equal(handle.hidden, false);
    assert.equal(getEventListeners(handle, 'keydown').length, 0);
    handle.fire('pointerdown');
    handle.fire('pointermove', { clientX: 100 + dx, clientY: 100 + dy });
    handle.fire('pointerup');
    assert.deepEqual(plain(h.preferences.get('layout').bounds), expected);
    assert.equal(h.state.dock, null);
});

for (const [dock, usable] of [[null, ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']], ['left', ['n', 'ne', 'e']], ['center', ['n', 'ne', 'e', 'w', 'nw']], ['right', ['n', 'w', 'nw']]]) {
    test(`${dock || 'free'} layout exposes only pointer edges that can move with its anchor`, () => {
        const h = fixture(true, { layout: layout({ dock }) });
        for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
            assert.equal(h.node(`aflpp-panel .aflpp-edge-${edge}`).hidden, !usable.includes(edge));
        }
        h.actions.mode();
        for (const edge of usable) assert.equal(h.node(`aflpp-panel .aflpp-edge-${edge}`).hidden, true);
        assert.equal(h.state.movable, false);
    });
}

test('no-frame and retained-frame recovery use native UI models without weakening retry or handover guards', () => {
    const h = fixture(true);
    assert.equal(h.state.empty.busy, true);
    h.view.report('Failed', 'error', { canRetry: true });
    assert.equal(h.state.empty.icon, 'warning', 'Failed preview loading keeps its native warning icon.');
    assert.equal(h.state.empty.retry, true);
    assert.equal(h.state.empty.close, false);
    h.actions.retry();
    assert.deepEqual(h.retryCalls, [false]);
    h.view.report('Waiting', 'handover', { canTakeOver: true });
    assert.equal(h.state.empty.busy, true);
    assert.equal(h.state.empty.disabled, true);
    h.actions.retry();
    assert.deepEqual(h.retryCalls, [false]);
    h.view.report('Other tab', 'conflict', { canTakeOver: true });
    assert.equal(h.state.empty.icon, 'info', 'Another-tab recovery is informational, not a PiP action.');
    h.actions.retry();
    assert.deepEqual(h.retryCalls, [false, true]);
    h.view.report('Expired', 'error', { hasPreview: true, canRetry: false, reason: 'reload' });
    assert.equal(h.state.empty, null);
    assert.equal(h.state.notice.status, 'error');
    assert.equal(h.state.notice.dismissible, false);
    assert.equal(h.state.notice.retry, false);
    assert.equal(h.state.notice.close, false);
    h.actions.retry();
    assert.deepEqual(h.retryCalls, [false, true]);
    h.actions.dismissNotice();
    assert.equal(h.state.notice.status, 'error', 'A window-notice callback cannot dismiss an unresolved preview problem.');
    h.view.report('Write failed', 'error', { hasPreview: true, canRetry: true });
    assert.equal(h.state.notice.status, 'warning');
    assert.equal(h.state.notice.retry, true);
    assert.equal(h.state.notice.dismissible, false);
    h.view.report('Refreshing');
    assert.equal(h.state.notice, null);
});

test('a followed redirect is an informational notice for the displayed frame, not a preview problem', () => {
    const h = fixture(true, { labels: panelStrings });
    const redirect = { hasPreview: true, redirectDestination: '/destination/', canRefresh: true };
    h.view.report(panelStrings.current, 'ready', redirect);
    const feedback = h.node('aflpp-panel .aflpp-feedback');
    const message = 'Followed a redirect to: /destination/';
    assert.deepEqual(plain(h.state.notice), { heading: message, status: 'info', dismissible: false });
    assert.equal(feedback.hidden, false);
    assert.equal(h.state.canRefresh, true);
    assert.ok(h.node('aflpp-panel [role="status"]').textContent.includes(message));
    h.view.report(panelStrings.updating, 'loading', { ...redirect, canRefresh: false });
    assert.equal(h.state.notice.heading, message, 'Keep the note while its frame is still visible during an update.');
    assert.equal(h.node('aflpp-panel [role="status"]').textContent, panelStrings.updating);
    h.view.report('Update failed', 'error', redirect);
    assert.equal(h.state.notice.status, 'warning', 'A real preview problem takes precedence.');
    h.view.report(panelStrings.current, 'ready', { hasPreview: true, canRefresh: true });
    assert.equal(h.state.notice, null);
    assert.equal(feedback.hidden, true);
    h.view.report(panelStrings.current, 'ready', redirect);
    h.view.clearPreview();
    assert.equal(h.state.notice, null, 'Do not keep a redirect notice after discarding the frame.');
});

test('the public permalink check starts once on a recognized preview and never overrides its own redirect', async () => {
    const request = Promise.withResolvers();
    const calls = [];
    const publicRedirect = { endpoint: 'https://site.test/wp-json/public-redirect', nonce: 'rest-nonce' };
    const h = fixture(true, { labels: panelStrings, publicRedirect, fetch: (...args) => {
        calls.push(args);
        return request.promise;
    } });
    const html = { hasPreview: true, hasHtmlPreview: true, canRefresh: true };
    const redirected = { hasPreview: true, redirectDestination: '/preview-destination/', canRefresh: true };
    h.view.report(panelStrings.current, 'ready', redirected);
    assert.equal(calls.length, 0, 'A redirected preview takes priority without starting the public check.');
    h.view.report(panelStrings.current, 'ready', { hasPreview: true });
    assert.equal(calls.length, 0, 'Do not show an unrelated public notice for browser-owned output.');

    h.view.report(panelStrings.current, 'ready', html);
    assert.equal(h.state.notice, null, 'Do not show loading or a negative result for the advisory check.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].href, publicRedirect.endpoint);
    assert.equal(calls[0][1].headers['X-WP-Nonce'], publicRedirect.nonce);
    assert.equal(calls[0][1].redirect, 'error', 'Do not forward the REST nonce to a redirected endpoint.');

    h.view.report(panelStrings.current, 'ready', redirected);
    request.resolve({ ok: true, json: () => Promise.resolve({ destination: '/Public/' }) });
    await new Promise(setImmediate);
    assert.equal(h.state.notice.heading, 'Followed a redirect to: /preview-destination/');
    h.view.report(panelStrings.current, 'ready', html);
    assert.deepEqual(plain(h.state.notice), {
        heading: 'Public URL redirects to: /Public/', status: 'info', dismissible: false,
    });
    assert.equal(h.state.canRefresh, true);
    h.view.report(panelStrings.updating, 'loading', html);
    assert.equal(h.state.notice.heading, 'Public URL redirects to: /Public/');
    h.view.clearPreview();
    assert.equal(h.state.notice, null);
    h.view.report(panelStrings.current, 'ready', html);
    assert.equal(calls.length, 1, 'Refresh, replacement and reopen must not probe again.');
});

for (const result of ['draft', 'no redirect', 'unavailable']) test(`public redirect check stays silent: ${result}`, async () => {
    let calls = 0;
    const h = fixture(true, {
        labels: panelStrings,
        publicRedirect: result === 'draft' ? undefined : { endpoint: 'https://site.test/wp-json/public-redirect' },
        fetch() {
            calls++;
            return result === 'unavailable' ? Promise.reject(new Error('offline'))
                : Promise.resolve({ ok: true, json: () => Promise.resolve({ destination: null }) });
        },
    });
    h.view.report(panelStrings.current, 'ready', { hasPreview: true, hasHtmlPreview: true, canRefresh: true });
    await new Promise(setImmediate);
    assert.equal(calls, result === 'draft' ? 0 : 1);
    assert.equal(h.state.notice, null);
    assert.equal(h.state.canRefresh, true);
});

for (const hasPreview of [false, true]) {
    test(`paused editor capture visibly explains how to resume with a ${hasPreview ? 'retained frame' : 'placeholder'}`, () => {
        const h = fixture(true);
        const message = 'Return to editing this post to resume its live preview.';
        h.view.report(message, 'paused', { hasPreview, canRetry: false });
        assert.equal(h.state.busy, false);
        assert.equal(h.state.canRefresh, false);
        const content = hasPreview ? h.state.notice : h.state.empty;
        assert.equal(content.heading, 'pausedTitle');
        assert.equal(content.description, message);
        assert.equal(content.retry, false);
        if (hasPreview) {
            assert.equal(h.state.empty, null);
            assert.equal(h.state.notice.status, 'info');
            assert.equal(h.state.notice.dismissible, false);
            assert.equal(h.node('aflpp-panel .aflpp-feedback').hidden, false);
        } else {
            assert.equal(h.state.empty.busy, false);
            assert.equal(h.state.empty.icon, 'info');
        }
        h.view.report('Refreshed', 'ready', { hasPreview: true, canRefresh: true });
        assert.equal(h.state.notice, null);
        assert.equal(h.state.canRefresh, true);
    });
}

const postLockedMessage = (await readFile(new URL('../classes/LivePreview.php', import.meta.url), 'utf8'))
    .match(/'aflpp_post_locked',\s*__\(\s*'([^']+)'/)[1];
for (const hasPreview of [false, true]) {
    test(`an edit lock points to native takeover without a retry with ${hasPreview ? 'a retained preview' : 'no preview'}`, () => {
        const h = fixture(true, { labels: panelStrings });
        const message = postLockedMessage;
        h.view.report(message, 'paused', { hasPreview, reason: 'post-locked', canRetry: false, canTakeOver: true });
        const content = hasPreview ? h.state.notice : h.state.empty;
        assert.equal(content.heading, 'Preview paused');
        assert.equal(content.description, 'Another user is editing this post. Take over editing to continue.');
        assert.doesNotMatch(`${content.heading} ${content.description}`, /reload|copy any changes|couldn’t load|try again|retry/i);
        assert.equal(content.retry, false, 'WordPress’s native takeover restarts the preview; no plugin action is needed.');
        assert.equal(content.close, false);
        assert.equal(h.state.canRefresh, false);
        if (hasPreview) {
            assert.equal(content.status, 'info');
            assert.equal(content.dismissible, false);
        } else {
            assert.equal(content.icon, 'info');
            assert.equal(content.busy, false);
        }
        h.actions.retry();
        assert.deepEqual(h.retryCalls, [], 'A stale retry callback must not bypass the native editing lock.');
    });
}

// Exercise complete messages, not just individual strings: server errors must not repeat the reload warning.
const reloadDetails = [acfStrings.nativePreviewAcf, panelStrings.nativePreviewFailed, blockEditorStrings.nativeSaveFailed,
    panelStrings.integrationFailed, acfStrings.acfUnavailable];
for (const path of ['classes/LivePreview.php', 'classes/Compatibility/Acf.php']) {
    const php = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    for (const [, code, message] of php.matchAll(/new WP_Error\(\s*'(aflpp_[^']+)',\s*__\(\s*'([^']+)'/g)) {
        if (['aflpp_invalid_nonce', 'aflpp_preview_conflict', 'aflpp_source_changed', 'aflpp_acf_unavailable'].includes(code)) {
            reloadDetails.push(message);
        }
    }
}
assert.equal(reloadDetails.length, 9, 'Cover every plugin-owned error that requires reloading.');
for (const hasPreview of [false, true]) {
    test(`reload errors explain how to keep changes once with ${hasPreview ? 'a retained preview' : 'no preview'}`, () => {
        const h = fixture(true, { labels: panelStrings });
        for (const message of reloadDetails) {
            assert.equal(typeof message, 'string');
            h.view.report(message, 'error', { hasPreview, reason: 'reload', canRetry: false });
            const content = hasPreview ? h.state.notice : h.state.empty;
            const text = `${content.heading} ${content.description}`;
            assert.ok(text.includes(message));
            assert.equal((text.match(/Copy any changes you want to keep/g) || []).length, 1);
            assert.equal((text.match(/reload the editor/gi) || []).length, 1);
            assert.match(text, /Copy any changes you want to keep\. Then reload the editor before saving again\./);
            assert.equal(content.retry, false);
            assert.equal(content.close, !hasPreview, 'Keep the existing close action for errors without a preview.');
        }
    });
}

test('uncertain saves do not claim failure or success, and ACF recovery identifies what WordPress already saved', () => {
    assert.equal(blockEditorStrings.nativeSaveFailed, 'We couldn’t check whether WordPress saved your latest changes.');
    assert.equal(acfStrings.nativePreviewAcf, 'WordPress Preview saved changes in your repeating fields to the post.');
    assert.doesNotMatch(acfStrings.nativePreviewAcf, /all changes|all edits|reload/i);
});

test('ordinary updates and native saving never replace a retained frame with a placeholder or success notice', () => {
    const h = fixture(true);
    for (const [text, state] of [['updating', 'loading'], ['saving', 'loading'], ['stale', 'stale'], ['current', 'ready']]) {
        h.view.report(text, state, { hasPreview: true });
        assert.equal(h.state.empty, null);
        assert.equal(h.state.notice, null);
    }
});

for (const expanded of [false, true]) {
    for (const [width, height] of [[390, 600], [240, 150], [20, 30]]) {
        test(`saved ${expanded ? 'expanded' : 'compact'} layouts stay inside a ${width}×${height} window`, () => {
            const h = fixture(true, { width, height, layout: layout({
                bounds: { x: 5000, y: -400, width: 1800, height: 1200 }, expanded,
            }) });
            inside(h);
            assert.equal(h.writes.length, 0);
        });
    }
}

for (const invalid of [
    { ...layout(), bounds: { x: '100', y: 100, width: 500, height: 300 } },
    { ...layout(), bounds: { x: NaN, y: 100, width: 500, height: 300 } },
    { ...layout(), bounds: { x: 100, y: 100, width: -5, height: 300 } },
    layout({ dock: 'invalid' }), layout({ expanded: 'yes' }), layout({ anchor: 'invalid' }), [], 'invalid',
]) {
    test(`invalid saved layout falls back safely: ${JSON.stringify(invalid)}`, () => {
        const h = fixture(true, { layout: invalid });
        assert.equal(h.state.dock, 'right');
        assert.equal(h.state.mode, 'expand');
        assert.deepEqual(h.rect(), { left: 940, top: 587, width: 480, height: 393 });
    });
}

test('temporary viewport fitting does not lose the preferred custom size or position', () => {
    const h = fixture(true, { layout: layout() });
    h.window.innerWidth = 390;
    h.window.innerHeight = 400;
    h.window.fire('resize');
    inside(h);
    h.window.innerWidth = 1440;
    h.window.innerHeight = 1000;
    h.window.fire('resize');
    assert.deepEqual(h.rect(), { left: 150, top: 180, width: 560, height: 420 });
    assert.equal(h.writes.length, 0);
});

test('reset restores compact default size and bottom-right position', () => {
    const h = fixture(true, { layout: layout({ expanded: true }) });
    h.actions.reset();
    assert.deepEqual(h.rect(), { left: 940, top: 587, width: 480, height: 393 });
    assert.equal(h.state.mode, 'expand');
    assert.equal(h.preferences.get('layout').dock, 'right');
});

for (const dock of ['left', 'center', 'right']) {
    test(`${dock} launcher shares the compact panel anchor after closing and moving away from its dock`, () => {
        const h = fixture(true);
        h.actions.dock(dock);
        h.actions.close();
        const factor = dock === 'left' ? 0 : dock === 'center' ? 0.5 : 1;
        const before = h.rect();
        assert.equal(parseFloat(h.launcherContainer.style.left), before.left + before.width * factor);
        assert.equal(parseFloat(h.launcherContainer.style.top), before.top + before.height);
        assert.equal(h.launcherContainer.style.transform, `translate(${-100 * factor}%, -100%)`);
        const dx = dock === 'left' ? 60 : -60;
        h.launcher.fire('pointerdown');
        h.launcher.fire('pointermove', { clientX: 100 + dx, clientY: 60 });
        h.launcher.fire('pointerup');
        const moved = h.rect();
        assert.equal(moved.left, before.left + dx);
        assert.equal(moved.top, before.top - 40);
        assert.equal(h.state.dock, null);
        assert.equal(h.preferences.get('layout').anchor, dock);
        assert.deepEqual([moved.width, moved.height], [before.width, before.height]);
        const reopened = fixture(false, { layout: h.preferences.get('layout') });
        assert.equal(reopened.launcherContainer.style.left, h.launcherContainer.style.left);
        assert.equal(reopened.launcherContainer.style.transform, h.launcherContainer.style.transform);
    });

    test(`${dock} resize grip follows the pointer while preserving the bottom anchor and docking`, () => {
        const h = fixture(true);
        h.actions.dock(dock);
        const before = h.rect();
        const grip = h.node('aflpp-panel .aflpp-resize');
        const dx = dock === 'left' ? 50 : -50;
        grip.fire('pointerdown');
        grip.fire('pointermove', { clientX: 100 + dx, clientY: 40 });
        grip.fire('pointerup');
        const after = h.rect();
        assert.equal(after.width, before.width + (dock === 'center' ? 100 : 50));
        assert.equal(after.height, before.height + 60);
        assert.equal(after.top, before.top - 60);
        assert.equal(after.top + after.height, before.top + before.height);
        assert.equal(dock === 'left' ? after.left + after.width : after.left,
            (dock === 'left' ? before.left + before.width : before.left) + dx);
        assert.equal(h.state.dock, dock);
    });
}

test('launcher dragging suppresses only its generated pointer click, not later keyboard activation', () => {
    const h = fixture(false);
    h.launcher.fire('pointerdown');
    h.launcher.fire('pointermove', { clientX: 50, clientY: 70 });
    h.launcher.fire('pointerup');
    assert.equal(h.launcher.fire('click', { detail: 1 }).defaultPrevented, true);
    assert.equal(h.view.visible, false);
    h.launcher.fire('click', { detail: 0 });
    assert.equal(h.view.visible, true);
    assert.equal(h.focusCalls.at(-1), 'actions');
});

test('a launcher click or sub-threshold movement opens normally without changing the layout', () => {
    const h = fixture(false);
    h.launcher.fire('pointerdown');
    h.launcher.fire('pointermove', { clientX: 101, clientY: 101 });
    h.launcher.fire('pointerup');
    h.launcher.fire('click', { detail: 1 });
    assert.equal(h.view.visible, true);
    assert.equal(h.preferences.get('layout'), undefined);
    assert.equal(h.state.dock, 'right');
    assert.deepEqual(h.focusCalls, [], 'Pointer opening must not force a focus ring onto Preview actions.');
});

test('the closed launcher can move an expanded panel without overwriting compact size or expanded mode', () => {
    const h = fixture(false, { layout: layout({ expanded: true }) });
    h.launcher.fire('keydown', { key: 'ArrowLeft', shiftKey: true });
    const saved = h.preferences.get('layout');
    assert.equal(saved.bounds.x, 110);
    assert.equal(saved.bounds.width, 560);
    assert.equal(saved.bounds.height, 420);
    assert.equal(saved.expanded, true);
});

test('moving in a small viewport never replaces the preferred size with the temporary fitted size', () => {
    const h = fixture(false, { layout: layout(), width: 390, height: 400 });
    h.launcher.fire('keydown', { key: 'ArrowLeft' });
    assert.equal(h.preferences.get('layout').bounds.width, 560);
    assert.equal(h.preferences.get('layout').bounds.height, 420);
    h.view.setVisible(true);
    h.node('aflpp-panel .aflpp-move-control').fire('keydown', { key: 'ArrowUp' });
    assert.equal(h.preferences.get('layout').bounds.width, 560);
    assert.equal(h.preferences.get('layout').bounds.height, 420);
});

for (const anchor of ['left', 'center', 'right']) {
    test(`${anchor} vertical resizing preserves the preferred horizontal geometry in a narrow viewport`, () => {
        const saved = layout({ anchor });
        const h = fixture(true, { layout: saved, width: 390, height: 800 });
        h.node('aflpp-panel .aflpp-resize').fire('keydown', { key: 'ArrowUp' });
        const { bounds } = h.preferences.get('layout');
        assert.equal(bounds.x, saved.bounds.x);
        assert.equal(bounds.width, saved.bounds.width);
        assert.equal(bounds.height, saved.bounds.height + 10);
        h.window.innerWidth = 1440;
        h.window.fire('resize');
        assert.equal(h.rect().left, saved.bounds.x);
    });

    test(`${anchor} horizontal resizing preserves the preferred vertical geometry in a short viewport`, () => {
        const saved = layout({ anchor });
        const h = fixture(true, { layout: saved, height: 400 });
        h.node('aflpp-panel .aflpp-resize').fire('keydown', { key: anchor === 'left' ? 'ArrowRight' : 'ArrowLeft' });
        const { bounds } = h.preferences.get('layout');
        assert.equal(bounds.y, saved.bounds.y);
        assert.equal(bounds.height, saved.bounds.height);
        assert.equal(bounds.width, saved.bounds.width + (anchor === 'center' ? 20 : 10));
        h.window.innerHeight = 1000;
        h.window.fire('resize');
        assert.equal(h.rect().top, saved.bounds.y);
    });

    test(`${anchor} returning a fitted resize to its origin restores all preferred bounds`, () => {
        const saved = layout({ anchor });
        const h = fixture(true, { layout: saved, width: 390, height: 400 });
        const before = h.rect();
        const grip = h.node('aflpp-panel .aflpp-resize');
        grip.fire('pointerdown');
        grip.fire('pointermove', { clientX: 120, clientY: 120 });
        grip.fire('pointermove', { clientX: 100, clientY: 100 });
        grip.fire('pointerup');
        assert.deepEqual(h.rect(), before);
        assert.deepEqual(plain(h.preferences.get('layout').bounds), saved.bounds);
        const reopened = fixture(true, { layout: h.preferences.get('layout') });
        assert.deepEqual(reopened.rect(), { left: 150, top: 180, width: 560, height: 420 });
    });
}

for (const direction of ['ltr', 'rtl']) for (const anchor of ['left', 'center', 'right']) {
    test(`${direction} ${anchor} anchor retains physical free-corner pointer resizing`, () => {
        const h = fixture(true, { layout: layout({ dock: anchor, anchor }), direction });
        const before = h.rect();
        const grip = h.node(`aflpp-panel .aflpp-edge-${anchor === 'left' ? 'ne' : 'nw'}`);
        const dx = anchor === 'left' ? 30 : -30;
        grip.fire('pointerdown');
        grip.fire('pointermove', { clientX: 100 + dx, clientY: 80 });
        grip.fire('pointerup');
        assert.equal(h.rect().width, before.width + (anchor === 'center' ? 60 : 30));
        assert.equal(h.rect().height, before.height + 20);
        assert.equal(h.rect().top + h.rect().height, before.top + before.height);
    });
}

for (const [width, height] of [[480, 340], [640, 440]]) {
    test(`older saved ${width}×${height} dimensions survive the new default and expand/restore`, () => {
        const h = fixture(true, { layout: layout({ bounds: { x: 150, y: 180, width, height }, expanded: true }) });
        assert.equal(h.state.mode, 'compact');
        assert.equal(h.writes.length, 0);
        h.actions.mode();
        assert.equal(h.rect().width, width);
        assert.equal(h.rect().height, height);
        assert.equal(h.state.mode, 'expand');
        const reopened = fixture(true, { preferences: h.preferences });
        assert.deepEqual(reopened.rect(), { left: 150, top: 180, width, height });
        assert.equal(reopened.writes.length, 0);
    });
}

for (const event of ['pointercancel', 'lostpointercapture', 'blur']) {
    test(`${event} ends launcher dragging and saves its completed movement only once`, () => {
        const h = fixture(false);
        h.launcher.fire('pointerdown');
        h.launcher.fire('pointermove', { clientX: 60, clientY: 70 });
        (event === 'blur' ? h.window : h.launcher).fire(event);
        h.launcher.fire('pointerup');
        assert.equal(h.writes.length, 1);
        assert.equal(h.launcher.hasPointerCapture(1), false);
        assert.equal(h.document.documentElement.classList.contains('aflpp-window-dragging'), false);
        assert.equal(h.panel.classList.contains('aflpp-dragging'), false);
    });
}

test('returning a resize drag to its origin restores both original preferred dimensions', () => {
    const h = fixture(true);
    const before = h.rect();
    const grip = h.node('aflpp-panel .aflpp-resize');
    grip.fire('pointerdown');
    grip.fire('pointermove', { clientX: 30, clientY: 20 });
    grip.fire('pointermove', { clientX: 100, clientY: 100 });
    grip.fire('pointerup');
    assert.deepEqual(h.rect(), before);
});

test('reset restores the default dimensions and docking even in a small expanded viewport', () => {
    const h = fixture(true, { width: 390, height: 400, layout: layout({ bounds: { x: 20, y: 80, width: 640, height: 440 } }) });
    h.actions.dock('left');
    h.actions.mode();
    h.actions.reset();
    assert.equal(h.state.mode, 'expand');
    assert.equal(h.state.dock, 'right');
    assert.equal(h.preferences.get('layout').bounds.width, 480);
    assert.equal(h.preferences.get('layout').bounds.height, 393);
    inside(h);
});

test('keyboard opening focuses actions and closing focuses the launcher, without automatic focus on load or visibility changes', () => {
    const h = fixture(false);
    assert.deepEqual(h.focusCalls, []);
    h.view.setVisible(true);
    h.view.setVisible(false);
    assert.deepEqual(h.focusCalls, []);
    h.launcher.fire('click', { detail: 0 });
    assert.deepEqual(h.focusCalls, ['actions']);
    h.actions.close();
    assert.equal(h.document.activeElement, h.launcher);
    assert.equal(h.view.visible, false);
});

test('the single resize grip hides in expanded, fullscreen and PiP modes', async () => {
    const h = fixture(true, { pip: true });
    const grip = h.node('aflpp-panel .aflpp-resize');
    assert.equal(grip.hidden, false);
    h.actions.mode();
    assert.equal(grip.hidden, true);
    h.actions.mode();
    h.document.fullscreenElement = h.panel;
    h.document.fire('fullscreenchange');
    assert.equal(grip.hidden, true);
    h.document.fullscreenElement = null;
    h.document.fire('fullscreenchange');
    await h.actions.popOut();
    assert.equal(grip.hidden, true);
    h.detached.close();
    assert.equal(grip.hidden, false);
});

for (const direction of ['ltr', 'rtl']) for (const gutter of [12, 20, 28]) {
    test(`${direction} docking matches the editor's ${gutter}px gutter, excluding the scrollbar`, () => {
        const h = fixture(false, { direction, gutter, scrollbar: 15 });
        const width = h.document.documentElement.clientWidth;
        assert.equal(parseFloat(h.launcherContainer.style.left), width - gutter);
        assert.equal(parseFloat(h.launcherContainer.style.top), h.window.innerHeight - gutter);
        h.view.setVisible(true);
        assert.equal(h.rect().left + h.rect().width, width - gutter);
        assert.equal(h.rect().top + h.rect().height, h.window.innerHeight - gutter);
        h.actions.dock('left');
        assert.equal(h.rect().left, gutter);
        h.actions.mode();
        assert.equal(h.rect().top, 32 + gutter);
        assert.equal(h.rect().left, gutter);
        inside(h);
    });
}

for (const anchor of ['left', 'center', 'right']) for (const keyboard of [false, true]) {
    test(`${anchor} launcher reaches the top-left independently of its panel using ${keyboard ? 'keys' : 'dragging'}`, () => {
        const h = fixture(false, { layout: layout({ dock: anchor, anchor }) });
        if (keyboard) {
            for (let i = 0; i < 40; i++) {
                h.launcher.fire('keydown', { key: 'ArrowLeft', shiftKey: true });
                h.launcher.fire('keydown', { key: 'ArrowUp', shiftKey: true });
            }
        } else {
            h.launcher.fire('pointerdown');
            h.launcher.fire('pointermove', { clientX: -2000, clientY: -2000 });
            h.launcher.fire('pointerup');
        }
        const factor = anchor === 'left' ? 0 : anchor === 'center' ? 0.5 : 1;
        assert.equal(parseFloat(h.launcherContainer.style.left), h.launcherContainer.offsetWidth * factor);
        assert.equal(parseFloat(h.launcherContainer.style.top), 32 + h.launcherContainer.offsetHeight);
        const saved = h.preferences.get('layout');
        assert.equal(saved.bounds.width, 560);
        assert.equal(saved.bounds.height, 420);
        assert.equal(saved.dock, null);
        h.launcher.fire('click', { detail: 0 });
        assert.equal(h.rect().left, 0);
        assert.equal(h.rect().top, 32);
        inside(h);
        h.actions.close();
        assert.equal(parseFloat(h.launcherContainer.style.left), h.launcherContainer.offsetWidth * factor);
        assert.equal(parseFloat(h.launcherContainer.style.top), 32 + h.launcherContainer.offsetHeight);
        const reopened = fixture(false, { layout: saved });
        assert.equal(reopened.launcherContainer.style.left, h.launcherContainer.style.left);
        assert.equal(reopened.launcherContainer.style.top, h.launcherContainer.style.top);
    });
}

for (const launcher of [false, true]) {
    test(`the ${launcher ? 'launcher' : 'panel'} can use the full layout viewport below the actual admin bar`, () => {
        const h = fixture(!launcher, { toolbarHeight: 46, scrollbar: 15 });
        const control = launcher ? h.launcher : h.node('aflpp-panel .aflpp-move-control');
        control.fire('pointerdown');
        control.fire('pointermove', { clientX: -2000, clientY: -2000 });
        control.fire('pointerup');
        assert.equal(launcher ? parseFloat(h.launcherContainer.style.left) - h.launcherContainer.offsetWidth : h.rect().left, 0);
        assert.equal(launcher ? parseFloat(h.launcherContainer.style.top) - h.launcherContainer.offsetHeight : h.rect().top, 46);
        control.fire('pointerdown');
        control.fire('pointermove', { clientX: 3000, clientY: 3000 });
        control.fire('pointerup');
        assert.equal(launcher ? parseFloat(h.launcherContainer.style.left) : h.rect().left + h.rect().width, 1425);
        assert.equal(launcher ? parseFloat(h.launcherContainer.style.top) : h.rect().top + h.rect().height, 1000);
    });
}

test('scrolling the mobile admin bar into view temporarily fits a free launcher without rewriting its corner', () => {
    const h = fixture(false, { toolbarHeight: 0 });
    h.launcher.fire('pointerdown');
    h.launcher.fire('pointermove', { clientX: -2000, clientY: -2000 });
    h.launcher.fire('pointerup');
    const writes = h.writes.length;
    h.node('wpadminbar').getBoundingClientRect = () => ({ bottom: 46 });
    h.window.fire('scroll');
    assert.equal(parseFloat(h.launcherContainer.style.top), 46 + h.launcherContainer.offsetHeight);
    h.node('wpadminbar').getBoundingClientRect = () => ({ bottom: -200 });
    h.window.fire('scroll');
    assert.equal(parseFloat(h.launcherContainer.style.top), h.launcherContainer.offsetHeight);
    assert.equal(h.writes.length, writes);
});

test('fullscreen state is not stored or restored as expanded mode', () => {
    const h = fixture(true, { layout: layout() });
    h.document.fullscreenElement = h.panel;
    h.document.fire('fullscreenchange');
    assert.equal(h.state.inPage, false);
    assert.equal(h.state.mode, 'compact');
    assert.equal(h.writes.length, 0);
    const reopened = fixture(true, { layout: h.preferences.get('layout') });
    assert.equal(reopened.state.mode, 'expand');
    assert.equal(reopened.state.inPage, true);
});
