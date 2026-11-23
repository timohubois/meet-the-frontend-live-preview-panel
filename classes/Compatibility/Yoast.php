<?php

namespace AFloatingLivePreviewPanel\Compatibility;

use AFloatingLivePreviewPanel\LivePreview;
use WP_Error;
use WP_Post;
use WP_Term;

/** Match Yoast's native primary-term, breadcrumb and term description behavior in previews. */
final class Yoast
{
    private const META_PREFIX = '_yoast_wpseo_primary_';
    private array $pending = [];
    private int $pendingPostId = 0;
    private int $previewPostId = 0;
    private ?WP_Post $source = null;
    private bool $saved = false;
    private bool $cold = false;
    private array $keys = [];
    private array $trailIds = [];
    private ?WP_Term $term = null;
    private string $savedTermName = '';
    private int|string|null $termBreadcrumbKey = null;

    public function __construct()
    {
        add_filter('aflpp_block_editor_preview_config', [$this, 'configureEditor'], 10, 2);
        add_filter('aflpp_term_preview_pre_sanitize_description', [$this, 'sanitizeTermDescription'], 10, 3);
        add_filter('aflpp_live_preview_form_values', [$this, 'preparePayload'], 10, 2);
        add_action('aflpp_live_preview_custom_fields_initialized', fn (array $context) =>
            $this->savePrimaryTerms($context['source']['id'], $context['post']['id']));
        add_filter('aflpp_live_preview_preparation_error', [$this, 'verifySave'], 10, 2);
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
            $context['term']
        ));
    }

    public function configureEditor(array $config, array $context): array
    {
        if ($this->isAvailable()) {
            $config['yoastPrimaryTaxonomies'] = $this->primaryTaxonomies($context['post']['id']);
        }
        return $config;
    }

    public function isAvailable(): bool
    {
        return function_exists('YoastSEO') && class_exists('WPSEO_Primary_Term')
            && class_exists('WPSEO_Options') && class_exists('WPSEO_Taxonomy_Meta');
    }

    public function sanitizeTermDescription(?string $sanitized, string $description, WP_Term $term): ?string
    {
        if (
            $sanitized !== null || !function_exists('YoastSEO')
            || !method_exists('WPSEO_Taxonomy', 'custom_category_descriptions_allow_html')
        ) {
            return $sanitized;
        }

        // Yoast swaps these save filters on the taxonomy admin screen, not in REST.
        // Copy the hook so other callbacks still run and their original order is restored.
        global $wp_filter;
        $hook = 'pre_term_description';
        $original = $wp_filter[$hook] ?? null;
        if ($original !== null) {
            $wp_filter[$hook] = clone $original;
        }
        remove_filter($hook, 'wp_filter_kses');
        add_filter($hook, 'wp_filter_post_kses');
        try {
            return sanitize_term_field('description', $description, $term->term_id, $term->taxonomy, 'db');
        } finally {
            if ($original === null) {
                unset($wp_filter[$hook]);
            } else {
                $wp_filter[$hook] = $original;
            }
        }
    }

    private function bindTermPreview(WP_Term $term): void
    {
        $this->unbindTermPreview();
        if (!$this->isAvailable() || \WPSEO_Taxonomy_Meta::get_term_meta($term, $term->taxonomy, 'bctitle')) {
            return;
        }
        $saved = get_term($term->term_id, $term->taxonomy);
        if (!$saved instanceof WP_Term || $saved->name === $term->name) {
            return;
        }
        $this->term = clone $term;
        $this->savedTermName = $saved->name;
        add_filter('wpseo_breadcrumb_indexables', [$this, 'locateTermBreadcrumb'], PHP_INT_MAX, 2);
        add_filter('wpseo_breadcrumb_links', [$this, 'readTermBreadcrumb'], PHP_INT_MIN);
        add_action('shutdown', [$this, 'unbindTermPreview'], PHP_INT_MAX);
    }

    public function locateTermBreadcrumb($indexables, object $context)
    {
        $this->termBreadcrumbKey = null;
        $current = $context->indexable ?? null;
        if (
            $this->term && is_array($indexables) && $current instanceof \Yoast\WP\SEO\Models\Indexable
            && $current->object_type === 'term' && (int) $current->object_id === $this->term->term_id
            && $current->object_sub_type === $this->term->taxonomy
        ) {
            $key = array_search($current, $indexables, true);
            $this->termBreadcrumbKey = $key === false ? null : $key;
        }
        return $indexables;
    }

    public function readTermBreadcrumb($crumbs)
    {
        $key = $this->termBreadcrumbKey;
        $this->termBreadcrumbKey = null;
        // Indexables may share mutable ORM state even when cloned. Only edit the rendered link data.
        if (
            $this->term && $key !== null && is_array($crumbs) && isset($crumbs[$key]['term_id'])
            && (int) $crumbs[$key]['term_id'] === $this->term->term_id
            && ($crumbs[$key]['taxonomy'] ?? null) === $this->term->taxonomy
            && ($crumbs[$key]['text'] ?? null) === $this->savedTermName
        ) {
            $crumbs[$key]['text'] = esc_html($this->term->name);
        }
        return $crumbs;
    }

    public function unbindTermPreview(): void
    {
        remove_filter('wpseo_breadcrumb_indexables', [$this, 'locateTermBreadcrumb'], PHP_INT_MAX);
        remove_filter('wpseo_breadcrumb_links', [$this, 'readTermBreadcrumb'], PHP_INT_MIN);
        remove_action('shutdown', [$this, 'unbindTermPreview'], PHP_INT_MAX);
        $this->term = null;
        $this->savedTermName = '';
        $this->termBreadcrumbKey = null;
    }

    /** Only expose native primary controls whose taxonomy can also be captured from Gutenberg. */
    public function primaryTaxonomies(int $postId): array
    {
        if (!$this->isAvailable()) {
            return [];
        }
        $taxonomies = \YoastSEO()->helpers->primary_term->get_primary_term_taxonomies($postId);
        $result = [];
        foreach ($taxonomies as $taxonomy) {
            if (
                is_object($taxonomy) && isset($taxonomy->name)
                && is_object_in_taxonomy(get_post_type($postId), $taxonomy->name)
                && $taxonomy->show_in_rest && current_user_can($taxonomy->cap->assign_terms)
            ) {
                $result[] = $taxonomy->name;
            }
        }
        return $result;
    }

    public function preparePayload(array|WP_Error $payload, array $context): array|WP_Error
    {
        $input = $context['input'];
        $postId = $context['post']['id'];
        $this->pending = [];
        $this->pendingPostId = 0;
        if (is_wp_error($payload) || !array_key_exists('yoast_primary_terms', $input)) {
            return $payload;
        }
        if (!$this->isAvailable() || !is_string($input['yoast_primary_terms'])) {
            return $this->invalidInput();
        }
        $primary = json_decode($input['yoast_primary_terms']);
        if (!is_object($primary)) {
            return $this->invalidInput();
        }
        $allowed = $this->primaryTaxonomies($postId);
        // Core has already validated this map before invoking preparation hooks.
        $terms = isset($input['terms']) ? json_decode($input['terms'], true) : [];
        foreach (get_object_vars($primary) as $taxonomy => $id) {
            if (!in_array($taxonomy, $allowed, true)) {
                return new WP_Error(
                    'aflpp_yoast_primary_forbidden',
                    __(
                        'You cannot change this primary taxonomy in the preview.',
                        'meet-the-frontend-live-preview-panel'
                    ),
                    ['status' => 403]
                );
            }
            if (!is_int($id) || $id < 0) {
                return $this->invalidInput();
            }
            if ($id) {
                $term = get_term($id, $taxonomy);
                $assigned = $terms[$taxonomy] ?? wp_get_object_terms($postId, $taxonomy, ['fields' => 'ids']);
                if (
                    !$term instanceof WP_Term || !is_array($assigned)
                    || !in_array($id, wp_parse_id_list($assigned), true)
                ) {
                    return $this->invalidInput();
                }
                if (!current_user_can('assign_term', $id)) {
                    return new WP_Error(
                        'aflpp_yoast_primary_forbidden',
                        __('You cannot assign this primary term.', 'meet-the-frontend-live-preview-panel'),
                        ['status' => 403]
                    );
                }
            }
            $this->pending[$taxonomy] = $id;
        }
        $this->pendingPostId = $postId;
        return $payload;
    }

    private function invalidInput(): WP_Error
    {
        return new WP_Error(
            'aflpp_invalid_yoast_primary_terms',
            __('Choose a valid assigned primary term for the preview.', 'meet-the-frontend-live-preview-panel'),
            ['status' => 400]
        );
    }

    /** Core guarantees this is the owned revision; never use parent-redirecting post-meta writers. */
    public function savePrimaryTerms(int $revisionId, int $postId): void
    {
        if ($postId !== $this->pendingPostId) {
            return;
        }
        foreach ($this->pending as $taxonomy => $id) {
            update_metadata('post', $revisionId, self::META_PREFIX . $taxonomy, $id);
        }
    }

    public function verifySave(?WP_Error $error, array $context): ?WP_Error
    {
        $revisionId = $context['source']['id'] ?? 0;
        try {
            if ($error) {
                return $error;
            }
            foreach ($this->pending as $taxonomy => $id) {
                $key = self::META_PREFIX . $taxonomy;
                if (
                    !$revisionId || !metadata_exists('post', $revisionId, $key)
                    || (int) get_post_meta($revisionId, $key, true) !== $id
                ) {
                    return new WP_Error(
                        'aflpp_yoast_primary_not_saved',
                        __('We couldn’t prepare the primary-term preview.', 'meet-the-frontend-live-preview-panel'),
                        ['status' => 409]
                    );
                }
            }
            return null;
        } finally {
            $this->pending = [];
            $this->pendingPostId = 0;
        }
    }

    public function bindPreview(int $postId, int $sourceId, bool $saved = false): void
    {
        $this->unbindPreview();
        if (!$this->isAvailable() || $postId < 1 || $sourceId < 1 || !($source = get_post($sourceId))) {
            return;
        }
        $this->previewPostId = $postId;
        $this->source = sanitize_post($source);
        $this->saved = $saved;
        $this->keys = array_map(
            static fn (string $name): string => self::META_PREFIX . $name,
            $this->primaryTaxonomies($postId)
        );
        if (!$saved) {
            add_filter('get_post_metadata', [$this, 'readPrimaryMeta'], 10, 4);
        }
        // Record the native ancestry before link filters can insert unrelated term crumbs.
        add_filter('wpseo_breadcrumb_indexables', [$this, 'readBreadcrumbIndexables'], PHP_INT_MIN, 2);
        add_filter('wpseo_breadcrumb_links', [$this, 'readBreadcrumbs']);
        add_filter('wpseo_should_save_indexable', [$this, 'allowIndexableSave'], PHP_INT_MAX, 2);
        add_action('shutdown', [$this, 'unbindPreview'], PHP_INT_MAX);
    }

    public function unbindPreview(): void
    {
        remove_filter('get_post_metadata', [$this, 'readPrimaryMeta'], 10);
        remove_filter('wpseo_breadcrumb_indexables', [$this, 'readBreadcrumbIndexables'], PHP_INT_MIN);
        remove_filter('wpseo_breadcrumb_links', [$this, 'readBreadcrumbs']);
        remove_filter('wpseo_should_save_indexable', [$this, 'allowIndexableSave'], PHP_INT_MAX);
        remove_action('shutdown', [$this, 'unbindPreview'], PHP_INT_MAX);
        $this->previewPostId = 0;
        $this->source = null;
        $this->keys = [];
        $this->trailIds = [];
        $this->saved = false;
        $this->cold = false;
    }

    /** Lazy builds must not save this post's preview-derived permalink, fields or hierarchy. */
    public function allowIndexableSave(bool $save, object $indexable): bool
    {
        if (!$this->source) {
            return $save;
        }
        if (
            $indexable instanceof \Yoast\WP\SEO\Models\Indexable
            && $indexable->object_type === 'post' && (int) $indexable->object_id === $this->previewPostId
        ) {
            $this->cold = $this->cold || ($save && !$indexable->id);
            return false;
        }
        if (
            $indexable instanceof \Yoast\WP\SEO\Models\Primary_Term
            && (int) $indexable->post_id === $this->previewPostId
        ) {
            return false;
        }
        return $save;
    }

    public function readPrimaryMeta($value, int $postId, string $key, bool $single)
    {
        if (
            $value !== null || $postId !== $this->previewPostId || !$this->source
            || $postId === $this->source->ID || !in_array($key, $this->keys, true)
        ) {
            return $value;
        }
        $values = get_post_meta($this->source->ID, $key, false);
        return $single && !$values ? '' : $values;
    }

    /** Observe the native saved trail without modifying or rebuilding its indexables. */
    public function readBreadcrumbIndexables($indexables, object $context)
    {
        if (
            !$this->source || $context->indexable->object_type !== 'post'
            || (int) $context->indexable->object_id !== $this->previewPostId
        ) {
            return $indexables;
        }
        $this->trailIds = [];
        foreach (is_array($indexables) ? $indexables : [] as $indexable) {
            if ($indexable instanceof \Yoast\WP\SEO\Models\Indexable && $indexable->object_type === 'term') {
                $this->trailIds[] = (int) $indexable->object_id;
            }
        }
        return $indexables;
    }

    /** Keep Yoast's renderer and later link filters; only replace this post's main taxonomy trail. */
    public function readBreadcrumbs($crumbs)
    {
        if (!$this->source || !is_array($crumbs)) {
            return $crumbs;
        }
        $current = null;
        foreach ($crumbs as $index => $crumb) {
            if (isset($crumb['id'])) {
                $current = $index;
            }
        }
        if ($current === null || (int) $crumbs[$current]['id'] !== $this->previewPostId) {
            return $crumbs;
        }
        $post = get_post($this->previewPostId);
        // Preserve explicit Yoast titles and titles already customized by an earlier breadcrumb filter.
        if (
            !get_post_meta($post->ID, '_yoast_wpseo_bctitle', true)
            && $crumbs[$current]['text'] === wp_strip_all_tags(get_the_title($post), true)
        ) {
            $post = clone $post;
            $post->post_title = $this->source->post_title;
            $crumbs[$current]['text'] = esc_html(wp_strip_all_tags(get_the_title($post), true));
        }
        $taxonomy = \WPSEO_Options::get('post_types-' . $post->post_type . '-maintax');
        if ($this->saved && !$this->cold) {
            return $crumbs;
        }
        if ($post->post_parent) {
            if (!$this->cold) {
                return $crumbs;
            }
            $trail = $this->parentTrail($post, $crumbs);
            $taxonomy = null;
        } else {
            if (
                !is_string($taxonomy) || !is_object_in_taxonomy($post->post_type, $taxonomy)
                || (!$this->cold && !$this->taxonomyChanged($taxonomy))
            ) {
                return $crumbs;
            }
            $trail = $this->termTrail($this->breadcrumbTerm($taxonomy));
            if (is_wp_error($trail)) {
                return $crumbs;
            }
        }
        $result = [];
        foreach ($crumbs as $index => $crumb) {
            if (
                $taxonomy !== null && ($crumb['taxonomy'] ?? null) === $taxonomy
                && in_array((int) ($crumb['term_id'] ?? 0), $this->trailIds, true)
            ) {
                continue;
            }
            if ($index === $current) {
                array_push($result, ...$trail);
            }
            $result[] = $crumb;
        }
        return $result;
    }

    /** Reuse the native parent's trail when a guarded new child indexable has no persisted hierarchy yet. */
    private function parentTrail(WP_Post $post, array $crumbs): array
    {
        $parent = \YoastSEO()->meta->for_post($post->post_parent);
        // With indexing disabled, Yoast can alias null-ID contexts. Never recurse into this post's context.
        if (!$parent || (int) $parent->context->indexable->object_id !== (int) $post->post_parent) {
            return [];
        }
        $parents = get_post_ancestors($post);
        $existing = array_column($crumbs, 'id');
        return array_values(array_filter($parent->breadcrumbs, static fn (array $crumb): bool =>
            isset($crumb['taxonomy'])
            || (isset($crumb['id']) && in_array((int) $crumb['id'], $parents, true)
                && !in_array($crumb['id'], $existing, true))));
    }

    private function termTrail(?WP_Term $term): array|WP_Error
    {
        $trail = [];
        $taxonomy = $term?->taxonomy;
        $ids = $term ? array_merge(
            array_reverse(get_ancestors($term->term_id, $taxonomy, 'taxonomy')),
            [$term->term_id]
        ) : [];
        foreach ($ids as $id) {
            $ancestor = get_term($id, $taxonomy);
            if (!$ancestor instanceof WP_Term) {
                return new WP_Error('aflpp_yoast_missing_ancestor');
            }
            $url = get_term_link($ancestor);
            if (is_wp_error($url)) {
                return $url;
            }
            $title = \WPSEO_Taxonomy_Meta::get_term_meta($ancestor, $taxonomy, 'bctitle');
            // Yoast's text field accepts HTML and its presenter does not escape it again.
            $trail[] = ['term_id' => $id, 'taxonomy' => $taxonomy, 'url' => $url,
                'text' => wp_kses_post($title ?: $ancestor->name)];
        }
        return $trail;
    }

    /** Leave unchanged baselines and Yoast's existing indexable state alone, including development mode. */
    private function taxonomyChanged(string $taxonomy): bool
    {
        $key = self::META_PREFIX . $taxonomy;
        // Bulk metadata stays native; single-key reads of the parent may already be overlaid.
        $savedMeta = get_post_meta($this->previewPostId);
        if ((int) get_post_meta($this->source->ID, $key, true) !== (int) ($savedMeta[$key][0] ?? 0)) {
            return true;
        }
        $selection = get_post_meta($this->source->ID, LivePreview::TERMS_META, true);
        if (!is_array($selection) || !isset($selection[$taxonomy]) || !is_array($selection[$taxonomy])) {
            return false;
        }
        $saved = wp_get_object_terms($this->previewPostId, $taxonomy, ['fields' => 'ids']);
        if (is_wp_error($saved)) {
            return false;
        }
        $selected = $selection[$taxonomy];
        sort($selected);
        sort($saved);
        return $selected !== $saved;
    }

    /** Yoast's read-only fallback: deepest assigned term, then lowest root term_order, then native list order. */
    private function breadcrumbTerm(string $taxonomy): ?WP_Term
    {
        $primary = new \WPSEO_Primary_Term($taxonomy, $this->previewPostId);
        $id = $primary->get_primary_term();
        if ($id) {
            $term = get_term($id, $taxonomy);
            return $term instanceof WP_Term ? $term : null;
        }
        $terms = get_the_terms($this->previewPostId, $taxonomy);
        $best = null;
        $depth = -1;
        $order = 9999;
        foreach (is_array($terms) ? $terms : [] as $term) {
            $parents = get_ancestors($term->term_id, $taxonomy, 'taxonomy');
            $root = $parents ? get_term(end($parents), $taxonomy) : null;
            $rootOrder = $root instanceof WP_Term && isset($root->term_order) ? (int) $root->term_order : 9999;
            if (count($parents) > $depth || (count($parents) === $depth && $rootOrder < $order)) {
                $best = $term;
                $depth = count($parents);
                $order = $rootOrder;
            }
        }
        return $best;
    }
}
