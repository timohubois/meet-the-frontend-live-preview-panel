import { readFile } from 'node:fs/promises';

// Give the existing VM fixtures explicit public-package mocks without executing WordPress in Node.
export async function sourceForVm(url) {
    const source = await readFile(url, 'utf8');
    return source
        .replace(/^import (\w+) from ['"]([^'"]+)['"];$/gm, (_, name, path) => `const ${name} = imports[${JSON.stringify(path)}].default;`)
        .replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];$/gm, (_, names, path) => {
            const bindings = names.replace(/\b(\w+)\s+as\s+(\w+)\b/g, '$1: $2');
            return `const { ${bindings} } = imports[${JSON.stringify(path)}];`;
        })
        .replace(/^import ['"][^'"]+\.css['"];$/gm, '')
        .replace(/^import ['"]([^'"]+)['"];$/gm, (_, path) => `void imports[${JSON.stringify(path)}];`)
        .replace(/^export (function|const) /gm, '$1 ');
}

// Execute the same shared iframe implementation in VM and data-URL browser fixtures.
export async function previewSourceForVm(url) {
    const frame = await sourceForVm(new URL('../../src/preview/frame.js', import.meta.url));
    let source = await sourceForVm(url);
    if (url.pathname.endsWith('/screens/classic-editor.js')) {
        const session = await sourceForVm(new URL('../../src/preview/live-preview.js', import.meta.url));
        source = source.replace(/^const \{\s*createLivePreview\s*\} = imports\["\.\.\/preview\/live-preview\.js"\];$/m, session);
    }
    source = source.replace(/^const \{\s*createPreviewFrame\s*\} = imports\["\.\.\/preview\/frame\.js"\];$/m, '');
    // Editor fixtures exercise the frame lifecycle, not DOM comparison. Revision tests inject their own observer.
    return `const createPreviewFrame = ((imports) => { ${frame}\nreturn createPreviewFrame; })({
        './comparison.js': imports['./comparison.js'] ?? { createPreviewComparison: () => ({ capture() {}, findChange: () => null }) },
    });\n${source}`;
}
