import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import webpack from 'webpack';
import { runChromiumTests, testInChromium } from './helpers/chromium.mjs';
import { panelStrings } from './helpers/panel-strings.mjs';

// Exercise panel CSS and the native overlay layers; WordPress owns actual menu rendering and positioning.
function browserTests(css) {
    const results = [];
    for (const pip of [false, true]) for (const height of [120, 180, 440]) {
        const name = `${pip ? 'PiP' : 'in-page'} menu in a ${height}px-high document`;
        const frame = document.createElement('iframe');
        frame.style.cssText = `width:360px;height:${height}px;border:0`;
        document.body.append(frame);
        try {
            const doc = frame.contentDocument;
            doc.open();
            doc.write(`<!doctype html><html><head><style>${css}</style></head><body class="mtflpp-pip-document">
                <section class="mtflpp-panel${pip ? ' mtflpp-pip' : ''}">
                    <div class="mtflpp-menu-popover" style="position:absolute;top:46px;right:8px">
                        <div class="components-popover__content" style="border:1px solid black">
                            ${Array.from({ length: 16 }, (_, i) => `<button type="button" style="display:block;height:32px">Command ${i}</button>`).join('')}
                        </div>
                    </div>
                </section></body></html>`);
            doc.close();
            const content = doc.querySelector('.components-popover__content');
            const style = doc.defaultView.getComputedStyle(content);
            if (!pip) {
                if (style.maxHeight !== 'none' || style.overflowY !== 'visible') throw new Error('Do not override in-page native sizing.');
            } else {
                const rect = content.getBoundingClientRect();
                if (style.maxHeight !== `${height - 48}px` || style.overflowY !== 'auto') throw new Error('PiP needs a destination-viewport height cap and scrolling.');
                if (rect.top < 0 || rect.bottom > height) throw new Error('The PiP menu extends beyond its document.');
                if (content.scrollHeight <= content.clientHeight) throw new Error('The fixture must exercise overflowing commands.');
                content.lastElementChild.scrollIntoView({ block: 'end' });
                const last = content.lastElementChild.getBoundingClientRect();
                if (content.scrollTop <= 0 || last.top < rect.top || last.bottom > rect.bottom) throw new Error('The final command must be reachable by scrolling.');
            }
            results.push({ name });
        } catch (error) { results.push({ name, error: error.message }); }
        finally { frame.remove(); }
    }
    const name = 'PiP shortcut stays viewport-pinned and keyboard-focusable';
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const layeringName = 'in-page menu overlays the admin bar without raising the panel';
    const adminBar = document.createElement('div');
    adminBar.style.cssText = 'position:fixed;inset:0 0 auto;height:32px;z-index:99999;background:black';
    const shell = document.createElement('section');
    shell.className = 'mtflpp-panel';
    shell.style.cssText = 'left:0;top:80px;width:360px;height:240px';
    const menu = document.createElement('div');
    menu.className = 'components-popover mtflpp-menu-popover';
    // WordPress gives its native popovers z-index 1000000.
    menu.style.cssText = 'position:fixed;left:100px;top:8px;width:200px;height:120px;z-index:1000000;background:white';
    document.body.append(adminBar, shell, menu);
    try {
        if (Number(getComputedStyle(shell).zIndex) >= Number(getComputedStyle(adminBar).zIndex)) throw new Error('Keep the panel below native admin overlays.');
        if (document.elementFromPoint(110, 20) !== menu) throw new Error('The menu must remain visible and clickable over the admin bar.');
        shell.append(menu);
        if (document.elementFromPoint(110, 20) !== adminBar) throw new Error('The fixture must reproduce the clipping when the menu is trapped inside the panel.');
        results.push({ name: layeringName });
    } catch (error) { results.push({ name: layeringName, error: error.message }); }
    finally { menu.remove(); shell.remove(); adminBar.remove(); }
    const panel = document.createElement('section');
    panel.className = 'mtflpp-panel';
    panel.style.cssText = 'left:0;top:0;width:360px;height:240px';
    panel.innerHTML = '<div class="mtflpp-viewport"><div class="mtflpp-pip-control"><div class="mtflpp-pip-surface"><button class="components-button mtflpp-pip-button" aria-label="Keep on top"></button></div></div></div>';
    document.body.append(panel);
    try {
        const button = panel.querySelector('button');
        const surface = panel.querySelector('.mtflpp-pip-surface');
        const control = panel.querySelector('.mtflpp-pip-control');
        const viewport = panel.querySelector('.mtflpp-viewport').getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        if (viewport.right - rect.right !== 12 || viewport.bottom - rect.bottom !== 12) throw new Error('Keep the shortcut inside the viewport bottom-right corner.');
        const touch = matchMedia('(hover: none)').matches;
        if (getComputedStyle(surface).opacity !== (touch ? '1' : '0')) throw new Error('Hide the entire shortcut and its backing at rest unless the device cannot hover.');
        const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (getComputedStyle(surface).transitionDuration !== (reducedMotion ? '0s' : '0.16s')) throw new Error('Use a short opacity fade, respecting reduced motion.');
        if (getComputedStyle(control, '::before').inset !== '-12px') throw new Error('Limit proximity to the small area around the button.');
        button.focus();
        if (document.activeElement !== button || getComputedStyle(surface).opacity !== '1' || getComputedStyle(surface).transitionDuration !== '0s') throw new Error('Keyboard focus must reveal the shortcut immediately.');
        if (getComputedStyle(button).pointerEvents !== 'auto') throw new Error('The revealed shortcut must accept clicks.');
        control.replaceChildren();
        if (getComputedStyle(control).display !== 'none') throw new Error('An unavailable shortcut must not leave an invisible hit area over the preview.');
        results.push({ name });
    } catch (error) { results.push({ name, error: error.message }); }
    finally { panel.remove(); }
    for (const direction of ['ltr', 'rtl']) for (const anchor of ['left', 'center', 'right']) {
        const name = `${direction} ${anchor} boundary resizing stays physical, keyboard-accessible and out of the header`;
        panel.dir = direction;
        panel.dataset.anchor = anchor;
        panel.innerHTML = `<header class="mtflpp-header"><button class="components-button mtflpp-move">Move preview</button><h2 class="mtflpp-caption">Title</h2></header>
            <span class="mtflpp-edge mtflpp-edge-n"></span><span class="mtflpp-edge mtflpp-edge-e"></span><span class="mtflpp-edge mtflpp-edge-nw"></span>
            <div class="mtflpp-resize-control"><button class="mtflpp-resize" aria-label="Resize preview"></button></div>`;
        document.body.append(panel);
        try {
            const grip = panel.querySelector('.mtflpp-resize');
            const rect = grip.getBoundingClientRect(), box = panel.getBoundingClientRect();
            if (rect.width < 24 || rect.height < 24) throw new Error('The keyboard boundary needs a usable focus indicator.');
            if (anchor === 'left' ? rect.left < box.left + box.width / 2 : rect.left > box.left + box.width / 2) throw new Error('Keep the keyboard boundary at its physical free corner, including RTL.');
            if (panel.querySelector('.mtflpp-header .mtflpp-resize')) throw new Error('No resize icon or resize Tab stop in the header.');
            for (const [selector, cursor] of [['n', 'ns-resize'], ['e', 'ew-resize'], ['nw', 'nwse-resize']]) {
                if (getComputedStyle(panel.querySelector('.mtflpp-edge-' + selector)).cursor !== cursor) throw new Error('Pointer borders need directional cursors.');
            }
            if (getComputedStyle(panel.querySelector('.mtflpp-move')).cursor !== 'grab') throw new Error('The dedicated move button retains its grab cursor.');
            grip.focus();
            if (document.activeElement !== grip) throw new Error('The boundary resize control must remain keyboard-focusable.');
            panel.classList.add('mtflpp-expanded');
            if (grip.getClientRects().length) throw new Error('Expanded mode hides the keyboard boundary.');
            panel.classList.remove('mtflpp-expanded');
            results.push({ name });
        } catch (error) { results.push({ name, error: error.message }); }
        finally { panel.remove(); }
    }
    const placeholderName = 'native Placeholder instructions remain readable at compact widths';
    panel.innerHTML = '<div class="mtflpp-empty"><div class="components-placeholder mtflpp-placeholder is-medium"><div class="components-placeholder__instructions">Recovery instructions</div></div></div>';
    const coreStyle = document.createElement('style');
    // Core hides block Placeholder instructions below its medium-width breakpoint.
    coreStyle.textContent = '.components-placeholder.is-medium .components-placeholder__instructions, .components-placeholder.is-small .components-placeholder__instructions { display:none; }';
    document.head.prepend(coreStyle);
    document.body.append(panel);
    try {
        for (const size of ['is-medium', 'is-small']) {
            panel.querySelector('.components-placeholder').className = `components-placeholder mtflpp-placeholder ${size}`;
            if (getComputedStyle(panel.querySelector('.components-placeholder__instructions')).display !== 'block') throw new Error('Do not hide loading, permission or recovery instructions.');
        }
        results.push({ name: placeholderName });
    } catch (error) { results.push({ name: placeholderName, error: error.message }); }
    finally { panel.remove(); coreStyle.remove(); }
    style.remove();
    return results;
}

