<?php

namespace MeetTheFrontendLivePreviewPanel;

use WP_Post;

/** Authorize preview reads and render only the selected source on the frontend. */
final class FrontendPreview
{
    private ?WP_Post $source = null;
    private int $previewPostId = 0;
    private string $previewToken = '';
    private bool $isolated = false;
    private bool $saved = false;
    private bool $sourceRequested = false;

    public function __construct(
        private readonly string $file,
        private readonly LivePreview $livePreview
    ) {
        add_action('init', [$this, 'authorizePreview'], 20);
    }

    /** Saved history is read-only and may belong to any author the current user can read. */
    private function savedSource(int $postId, int $sourceId): ?WP_Post
    {
        $post = get_post($postId);
        $source = get_post($sourceId);
        $status = $post ? get_post_status_object($post->post_status) : null;
        if (
            !is_user_logged_in() || !$post || !$source || !is_post_type_viewable($post->post_type)
            // Match the public, protected and private statuses core can render in an authenticated preview.
            || !$status || !($status->public || $status->protected || $status->private)
            || !current_user_can('edit_post', $postId) || !current_user_can('read_post', $sourceId)
        ) {
            return null;
        }
        if ($sourceId === $postId) {
            return $source;
        }
        return $source->post_type === 'revision' && $source->post_status === 'inherit'
            && (int) $source->post_parent === $postId ? $source : null;
    }

    private function savedAction(int $postId, int $sourceId): string
    {
        // A separate namespace must never authorize the mutable internal live-preview revision.
        return 'mtflpp_saved_' . $postId . '_' . $sourceId;
    }

    public function savedPreviewUrl(WP_Post $post, int $sourceId): ?string
    {
        if (!$this->savedSource($post->ID, $sourceId)) {
            return null;
        }
        return get_preview_post_link($post, [
            'mtflpp_post' => $post->ID,
            'mtflpp_revision' => $sourceId,
            'mtflpp_saved' => '1',
            'mtflpp_token' => wp_create_nonce($this->savedAction($post->ID, $sourceId)),
        ]);
    }

    public function authorizePreview(): void
    {
        if (!isset($_GET['mtflpp_post'])) {
            return;
        }
        PreviewDocument::disableCaching();
        $postId = isset($_GET['mtflpp_post']) && is_scalar($_GET['mtflpp_post']) ? absint($_GET['mtflpp_post']) : 0;
        $revisionId = isset($_GET['mtflpp_revision']) && is_scalar($_GET['mtflpp_revision'])
            ? absint($_GET['mtflpp_revision']) : 0;
        $token = isset($_GET['mtflpp_token']) && is_string($_GET['mtflpp_token'])
            ? sanitize_text_field(wp_unslash($_GET['mtflpp_token'])) : '';
        $saved = isset($_GET['mtflpp_saved']);
        $source = null;
        if ($saved) {
            if ($_GET['mtflpp_saved'] === '1' && $postId && $revisionId) {
                $source = $this->savedSource($postId, $revisionId);
            }
            $authorized = $source && wp_verify_nonce($token, $this->savedAction($postId, $revisionId));
        } else {
            $source = $this->livePreview->authorizedSource($postId, $revisionId, $token);
            $authorized = $source !== null;
        }
        if (!$authorized) {
            wp_die(
                esc_html__(
                    'This preview has expired or can’t be opened. Open a new preview from the editor or Revisions page.', // phpcs:ignore Generic.Files.LineLength.TooLong -- Keep the translatable message intact.
                    'meet-the-frontend-live-preview-panel'
                ),
                '',
                ['response' => 403]
            );
        }

        $this->previewPostId = $postId;
        $this->previewToken = $token;
        $this->isolated = isset($_GET['mtflpp_isolated']) && $_GET['mtflpp_isolated'] === '1';
        $this->source = sanitize_post($source);
        $this->saved = $saved;
        $this->sourceRequested = isset($_GET['mtflpp_source']) && $_GET['mtflpp_source'] === '1';
        // Bind core and compatibility reads to the authorized source, not the latest revision.
        remove_filter('the_preview', '_set_preview');
        add_filter('the_preview', [$this, 'readPost']);
        add_filter('get_post_metadata', [$this, 'readRevisionMeta'], 10, 4);
        add_filter('get_the_terms', [$this, 'readTerms'], 10, 3);
        add_action('template_redirect', [$this, 'checkPreviewTarget'], -1);

        /**
         * Bind optional reads only after core has authorized and selected the preview source.
         *
         * Live and saved previews have separate actions; neither can select another source.
         *
         * @param array $context Original post and authorized source identities; unrelated posts stay untouched.
         */
        // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.DynamicHooknameFound -- Both names are prefixed.
        do_action($saved
            ? 'mtflpp_frontend_saved_preview_source_selected'
            : 'mtflpp_frontend_live_preview_source_selected', [
                'post' => ['id' => $postId],
                'source' => ['id' => $this->source->ID],
            ]);
    }

