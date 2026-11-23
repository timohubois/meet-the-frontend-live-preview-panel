import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runChromiumTests } from './helpers/chromium.mjs';

function browserTests(styles) {
    const results = [];
    function equal(actual, expected, message) {
        if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}.`);
    }
    function check(name, run) {
        try {
            run();
            results.push({ name });
        } catch (error) {
            results.push({ name, error: error.message });
        }
    }

    for (const [direction, css] of Object.entries(styles)) {
        document.documentElement.dir = direction;
        const style = document.createElement('style');
        style.textContent = css;
        const panel = document.createElement('section');
        panel.className = 'mtflpp-panel';
        panel.style.cssText = 'left:100px;top:100px;width:480px;height:400px';
        panel.innerHTML = `<header class="mtflpp-header"><button class="mtflpp-mode">Mode</button></header>
            <div class="mtflpp-viewport"><div class="mtflpp-canvas"><div class="mtflpp-canvas-space">
                <div class="mtflpp-stage" style="width:1280px;height:800px"></div>
            </div></div><div class="mtflpp-pip-control"><button style="width:20px;height:20px">PiP</button></div></div>
            <footer class="mtflpp-devicebar"><div class="mtflpp-viewport-controls"></div></footer>
            ${['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].map((edge) => `<span class="mtflpp-edge mtflpp-edge-${edge}"></span>`).join('')}
            <div class="mtflpp-resize-control"><button class="mtflpp-resize"></button><span class="mtflpp-resize-help">Resize help</span></div>`;
        const popover = document.createElement('div');
        popover.className = 'mtflpp-zoom-popover';
        popover.innerHTML = '<div class="components-popover__content"><div class="mtflpp-custom-zoom"></div><div class="mtflpp-dpr-note"></div></div>';
        const launcher = document.createElement('div');
        launcher.className = 'mtflpp-launcher';
        launcher.style.cssText = 'left:60px;top:50px';
        launcher.textContent = 'Preview';
        document.head.append(style);
        document.body.append(panel, popover, launcher);
        const styleOf = (selector) => getComputedStyle(panel.querySelector(selector));
        try {
            check(`${direction}: logical dimensions, spacing and separators retain their layout`, () => {
                equal(panel.getBoundingClientRect().width, 480, 'Physical window width');
                equal(panel.getBoundingClientRect().height, 400, 'Physical window height');
                const header = styleOf('.mtflpp-header');
                equal(header.blockSize, '44px', 'Header block size');
                equal(header.paddingBlockStart, '4px', 'Header block padding');
                equal(header.paddingInlineStart, '7px', 'Header inline padding');
                equal(header.borderBlockEndWidth, '1px', 'Header separator');
                equal(styleOf('.mtflpp-devicebar').borderBlockStartWidth, '1px', 'Footer separator');
                equal(styleOf('.mtflpp-mode').marginInlineStart, '6px', 'Mode-button spacing');
                for (const selector of ['.mtflpp-custom-zoom', '.mtflpp-dpr-note']) {
                    const section = getComputedStyle(popover.querySelector(selector));
                    equal(section.marginBlockStart, '12px', `${selector} block margin`);
                    equal(section.paddingBlockStart, '12px', `${selector} block padding`);
                    equal(section.borderBlockStartWidth, '1px', `${selector} separator`);
                }
            });

            check(`${direction}: the canvas origin and compass resize edges remain physical`, () => {
                equal(styleOf('.mtflpp-stage').transformOrigin, '0px 0px', 'Canvas scaling origin');
                const bounds = panel.getBoundingClientRect();
                for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
                    const handle = panel.querySelector(`.mtflpp-edge-${edge}`);
                    const rect = handle.getBoundingClientRect();
                    const offset = edge.length === 2 ? -6 : -4;
                    if (edge.includes('n')) equal(rect.top - bounds.top, offset, `${edge} north edge`);
                    if (edge.includes('s')) equal(bounds.bottom - rect.bottom, offset, `${edge} south edge`);
                    if (edge.includes('w')) equal(rect.left - bounds.left, offset, `${edge} west edge`);
                    if (edge.includes('e')) equal(bounds.right - rect.right, offset, `${edge} east edge`);
                }
                equal(styleOf('.mtflpp-edge-ne').cursor, 'nesw-resize', 'North-east cursor');
                equal(styleOf('.mtflpp-edge-nw').cursor, 'nwse-resize', 'North-west cursor');
            });

            check(`${direction}: PiP follows inline-end while window anchors keep physical coordinates`, () => {
                const pip = styleOf('.mtflpp-pip-control');
                equal(pip.insetInlineEnd, '12px', 'PiP inline-end offset');
                equal(pip.insetBlockEnd, '12px', 'PiP block-end offset');
                equal(direction === 'rtl' ? pip.left : pip.right, '12px', 'PiP trailing side');
                equal(launcher.getBoundingClientRect().left, 60, 'Launcher physical x coordinate');
                const bounds = panel.getBoundingClientRect();
                for (const anchor of ['left', 'center', 'right']) {
                    panel.dataset.anchor = anchor;
                    const grip = panel.querySelector('.mtflpp-resize-control').getBoundingClientRect();
                    const offset = anchor === 'left' ? bounds.right - grip.right : grip.left - bounds.left;
                    equal(offset, -12, `${anchor} physical resize corner`);
                }
            });
        } finally {
            panel.remove();
            popover.remove();
            launcher.remove();
            style.remove();
        }
    }
    return results;
}

test('logical panel CSS and physical preview geometry coexist in both LTR and RTL bundles', async (t) => {
    const [ltr, rtl] = await Promise.all([
        readFile(new URL('../build/classic-editor.css', import.meta.url), 'utf8'),
        readFile(new URL('../build/classic-editor-rtl.css', import.meta.url), 'utf8'),
    ]);
    await runChromiumTests(t, {
        script: `(${browserTests.toString()})(${JSON.stringify({ ltr, rtl })})`,
        count: 6,
    });
});