testInChromium('menu layering, PiP bounds, preview shortcut and geometry controls', async (t) => {
    const css = await readFile(new URL('../build/classic-editor.css', import.meta.url), 'utf8');
    await runChromiumTests(t, { script: `(${browserTests.toString()})(${JSON.stringify(css)})`, count: 15 });
});

function nativeLauncherTests() {
    const results = [];
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    for (const direction of ['ltr', 'rtl']) {
        const name = `native ${direction} launcher renders a secondary Button with an accessible description`;
        const container = document.createElement('div');
        container.dir = direction;
        container.className = 'mtflpp-launcher';
        container.hidden = true;
        container.style.cssText = 'left:20px;top:20px';
        Object.assign(container.dataset, { title: 'Live preview', moveHelp: 'Drag or use arrow keys.' });
        document.body.append(container);
        try {
            const button = window.previewControls.createPreviewLauncher(container);
            check(button instanceof HTMLButtonElement && button.classList.contains('components-button') && button.classList.contains('is-secondary'), 'Render the native secondary Button component.');
            check(container.firstElementChild === button && !container.querySelector('.components-card'), 'Render the button directly without a Card edge competing with its focus ring.');
            check(container.hidden && !button.getClientRects().length && button.getAttribute('aria-expanded') === 'false', 'Hide the entire native surface until it is positioned.');
            check(button.getAttribute('aria-controls') === 'mtflpp-panel' && !button.hasAttribute('href'), 'Keep native button semantics.');
            check(button.getAttribute('aria-label') === 'Live preview', 'Keep the action label independent of status messages.');
            const description = document.getElementById(button.getAttribute('aria-describedby'));
            check(description?.textContent === container.dataset.moveHelp, 'Let Button provide its accessible description.');
            check(!button.querySelector('svg, .components-external-link__icon') && button.querySelector('.mtflpp-launcher-label')?.textContent === 'Live preview', 'Keep the launcher text-only rather than suggesting an external link.');
            container.hidden = false;
            const reference = button.cloneNode(true);
            reference.removeAttribute('id');
            reference.removeAttribute('aria-describedby');
            document.body.append(reference);
            try {
                const properties = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'webkitFontSmoothing', 'height', 'padding', 'backgroundColor', 'backgroundImage', 'border', 'borderRadius', 'boxShadow', 'outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset'];
                const appearance = (element) => JSON.stringify(properties.map((property) => getComputedStyle(element)[property]));
                for (const focused of [false, true]) {
                    if (focused) button.focus();
                    const actual = appearance(button);
                    if (focused) reference.focus();
                    check(actual === appearance(reference), 'Preserve native secondary Button appearance and focus.');
                    button.blur();
                    reference.blur();
                }
                check(getComputedStyle(container).backgroundColor === 'rgb(255, 255, 255)', 'Keep the floating surface opaque over editor content.');
                check(getComputedStyle(container).boxShadow !== 'none', 'Apply the subtle floating shadow to the mount, not the button focus ring.');
                check(getComputedStyle(container).borderRadius === getComputedStyle(button).borderRadius, 'Align the floating surface with the native button corners.');
                check(container.getBoundingClientRect().height === button.getBoundingClientRect().height, 'Fit the surface without a baseline gap.');
                check(getComputedStyle(button).cursor === 'grab', 'Keep the launcher draggable.');
            } finally { reference.remove(); }
            button.focus();
            check(document.activeElement === button, 'The native button must receive focus.');
            let clicks = 0;
            button.addEventListener('click', () => clicks++);
            button.click();
            check(clicks === 1, 'Existing shell handlers must receive the native button click once.');
            container.style.maxWidth = '120px';
            button.querySelector('.mtflpp-launcher-label').textContent = 'A long translated live preview label '.repeat(8);
            const box = container.getBoundingClientRect();
            check(box.width <= 120 && button.getBoundingClientRect().width <= box.width, 'Fit the entire secondary Button to the available width.');
            const label = button.querySelector('.mtflpp-launcher-label');
            const text = label.getBoundingClientRect(), bounds = button.getBoundingClientRect();
            check(text.width > 0 && text.left >= bounds.left && text.right <= bounds.right, 'Keep the translated label inside the button in both directions.');
            check(label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis' && button.scrollWidth <= button.clientWidth, 'Truncate the long label without overflowing the button.');
            results.push({ name });
        } catch (error) { results.push({ name, error: error.stack }); }
        finally { container.remove(); }
    }
    return results;
}

