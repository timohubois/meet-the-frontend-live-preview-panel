<?php

namespace MeetTheFrontendLivePreviewPanel;

use MeetTheFrontendLivePreviewPanel\Compatibility\Acf;
use MeetTheFrontendLivePreviewPanel\Compatibility\AcfTerm;
use MeetTheFrontendLivePreviewPanel\Compatibility\Flynt;
use MeetTheFrontendLivePreviewPanel\Compatibility\Yoast;
use WP_Post;

/** Own the shared admin window's configuration, assets, presentation and common labels. */
final class Panel
{
    private const COMPARISON_EXCLUDED_SELECTORS = [
        'script', 'style', 'noscript', 'template', 'link', 'meta', 'nav',
        '[role="navigation"]', '[aria-live]', 'input[type="hidden"]',
        // Runtime diagnostics are part of the default policy, not a special case in the matcher.
        'table.xdebug-error',
    ];

    public function __construct(
        private readonly string $file,
        private readonly Acf $acf = new Acf(),
        private readonly AcfTerm $acfTerm = new AcfTerm(),
        private readonly Flynt $flynt = new Flynt(),
        private readonly Yoast $yoast = new Yoast()
    ) {
    }

    public function enqueue(string $entry, array $config, array $dependencies = []): void
    {
        if ($entry === 'classic-editor' || $entry === 'block-editor') {
            $this->acf->configureEditor($config, $dependencies);
        }
        if ($entry === 'classic-editor') {
            $this->flynt->configureEditor($config);
        } elseif ($entry === 'block-editor') {
            $this->yoast->configureEditor($config);
        } elseif ($entry === 'term-editor') {
            $this->acfTerm->configureEditor($config, $dependencies);
        }
        $postId = (int) ($config['postId'] ?? 0);
        if ($postId && PublicRedirect::isAvailable(get_post($postId))) {
            $config['publicRedirect'] = [
                'endpoint' => PublicRedirect::endpoint($postId),
                'nonce' => wp_create_nonce('wp_rest'),
            ];
        }
        /**
         * Exclude non-author output from change detection. Return an empty array for no exclusions.
         *
         * @param string[] $selectors Complete list of CSS selectors, including defaults.
         * @param string   $screen    classic-editor, block-editor, revision-browser or term-editor.
         */
        $selectors = apply_filters('Mtflpp/previewComparisonExclusions', self::COMPARISON_EXCLUDED_SELECTORS, $entry);
        $config['comparisonExcludedSelectors'] = is_array($selectors) && !array_filter(
            $selectors,
            static fn ($selector): bool => !is_string($selector) || trim($selector) === ''
        ) ? array_values($selectors) : self::COMPARISON_EXCLUDED_SELECTORS;
        $asset = require dirname($this->file) . '/build/' . $entry . '.asset.php';
        wp_enqueue_style(
            'meet-the-frontend-live-preview-panel',
            plugins_url('build/' . $entry . '.css', $this->file),
            ['wp-components'],
            $asset['version']
        );
        wp_enqueue_script(
            'meet-the-frontend-live-preview-panel',
            plugins_url('build/' . $entry . '.js', $this->file),
            array_merge($dependencies, $asset['dependencies']),
            $asset['version'],
            true
        );
        $config['strings'] = array_merge($this->strings(), $config['strings'] ?? []);
        wp_add_inline_script(
            'meet-the-frontend-live-preview-panel',
            'window.meetTheFrontendLivePreviewPanel = ' . wp_json_encode(
                $config,
                JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
            ) . ';',
            'before'
        );
    }

    public function render(?string $title = null): void
    {
        $title ??= __('Live preview', 'meet-the-frontend-live-preview-panel');
        require dirname($this->file) . '/views/panel.php';
    }

    /** Shared editor identity, integrity state and labels; each adapter supplies its own native inputs. */
    public function liveConfig(WP_Post $post, LivePreview $preview): array
    {
        return [
            'endpoint' => rest_url('meet-the-frontend-live-preview-panel/v1/posts/' . $post->ID . '/preview'),
            'postId' => $post->ID,
            'postTitle' => $post->post_title,
            'userId' => get_current_user_id(),
            'nonce' => wp_create_nonce('wp_rest'),
            'base' => $preview->fingerprint($post->ID),
            'adminCookiePath' => ADMIN_COOKIE_PATH,
            'available' => $preview->isAvailable($post),
            'strings' => $this->liveStrings(),
        ];
    }

