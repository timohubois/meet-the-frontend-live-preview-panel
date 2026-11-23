import assert from 'node:assert/strict';
import { icons } from '../src/panel/icons.js';
import { sourceForVm } from './helpers/modules.mjs';
import { panelStrings } from './helpers/panel-strings.mjs';
import test from 'node:test';
import vm from 'node:vm';

const source = await sourceForVm(new URL('../src/panel/controls.js', import.meta.url));

// Verify our native-component contract without duplicating WordPress's React or menu implementation.
function fixture() {
    const mounts = [];
    const calls = [];
    const container = {};
    const h = (type, props, ...children) => ({ type, props: props || {}, children });
    const components = Object.fromEntries(['Button', 'Dropdown', 'DropdownMenu', 'MenuGroup', 'MenuItem', 'MenuItemsChoice', 'Notice', 'Placeholder', 'RadioControl', 'RangeControl', 'Spinner', 'Toolbar', 'ToolbarButton', 'SlotFillProvider'].map((name) => [name, name]));
    components.Popover = { Slot: 'Popover.Slot' };
    const element = {
        createElement: h, Fragment: 'Fragment', createPortal: (child, target) => h('Portal', { target }, child), flushSync: (callback) => callback(),
        createRoot(target) {
            const mount = { target, renders: 0, unmounts: 0, render(node) { this.tree = node.type(); this.renders++; }, unmount() { this.unmounts++; } };
            mounts.push(mount);
            return mount;
        },
    };
    const callbacks = Object.fromEntries(['refresh', 'retry', 'dismissNotice', 'mode', 'close', 'popOut', 'fullscreen', 'dock', 'fit', 'zoom', 'reset', 'follow', 'rememberVisibility', 'rememberPosition', 'device']
        .map((name) => [name, (...args) => calls.push({ name, args })]));
    const strings = panelStrings;
    const querySelector = (selector) => selector === '.mtflpp-controls' ? container : {
        selector, focus() { calls.push({ name: 'focus', args: [selector] }); },
    };
    const body = {};
    const panel = { querySelector, ownerDocument: { querySelector, body } };
    const imports = {
        '@wordpress/element': element,
        '@wordpress/components': components,
        '@wordpress/data': {},
        '@wordpress/notices': {},
        './icons.js': { icons },
    };
    const createPreviewControls = vm.runInNewContext(`${source}\ncreatePreviewControls`, { imports });
    const controls = createPreviewControls(panel, strings, callbacks);
    const state = {
        inPage: true, inPip: false, movable: true, mode: 'expand', modeLabel: strings.expand, canRefresh: true,
        hasPreview: true, zoomPercent: 100, customZoom: 100, dpr: 1,
        canPip: true, canFullscreen: true, dock: 'center', fit: 'automatic', orientation: 'landscape', rememberVisibility: true, rememberPosition: true, followChanges: false, device: 'desktop',
    };
    controls.update(state);
    function nodes(type) {
        const result = [];
        function walk(node) {
            if (typeof node === 'function') return walk(node());
            if (!node || typeof node !== 'object') return;
            if (node.type === type) result.push(node);
            if (node.type === 'Dropdown') {
                walk(node.props.renderToggle({ isOpen: node.props.open, onToggle: () => node.props.onToggle(!node.props.open) }));
                if (node.props.open) walk(node.props.renderContent({ onClose: () => node.props.onToggle(false) }));
            }
            for (const child of node.children || []) walk(child);
        }
        walk(mounts.at(-1).tree);
        return result;
    }
    return { controls, state, mounts, calls, nodes, icons, body, panel };
}

test('the PiP menu action delegates to the window owner', () => {
    const h = fixture();
    h.nodes('MenuItem').find(({ props }) => props['data-action'] === 'pip').props.onClick();
    assert.equal(h.calls.at(-1).name, 'popOut');
});