async function nativePreferenceTests(strings) {
    const results = [];
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    for (const mode of ['in-page', 'fullscreen', 'PiP']) {
        const name = `${mode} native menu exposes and toggles Remember size and position`;
        const panel = document.createElement('section');
        panel.className = 'mtflpp-panel';
        panel.style.cssText = 'left:20px;top:20px;width:480px;height:340px';
        panel.innerHTML = ['controls', 'refresh-control', 'move-control', 'device-controls', 'fit-control', 'pip-control', 'empty', 'feedback']
            .map((name) => `<div class="mtflpp-${name}"></div>`).join('');
        document.body.append(panel);
        let controls;
        try {
            let state = {
                inPage: mode === 'in-page', inPip: mode === 'PiP', movable: mode === 'in-page', mode: 'expand', modeLabel: strings.expand,
                canPip: mode === 'in-page', canFullscreen: mode === 'in-page',
                hasPreview: true, dock: 'center', device: 'desktop', fit: 'window', orientation: 'landscape',
                rememberVisibility: true, rememberPosition: true, followChanges: true,
            };
            let toggles = 0, closes = 0;
            controls = window.previewControls.createPreviewControls(panel, strings, {
                close() { closes++; },
                rememberPosition() {
                    toggles++;
                    state = { ...state, rememberPosition: !state.rememberPosition };
                    controls.update(state);
                },
            });
            controls.update(state);
            const trigger = panel.querySelector('[data-action="actions"]');
            const preference = () => document.querySelector('[data-action="remember-position"]');
            for (const checked of [true, false]) {
                trigger.click();
                await pause();
                const item = preference();
                check(item?.getAttribute('role') === 'menuitemcheckbox', 'Use the native checkbox menu item.');
                for (const [action, key, selected] of [['remember-visibility', 'rememberVisibility', true], ['remember-position', 'rememberPosition', checked], ['follow', 'follow', true]]) {
                    const toggle = document.querySelector(`[data-action="${action}"]`);
                    check(toggle.getAttribute('role') === 'menuitemcheckbox' && toggle.getAttribute('aria-checked') === String(selected), 'Expose every preference as a native checkbox with its current state.');
                    const label = toggle.querySelector('.components-menu-item__info-wrapper > .components-menu-item__item');
                    const help = toggle.querySelector('.components-menu-item__info');
                    check(label?.textContent.trim() === strings[key], 'Use the plain-language setting name.');
                    check(help?.textContent === strings[`${key}Help`], 'Show the explanation as native menu help, not a hidden tooltip.');
                    check(toggle.scrollWidth <= toggle.clientWidth && help.scrollWidth <= help.clientWidth, 'Keep labels and explanations inside the native menu.');
                }
                check(!document.querySelector('[data-action="open-preview"], .mtflpp-panel a[target="_blank"]'), 'Do not offer a separate preview tab.');
                const reset = document.querySelector('[data-action="reset"]');
                check(mode !== 'in-page' || reset?.querySelector('.components-menu-item__info')?.textContent === strings.resetHelp, 'Explain where resetting puts the window.');
                if (mode === 'in-page') {
                    for (const action of ['pip', 'pop-out']) {
                        const button = document.querySelector(`[data-action="${action}"]`);
                        check(button.getAttribute('aria-label') === 'Keep on top', 'Describe what the window does, not the browser API.');
                        const help = document.getElementById(button.getAttribute('aria-describedby'));
                        check(help?.textContent === 'Open the preview in a separate Picture-in-Picture window.', 'Name the browser feature in the associated help while keeping the action label plain.');
                    }
                    const pip = document.querySelector('[data-action="pip"]');
                    check(pip.textContent.trim() === 'Keep on top', 'Keep the action label short.');
                }
                item.focus();
                check(document.activeElement === item, 'Keep the preference keyboard-focusable.');
                item.click();
                await pause();
                check(!preference(), 'Toggling closes the menu like the other preferences.');
                check(state.rememberPosition === !checked, 'Update the preference once without changing display mode.');
            }
            check(toggles === 2, 'Invoke each toggle only once.');
            if (mode === 'PiP') {
                controls.focus('mode');
                check(document.activeElement === trigger && !panel.querySelector('[data-action="mode"], [data-action="close"]'), 'Use native browser window controls and focus the actions menu.');
                trigger.click(); await pause();
                document.querySelector('[data-action="close"]').click();
                check(closes === 1 && !preference(), 'The PiP menu must close live preview once and dismiss itself.');
            }
            results.push({ name });
        } catch (error) { results.push({ name, error: error.stack }); }
        finally { controls?.beforeMove(); panel.remove(); }
    }
    return results;
}

