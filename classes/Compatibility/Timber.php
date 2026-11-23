<?php

namespace AFloatingLivePreviewPanel\Compatibility;

use AFloatingLivePreviewPanel\LivePreview;
use WP_Post;
use WP_Term;
use WP_Term_Query;

/** Adapt Timber's native post and term reads to the already-authorized preview source. */
final class Timber
{
    private int $previewPostId = 0;
    private ?WP_Post $source = null;
    private array $fields = [];
    private array $terms = [];

    public function __construct()
    {
        add_action('aflpp_frontend_live_preview_source_selected', fn (array $context) => $this->bindPreview(
            $context['post']['id'],
            $context['source']['id']
        ));
        add_action('aflpp_frontend_saved_preview_source_selected', fn (array $context) => $this->bindPreview(
            $context['post']['id'],
            $context['source']['id'],
            true
        ));
        add_action('aflpp_frontend_term_preview_source_selected', fn (array $context) => $this->bindTermPreview(
            $context['term'],
            $context['saved']
        ));
    }

    private function bindTermPreview(WP_Term $term, WP_Term $saved): void
    {
        if (!class_exists(\Timber\Term::class)) {
            return;
        }
        require_once __DIR__ . '/TimberTerm.php';
        TimberTerm::setPreview($term, $saved);
        add_filter('timber/term/class', [TimberTerm::class, 'previewClass'], PHP_INT_MAX, 2);
        add_action('shutdown', [$this, 'unbindTermPreview'], PHP_INT_MAX);
    }

    public function unbindTermPreview(): void
    {
        if (class_exists(TimberTerm::class, false)) {
            TimberTerm::setPreview(null);
        }
        remove_filter('timber/term/class', [TimberTerm::class, 'previewClass'], PHP_INT_MAX);
        remove_action('shutdown', [$this, 'unbindTermPreview'], PHP_INT_MAX);
    }

    /** Core owns authorization and source selection; this adapter only binds Timber reads. */
    public function bindPreview(int $postId, int $sourceId, bool $saved = false): void
    {
        $this->unbindPreview();
        // Themes may load Timber's autoloader after our plugin bootstrap.
        if (!class_exists(\Timber\Timber::class) || $postId < 1 || $sourceId < 1) {
            return;
        }
        $source = get_post($sourceId);
        if (!$source) {
            return;
        }
        $this->previewPostId = $postId;
        $this->source = sanitize_post($source);
        $this->fields = $saved ? [] : LivePreview::livePostFields($sourceId);
        $terms = $saved ? [] : get_post_meta($sourceId, LivePreview::TERMS_META, true);
        $this->terms = is_array($terms) ? $terms : [];
        if ($this->terms) {
            add_filter('timber/post/class', [$this, 'postClass'], PHP_INT_MAX, 2);
        }
        // Timber can reload the parent by ID instead of using WordPress's filtered preview object.
        add_filter('timber/post/import_data', [$this, 'readPost'], PHP_INT_MAX, 2);
        add_action('shutdown', [$this, 'unbindPreview'], PHP_INT_MAX);
    }

    /** Idempotent cleanup for rebinding and the end of the frontend request. */
    public function unbindPreview(): void
    {
        remove_filter('timber/post/import_data', [$this, 'readPost'], PHP_INT_MAX);
        remove_filter('timber/post/class', [$this, 'postClass'], PHP_INT_MAX);
        remove_action('shutdown', [$this, 'unbindPreview'], PHP_INT_MAX);
        $this->previewPostId = 0;
        $this->source = null;
        $this->fields = [];
        $this->terms = [];
    }

    /** Use Timber's public class hook without replacing theme-specific Post subclasses. */
    public function postClass(string $class, WP_Post $post): string
    {
        if ($post->ID !== $this->previewPostId || !$this->terms || $class !== \Timber\Post::class) {
            return $class;
        }
        require_once __DIR__ . '/TimberPost.php';
        return TimberPost::class;
    }

    /** Delegate the real terms() method; adapt only its own WP_Term_Query while it runs. */
    public function readTerms(object $post, callable $native)
    {
        if (!$this->terms || (int) $post->ID !== $this->previewPostId) {
            return $native();
        }
        // Timber can issue one direct query per taxonomy when grouping. Queries triggered by
        // WordPress hooks inside those reads (including our own fallback reads) stay native.
        $queryDepth = count($GLOBALS['wp_current_filter']) + 1;
        $emptyQueries = new \WeakMap();
        $adapt = function (WP_Term_Query $query) use ($queryDepth, $emptyQueries): void {
            if (
                count($GLOBALS['wp_current_filter']) !== $queryDepth
                || wp_parse_id_list($query->query_vars['object_ids'] ?? []) !== [$this->previewPostId]
            ) {
                return;
            }
            $args = &$query->query_vars;
            // These modes depend on real relationship rows, not just a selection of terms.
            if (
                $args['fields'] === 'all_with_object_id' || $args['orderby'] === 'term_order' || $args['exclude_tree']
            ) {
                return;
            }
            $ids = [];
            foreach ((array) $args['taxonomy'] as $taxonomy) {
                $selected = $this->terms[$taxonomy] ?? wp_get_object_terms(
                    $this->previewPostId,
                    $taxonomy,
                    ['fields' => 'ids']
                );
                if (!is_array($selected)) {
                    return;
                }
                $ids = array_merge($ids, $selected);
            }
            $include = wp_parse_id_list($args['include']);
            $ids = $include ? array_intersect($include, $ids)
                : array_diff($ids, wp_parse_id_list($args['exclude']));
            $args['object_ids'] = [];
            $args['include'] = array_values(array_unique($ids));
            if (!$ids) {
                $emptyQueries[$query] = true;
            }
            // Native object_ids queries include assigned terms even when their count is zero.
            $args['hide_empty'] = false;
        };
        // Empty include lists (and even [0] on older core) otherwise query every term.
        $empty = static function ($terms, WP_Term_Query $query) use ($emptyQueries) {
            return isset($emptyQueries[$query]) ? ($query->query_vars['fields'] === 'count' ? '0' : []) : $terms;
        };
        add_action('pre_get_terms', $adapt, PHP_INT_MIN);
        add_filter('terms_pre_query', $empty, PHP_INT_MIN, 2);
        try {
            return $native();
        } finally {
            remove_action('pre_get_terms', $adapt, PHP_INT_MIN);
            remove_filter('terms_pre_query', $empty, PHP_INT_MIN);
        }
    }

    public function readPost(array $data, object $post): array
    {
        if ($this->source && (int) $post->ID === $this->previewPostId) {
            foreach (['post_title', 'post_content', 'post_excerpt'] as $field) {
                $data[$field] = $this->source->$field;
            }
            foreach ($this->fields as $field => $value) {
                $data[$field] = $value;
            }
            if ($post instanceof TimberPost) {
                $post->setPreviewTerms($this->readTerms(...));
            }
        }
        return $data;
    }
}