test('native layout choices delegate selection and hide outside in-page mode', () => {
    const h = fixture();
    const control = h.nodes('MenuItemsChoice')[0];
    assert.equal(control.props.value, 'center');
    assert.deepEqual(Array.from(control.props.choices, ({ value }) => value), ['left', 'center', 'right']);
    control.props.onSelect('left');
    assert.deepEqual(h.calls.at(-1), { name: 'dock', args: ['left'] });
    assert.equal(h.nodes('MenuItemsChoice').length, 1, 'No named size choices remain.');
    h.controls.update({ ...h.state, inPage: false });
    assert.equal(h.nodes('MenuItemsChoice').length, 0);
});

test('in-page popovers escape the panel stacking context while fullscreen and PiP retain their slot', () => {
    const h = fixture();
    const slotPortal = () => h.nodes('Portal').find(({ children }) => children[0]?.type === 'Popover.Slot');
    assert.equal(slotPortal().props.target, h.body, 'use the native body overlay layer above the admin bar');
    for (const inPip of [false, true]) {
        h.controls.update({ ...h.state, inPage: false, inPip });
        assert.equal(slotPortal(), undefined, 'fullscreen and PiP popovers must not escape the panel');
        assert.equal(h.nodes('Popover.Slot').length, 1);
    }
    h.controls.update(h.state);
    assert.equal(slotPortal().props.target, h.body, 'return to the body overlay after leaving fullscreen or PiP');
});

test('viewport choices use native Toolbar buttons and pressed-state behavior', () => {
    const h = fixture();
    assert.equal(h.nodes('Toolbar')[0].props.label, 'Screen size');
    assert.deepEqual(h.nodes('ToolbarButton').map(({ props }) => props.label), ['Computer', 'Tablet', 'Phone']);
    const buttons = h.nodes('ToolbarButton');
    assert.equal(buttons.length, 3);
    assert.deepEqual(buttons.map(({ props }) => props.isPressed), [true, false, false]);
    buttons[2].props.onClick();
    assert.deepEqual(h.calls.at(-1), { name: 'device', args: ['mobile'] });
});

test('the desktop button has no rotation label or icon state', () => {
    const h = fixture();
    for (const orientation of ['portrait', 'landscape']) {
        h.controls.update({ ...h.state, orientation });
        const button = h.nodes('ToolbarButton').find(({ props }) => props['data-viewport'] === 'desktop');
        assert.equal(button.props.label, panelStrings.desktop);
        assert.equal(button.props.icon, icons.desktop);
        assert.equal(button.props.className, undefined);
        assert.equal(button.props.isPressed, true);
    }
});

test('selected tablet and phone buttons offer rotation with an unwrapped native icon', () => {
    const h = fixture();
    for (const device of ['tablet', 'mobile']) {
        h.controls.update({ ...h.state, device, orientation: 'portrait' });
        let button = h.nodes('ToolbarButton').find(({ props }) => props['data-viewport'] === device);
        assert.equal(button.props.label, `${panelStrings[device]} — Turn sideways`);
        assert.equal(button.props.icon, icons[device], 'Pass the official SVG directly so core sizes it.');
        assert.equal(button.props.className, undefined);
        assert.equal(button.props.isPressed, true);
        button.props.onClick();
        assert.deepEqual(h.calls.at(-1), { name: 'device', args: [device] });
        h.controls.update({ ...h.state, device, orientation: 'landscape' });
        button = h.nodes('ToolbarButton').find(({ props }) => props['data-viewport'] === device);
        assert.match(button.props.label, /Turn upright$/);
        assert.equal(button.props.icon, icons[device]);
        assert.equal(button.props.className, 'mtflpp-device-rotated');
        assert.equal(h.nodes('ToolbarButton').length, 3);
        assert.equal(h.nodes('Button').some(({ props }) => props['data-action'] === 'rotate'), false);
    }
});

