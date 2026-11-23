import { createBlockEditor } from './screens/block-editor.js';
import { createLivePreview } from './preview/live-preview.js';
import { showStartupError } from './panel/startup-error.js';
import './compatibility/acf-editor.js';
import './compatibility/yoast.js';
import './panel/panel.css';

const config = window.meetTheFrontendLivePreviewPanel;
if (config) {
    let editor;
    try {
        editor = createBlockEditor(config);
        editor.connect(createLivePreview(config, editor));
    } catch (error) {
        editor?.destroy();
        showStartupError(config.strings.bootFailed, error);
    }
}