async function nativeNoticeTests(strings) {
    const results = [];
    const { createPreviewControls, dispatch, select, noticesStore } = window.previewControls;
    const actions = dispatch(noticesStore), selectors = select(noticesStore);
    const context = 'meet-the-frontend-live-preview-panel';
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    actions.createInfoNotice('Editor-owned notice', { id: 'unrelated-editor-notice', speak: false });
    const editorNotices = selectors.getNotices();
    const theme = window.wp.theme;
    for (const mode of ['in-page', 'fullscreen', 'PiP']) {
        const name = `${mode} feedback uses scoped native inline notices and preserves recovery and dismissal`;
        // Older core may expose notices without the optional theme provider.
        window.wp.theme = mode === 'fullscreen' ? undefined : theme;
        const panel = document.createElement('section');
        panel.className = 'mtflpp-panel';
        panel.style.cssText = 'left:20px;top:20px;width:480px;height:340px';
        panel.innerHTML = ['controls', 'refresh-control', 'move-control', 'device-controls', 'fit-control', 'pip-control', 'empty', 'feedback']
            .map((name) => `<div class="mtflpp-${name}"></div>`).join('');
        document.body.append(panel);
        let controls, frame;
        try {
            let state = {
                inPage: mode === 'in-page', inPip: mode === 'PiP', hasPreview: true, device: 'desktop', fit: 'window', orientation: 'landscape',
                notice: { heading: 'Could not update preview.', description: 'Showing the previous preview.', status: 'warning', dismissible: false, retry: true, action: strings.retry },
            };
            let retries = 0, dismissals = 0;
            controls = createPreviewControls(panel, strings, {
                retry() { retries++; },
                dismissNotice() { dismissals++; state = { ...state, notice: null }; controls.update(state); },
            });
            controls.update(state);
            await pause();
            const notice = panel.querySelector('.notices-inline-notices__notice');
            check(notice && !panel.querySelector('.components-notice'), 'Use the real newer inline renderer, not CSS on a legacy Notice.');
            check(notice.querySelector('svg') && !notice.querySelector('strong'), 'Let core provide the status icon and plain message.');
            check(notice.textContent.includes('Could not update preview. Showing the previous preview.'), 'Keep both parts of the message.');
            const style = getComputedStyle(notice);
            check(style.borderTopWidth === '0px' && style.borderLeftWidth === '0px' && style.borderRightWidth === '0px' && (!window.wp.theme || style.borderRadius === '0px'), `Integrate with the single header separator and flush editor notice edges: ${style.borderTopWidth}/${style.borderLeftWidth}/${style.borderRightWidth}/${style.borderRadius}.`);
            let record = selectors.getNotices(context)[0];
            check(record.spokenMessage === null && !record.isDismissible, 'Do not duplicate the shell announcement or dismiss an unresolved failure.');
            const retry = [...notice.querySelectorAll('button')].find((button) => button.textContent === strings.retry);
            retry.click();
            check(retries === 1, 'Invoke recovery once through the native action.');
            retry.focus();
            controls.update({ ...state, device: 'mobile', notice: { ...state.notice } });
            await pause();
            check(panel.querySelector('.notices-inline-notices__notice') === notice && document.activeElement === retry, 'Unrelated updates must preserve the notice and action focus.');
            state = { ...state, notice: { ...state.notice, disabled: true } };
            controls.update(state);
            await pause();
            check(retry.disabled || retry.getAttribute('aria-disabled') === 'true', 'Native recovery actions respect disabled state.');
            retry.click();
            check(retries === 1, 'Disabled actions cannot retry.');
            if (mode === 'PiP') {
                controls.beforeMove();
                controls.update(state);
                check(selectors.getNotices(context).length === 0, 'Keep our notice cleared while the controls are detached.');
                frame = document.createElement('iframe');
                document.body.append(frame);
                for (const sheet of document.styleSheets) {
                    const copy = frame.contentDocument.createElement('style');
                    copy.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
                    frame.contentDocument.head.append(copy);
                }
                frame.contentDocument.body.append(panel);
                controls.remount();
                await pause();
                check(panel.querySelector('.notices-inline-notices__notice') && selectors.getNotices(context).length === 1, 'Restore native feedback in the destination document.');
            }
            const feedback = panel.querySelector('.mtflpp-feedback');
            const textLines = () => {
                const description = feedback.querySelector('.notices-inline-notices__notice > :is(p, span)');
                check(description?.textContent === state.notice.heading, 'Keep the label and destination together as plain text.');
                const range = document.createRange();
                range.selectNodeContents(description);
                return [...range.getClientRects()];
            };
            state = { ...state, notice: { heading: 'Public URL redirects to: /BaseStyle/', status: 'info', dismissible: false } };
            controls.update(state);
            await pause();
            check(textLines().length === 1, 'Short redirect notices fit on one line.');

            panel.style.width = '280px';
            state = { ...state, notice: { ...state.notice, heading: `Public URL redirects to: /${'long'.repeat(32)}/` } };
            controls.update(state);
            await pause();
            const lines = textLines();
            const { left, right } = feedback.getBoundingClientRect();
            check(lines.length > 1 && lines.every((line) => line.left >= left - 1 && line.right <= right + 1)
                && feedback.scrollWidth <= feedback.clientWidth + 1, 'Very long paths wrap without horizontal overflow.');
            panel.style.width = '480px';

            const address = 'https://other.example/news/page/';
            state = { ...state, notice: {
                heading: strings.originMismatchTitle, description: strings.originMismatch.replace('%s', address), status: 'error', dismissible: false,
            } };
            controls.update(state);
            await pause();
            check(feedback.innerText.includes(`\n${address}\n`), 'Put the preview URL on its own line in native notices.');

            state = { ...state, notice: { heading: 'Window operation failed', status: 'info', dismissible: true } };
            controls.update(state);
            await pause();
            record = selectors.getNotices(context)[0];
            check(record.isDismissible, 'Incidental window messages remain dismissible.');
            const close = panel.querySelector('.mtflpp-feedback button');
            check(close, 'Core supplies its own dismiss button.');
            close.click();
            await pause();
            check(dismissals === 1 && selectors.getNotices(context).length === 0 && !panel.querySelector('.notices-inline-notices__notice'), 'Dismissal clears shell state and the scoped store once.');
            check(selectors.getNotices() === editorNotices, 'Never change editor-owned notices.');
            results.push({ name });
        } catch (error) { results.push({ name, error: error.stack }); }
        finally { controls?.beforeMove(); panel.remove(); frame?.remove(); window.wp.theme = theme; }
    }
    actions.removeNotice('unrelated-editor-notice');
    return results;
}