for (const inPip of [false, true]) {
    test(`one native Zoom mode choice conditionally reveals fixed percentages${inPip ? ' in PiP' : ''}`, () => {
        const h = fixture();
        h.controls.update({ ...h.state, inPip, fit: 'width', zoomPercent: 230, customZoom: 80, dpr: 2 });
        const toggle = h.nodes('Button').find(({ props }) => props['data-action'] === 'zoom');
        assert.equal(toggle.props['aria-label'], 'Zoom: Fill width');
        assert.equal(h.nodes('Dropdown')[0].props.popoverProps.shift, true);
        assert.equal(h.nodes('Dropdown')[0].props.popoverProps.resize, false, 'Native shifting must not be combined with resizing.');
        assert.equal(h.nodes('RangeControl').length, 0, 'Do not show a permanent custom field.');
        h.nodes('Dropdown')[0].props.onToggle(true);
        let modes = h.nodes('RadioControl')[0];
        assert.equal(modes.props.label, 'Zoom mode');
        assert.equal(modes.props.selected, 'width');
        assert.deepEqual(Array.from(modes.props.options, ({ value }) => value), ['automatic', 'window', 'width', 'custom']);
        assert.deepEqual(Array.from(modes.props.options, ({ label }) => label), ['Auto', 'Fit to panel', 'Fill width', 'Choose zoom']);
        assert.deepEqual(Array.from(modes.props.options, ({ description }) => description), [
            panelStrings.automaticHelp, panelStrings.fitToWindowHelp, panelStrings.fitToWidthHelp, panelStrings.fixedZoomHelp,
        ]);
        assert.equal(h.nodes('RangeControl').length, 0, 'Fitting modes do not expose an unrelated percentage field.');
        modes.props.onChange('window');
        assert.deepEqual(h.calls.at(-1), { name: 'fit', args: ['window'] });
        assert.equal(h.nodes('Dropdown')[0].props.open, true, 'A radio choice does not dismiss the dialog.');
        h.controls.update({ ...h.state, inPip, fit: 'window', customZoom: 80 });
        modes = h.nodes('RadioControl')[0];
        modes.props.onChange('custom');
        assert.deepEqual(h.calls.at(-1), { name: 'zoom', args: [80] }, 'Use the last fixed percentage, not an implicit 100% reset.');
        h.controls.update({ ...h.state, inPip, fit: 'custom', customZoom: 80, zoomPercent: 80 });
        assert.equal(h.nodes('RadioControl')[0].props.selected, 'custom');
        assert.equal(h.nodes('RangeControl')[0].props.value, 80);
        assert.equal(h.nodes('Button').some(({ props }) => props['data-zoom-mode']), false, 'Do not duplicate fixed zoom with a separate 100% choice.');
    });
}

test('all fitting modes hide the percentage field; 80% and 100% select the same fixed mode', () => {
    const h = fixture();
    h.nodes('Dropdown')[0].props.onToggle(true);
    for (const fit of ['automatic', 'window', 'width', 'custom']) for (const customZoom of [80, 100]) {
        h.controls.update({ ...h.state, fit, customZoom });
        assert.equal(h.nodes('RadioControl')[0].props.selected, fit);
        assert.equal(h.nodes('RangeControl').length, fit === 'custom' ? 1 : 0);
        assert.equal(h.nodes('RadioControl')[0].props.options.length, 4);
    }
});

test('custom zoom uses a native slider and number field, and accepts only whole percentages in range', () => {
    const h = fixture();
    h.controls.update({ ...h.state, fit: 'custom', customZoom: 80, zoomPercent: 80 });
    h.nodes('Dropdown')[0].props.onToggle(true);
    const field = h.nodes('RangeControl')[0];
    assert.equal(field.props.label, 'Zoom (%)');
    assert.equal(field.props.value, 80);
    assert.equal(field.props.withInputField, true);
    assert.deepEqual([field.props.min, field.props.max, field.props.step], [10, 400, 1]);
    for (const value of [undefined, null, NaN, 8, 0, 401, 80.5, '80']) field.props.onChange(value);
    assert.equal(h.calls.length, 0);
    for (const value of [10, 80, 400]) {
        field.props.onChange(value);
        assert.deepEqual(h.calls.at(-1), { name: 'zoom', args: [value] });
    }
});

