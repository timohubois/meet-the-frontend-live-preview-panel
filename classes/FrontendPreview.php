<?php

namespace MeetTheFrontendLivePreviewPanel;

use MeetTheFrontendLivePreviewPanel\Compatibility\Acf;
use MeetTheFrontendLivePreviewPanel\Compatibility\CoreBlocks;
use MeetTheFrontendLivePreviewPanel\Compatibility\Timber;
use MeetTheFrontendLivePreviewPanel\Compatibility\Yoast;
use WP_Post;

/** Authorize preview reads and render only the selected source on the frontend. */
final class FrontendPreview
{
    private ?WP_Post $source = null;
    private int $previewPostId = 0;
    private int $previewSiteId = 0;
    private string $previewToken = '';
    private bool $isolated = false;
    private bool $saved = false;
    private bool $sourceRequested = false;
    private bool $rowMarkersRequested = false;
    private bool $postsPage = false;
    private ?string $savedPostsPageTitle = null;

    public function __construct(
        private readonly string $file,
        private readonly LivePreview $livePreview,
        private readonly Acf $acf = new Acf(),
        private readonly CoreBlocks $coreBlocks = new CoreBlocks(),
        private readonly PreviewRowEvidence $rowEvidence = new PreviewRowEvidence(),
        private readonly Timber $timber = new Timber(),
        private readonly Yoast $yoast = new Yoast()
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
        return self::previewUrl($post, [
            'mtflpp_post' => $post->ID,
            'mtflpp_revision' => $sourceId,
            'mtflpp_saved' => '1',
            'mtflpp_token' => wp_create_nonce($this->savedAction($post->ID, $sourceId)),
        ]);
    }

    private static function isConfiguredPostsPage(?WP_Post $post): bool
    {
        return $post?->post_type === 'page' && get_option('show_on_front') === 'page'
            && $post->ID === (int) get_option('page_for_posts');
    }

    public static function previewUrl(WP_Post $post, array $args): ?string
    {
        if (self::isConfiguredPostsPage($post)) {
            // Core's preview=true can turn the posts index into a query for the static front page.
            return add_query_arg($args, set_url_scheme(get_permalink($post)));
        }
        return get_preview_post_link($post, $args);
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

        // Document-only exceptions must not follow a new source before its frontend route is matched.
        remove_filter('post_password_required', [$this, 'requirePostPassword'], 0);
        remove_filter('the_title', [$this, 'readPostsPageTitle'], PHP_INT_MIN);
        $this->previewPostId = $postId;
        $this->previewSiteId = get_current_blog_id();
        $this->previewToken = $token;
        $this->isolated = isset($_GET['mtflpp_isolated']) && $_GET['mtflpp_isolated'] === '1';
        $this->source = sanitize_post($source);
        $this->saved = $saved;
        $this->sourceRequested = isset($_GET['mtflpp_source']) && $_GET['mtflpp_source'] === '1';
        $this->rowMarkersRequested = isset($_GET['mtflpp_row_markers']) && $_GET['mtflpp_row_markers'] === '1';
        $this->postsPage = self::isConfiguredPostsPage(get_post($postId));
        add_action('template_redirect', [$this, 'checkPreviewTarget'], -1);
        if (!$this->postsPage) {
            // Ordinary previews use core's singular-query overlay, not the latest autosave.
            remove_filter('the_preview', '_set_preview');
            add_filter('the_preview', [$this, 'readPost']);
            $this->bindSource();
        }
    }

    private function bindSource(): void
    {
        add_filter('get_post_metadata', [$this, 'readRevisionMeta'], 10, 4);
        add_filter('get_the_terms', [$this, 'readTerms'], 10, 3);

        $postId = $this->previewPostId;
        $sourceId = $this->source->ID;
        $this->acf->bindPreview($postId, $sourceId, $this->saved);
        $this->coreBlocks->bindPreview($postId, $sourceId, $this->saved);
        $this->timber->bindPreview($postId, $sourceId, $this->saved);
        $this->yoast->bindPreview($postId, $sourceId, $this->saved);
    }

    private function isPreviewPost(mixed $postId): bool
    {
        return $postId === $this->previewPostId && get_current_blog_id() === $this->previewSiteId;
    }

    /** History uses revision-enabled keys; live reads overlay only the supported featured-image input. */
    public function readRevisionMeta($value, int $postId, string $key, bool $single)
    {
        if ($value !== null || !$this->source || $postId === $this->source->ID || !$this->isPreviewPost($postId)) {
            return $value;
        }
        $keys = $this->saved ? wp_post_revision_meta_keys(get_post_type($postId)) : ['_thumbnail_id'];
        if (!in_array($key, $keys, true)) {
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
        if ($this->saved || !$this->source || !$this->isPreviewPost($postId) || is_wp_error($terms)) {
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
        if ($this->source && $this->isPreviewPost($post->ID)) {
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

    private function bindPostsPage(): bool
    {
        global $wp_query;

        if (
            !$wp_query->is_posts_page || !is_home()
            || is_feed() || is_embed() || is_search() || is_trackback() || is_404()
        ) {
            return false;
        }
        $page = get_queried_object();
        if (!$page instanceof WP_Post || !$this->isPreviewPost($page->ID)) {
            return false;
        }

        // The queried page is separate from the posts loop. Don't swap the global post or change saved reads.
        $preview = $this->readPost(clone $page);
        $wp_query->queried_object = $preview;
        if ($page->post_title !== $preview->post_title) {
            // Support get_the_title($id) without replacing titles already formatted by core or other code.
            $this->savedPostsPageTitle = $page->post_title;
            add_filter('the_title', [$this, 'readPostsPageTitle'], PHP_INT_MIN, 2);
        }
        $this->bindSource();
        return true;
    }

    public function readPostsPageTitle($title, $id = 0)
    {
        return $title === $this->savedPostsPageTitle && $this->isPreviewPost($id)
            ? $this->source->post_title : $title;
    }

    public function requirePostPassword(bool $required, ?WP_Post $post): bool
    {
        return !empty($post->post_password) && $this->isPreviewPost($post->ID) ? false : $required;
    }

    public function checkPreviewTarget(): void
    {
        if ($this->postsPage) {
            if (!$this->bindPostsPage()) {
                return;
            }
        } elseif (is_preview() && is_singular() && $this->isPreviewPost(get_queried_object_id())) {
            // Core drops preview=true without native autosave parameters, losing the singular overlay.
            remove_action('template_redirect', 'redirect_canonical');
        } else {
            // Native routing owns other destinations, including archives, redirects and error pages.
            return;
        }
        // This panel document must not claim the window name WordPress uses for its native Preview tab.
        remove_action('wp_head', 'wp_post_preview_js', 1);

        // Editors have already authorized this preview. Leave other posts and later site policies alone.
        add_filter('post_password_required', [$this, 'requirePostPassword'], 0, 2);

        if (!$this->saved && $this->sourceRequested && $this->rowMarkersRequested) {
            // Row evidence may decorate this matched, authorized following document only.
            $this->rowEvidence->markPreview($this->source->ID);
        }
        (new PreviewDocument($this->file, $this->previewToken))->enhance($this->isolated, $this->sourceRequested);
    }
}