    /** History uses revision-enabled keys; live reads overlay only the supported featured-image input. */
    public function readRevisionMeta($value, int $postId, string $key, bool $single)
    {
        $keys = $this->saved ? wp_post_revision_meta_keys(get_post_type($this->previewPostId)) : ['_thumbnail_id'];
        if (
            $value !== null || $postId !== $this->previewPostId || !$this->source
            || $this->source->ID === $postId
            || !in_array($key, $keys, true)
        ) {
            return $value;
        }
        // Core unwraps the first item for single reads. Keep array-valued meta intact and
        // return a falsey scalar for absent keys (also used by metadata_exists()).
        $values = get_post_meta($this->source->ID, $key, false);
        return $single && !$values ? '' : $values;
    }

    /** Overlay lists after native relationship caching; never cache unsaved assignments on the parent. */
    public function readTerms($terms, int $postId, string $taxonomy)
    {
        if ($this->saved || !$this->source || $postId !== $this->previewPostId || is_wp_error($terms)) {
            return $terms;
        }
        $selection = get_post_meta($this->source->ID, LivePreview::TERMS_META, true);
        if (!is_array($selection) || !array_key_exists($taxonomy, $selection)) {
            return $terms;
        }
        $ids = $selection[$taxonomy];
        $saved = wp_get_object_terms($postId, $taxonomy, ['fields' => 'ids']);
        $selected = $ids;
        if (is_array($saved)) {
            sort($saved);
            sort($selected);
            if ($saved === $selected) {
                // Preserve native ordering and earlier list filters when the assignment has not changed.
                return $terms;
            }
        }
        $args = get_taxonomy($taxonomy)->args ?? [];
        return $ids ? get_terms(array_merge(is_array($args) ? $args : [], [
            'taxonomy' => $taxonomy, 'include' => $ids, 'hide_empty' => false,
        ])) : false;
    }

    public function readPost(WP_Post $post): WP_Post
    {
        if ($post->ID === $this->previewPostId && $this->source) {
            foreach (['post_title', 'post_content', 'post_excerpt'] as $field) {
                $post->$field = $this->source->$field;
            }
            // Revision authors/dates describe the revision, not historical post selections.
            foreach ($this->saved ? [] : LivePreview::livePostFields($this->source->ID) as $field => $value) {
                $post->$field = $value;
            }
        }
        return $post;
    }

    public function checkPreviewTarget(): void
    {
        if (!is_preview() || !is_singular() || get_queried_object_id() !== $this->previewPostId) {
            // Native routing owns other destinations, including archives, redirects and error pages.
            // The authorized source remains bound only to its original post; do not label other output verified.
            return;
        }
        // Core canonical redirects drop preview=true without native autosave parameters, losing our core-field overlay.
        remove_action('template_redirect', 'redirect_canonical');
        (new PreviewDocument($this->file, $this->previewToken))->enhance($this->isolated, $this->sourceRequested);
    }
}
