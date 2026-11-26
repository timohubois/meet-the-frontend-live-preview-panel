import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { icons } from '../src/panel/icons.js';
import { createHooks } from '@wordpress/hooks';

const adminEntries = ['classic-editor', 'block-editor', 'term-editor', 'revision-browser'];
const bundle = await readFile(new URL('../build/classic-editor.js', import.meta.url), 'utf8');

function shape({ props }) {
    const children = Array.isArray(props.children) ? props.children : [props.children];
    return JSON.stringify({
        fill: props.style.fill, stroke: props.stroke, strokeWidth: props.strokeWidth,
        paths: children.map(({ props }) => ({ d: props.d, fill: props.fill ?? null, stroke: props.stroke ?? null })),
    });
}

test('plugin metadata and CI agree on the WordPress 6.9 minimum', async () => {
    const [entry, readme, standards, workflow] = await Promise.all([
        'meet-the-frontend-live-preview-panel.php', 'readme.txt', 'phpcs.xml',
        '.github/workflows/commit-checks.yml',
    ].map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
    assert.equal(entry.match(/Requires at least:\s*(\S+)/)[1], '6.9');
    assert.equal(readme.match(/Requires at least:\s*(\S+)/)[1], '6.9');
    assert.match(standards, /name="minimum_supported_wp_version" value="6\.9"/);
    assert.match(workflow, /wordpress: \['6\.9', 'latest'\]/);
});

test('asset entries use consistent feature names and only emit standard WordPress build files', async () => {
    const entries = [...adminEntries, 'preview-navigation'];
    const expected = entries.flatMap((entry) => [
        `${entry}.js`, `${entry}.asset.php`,
        ...(entry === 'preview-navigation' ? [] : [`${entry}.css`, `${entry}-rtl.css`]),
    ]);
    assert.deepEqual((await readdir(new URL('../build/', import.meta.url))).sort(), expected.sort(),
        'obsolete entry assets must not remain in the shipped build');
});

for (const entry of adminEntries) {
    test(`${entry} declares its public WordPress runtime and bundles its code`, async () => {
        const [bundle, asset] = await Promise.all(['js', 'asset.php'].map((extension) =>
            readFile(new URL(`../build/${entry}.${extension}`, import.meta.url), 'utf8')
        ));
        const dependencies = [...asset.match(/'dependencies'\s*=>\s*array\(([^)]*)\)/s)[1].matchAll(/'([^']+)'/g)]
            .map((match) => match[1]);
        assert.deepEqual(dependencies, [
            'react-jsx-runtime', ...(entry === 'block-editor' ? ['wp-api-fetch'] : []),
            'wp-components', 'wp-data', 'wp-element', ...(['classic-editor', 'block-editor'].includes(entry) ? ['wp-hooks'] : []),
            'wp-notices', 'wp-preferences', 'wp-primitives',
        ]);
        assert.match(asset, /'version'\s*=>\s*'[a-f0-9]+'/);
        assert.doesNotMatch(bundle, /__experimental|__unstable|Cannot find module|import\(/);
        if (entry === 'revision-browser') assert.doesNotMatch(bundle, /before-autosave|heartbeat-send|deferredSaves/);
    });
}

test('the shipped editor bundle uses WordPress runtime globals and bundles exactly the selected official icons', () => {
    const bundledIcons = [];
    const jsx = (type, props) => {
        const element = { type, props };
        if (type === 'svg') bundledIcons.push(element);
        return element;
    };
    const window = {
        wp: { hooks: createHooks(), components: {}, data: {}, element: {}, notices: {}, preferences: {}, primitives: { SVG: 'svg', Path: 'path' } },
        ReactJSXRuntime: { jsx, jsxs: jsx },
    };
    // No editor form: loading the compiled entry must be safe, without booting coordination or React.
    vm.runInNewContext(bundle, { window, document: { getElementById: () => null } });
    assert.deepEqual(bundledIcons.map(shape).sort(), Object.values(icons).map(shape).sort());
    assert.equal(window.meetTheFrontendLivePreviewPanelIcons, undefined, 'icons are module-local, not a plugin global');
});

test('all admin entries emit the same panel stylesheet without a separate shared runtime', async () => {
    const [editor, ...others] = await Promise.all(adminEntries.map((entry) =>
        readFile(new URL(`../build/${entry}.css`, import.meta.url), 'utf8')
    ));
    for (const css of others) assert.equal(editor, css);
    assert.match(editor, /\.mtflpp-panel/);
    assert.match(editor, /\.mtflpp-pip-document/);
});

test('the standalone frontend build needs no WordPress runtime', async () => {
    const asset = await readFile(new URL('../build/preview-navigation.asset.php', import.meta.url), 'utf8');
    assert.match(asset, /'dependencies'\s*=>\s*array\(\s*\)/);
});