test('switching from an invalid draft back to fixed zoom restores the last valid percentage', () => {
    const h = fixture();
    h.controls.update({ ...h.state, fit: 'custom', customZoom: 80, zoomPercent: 80 });
    h.nodes('Dropdown')[0].props.onToggle(true);
    h.nodes('RangeControl')[0].props.onChange('');
    h.nodes('RadioControl')[0].props.onChange('automatic');
    h.controls.update({ ...h.state, fit: 'automatic', customZoom: 80 });
    assert.equal(h.nodes('RangeControl').length, 0);
    h.nodes('RadioControl')[0].props.onChange('custom');
    h.controls.update({ ...h.state, fit: 'custom', customZoom: 80, zoomPercent: 80 });
    assert.equal(h.nodes('RangeControl')[0].props.value, 80);
    assert.deepEqual(h.calls, [{ name: 'fit', args: ['automatic'] }, { name: 'zoom', args: [80] }]);
});

test('reopening fixed zoom focuses the percentage once without scrolling; mode selection keeps radio focus', () => {
    const h = fixture();
    h.controls.update({ ...h.state, fit: 'custom', customZoom: 80, zoomPercent: 80 });
    h.nodes('Dropdown')[0].props.onToggle(true);
    let focuses = 0;
    const event = { currentTarget: { closest: () => ({
        querySelector: () => ({ closest: () => null, focus(options) { assert.equal(options.preventScroll, true); focuses++; } }),
    }) } };
    const focusMode = () => h.nodes('RadioControl')[0].props.onFocus(event);
    focusMode();
    focusMode();
    assert.equal(focuses, 1);
    h.nodes('RadioControl')[0].props.onChange('automatic');
    h.controls.update({ ...h.state, fit: 'automatic', customZoom: 80 });
    h.nodes('RadioControl')[0].props.onChange('custom');
    h.controls.update({ ...h.state, fit: 'custom', customZoom: 80, zoomPercent: 80 });
    focusMode();
    assert.equal(focuses, 1, 'Revealing the field must not steal arrow-key focus from the radio group.');
});

test('reopening fixed zoom reveals its input by scrolling only the popover', () => {
    const h = fixture();
    h.controls.update({ ...h.state, fit: 'custom' });
    h.nodes('Dropdown')[0].props.onToggle(true);
    const content = { scrollTop: 0, getBoundingClientRect: () => ({ top: 20, bottom: 152 }) };
    const field = {
        focus(options) { assert.equal(options.preventScroll, true); },
        closest: () => content,
        getBoundingClientRect: () => ({ top: 220, bottom: 260 }),
    };
    h.nodes('RadioControl')[0].props.onFocus({ currentTarget: { closest: () => ({ querySelector: () => field }) } });
    assert.equal(content.scrollTop, 108);
});

test('Enter closes valid custom zoom, but incomplete drafts cannot submit or close the editor', () => {
    const h = fixture();
    h.controls.update({ ...h.state, fit: 'custom' });
    h.nodes('Dropdown')[0].props.onToggle(true);
    let prevented = 0;
    const enter = (value) => h.nodes('div').find(({ props }) => props.className === 'mtflpp-custom-zoom').props.onKeyDown({
        key: 'Enter', target: { value }, preventDefault() { prevented++; },
    });
    enter('8');
    assert.equal(h.nodes('Dropdown')[0].props.open, true);
    assert.equal(h.calls.length, 0);
    h.nodes('RangeControl')[0].props.onChange(80);
    enter('80');
    assert.equal(h.nodes('Dropdown')[0].props.open, false);
    assert.equal(prevented, 2);
    assert.deepEqual(h.calls.at(-1), { name: 'zoom', args: [80] });
});

