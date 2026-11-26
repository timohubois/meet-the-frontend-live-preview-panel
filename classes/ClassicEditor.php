<?php

namespace MeetTheFrontendLivePreviewPanel;

use WP_Post;

/** Connect the classic editor to the shared panel and preview features. */
final class ClassicEditor
{
    public function __construct(
        private readonly LivePreview $preview,
        private readonly Panel $panel
    ) {
        add_action('admin_enqueue_scripts', [$this, 'enqueueEditor']);
        add_action('post_submitbox_minor_actions', [$this, 'renderLauncher']);
        add_action('admin_footer', [$this, 'renderPanel']);
    }

    public function renderLauncher(mixed $post = null): void
    {
        $postId = self::postId($post);
        if ($postId === null || $this->editorPost()?->ID !== $postId) {
            return;
        }
        ?>
        <div id="mtflpp-publish-preview" class="mtflpp-publish-launcher">
            <button type="button" class="button" aria-controls="mtflpp-panel" aria-expanded="false" disabled>
                <?php esc_html_e('Live Preview Changes', 'meet-the-frontend-live-preview-panel'); ?>
            </button>
        </div>
        <?php
    }

    private static function postId(mixed $post): ?int
    {
        $id = is_object($post) ? (get_object_vars($post)['ID'] ?? null) : null;
        if (is_string($id) && (string) (int) $id === $id) {
            $id = (int) $id;
        }
        return is_int($id) && $id > 0 ? $id : null;
    }

    private function editorPost(): ?WP_Post
    {
        $screen = get_current_screen();
        if (!$screen || $screen->base !== 'post' || $screen->is_block_editor()) {
            return null;
        }

        $current = $GLOBALS['post'] ?? null;
        $postId = self::postId($current);
        // Core sets post_ID before rendering meta boxes; a wrapper must match that independent ID.
        $screenPostId = $GLOBALS['post_ID'] ?? ($current instanceof WP_Post ? $postId : null);
        if ($postId === null || $postId !== $screenPostId) {
            return null;
        }

        $post = get_post($postId);
        if (
            !$post instanceof WP_Post || !is_post_type_viewable($post->post_type)
            || !current_user_can('edit_post', $postId)
        ) {
            return null;
        }

        return $post;
    }

    public function enqueueEditor(): void
    {
        $post = $this->editorPost();
        if (!$post) {
            return;
        }

        $this->panel->enqueue(
            'classic-editor',
            $this->panel->liveConfig($post, $this->preview),
            ['jquery', 'autosave']
        );
    }

    public function renderPanel(): void
    {
        if (!$this->editorPost()) {
            return;
        }

        $this->panel->render();
    }
}