    public function liveStrings(): array
    {
        return [
            'takeOver' => __('Use preview here', 'meet-the-frontend-live-preview-panel'),
            'takingOver' => __('Switching…', 'meet-the-frontend-live-preview-panel'),
            'switchingPreview' => __('Switching preview…', 'meet-the-frontend-live-preview-panel'),
            'waiting' => __(
                'Waiting for the other preview to finish updating.',
                'meet-the-frontend-live-preview-panel'
            ),
            'handedOff' => __('Preview is paused here', 'meet-the-frontend-live-preview-panel'),
            'handedOffHelp' => __(
                'Live preview is active elsewhere. If you use it here, the other preview will stop updating.',
                'meet-the-frontend-live-preview-panel'
            ),
            'takeoverTimeout' => __('The other preview is still busy', 'meet-the-frontend-live-preview-panel'),
            'takeoverTimeoutHelp' => __(
                'Try again, or close the other preview.',
                'meet-the-frontend-live-preview-panel'
            ),
            'tabEdits' => __('Your edits stay where you made them.', 'meet-the-frontend-live-preview-panel'),
            'bootFailed' => __(
                'Couldn’t start live preview. Use WordPress Preview, or copy any changes you want to keep and reload the editor.', // phpcs:ignore Generic.Files.LineLength.TooLong -- Keep the translatable message intact.
                'meet-the-frontend-live-preview-panel'
            ),
            'savedPostConflict' => LivePreview::conflictMessage(),
            'reviewBeforeReload' => __(
                'Copy any unsaved changes you want to keep, then reload the editor to resume live preview.',
                'meet-the-frontend-live-preview-panel'
            ),
            'conflict' => __('Live preview is already in use', 'meet-the-frontend-live-preview-panel'),
            'conflictHelp' => __(
                'If you use the preview here, the other preview will stop updating.',
                'meet-the-frontend-live-preview-panel'
            ),
            'closeOther' => __('Close the other preview first', 'meet-the-frontend-live-preview-panel'),
            'closeOtherHelp' => __(
                'Close the other preview, then start it here.',
                'meet-the-frontend-live-preview-panel'
            ),
            'manualSwitchHint' => __(
                'This browser can’t switch previews automatically.',
                'meet-the-frontend-live-preview-panel'
            ),
            'unavailableTitle' => __('Live preview isn’t available yet', 'meet-the-frontend-live-preview-panel'),
            'unavailable' => __(
                'If this is a new post, save it as a draft first.',
                'meet-the-frontend-live-preview-panel'
            ),
            'browserTitle' => __('Live preview can’t run here', 'meet-the-frontend-live-preview-panel'),
            'browser' => __(
                'Use an up-to-date browser and open the editor over a secure connection.',
                'meet-the-frontend-live-preview-panel'
            ),
            'saving' => __('Saving in WordPress…', 'meet-the-frontend-live-preview-panel'),
            'nativePreview' => __('Preparing WordPress Preview…', 'meet-the-frontend-live-preview-panel'),
            'integrationFailed' => __(
                'A preview integration could not read your edits.',
                'meet-the-frontend-live-preview-panel'
            ),
            'nativePreviewFailed' => __(
                'We couldn’t check whether WordPress finished preparing its preview. Check the preview tab before continuing.', // phpcs:ignore Generic.Files.LineLength.TooLong -- Keep the translatable message intact.
                'meet-the-frontend-live-preview-panel'
            ),
        ];
    }

