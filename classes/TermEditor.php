<?php

namespace AFloatingLivePreviewPanel;

use WP_Term;

/** Connect the native term-edit form, not the taxonomy list or quick-edit form. */
final class TermEditor
{
    public function __construct(
        private readonly TermPreview $preview,
        private readonly Panel $panel
    ) {
        add_action('admin_enqueue_scripts', [$this, 'enqueueEditor']);
        add_action('admin_footer', [$this, 'renderPanel']);
    }

    private function editorTerm(): ?WP_Term
    {
        global $tag;

        $screen = get_current_screen();
        // term.php resolves and authorizes $tag before loading the admin header.
        if (
            !$screen || $screen->base !== 'term' || !$tag instanceof WP_Term
            || $screen->taxonomy !== $tag->taxonomy || !$this->preview->canEdit($tag)
        ) {
            return null;
        }
        return $tag;
    }

    public function enqueueEditor(): void
    {
        $term = $this->editorTerm();
        if (!$term) {
            return;
        }

        $this->panel->enqueue('term-editor', [
            'endpoint' => rest_url('a-floating-live-preview-panel/v1/terms/' . $term->term_id . '/preview'),
            'termId' => $term->term_id,
            'taxonomy' => $term->taxonomy,
            'userId' => get_current_user_id(),
            'nonce' => wp_create_nonce('wp_rest'),
            'available' => true,
            'strings' => [
                'bootFailed' => __(
                    'Couldn’t start live preview. You can still update the term normally.',
                    'meet-the-frontend-live-preview-panel'
                ),
            ] + $this->panel->liveStrings(),
        ], ['jquery']);
    }

    public function renderPanel(): void
    {
        if ($this->editorTerm()) {
            $this->panel->render();
        }
    }
}
