import { initRevisionPreview } from './screens/revision-browser.js';
import { showStartupError } from './panel/startup-error.js';
import './panel/panel.css';

// Core registers its own ready callback first. Do not replace or initialize the native revision UI.
window.jQuery(() => {
    const config = window.meetTheFrontendLivePreviewPanel;
    if (!config) return;
    try {
        const model = window.wp?.revisions?.view?.frame?.model;
        if (!model || typeof model.get !== 'function' || typeof model.on !== 'function'
            || typeof model.off !== 'function') {
            throw new Error('The native revision selection is unavailable.');
        }
        const backLink = document.querySelector('#wpbody-content > .wrap > h1.long-header + a');
        if (!backLink) throw new Error('The native revision header is unavailable.');
        initRevisionPreview(config, model, backLink);
    } catch (error) {
        showStartupError(config.strings.bootFailed, error);
    }
});