test('Zoom descriptions use the agreed short, plain English', () => {
    assert.deepEqual([
        panelStrings.automaticHelp, panelStrings.fitToWindowHelp, panelStrings.fitToWidthHelp,
        panelStrings.fixedZoomHelp, panelStrings.customZoomHelp,
    ], [
        'Show the whole screen, up to 100%.', 'Make the whole screen fit the panel.', 'Fill the width. May need extra scrolling.',
        'Set a percentage. May need extra scrolling.', 'Choose 10% to 400%.',
    ]);
});

test('DPR is separate read-only display information, not another setting or device preset', () => {
    const h = fixture();
    h.controls.update({ ...h.state, fit: 'custom', customZoom: 80, zoomPercent: 80, dpr: 2 });
    h.nodes('Dropdown')[0].props.onToggle(true);
    const dpr = () => h.nodes('span').find(({ props }) => props.className === 'mtflpp-dpr-value').children[0];
    assert.equal(dpr(), 'Display DPR: 2');
    const display = h.nodes('div').find(({ props }) => props.className === 'mtflpp-dpr-note');
    assert.equal(display.props['aria-label'], 'Display information');
    assert.deepEqual(Array.from(display.children, ({ type }) => type), ['span', 'span']);
    assert.equal(display.children[1].children[0], '100% = pixel for pixel.');
    assert.equal(display.props.hidden, undefined, 'Display information is always visible, never collapsible.');
    assert.equal(h.nodes('strong').some(({ props }) => props.className === 'mtflpp-dpr-title'), false);
    assert.equal(h.nodes('RangeControl').length, 1, 'Only the fixed percentage is editable.');
    assert.equal(h.nodes('Button').find(({ props }) => props['data-action'] === 'zoom').props['aria-label'], 'Zoom: Choose zoom');
    h.controls.update({ ...h.state, fit: 'custom', customZoom: 80, zoomPercent: 80, dpr: 1.25 });
    assert.equal(dpr(), 'Display DPR: 1.25');
    assert.equal(h.nodes('RangeControl')[0].props.value, 80);
    assert.equal(h.calls.length, 0);
});

test('losing the preview closes Zoom and moves portaled focus to recovery, without moving outside focus', () => {
    for (const focusedZoom of [false, true]) {
        const h = fixture();
        h.nodes('Dropdown')[0].props.onToggle(true);
        h.panel.ownerDocument.activeElement = { closest: () => focusedZoom ? {} : null };
        h.controls.update({ ...h.state, hasPreview: false, empty: { heading: 'Loading', description: 'Preparing' } });
        assert.equal(h.nodes('Dropdown')[0].props.open, false);
        assert.deepEqual(h.calls, focusedZoom ? [{ name: 'focus', args: ['[data-action="empty-title"]'] }] : []);
    }
});

test('window options and Zoom never leave two popovers open', () => {
    const h = fixture();
    h.nodes('Dropdown')[0].props.onToggle(true);
    h.nodes('DropdownMenu')[0].props.onToggle(true);
    assert.equal(h.nodes('Dropdown')[0].props.open, false);
    h.nodes('Dropdown')[0].props.onToggle(true);
    assert.equal(h.nodes('DropdownMenu')[0].props.open, false);
    h.controls.closeMenu();
    assert.equal(h.nodes('Dropdown')[0].props.open, false);
    assert.equal(h.nodes('DropdownMenu')[0].props.open, false);
});

