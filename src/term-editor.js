import { initTermPreview } from './screens/term-editor.js';
import { setupAcfTermEditor } from './compatibility/acf-term-editor.js';
import { showStartupError } from './panel/startup-error.js';
import './panel/panel.css';

const config = window.meetTheFrontendLivePreviewPanel;
const form = document.getElementById('edittag');
if (config && form) {
    try {
        initTermPreview(config, form, setupAcfTermEditor);
    } catch (error) {
        showStartupError(config.strings.bootFailed, error);
    }
}