async function nativeViewportControlTests(strings) {
    // Use a translated label wider than the footer’s original fixed space reservation.
    strings = { ...strings, mobile: 'Téléphone portable' };
    const results = [];
    const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    for (const mode of ['floating', 'expanded', 'fullscreen', 'PiP']) for (const width of mode === 'PiP' ? [240, 320, 480, 900] : [320, 480, 900]) {
        const name = `${mode}, ${width}px: unified Zoom, custom percentages, rotation and responsive footer`;
        const panel = document.createElement('section');
        panel.className = 'mtflpp-panel';
        panel.dir = width === 480 ? 'rtl' : 'ltr';
        panel.dataset.hasPreview = 'true';
        panel.style.cssText = `position:relative;width:${width}px;height:340px`;
        panel.innerHTML = '<header class="mtflpp-header"><div class="mtflpp-move-control"></div><div class="mtflpp-refresh-control"></div><div class="mtflpp-titlebar">Preview</div><div class="mtflpp-controls"></div></header><div class="mtflpp-feedback" hidden></div><div class="mtflpp-viewport"><div class="mtflpp-canvas" role="region" aria-label="Preview canvas" tabindex="-1"><div class="mtflpp-canvas-space"><div class="mtflpp-stage"></div></div></div><div class="mtflpp-empty" hidden></div><div class="mtflpp-pip-control"></div></div><footer class="mtflpp-devicebar"><div class="mtflpp-device-controls"></div><div class="mtflpp-viewport-controls"><span class="mtflpp-dimensions"><span class="mtflpp-dimensions-text"></span></span><div class="mtflpp-fit-control"></div></div></footer>';
        document.body.append(panel);
        let controls, viewport, state, frame;
        const sync = () => {
            if (!controls) return;
            state = { ...state, device: viewport.device, fit: viewport.fit, orientation: viewport.orientation,
                zoomPercent: viewport.zoomPercent, customZoom: viewport.customZoom, dpr: viewport.dpr };
            controls.update(state);
        };
        try {
            viewport = window.previewControls.createPreviewViewport(panel.querySelector('.mtflpp-viewport'), panel.querySelector('.mtflpp-stage'), panel.querySelector('.mtflpp-dimensions'), { device: 'tablet' }, sync, strings);
            state = {
                inPage: mode === 'floating' || mode === 'expanded', inPip: mode === 'PiP', movable: mode === 'floating',
                mode: 'expand', modeLabel: strings.expand, hasPreview: true, canRefresh: true,
                device: viewport.device, fit: viewport.fit, orientation: viewport.orientation,
            };
            controls = window.previewControls.createPreviewControls(panel, strings, {
                fit(value) { viewport.setFit(value); sync(); },
                zoom(value) { viewport.setZoom(value); sync(); },
                device(value) {
                    if (value === viewport.device) viewport.rotate();
                    else viewport.select(value);
                    sync();
                },
            });
            sync();
            await pause();
            if (mode === 'floating' && width === 480) {
                panel.style.height = '393px';
                viewport.select('desktop');
                await pause();
                const canvas = panel.querySelector('.mtflpp-canvas');
                check(canvas.clientWidth === 480 && canvas.clientHeight === 300,
                    `The default panel must hug the Desktop preview: ${canvas.clientWidth}×${canvas.clientHeight}.`);
                check(viewport.zoomPercent === Math.min(100, Math.round(37.5 * devicePixelRatio)),
                    'Desktop Auto respects the fitting scale and the 100% cap.');
                // Around the footer's wrapping boundary, 100% used to wrap the footer,
                // shrink the canvas and become a two-digit zoom that unwrapped it again.
                panel.style.height = `${844 / viewport.dpr + 93}px`;
                viewport.select('mobile');
                for (const narrowWidth of [418, 420, 422, 424, 426, 440, 448, 480]) {
                    panel.style.width = `${narrowWidth}px`;
                    await pause();
                    const layouts = new Set();
                    for (let pass = 0; pass < 8; pass++) {
                        viewport.layout();
                        layouts.add(`${viewport.zoomPercent}:${panel.querySelector('.mtflpp-devicebar').getBoundingClientRect().height}`);
                    }
                    check(layouts.size === 1, `Auto and the footer must settle at ${narrowWidth}px, not alternate across digit counts.`);
                    viewport.setZoom(99);
                    const readoutWidth = panel.querySelector('.mtflpp-dimensions').getBoundingClientRect().width;
                    const footerHeight = panel.querySelector('.mtflpp-devicebar').getBoundingClientRect().height;
                    for (const percent of [100, 400]) {
                        viewport.setZoom(percent);
                        check(panel.querySelector('.mtflpp-dimensions').getBoundingClientRect().width === readoutWidth,
                            'Changing zoom digit counts must not resize the readout.');
                        check(panel.querySelector('.mtflpp-devicebar').getBoundingClientRect().height === footerHeight,
                            'Changing zoom digit counts must not rewrap the footer.');
                    }
                    viewport.setFit('automatic');
                }
                viewport.setZoom(100);
                viewport.setFit('automatic');
                panel.style.width = '480px';
                panel.style.height = '340px';
                viewport.select('tablet');
                await pause();
            }
            const checkIcons = () => {
                for (const button of panel.querySelectorAll('[data-viewport]')) {
                    const svg = button.querySelector('svg');
                    check(svg?.parentElement === button, 'Native SVGs must not be nested in an unsized icon wrapper.');
                    const rect = svg.getBoundingClientRect();
                    check(rect.width === 24 && rect.height === 24, `Native toolbar icons must paint at 24×24, not shrink to dots: ${rect.width}×${rect.height}.`);
                    const glyph = svg.querySelector('path').getBoundingClientRect();
                    check(glyph.width >= 8 && glyph.height >= 8, 'The actual icon paths must remain visible at native size.');
                }
            };
            checkIcons();
            const toggle = () => panel.querySelector('[data-action="zoom"]');
            check(toggle()?.classList.contains('components-button'), 'Use a native Button to open Zoom.');
            check(state.fit === 'automatic' && toggle().textContent === strings.automatic, 'The Zoom button shows only the mode name.');
            const readout = panel.querySelector('.mtflpp-dimensions');
            check(readout.textContent === `Tablet (768 × 1024) · ${state.zoomPercent}%`, 'The readout reports the device, viewport size and computed zoom.');
            const textRange = document.createRange();
            textRange.selectNodeContents(readout);
            check(Math.abs(textRange.getBoundingClientRect().right - readout.getBoundingClientRect().right) <= 1, 'The readout text aligns to the right of its reserved space.');
            check(!panel.querySelector('select[data-action="fit"]'), 'No separate fitting selector remains.');
            const toggleWidth = toggle().getBoundingClientRect().width;
            const choice = (popup, fit) => popup.querySelector(`input[type="radio"][value="${fit}"]`);
            const showZoom = async () => {
                const canvasHeight = panel.querySelector('.mtflpp-viewport').getBoundingClientRect().height;
                toggle().focus();
                toggle().click();
                await pause();
                const popup = panel.ownerDocument.querySelector('.mtflpp-zoom-popover');
                check(popup && toggle().getAttribute('aria-expanded') === 'true', 'The native Dropdown opens a labelled popover.');
                const modes = popup.querySelector('[role="radiogroup"]');
                check(modes?.querySelector('legend').textContent === strings.zoomMode, 'Name the native radio group with a visible legend.');
                check(modes.querySelectorAll('input[type="radio"]').length === 4 && modes.querySelectorAll(':checked').length === 1, 'Exactly one of the four modes is selected.');
                check([...modes.querySelectorAll('label')].map(({ textContent }) => textContent).join(',') === [strings.automatic, strings.fitToWindow, strings.fitToWidth, strings.fixedZoom].join(','), 'Use translated fitting and fixed-zoom labels.');
                check(choice(popup, state.fit).checked, 'The radio selection follows the actual viewport mode, including custom 80%.');
                const dialog = popup.matches('[role="dialog"]') ? popup : popup.querySelector('[role="dialog"]');
                check(dialog?.getAttribute('aria-label') === strings.fitting && toggle().getAttribute('aria-haspopup') === 'dialog', 'Expose a named dialog with native radio and number controls.');
                const display = popup.querySelector('.mtflpp-dpr-note');
                check(display.getAttribute('aria-label') === strings.displayInformation && display.children.length === 2 && !display.querySelector('strong,details,summary,button,[aria-expanded]'), 'Keep display information as two always-visible lines, without a heading or disclosure.');
                check(display.querySelector('.mtflpp-pixel-note').textContent === strings.pixelZoomHelp, 'Keep the 100% reference visible in every mode.');
                for (const text of [strings.automaticHelp, strings.fitToWindowHelp, strings.fitToWidthHelp, strings.fixedZoomHelp,
                    ...(state.fit === 'custom' ? [strings.customZoomHelp] : []), strings.pixelZoomHelp]) {
                    const description = [...popup.querySelectorAll('*')].find((element) => element.childNodes.length === 1 && element.firstChild.nodeType === 3 && element.textContent === text);
                    check(description, `Keep the short explanation visible: ${text}`);
                    const range = panel.ownerDocument.createRange();
                    range.selectNodeContents(description);
                    // RTL can split a single visual line into separate text/punctuation rectangles.
                    const lines = new Set([...range.getClientRects()].map(({ top }) => Math.round(top)));
                    check(lines.size <= 3, `Keep the short explanation readable in narrow popovers: ${text}`);
                }
                check(display.querySelector('.mtflpp-dpr-value').textContent === `${strings.displayDpr}: ${Number(viewport.dpr.toFixed(2))}` && !display.querySelector('input,select,button'), 'DPR belongs to the displaying window and is not editable.');
                check(popup.querySelectorAll('input[type="number"]').length === (state.fit === 'custom' ? 1 : 0), 'Only Fixed zoom reveals a percentage field.');
                check(getComputedStyle(display).borderTopStyle === 'solid', 'Portaled content retains its scoped visual variables.');
                const rect = popup.querySelector('.components-popover__content').getBoundingClientRect();
                check(rect.left >= -1 && rect.right <= panel.ownerDocument.defaultView.innerWidth + 1, 'Keep the native popover within its owner window.');
                check(panel.querySelector('.mtflpp-viewport').getBoundingClientRect().height === canvasHeight, 'The popup never reserves a hint strip or steals preview height.');
                return popup;
            };
            const escape = async (popup) => {
                (popup.querySelector('input[type="number"]') || popup.querySelector('input:checked')).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                await pause();
                check(!panel.ownerDocument.querySelector('.mtflpp-zoom-popover') && panel.ownerDocument.activeElement === toggle(), 'Escape closes Zoom and restores focus.');
            };
            let popup = await showZoom();
            for (const fit of ['width', 'window', 'automatic']) {
                choice(popup, fit).click();
                await pause();
                check(state.fit === fit && toggle().getAttribute('aria-label').startsWith(`${strings.fitting}: `), 'Changing Zoom updates the viewport and accessible label.');
                check(panel.ownerDocument.querySelector('.mtflpp-zoom-popover') === popup && choice(popup, fit).checked, 'Radio selection applies without dismissing the dialog.');
                check(panel.ownerDocument.activeElement === choice(popup, fit), 'Keep focus in the native radio group when choosing a mode.');
                check(!popup.querySelector('input[type="number"]'), 'Fitting modes hide the manual percentage.');
                check(fit === 'automatic' ? toggle().getBoundingClientRect().width === toggleWidth : toggle().getBoundingClientRect().width > toggleWidth,
                    'Size the mode button to its current label rather than a fixed width.');
                const modeLabel = toggle().querySelector('.mtflpp-zoom-value');
                check(modeLabel.scrollWidth <= modeLabel.clientWidth, 'The complete mode name fits without text truncation.');
            }
            await escape(popup);
            popup = await showZoom();
            choice(popup, 'custom').click();
            await pause();
            check(state.fit === 'custom' && state.zoomPercent === 100 && toggle().textContent === strings.fixedZoom, 'Fixed zoom starts with the last percentage, initially screen-pixel 1:1.');
            check(choice(popup, 'custom').checked && panel.ownerDocument.activeElement === choice(popup, 'custom'), 'Revealing the percentage does not steal radio-key focus.');
            await escape(popup);
            popup = await showZoom();
            const field = popup.querySelector('.mtflpp-custom-zoom input[type="number"]');
            check(field.getAttribute('aria-label') === strings.customZoom && field.type === 'number', 'Choose zoom uses a labelled native number field.');
            check(panel.ownerDocument.activeElement === field, 'Fixed zoom reopens with keyboard focus in the percentage field.');
            check(getComputedStyle(popup.querySelector('.mtflpp-custom-zoom')).borderTopStyle === 'solid', 'Separate the conditional percentage from the mode group.');
            const change = async (value) => {
                Object.getOwnPropertyDescriptor(panel.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set.call(field, value);
                field.dispatchEvent(new Event('input', { bubbles: true }));
                await pause();
            };
            check(popup.querySelector('input[type="range"]'), 'Choose zoom exposes a native slider alongside its number field.');
            await change('');
            check(state.zoomPercent === 100, 'An empty percentage never changes the preview.');
            const invalidEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
            field.dispatchEvent(invalidEnter);
            check(invalidEnter.defaultPrevented && panel.ownerDocument.querySelector('.mtflpp-zoom-popover') === popup, 'An invalid Enter cannot submit or dismiss the editor.');
            await change('80');
            check(state.zoomPercent === 80 && state.customZoom === 80 && toggle().textContent === strings.fixedZoom, 'Custom 80% applies without changing the mode label or viewport dimensions.');
            const customLabel = toggle().querySelector('.mtflpp-zoom-value');
            check(customLabel.scrollWidth <= customLabel.clientWidth, 'Choose zoom fits without text truncation.');
            check(field.validity.valid, 'A valid percentage satisfies native number-input constraints.');
            const slider = popup.querySelector('input[type="range"]');
            Object.getOwnPropertyDescriptor(panel.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set.call(slider, '125');
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            slider.dispatchEvent(new Event('change', { bubbles: true }));
            await pause();
            check(state.zoomPercent === 125 && field.value === '125', 'Moving the native slider updates the preview and number field together.');
            await change('80');
            check(choice(popup, 'custom').checked && popup.querySelectorAll('input:checked').length === 1, '80% and 100% belong to the same, single Fixed zoom choice.');
            check(panel.querySelector('.mtflpp-stage').style.width === '768px' && panel.querySelector('.mtflpp-stage').style.height === '1024px', 'Custom zoom never edits the iframe geometry.');
            check(panel.querySelector('.mtflpp-dimensions').textContent === 'Tablet (768 × 1024) · 80%', 'Manual zoom updates the combined readout, not the mode button.');
            await escape(popup);
            popup = await showZoom();
            check(popup.querySelector('input[type="number"]').value === '80', 'Reopening retains the fixed percentage.');
            if (mode === 'floating' && width === 480) {
                popup.querySelector('input[type="number"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                await pause();
                check(!panel.ownerDocument.querySelector('.mtflpp-zoom-popover') && panel.ownerDocument.activeElement === toggle(), 'A valid Enter dismisses Zoom and restores focus.');
                popup = await showZoom();
                choice(popup, 'automatic').click();
                await pause();
                check(!popup.querySelector('input[type="number"]'), 'Returning to fitting removes the percentage field.');
                choice(popup, 'custom').click();
                await pause();
                check(popup.querySelector('input[type="number"]').value === '80' && state.zoomPercent === 80, 'Returning to Fixed zoom restores 80%, not 100% or a stale draft.');
            }
            choice(popup, 'automatic').click();
            await pause();
            check(!popup.querySelector('input[type="number"]') && state.customZoom === 80, 'Hide the field without discarding the last fixed percentage.');
            await escape(popup);
            const tablet = panel.querySelector('[data-viewport="tablet"]');
            check(tablet.getAttribute('aria-label') === `${strings.tablet} — ${strings.rotateLandscape}`, 'The selected button explains how to rotate.');
            tablet.click();
            await pause();
            check(state.orientation === 'landscape' && panel.querySelector('.mtflpp-dimensions').textContent.startsWith('Tablet (1024 × 768)'), 'Reselecting the device rotates the viewport.');
            check(tablet.getAttribute('aria-label') === `${strings.tablet} — ${strings.rotatePortrait}`, 'The next rotation action has the correct accessible name.');
            check(tablet.classList.contains('mtflpp-device-rotated'), 'The selected device icon shows landscape orientation.');
            checkIcons();
            check(!panel.querySelector('[data-action="rotate"]'), 'No separate rotate control remains.');
            const footer = panel.querySelector('.mtflpp-devicebar').getBoundingClientRect();
            for (const element of panel.querySelectorAll('.mtflpp-devicebar button, .mtflpp-dimensions')) {
                const rect = element.getBoundingClientRect();
                check(rect.left >= footer.left - 1 && rect.right <= footer.right + 1 && rect.top >= footer.top - 1 && rect.bottom <= footer.bottom + 1, 'All footer controls and dimensions must fit without clipping.');
            }
            check(panel.scrollWidth <= panel.clientWidth + 1, 'The footer must wrap instead of widening a narrow panel.');
            panel.querySelector('[data-viewport="desktop"]').click();
            await pause();
            check(state.device === 'desktop' && panel.querySelectorAll('[data-viewport]').length === 3, 'Device selection keeps just the three existing buttons.');
            const desktop = panel.querySelector('[data-viewport="desktop"]');
            check(desktop.getAttribute('aria-pressed') === 'true', 'Keep native toolbar selected state.');
            check(!desktop.classList.contains('mtflpp-device-rotated'), 'Desktop starts with its normal landscape icon.');
            desktop.click();
            await pause();
            check(state.orientation === 'landscape' && panel.querySelector('.mtflpp-dimensions').textContent.startsWith('Desktop (1280 × 800)'), 'Reselecting desktop keeps its landscape viewport.');
            check(!desktop.classList.contains('mtflpp-device-rotated'), 'The desktop icon never rotates.');
            check(desktop.getAttribute('aria-label') === strings.desktop, 'Desktop must not offer rotation in its accessible name or tooltip.');
            checkIcons();
            desktop.click();
            await pause();
            check(state.orientation === 'landscape' && !desktop.classList.contains('mtflpp-device-rotated'), 'Repeated desktop activation remains a no-op.');
            checkIcons();
            if (mode === 'floating' && width === 320) {
                const popup = await showZoom();
                popup.querySelector('input:checked').focus();
                state = { ...state, hasPreview: false, empty: { heading: strings.loading, description: strings.preparing, busy: true } };
                panel.dataset.hasPreview = 'false';
                panel.querySelector('.mtflpp-devicebar').hidden = true;
                panel.querySelector('.mtflpp-empty').hidden = false;
                controls.update(state);
                await pause();
                check(!document.querySelector('.mtflpp-zoom-popover'), 'Unavailable previews cannot leave an orphaned Zoom popover.');
                check(document.activeElement === panel.querySelector('[data-action="empty-title"]'), 'Focus returns from the portaled field to visible recovery.');
            }
            if (mode === 'PiP' && width === 480) {
                viewport.setZoom(80);
                sync();
                await showZoom();
                controls.beforeMove();
                viewport.beforeMove();
                check(!document.querySelector('.mtflpp-zoom-popover'), 'Adoption closes the old document’s Zoom popover.');
                frame = document.createElement('iframe');
                frame.style.cssText = 'width:480px;height:180px;border:0';
                document.body.append(frame);
                const doc = frame.contentDocument;
                doc.head.innerHTML = [...document.querySelectorAll('style')].map(({ outerHTML }) => outerHTML).join('');
                doc.body.className = 'mtflpp-pip-document';
                // A controlled owner-window value tests detection; physical DPR is covered separately.
                Object.defineProperty(doc.defaultView, 'devicePixelRatio', { value: 2 });
                panel.classList.add('mtflpp-pip');
                panel.style.cssText = '';
                doc.body.append(panel);
                viewport.afterMove();
                controls.remount();
                sync();
                await pause();
                popup = await showZoom();
                check(popup.ownerDocument === doc && !document.querySelector('.mtflpp-zoom-popover'), 'The native popover and its focus hooks belong to the destination document.');
                check(viewport.dpr === 2 && state.zoomPercent === 80 && panel.querySelector('.mtflpp-stage').style.transform === 'scale(0.4)', 'Fixed zoom uses the displaying window’s DPR after adoption.');
                const content = popup.querySelector('.components-popover__content');
                const bounds = content.getBoundingClientRect();
                check(bounds.top >= -1 && bounds.bottom <= doc.defaultView.innerHeight + 1 && content.scrollHeight > content.clientHeight, 'A short PiP window contains and scrolls the Zoom controls.');
                const number = popup.querySelector('input[type="number"]');
                const numberBounds = number.getBoundingClientRect();
                check(doc.activeElement === number && numberBounds.top >= bounds.top - 1 && numberBounds.bottom <= bounds.bottom + 1, 'The reopened percentage is focused and visible inside a short popover.');
                check(doc.defaultView.scrollX === 0 && doc.defaultView.scrollY === 0, 'Making the percentage visible must not scroll the displaying window.');
                popup.querySelector('.mtflpp-pixel-note').scrollIntoView({ block: 'end' });
                check(content.scrollTop > 0 && popup.querySelector('.mtflpp-pixel-note').getBoundingClientRect().bottom <= bounds.bottom + 1, 'The final explanation remains reachable in a short window.');
                controls.beforeMove();
                viewport.beforeMove();
                document.body.append(panel);
                panel.classList.remove('mtflpp-pip');
                panel.style.cssText = `position:relative;width:${width}px;height:340px`;
                state = { ...state, inPip: false, inPage: true };
                viewport.afterMove();
                controls.remount();
                sync();
                await pause();
                popup = await showZoom();
                check(viewport.dpr === window.devicePixelRatio && state.zoomPercent === 80, 'Returning to the editor rebinds DPR without losing the manual percentage.');
                controls.closeMenu();
            }
            results.push({ name });
        } catch (error) { results.push({ name, error: error.stack }); }
        finally { controls?.beforeMove(); viewport?.beforeMove(); panel.remove(); frame?.remove(); }
    }
    return results;
}

testInChromium('native WordPress launcher, menu and notices render and handle focus and clicks', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'mtflpp-native-launcher-'));
    try {
        // Expose public APIs only in the fixture so native-store isolation can be checked too.
        await writeFile(join(directory, 'entry.js'), `
            export { createPreviewControls, createPreviewLauncher } from ${JSON.stringify(fileURLToPath(new URL('../src/panel/controls.js', import.meta.url)))};
            export { createPreviewViewport } from ${JSON.stringify(fileURLToPath(new URL('../src/panel/viewport.js', import.meta.url)))};
            export { dispatch, select } from '@wordpress/data';
            export { store as noticesStore } from '@wordpress/notices';
            export { ThemeProvider } from '@wordpress/theme';
        `);
        await new Promise((resolve, reject) => webpack({
            mode: 'production', devtool: false,
            entry: join(directory, 'entry.js'),
            resolve: { modules: [fileURLToPath(new URL('../node_modules', import.meta.url)), 'node_modules'] },
            output: { path: directory, filename: 'controls.js', library: { name: 'previewControls', type: 'window' } },
            optimization: { minimize: false }, performance: false,
        }, (error, stats) => {
            if (error) return reject(error);
            if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
            resolve();
        }));
        const css = await readFile(new URL('../build/classic-editor.css', import.meta.url), 'utf8');
        const core = await readFile(new URL('../node_modules/@wordpress/components/build-style/style.css', import.meta.url), 'utf8');
        const tokens = await readFile(new URL('../node_modules/@wordpress/theme/prebuilt/css/design-tokens.css', import.meta.url), 'utf8');
        const bundle = pathToFileURL(join(directory, 'controls.js')).href;
        await runChromiumTests(t, {
            script: `(async () => {
                window.wp = { theme: { ThemeProvider: window.previewControls.ThemeProvider } };
                return [...(${nativeLauncherTests.toString()})(), ...await (${nativePreferenceTests.toString()})(${JSON.stringify(panelStrings)}), ...await (${nativeNoticeTests.toString()})(${JSON.stringify(panelStrings)}), ...await (${nativeViewportControlTests.toString()})(${JSON.stringify(panelStrings)})];
            })()`, count: 21, virtualTimeBudget: 20000,
            head: `<style>${tokens}\n${core}\n${css}</style><script src="${bundle}"></script>`,
        });
    } finally { await rm(directory, { recursive: true, force: true }); }
});