for (const mode of ['in-page', 'fullscreen', 'PiP']) {
    test(`${mode} controls stay compact and refresh remains focusable while loading`, () => {
        const h = fixture();
        const state = { ...h.state, inPage: mode === 'in-page', inPip: mode === 'PiP' };
        h.controls.update(state);
        for (const { props } of h.nodes('Button').filter(({ props }) => props.className?.split(' ').includes('mtflpp-icon'))) {
            assert.equal(props.size, 'compact');
        }
        assert.equal(h.nodes('DropdownMenu')[0].props.toggleProps.size, 'compact');
        const refresh = () => h.nodes('Button').find(({ props }) => props['data-action'] === 'refresh');
        const portal = h.nodes('Portal').find(({ props }) => props.target.selector === '.mtflpp-refresh-control');
        assert.equal(portal.children[0], refresh(), 'Keep refresh in the header in every window mode.');
        assert.equal(refresh().props.accessibleWhenDisabled, true);
        refresh().props.onClick();
        assert.equal(h.calls.at(-1).name, 'refresh');
        h.controls.update({ ...state, busy: true, canRefresh: false });
        assert.equal(refresh().props.icon.type, 'Spinner');
        assert.equal(refresh().props.label, 'Update preview');
        assert.equal(refresh().props.disabled, true);
        assert.equal(refresh().props.accessibleWhenDisabled, true, 'Use native aria-disabled behavior without disabling DOM focus.');
        h.controls.focus('refresh');
        assert.deepEqual(h.calls.at(-1), { name: 'focus', args: ['[data-action="refresh"]'] });
        h.controls.update({ ...state, busy: false });
        assert.equal(refresh().props.icon, h.icons.refresh);
        assert.equal(refresh().props.disabled, false);
        assert.equal(refresh().props.accessibleWhenDisabled, true);
    });
}

test('placeholder actions and loading use public components with no custom spinner or fake title button', () => {
    const h = fixture();
    h.controls.update({ ...h.state, hasPreview: false, empty: {
        heading: 'Loading', description: 'Preparing', note: 'Each tab keeps its edits', busy: true,
        retry: true, disabled: true, action: 'Switching',
    } });
    const placeholder = h.nodes('Placeholder')[0];
    assert.equal(placeholder.props.instructions, 'Preparing');
    assert.equal(placeholder.props.icon.type, 'Spinner');
    assert.equal(placeholder.props.label.type, 'h3', 'Nest the empty state below the panel heading.');
    assert.equal(placeholder.props.label.children[0], 'Loading');
    assert.equal(placeholder.props.label.props.tabIndex, -1, 'Keep programmatic focus without adding a Tab stop.');
    const retry = h.nodes('Button').find(({ props }) => props['data-action'] === 'retry');
    assert.equal(retry.props.disabled, true);
});

test('native notices keep unresolved failures persistent and dismiss only incidental window messages', () => {
    const h = fixture();
    h.controls.update({ ...h.state, notice: { heading: 'Failed', description: 'Previous frame', status: 'warning', dismissible: false, retry: true, action: 'Retry' } });
    let notice = h.nodes('Notice')[0];
    assert.equal(notice.props.isDismissible, false);
    assert.equal(notice.props.status, 'warning');
    assert.equal(notice.props.spokenMessage, '', 'The shell announces this state once.');
    assert.equal(notice.children[0], 'Failed. Previous frame', 'Render one plain message without a custom bold heading.');
    assert.equal(h.nodes('strong').length, 0);
    notice.props.actions[0].onClick();
    assert.equal(h.calls.at(-1).name, 'retry');
    h.controls.update({ ...h.state, notice: { heading: 'Pop-out failed', status: 'info', dismissible: true } });
    notice = h.nodes('Notice')[0];
    assert.equal(notice.props.isDismissible, true);
    notice.props.onRemove();
    assert.equal(h.calls.at(-1).name, 'dismissNotice');
});

