import { createElement as h } from '@wordpress/element';
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
        const PreviewMenuItem = window.wp?.editor?.PluginPreviewMenuItem;
        const registerPlugin = window.wp?.plugins?.registerPlugin;
        const nativeMenu = typeof PreviewMenuItem === 'function' && typeof registerPlugin === 'function';
        const nativeLauncher = nativeMenu ? {
            // Core's PreviewDropdown is absent at useViewportMatch('medium', '<').
            fallbackMedia: window.matchMedia('(max-width: 782px)'),
            focus() {
                const options = { preventScroll: true };
                const view = document.querySelector('.editor-preview-dropdown__toggle');
                view?.focus(options);
                if (!view || document.activeElement !== view) {
                    // Distraction free hides View. Use Gutenberg's keyboard-navigable content region.
                    document.querySelector('.interface-interface-skeleton__content[tabindex="-1"]')?.focus(options);
                }
            },
        } : undefined;
        const preview = createLivePreview(config, editor, { nativeLauncher });
        editor.connect(preview);
        if (nativeMenu) {
            registerPlugin('meet-the-frontend-live-preview-panel', {
                render: () => h(PreviewMenuItem, {
                    role: 'menuitem',
                    icon: null,
                    info: config.strings.showLivePreviewHelp,
                    onClick: () => preview.openFromLauncher(),
                }, config.strings.showLivePreview),
            });
        }
    } catch (error) {
        editor?.destroy();
        showStartupError(config.strings.bootFailed, error);
    }
}
