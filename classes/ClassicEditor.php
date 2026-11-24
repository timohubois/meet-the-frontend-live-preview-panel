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

    public function renderLauncher(WP_Post $post): void
    {
        if ($this->editorPost()?->ID !== $post->ID) {
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

    private function editorPost(): ?WP_Post
    {
        $screen = get_current_screen();
        $post = get_post();

        if (
            !$screen || $screen->base !== 'post' || $screen->is_block_editor()
            || !$post || !is_post_type_viewable($post->post_type)
            || !current_user_can('edit_post', $post->ID)
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
