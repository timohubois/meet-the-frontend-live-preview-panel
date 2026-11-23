import { select } from '@wordpress/data';
import { addAction } from '@wordpress/hooks';

addAction('mtflpp.blockEditor.previewSetup', 'meet-the-frontend-live-preview-panel/yoast', ({ config, hooks }) => {
    if (!config.yoastPrimaryTaxonomies?.length) return;
    hooks.addFilter('additionalPreviewValues', 'meet-the-frontend-live-preview-panel/yoast', (values, editor) => {
        const primary = yoastPrimaryTerms(config, editor);
        return primary === undefined ? values : { ...values, yoast_primary_terms: primary };
    });
});

// Use Yoast's native primary-term selector; never dispatch changes to either editor store.
function yoastPrimaryTerms(config, editor) {
    if (!config.yoastPrimaryTaxonomies?.length) return undefined;
    const yoast = select('yoast-seo/editor');
    if (typeof yoast?.getPrimaryTaxonomyId !== 'function' || Number(yoast.getPostId?.()) !== config.postId) return undefined;
    const terms = {};
    for (const taxonomy of config.yoastPrimaryTaxonomies) {
        const raw = yoast.getPrimaryTaxonomyId(taxonomy);
        // A not-yet-initialized control is omitted so the source keeps its saved baseline.
        if (raw === undefined) continue;
        const id = Number(raw) === -1 ? 0 : Number(raw);
        const assigned = editor.getEditedPostAttribute(config.taxonomies[taxonomy]);
        // Yoast's native getter also treats an unassigned primary term as unset.
        terms[taxonomy] = Array.isArray(assigned) && !assigned.includes(id) ? 0 : id;
    }
    return Object.keys(terms).length ? JSON.stringify(terms) : undefined;
}