    private function strings(): array
    {
        return [
            'title' => __('Live preview', 'meet-the-frontend-live-preview-panel'),
            'preview' => __('Preview', 'meet-the-frontend-live-preview-panel'),
            'move' => __('Move preview: drag or use arrow keys', 'meet-the-frontend-live-preview-panel'),
            'moved' => __('Preview moved', 'meet-the-frontend-live-preview-panel'),
            'resize' => __('Resize preview', 'meet-the-frontend-live-preview-panel'),
            'retry' => __('Try again', 'meet-the-frontend-live-preview-panel'),
            'actions' => __('Preview options', 'meet-the-frontend-live-preview-panel'),
            'refresh' => __('Update preview', 'meet-the-frontend-live-preview-panel'),
            'close' => __('Close preview', 'meet-the-frontend-live-preview-panel'),
            'closeLivePreview' => __('Close live preview', 'meet-the-frontend-live-preview-panel'),
            'display' => __('Preview window', 'meet-the-frontend-live-preview-panel'),
            'popOut' => __('Keep on top', 'meet-the-frontend-live-preview-panel'),
            'popOutHelp' => __(
                'Open the preview in a separate Picture-in-Picture window.',
                'meet-the-frontend-live-preview-panel'
            ),
            'fullscreen' => __('Use full screen', 'meet-the-frontend-live-preview-panel'),
            'position' => __('Move preview to', 'meet-the-frontend-live-preview-panel'),
            'bottomLeft' => __('Bottom left', 'meet-the-frontend-live-preview-panel'),
            'bottomCenter' => __('Bottom center', 'meet-the-frontend-live-preview-panel'),
            'bottomRight' => __('Bottom right', 'meet-the-frontend-live-preview-panel'),
            'preferences' => __('Settings', 'meet-the-frontend-live-preview-panel'),
            'rememberVisibility' => __('Remember open or closed', 'meet-the-frontend-live-preview-panel'),
            'rememberVisibilityHelp' => __('Turn off to always start open.', 'meet-the-frontend-live-preview-panel'),
            'rememberPosition' => __('Remember size and position', 'meet-the-frontend-live-preview-panel'),
            'rememberPositionHelp' => __('Same size and spot next time.', 'meet-the-frontend-live-preview-panel'),
            'follow' => __('Scroll to my changes', 'meet-the-frontend-live-preview-panel'),
            'followHelp' => __('Show the part you changed.', 'meet-the-frontend-live-preview-panel'),
            'reset' => __('Reset preview window', 'meet-the-frontend-live-preview-panel'),
            'resetHelp' => __('Small window, bottom right.', 'meet-the-frontend-live-preview-panel'),
            'viewport' => __('Screen size', 'meet-the-frontend-live-preview-panel'),
            'fitting' => __('Zoom', 'meet-the-frontend-live-preview-panel'),
            'zoomMode' => __('Zoom mode', 'meet-the-frontend-live-preview-panel'),
            'automatic' => __('Auto', 'meet-the-frontend-live-preview-panel'),
            'automaticHelp' => __('Show the whole screen, up to 100%.', 'meet-the-frontend-live-preview-panel'),
            'fitToWindow' => __('Fit to panel', 'meet-the-frontend-live-preview-panel'),
            'fitToWindowHelp' => __('Make the whole screen fit the panel.', 'meet-the-frontend-live-preview-panel'),
            'fitToWidth' => __('Fill width', 'meet-the-frontend-live-preview-panel'),
            'fitToWidthHelp' => __('Fill the width. May need extra scrolling.', 'meet-the-frontend-live-preview-panel'),
            'fixedZoom' => __('Choose zoom', 'meet-the-frontend-live-preview-panel'),
            'fixedZoomHelp' => __(
                'Set a percentage. May need extra scrolling.',
                'meet-the-frontend-live-preview-panel'
            ),
            'customZoom' => __('Zoom (%)', 'meet-the-frontend-live-preview-panel'),
            'customZoomHelp' => __('Choose 10% to 400%.', 'meet-the-frontend-live-preview-panel'),
            'displayInformation' => __('Display information', 'meet-the-frontend-live-preview-panel'),
            'displayDpr' => __('Display DPR', 'meet-the-frontend-live-preview-panel'),
            'pixelZoomHelp' => __('100% = pixel for pixel.', 'meet-the-frontend-live-preview-panel'),
            'rotateLandscape' => __('Turn sideways', 'meet-the-frontend-live-preview-panel'),
            'rotatePortrait' => __('Turn upright', 'meet-the-frontend-live-preview-panel'),
            'desktop' => __('Desktop', 'meet-the-frontend-live-preview-panel'),
            'tablet' => __('Tablet', 'meet-the-frontend-live-preview-panel'),
            'mobile' => __('Phone', 'meet-the-frontend-live-preview-panel'),
            'expand' => __('Make preview bigger', 'meet-the-frontend-live-preview-panel'),
            'compact' => __('Make preview smaller', 'meet-the-frontend-live-preview-panel'),
            'exitFullscreen' => __('Leave full screen', 'meet-the-frontend-live-preview-panel'),
            'pipFailed' => __('Couldn’t open the preview in its own window.', 'meet-the-frontend-live-preview-panel'),
            'fullscreenFailed' => __('Couldn’t switch to or from full screen.', 'meet-the-frontend-live-preview-panel'),
            'windowNoticeHelp' => __('You can still use the preview here.', 'meet-the-frontend-live-preview-panel'),
            'loading' => __('Loading preview…', 'meet-the-frontend-live-preview-panel'),
            'preparing' => __('Preparing your first preview.', 'meet-the-frontend-live-preview-panel'),
            'updating' => __('Updating preview…', 'meet-the-frontend-live-preview-panel'),
            'current' => __('Preview updated', 'meet-the-frontend-live-preview-panel'),
            'redirected' => __('Followed a redirect to:', 'meet-the-frontend-live-preview-panel'),
            'publicRedirected' => __('Public URL redirects to:', 'meet-the-frontend-live-preview-panel'),
            'pausedTitle' => __('Preview paused', 'meet-the-frontend-live-preview-panel'),
            'stale' => __('Waiting to update preview…', 'meet-the-frontend-live-preview-panel'),
            'failed' => __('Couldn’t load preview', 'meet-the-frontend-live-preview-panel'),
            'failedHelp' => __('Try loading the preview again.', 'meet-the-frontend-live-preview-panel'),
            'refreshFailed' => __('Couldn’t update preview', 'meet-the-frontend-live-preview-panel'),
            'previousPreview' => __('Showing the last preview.', 'meet-the-frontend-live-preview-panel'),
            'originMismatchTitle' => __(
                'Preview uses a different website address',
                'meet-the-frontend-live-preview-panel'
            ),
            /* translators: %s: Preview URL without credentials, query or fragment. Keep it on its own line. */
            'originMismatch' => __(
                'WordPress provided this preview URL:
%s

It must use the same website address as the editor.',
                'meet-the-frontend-live-preview-panel'
            ),
        ];
    }
}
