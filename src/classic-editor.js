import { createNativeEditor } from './screens/classic-native-editor.js';
import { initLivePreview } from './screens/classic-editor.js';
import { showStartupError } from './panel/startup-error.js';
import './compatibility/acf-editor.js';
import './panel/panel.css';

const config = window.meetTheFrontendLivePreviewPanel;
const form = document.getElementById('post');
if (config && form) {
    // Bind native observers first. All plugin modules are bundled, so initialization cannot yield to a save.
    const nativeEditor = createNativeEditor(config, form);
    try {
        initLivePreview(config, nativeEditor, form.querySelector('#mtflpp-publish-preview button'));
    } catch (error) {
        nativeEditor.destroy();
        showStartupError(config.strings.bootFailed, error);
    }
}