test('document moves unmount old native hooks before creating the next root', () => {
    const h = fixture();
    const original = h.mounts[0];
    h.controls.beforeMove();
    assert.equal(original.unmounts, 1);
    h.controls.update({ ...h.state, inPage: false, inPip: true, canPip: false });
    assert.equal(original.renders, 1, 'state updates while detached must not render into the old root');
    h.controls.remount();
    assert.equal(h.mounts.length, 2);
    assert.equal(h.nodes('Button').some(({ props }) => props['data-action'] === 'refresh'), true);
    assert.equal(h.nodes('Button').some(({ props }) => props['data-action'] === 'mode'), false);
    assert.equal(h.nodes('DropdownMenu').length, 1);
});

test('PiP actions follow feature support and preview availability', () => {
    const h = fixture();
    const shortcut = () => h.nodes('Button').find(({ props }) => props['data-action'] === 'pop-out');
    const surface = h.nodes('div').find(({ props }) => props.className === 'mtflpp-pip-surface');
    assert.equal(surface.children[0], shortcut(), 'Keep a backing surface separate from the native action Button.');
    assert.equal(shortcut().props.size, undefined);
    assert.equal(shortcut().props.isPressed, undefined, 'PiP is an action, not a selected viewport toggle.');
    shortcut().props.onClick();
    assert.equal(h.calls.at(-1).name, 'popOut');
    for (const next of [{ hasPreview: false }, { canPip: false }]) {
        h.controls.update({ ...h.state, ...next });
        assert.equal(shortcut(), undefined);
    }
    assert.equal(h.nodes('MenuItem').some(({ props }) => props['data-action'] === 'pip'), false);
    assert.equal(h.nodes('MenuItem').some(({ props }) => props['data-action'] === 'open-preview'), false);
});

test('new-tab actions are absent from the menu and failed-preview recovery', () => {
    const h = fixture();
    for (const hasPreview of [true, false]) {
        h.controls.update({ ...h.state, hasPreview, empty: hasPreview ? null : {
            heading: 'Couldn’t load preview', description: 'Try again.', retry: true, action: 'Try again',
        } });
        for (const type of ['MenuItem', 'Button']) {
            assert.equal(h.nodes(type).some(({ props }) => props.href || props.target === '_blank'), false);
        }
        assert.equal(h.nodes('MenuItem').some(({ props }) => props['data-action'] === 'open-preview'), false);
    }
    h.controls.update({ ...h.state, canPip: false, canFullscreen: false });
    assert.equal(h.nodes('MenuGroup').some(({ props }) => props.label === panelStrings.display), false, 'Do not leave an empty window group behind.');
});

for (const mode of ['in-page', 'fullscreen', 'PiP']) {
    test(`${mode} settings explain their effects and keep their existing toggle behavior`, () => {
        const h = fixture();
        h.controls.update({ ...h.state, inPage: mode === 'in-page', inPip: mode === 'PiP' });
        assert.equal(h.nodes('DropdownMenu')[0].props.label, 'Preview options');
        for (const [action, key, selected, callback] of [
            ['remember-visibility', 'rememberVisibility', true, 'rememberVisibility'],
            ['remember-position', 'rememberPosition', true, 'rememberPosition'],
            ['follow', 'follow', false, 'follow'],
        ]) {
            const item = h.nodes('MenuItem').find(({ props }) => props['data-action'] === action);
            assert.equal(item.children[0], panelStrings[key]);
            assert.equal(item.props.info, panelStrings[`${key}Help`]);
            assert.ok(item.props.info, 'Show an explanation, not just a renamed label.');
            assert.equal(item.props.role, 'menuitemcheckbox');
            assert.equal(item.props.isSelected, selected);
            item.props.onClick();
            assert.equal(h.calls.at(-1).name, callback);
        }
        const reset = h.nodes('MenuItem').find(({ props }) => props['data-action'] === 'reset');
        assert.equal(!!reset, mode === 'in-page');
        if (reset) {
            assert.equal(reset.children[0], 'Reset preview window');
            assert.equal(reset.props.info, panelStrings.resetHelp);
        }
    });
}
