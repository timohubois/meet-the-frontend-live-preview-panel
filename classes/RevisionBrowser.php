<?php

namespace MeetTheFrontendLivePreviewPanel;

use WP_Post;

/** Connect WordPress's revision browser without changing its comparison or restore behavior. */
final class RevisionBrowser
{
    public function __construct(
        private readonly FrontendPreview $preview,
        private readonly Panel $panel
    ) {
        add_action('admin_enqueue_scripts', [$this, 'enqueueRevisions']);
        add_action('admin_footer', [$this, 'renderPanel']);
        add_filter('wp_prepare_revision_for_js', [$this, 'revisionData'], 10, 3);
    }

    private function revisionPost(): ?WP_Post
    {
        $screen = get_current_screen();
        $post = get_post();
        if (
            !$screen || $screen->base !== 'revision' || !$post
            || !is_post_type_viewable($post->post_type) || !current_user_can('edit_post', $post->ID)
        ) {
            return null;
        }
        return $post;
    }

    public function revisionData(array $data, WP_Post $revision, WP_Post $post): array
    {
        $screenPost = $this->revisionPost();
        if ($screenPost && $screenPost->ID === $post->ID) {
            $data['mtflppPreviewUrl'] = $this->preview->savedPreviewUrl($post, $revision->ID);
        }
        return $data;
    }

    public function enqueueRevisions(): void
    {
        $post = $this->revisionPost();
        if (!$post) {
            return;
        }
        $this->panel->enqueue('revision-browser', [
            'postId' => $post->ID,
            // Core's synthetic current-post entry does not always pass through revisionData().
            'currentPreviewUrl' => $this->preview->savedPreviewUrl($post, $post->ID),
            'strings' => [
                'title' => __('Revision preview', 'meet-the-frontend-live-preview-panel'),
                'preview' => __('Revision preview', 'meet-the-frontend-live-preview-panel'),
                'closeLivePreview' => __('Close revision preview', 'meet-the-frontend-live-preview-panel'),
                'preparing' => __(
                    'Showing this saved version won’t change your post.',
                    'meet-the-frontend-live-preview-panel'
                ),
                'bootFailed' => __(
                    'Couldn’t start revision preview. You can still compare and restore saved versions in WordPress.',
                    'meet-the-frontend-live-preview-panel'
                ),
                'unavailableTitle' => __('Can’t show this revision', 'meet-the-frontend-live-preview-panel'),
                'unavailable' => __(
                    'We can’t show this saved version. Choose another version, or reload this page.',
                    'meet-the-frontend-live-preview-panel'
                ),
                /* translators: 1: Revision date, 2: Revision author. */
                'revisionLabel' => __('%1$s — %2$s', 'meet-the-frontend-live-preview-panel'),
                'currentVersion' => __('Current version', 'meet-the-frontend-live-preview-panel'),
            ],
        ], ['revisions']);
    }

    public function renderPanel(): void
    {
        if ($this->revisionPost()) {
            $this->panel->render(__('Revision preview', 'meet-the-frontend-live-preview-panel'));
        }
    }
}
