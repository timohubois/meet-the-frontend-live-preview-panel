import vm from 'node:vm';
import { sourceForVm } from './modules.mjs';

const [inputsSource, acfSource, fieldsSource, blockSource, flyntSource, yoastSource] = await Promise.all([
    '../../src/screens/preview-inputs.js', '../../src/compatibility/acf-editor.js',
    '../../src/compatibility/acf-fields.js', '../../src/compatibility/acf-block-editor.js',
    '../../src/compatibility/flynt-editor.js', '../../src/compatibility/yoast.js',
].map((path) => sourceForVm(new URL(path, import.meta.url))));

export function previewInputImports(context, overrides = {}) {
    const evaluate = (source, result, imports) => vm.runInNewContext(
        `(() => { ${source}\nreturn ${result}; })()`, { ...context, imports }
    );
    const initAcf = overrides.initAcf || evaluate(fieldsSource, 'initAcf');
    const select = context.imports?.['@wordpress/data']?.select || (() => undefined);
    const createBlockEditorAcf = overrides.createBlockEditorAcf || evaluate(blockSource, 'createBlockEditorAcf', {
        '@wordpress/data': { select }, './acf-fields.js': { initAcf },
    });
    return {
        './preview-inputs.js': evaluate(inputsSource, '{ guardPreviewInputs, submittedValues }'),
        '../compatibility/acf-editor.js': evaluate(acfSource, '{ setupClassicEditorAcf, setupBlockEditorAcf, markAcfPlainText }', {
            './acf-fields.js': { initAcf }, './acf-block-editor.js': { createBlockEditorAcf },
        }),
        '../compatibility/flynt-editor.js': evaluate(flyntSource, '{ requestFlyntRowMarkers, addFlyntRowMarkers, resolveFlyntRegions }'),
        '../compatibility/yoast.js': evaluate(yoastSource, '{ yoastPrimaryTerms }', { '@wordpress/data': { select } }),
    };
}

export const browserPreviewInputImports = `(function(initAcf) {
    return {
        './preview-inputs.js': new Function(${JSON.stringify(`${inputsSource}\nreturn { guardPreviewInputs, submittedValues };`)})(),
        '../compatibility/acf-editor.js': new Function('imports', ${JSON.stringify(`${acfSource}\nreturn { setupClassicEditorAcf };`)})({
            './acf-fields.js': { initAcf }, './acf-block-editor.js': {},
        }),
        '../compatibility/flynt-editor.js': new Function(${JSON.stringify(`${flyntSource}\nreturn { requestFlyntRowMarkers, addFlyntRowMarkers, resolveFlyntRegions };`)})(),
    };
})`;
