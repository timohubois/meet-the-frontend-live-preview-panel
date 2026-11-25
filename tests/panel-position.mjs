import { readFile } from 'node:fs/promises';
import { runChromiumTests, testInChromium } from './helpers/chromium.mjs';
import { sourceForVm } from './helpers/modules.mjs';

// Exercise real layout, hidden-element measurement and responsive admin gutters. Mock only
// component rendering and native pointer capture; drive the view's actual event handlers.
function browserTests({ core, css, geometry, source }) {
    const results = [];
    for (const direction of ['ltr', 'rtl']) for (const [width, height] of [[1440, 900], [800, 600], [600, 480], [390, 600], [320, 240]]) {
        const name = `${direction} ${width}×${height}: heading label, startup, native gutters, drag fitting and focus`;
        const frame = document.createElement('iframe');
        frame.style.cssText = `width:${width}px;height:${height}px;border:0;display:block`;
        document.body.append(frame);
        try {
            const doc = frame.contentDocument;
            doc.open();
            doc.write(`<!doctype html><html dir="${direction}"><head><style>
                /* Relevant native classic-editor spacing, including its 782px breakpoint. */
                html { overflow-y:scroll; } body { margin:0; min-height:2000px; }
                #wpcontent { margin-inline-start:160px; padding-inline-start:20px; }
                .wrap { margin:10px 0 0; margin-inline-start:2px; margin-inline-end:20px; }
                #wpadminbar { position:fixed; top:0; left:0; right:0; height:32px; }
                @media (max-width:782px) {
                    #wpcontent { margin-inline-start:0; padding-inline-start:10px; }
                    .wrap { margin-inline-start:0; margin-inline-end:12px; }
                    #wpadminbar { height:46px; }
                }
                ${core}
                ${css}
                </style></head><body><div id="wpadminbar"></div>
                <div id="wpcontent"><div id="wpbody-content"><div class="wrap">Editor content</div></div></div>
                <div id="mtflpp-toggle" class="mtflpp-launcher" hidden><button type="button" class="components-button is-secondary"><span class="mtflpp-launcher-label">Floating live preview</span></button></div>
                <section id="mtflpp-panel" class="mtflpp-panel" aria-labelledby="mtflpp-title" hidden>
                    <header class="mtflpp-header"><div class="mtflpp-move-control"><button>Move</button></div>
                        <div class="mtflpp-titlebar"><h2 id="mtflpp-title" class="mtflpp-caption">Live preview</h2></div>
                        <div class="mtflpp-controls"><button data-action="actions">Actions</button></div></header>
                    <div class="mtflpp-feedback" hidden></div><div class="mtflpp-viewport"><div class="mtflpp-canvas" role="region" aria-label="Preview canvas" tabindex="-1"><div class="mtflpp-canvas-space"><div class="mtflpp-stage"></div></div></div><div class="mtflpp-empty"></div></div>
                    <footer class="mtflpp-devicebar"><span class="mtflpp-dimensions"></span></footer>
                    <button class="mtflpp-resize"></button><span role="status"></span>
                </section></body></html>`);
            doc.close();
            const win = doc.defaultView;
            // A saved corner may come from a screen or language with a shorter launcher label.
            // Measure the full text-only label before fitting it.
            const saved = { bounds: { x: -348, y: -268, width: 480, height: 340 }, dock: null, anchor: 'right', expanded: false };
            const preferences = new Map([['panelOpen', false], ['layout', saved]]);
            const focusCalls = [];
            let actions;
            const imports = {
                '@wordpress/data': {
                    select: () => ({ get: (scope, key) => scope === 'meet-the-frontend-live-preview-panel' ? preferences.get(key) : undefined }),
                    dispatch: () => ({ setDefaults() {}, set: (scope, key, value) => preferences.set(key, value) }),
                },
                '@wordpress/preferences': { store: {} },
                './geometry.js': { createPanelGeometry: win.Function(`${geometry}\nreturn createPanelGeometry;`)() },
                './viewport.js': { createPreviewViewport: () => ({ device: 'desktop', layout() {} }) },
                './controls.js': { createPreviewLauncher: (container) => container.querySelector('button'), createPreviewControls(panel, strings, callbacks) {
                    actions = callbacks;
                    return {
                        update() {},
                        closeMenu() {}, focus(action) {
                            focusCalls.push(action);
                            panel.querySelector(`[data-action="${action}"]`)?.focus();
                        },
                    };
                } },
            };
            const createPreviewPanel = win.Function('imports', `${source}\nreturn createPreviewPanel;`)(imports);
            const strings = new Proxy({}, { get: (target, key) => String(key) });
            const view = createPreviewPanel(strings, {
                postTitle: 'Initial post title',
                onOpen: () => view.setVisible(true), onClose: () => view.setVisible(false),
            });
            const launcher = doc.querySelector('#mtflpp-toggle button');
            const panel = doc.getElementById('mtflpp-panel');
            const caption = panel.querySelector('.mtflpp-caption');
            if (caption.tagName !== 'H2' || caption.tabIndex !== -1
                || doc.getElementById(panel.getAttribute('aria-labelledby')) !== caption
                || caption.textContent !== 'preview — Initial post title') {
                throw new Error('Name the panel through its visible, non-interactive heading.');
            }
            view.setTitle('  Updated\n<title>  ');
            if (caption.textContent !== 'preview — Updated <title>' || caption.childElementCount) {
                throw new Error('Keep the linked heading current and treat post titles as plain text.');
            }
            view.setTitle('');
            if (caption.textContent !== strings.title) throw new Error('An empty post title must retain the default panel name.');
            const close = (actual, expected, message) => {
                if (Math.abs(actual - expected) > 1) throw new Error(`${message}: got ${actual}, expected ${expected}`);
            };
            const gutter = width > 782 ? 20 : 12;
            const viewportLeft = doc.documentElement.getBoundingClientRect().left + win.scrollX;
            const viewportRight = viewportLeft + doc.documentElement.clientWidth;
            const initial = launcher.getBoundingClientRect();
            if (initial.left < viewportLeft - 1 || initial.right > viewportRight + 1
                || initial.top < doc.getElementById('wpadminbar').getBoundingClientRect().bottom - 1 || initial.bottom > height + 1) {
                throw new Error('Startup must fit the fully rendered floating launcher before any resize or scroll.');
            }
            if (preferences.get('layout') !== saved) throw new Error('Startup fitting must not rewrite the shared preferred corner.');
            actions.reset();
            close(launcher.getBoundingClientRect().right, viewportRight - gutter, 'Launcher matches the editor outer gutter');
            close(launcher.getBoundingClientRect().bottom, height - gutter, 'Launcher bottom uses the same gutter');
            view.setVisible(true);
            close(panel.getBoundingClientRect().right, viewportRight - gutter, 'Panel uses the same horizontal gutter');
            close(panel.getBoundingClientRect().bottom, height - gutter, 'Panel uses the same bottom gutter');
            actions.close();
            const key = (control, name) => control.dispatchEvent(new win.KeyboardEvent('keydown', { key: name, shiftKey: true, cancelable: true }));
            for (let i = 0; i < 40; i++) { key(launcher, 'ArrowLeft'); key(launcher, 'ArrowUp'); }
            const corner = launcher.getBoundingClientRect();
            close(corner.left, viewportLeft, 'The closed launcher reaches the usable left edge');
            close(corner.top, width > 782 ? 32 : 46, 'The closed launcher reaches immediately below the admin bar');
            launcher.dispatchEvent(new win.MouseEvent('click', { detail: 1 }));
            if (!view.visible || focusCalls.length) throw new Error('Pointer opening must not focus Preview actions.');
            const box = panel.getBoundingClientRect();
            if (box.left < viewportLeft || box.top < 0 || box.right > viewportRight + 1 || box.bottom > height + 1) throw new Error('Opening must temporarily fit the full panel within the viewport.');
            actions.close();
            close(launcher.getBoundingClientRect().left, corner.left, 'Closing restores the preferred launcher corner');
            close(launcher.getBoundingClientRect().top, corner.top, 'Opening does not rewrite the launcher corner');
            launcher.dispatchEvent(new win.MouseEvent('click', { detail: 0 }));
            if (focusCalls.join() !== 'actions' || doc.activeElement?.dataset.action !== 'actions') throw new Error('Keyboard opening retains accessible focus transfer.');
            actions.close();
            launcher.querySelector('.mtflpp-launcher-label').textContent = 'A long translated live preview label '.repeat(8);
            win.dispatchEvent(new win.Event('resize'));
            const long = launcher.getBoundingClientRect();
            if (long.left < viewportLeft - 1 || long.right > viewportRight + 1) throw new Error('Real translated launcher dimensions must fit independently.');
            {
                view.setVisible(true);
                // Control paint timing; native pointer capture is outside this layout regression.
                const paints = [];
                win.requestAnimationFrame = (callback) => paints.push(callback);
                win.cancelAnimationFrame = () => {};
                const paint = () => { for (const callback of paints.splice(0)) callback(); };
                const move = panel.querySelector('.mtflpp-move-control');
                move.setPointerCapture = () => {};
                move.hasPointerCapture = () => false;
                let start;
                const pointer = (type, dx, dy) => move.firstElementChild.dispatchEvent(new win.PointerEvent(type, {
                    pointerId: 1, button: 0, clientX: start.left + 10 + dx, clientY: start.top + 10 + dy,
                    bubbles: true, cancelable: true,
                }));
                for (const event of width >= 800 ? ['scroll', 'resize'] : []) {
                    start = panel.getBoundingClientRect();
                    pointer('pointerdown', 0, 0);
                    pointer('pointermove', 50, 30); paint();
                    close(panel.getBoundingClientRect().left, start.left + 50, 'Initial drag follows the pointer horizontally');
                    close(panel.getBoundingClientRect().top, start.top + 30, 'Initial drag follows the pointer vertically');
                    win.dispatchEvent(new win.Event(event));
                    close(panel.getBoundingClientRect().left, start.left + 50, `${event} redraw retains the current horizontal position`);
                    close(panel.getBoundingClientRect().top, start.top + 30, `${event} redraw retains the current vertical position`);
                    pointer('pointermove', 60, 40); paint();
                    close(panel.getBoundingClientRect().left, start.left + 60, `${event} must not reapply prior horizontal movement`);
                    close(panel.getBoundingClientRect().top, start.top + 40, `${event} must not reapply prior vertical movement`);
                    pointer('pointerup', 60, 40);
                    close(panel.getBoundingClientRect().left, start.left + 60, 'Releasing the drag does not jump horizontally');
                    close(panel.getBoundingClientRect().top, start.top + 40, 'Releasing the drag does not jump vertically');
                }
                actions.reset();
                start = panel.getBoundingClientRect();
                pointer('pointerdown', 0, 0);
                pointer('pointermove', -50, -30); paint();
                const during = panel.getBoundingClientRect();
                pointer('pointerup', -50, -30);
                const released = panel.getBoundingClientRect();
                for (const key of ['left', 'top', 'width', 'height']) {
                    close(during[key], released[key], `Undocking must paint the final fitted ${key} before release`);
                }
                if (during.left < viewportLeft - 1 || during.right > viewportRight + 1 || during.bottom > height + 1) throw new Error('The moving panel must remain inside the viewport.');
                const preferred = preferences.get('layout').bounds;
                if (preferred.width !== 480 || preferred.height !== 393) throw new Error('Moving must not replace preferred dimensions with temporary fitting.');
            }
            results.push({ name });
        } catch (error) { results.push({ name, error: error.message }); }
        finally { frame.remove(); }
    }
    return results;
}

testInChromium('responsive panel and launcher geometry', async (t) => {
    const [core, css, geometry, source] = await Promise.all([
        readFile(new URL('../node_modules/@wordpress/components/build-style/style.css', import.meta.url), 'utf8'),
        readFile(new URL('../build/classic-editor.css', import.meta.url), 'utf8'),
        sourceForVm(new URL('../src/panel/geometry.js', import.meta.url)),
        sourceForVm(new URL('../src/panel/window.js', import.meta.url)),
    ]);
    await runChromiumTests(t, {
        script: `(${browserTests.toString()})(${JSON.stringify({ core, css, geometry, source })})`, count: 10,
    });
});
