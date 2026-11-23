<?php

namespace MeetTheFrontendLivePreviewPanel;

use WP_Post;

/** Connect only the post block editor, not the Site Editor or its separate entities. */
final class BlockEditor
{
    public function __construct(
        private readonly LivePreview $preview,
        private readonly Panel $panel
    ) {
        add_action('enqueue_block_editor_assets', [$this, 'enqueueEditor']);
        add_action('admin_footer', [$this, 'renderPanel']);
    }

    private function editorPost(): ?WP_Post
    {
        $screen = get_current_screen();
        $post = get_post();
        if (
            !$screen || $screen->base !== 'post' || !$screen->is_block_editor()
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
        $config = $this->panel->liveConfig($post, $this->preview);
        $config['postType'] = $post->post_type;
        $config['postRoute'] = rest_get_route_for_post($post);
        $config['restRoot'] = rest_url();
        $config['postFormUrl'] = admin_url('post.php');
        $config['taxonomies'] = [];
        foreach (get_object_taxonomies($post->post_type, 'objects') as $taxonomy) {
            if ($taxonomy->show_in_rest && current_user_can($taxonomy->cap->assign_terms)) {
                $config['taxonomies'][$taxonomy->name] = $taxonomy->rest_base ?: $taxonomy->name;
            }
        }
        $config['strings']['nativeSaveFailed'] = __(
            'We couldn’t check whether WordPress saved your latest changes.',
            'meet-the-frontend-live-preview-panel'
        );
        $config['strings']['postOnly'] = __(
            'Return to editing this post to resume its live preview.',
            'meet-the-frontend-live-preview-panel'
        );
        $this->panel->enqueue('block-editor', $config, ['wp-editor']);
    }

    public function renderPanel(): void
    {
        if ($this->editorPost()) {
            $this->panel->render();
        }
    }
}
