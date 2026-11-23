<?php

namespace AFloatingLivePreviewPanel\Compatibility;

use AFloatingLivePreviewPanel\LivePreview;
use WP_Block;
use WP_Block_Type;
use WP_Block_Type_Registry;
use WP_Post;
use WP_Term;

/** Supply selected fields to native ID-based renderers without changing real block or content identity. */
final class CoreBlocks
{
    private const AUTHOR_BLOCKS = [
        'core/post-author' => 'render_block_core_post_author',
        'core/post-author-name' => 'render_block_core_post_author_name',
        'core/post-author-biography' => 'render_block_core_post_author_biography',
        'core/avatar' => 'render_block_core_avatar',
    ];

    private const TERM_BLOCKS = [
        'core/term-name' => 'render_block_core_term_name',
        'core/term-description' => 'render_block_core_term_description',
    ];

    private array $termBlocks = [];
    private ?WP_Term $term = null;
    private ?WP_Term $savedTerm = null;
    private ?WP_Block_Type $excerptBlock = null;
    private ?WP_Block_Type $dateBlock = null;
    private array $authorBlocks = [];
    private ?WP_Post $post = null;
    private ?WP_Post $displayPost = null;

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
        $this->unbindTermPreview();
        $this->term = clone $term;
        $this->savedTerm = clone $saved;
        $registry = WP_Block_Type_Registry::get_instance();
        foreach (self::TERM_BLOCKS as $name => $callback) {
            $type = $registry->get_registered($name);
            if ($type && $type->render_callback === $callback && function_exists($callback)) {
                $this->termBlocks[$name] = $type;
                $type->render_callback = [$this, 'renderTerm'];
            }
        }
        if ($this->termBlocks) {
            add_action('shutdown', [$this, 'unbindTermPreview'], PHP_INT_MAX);
        }
    }

    public function renderTerm(array $attributes, string $content, WP_Block $block): string
    {
        $render = self::TERM_BLOCKS[$block->name];
        $linked = $block->name === 'core/term-name' && !empty($attributes['isLink']);
        $term = $this->term;
        if (!$term) {
            return $render($attributes, $content, $block);
        }
        if (isset($block->context['termId'], $block->context['taxonomy'])) {
            if (
                $block->context['taxonomy'] !== $term->taxonomy
                || !in_array($block->context['termId'], [$term->term_id, (string) $term->term_id], true)
            ) {
                return $render($attributes, $content, $block);
            }
        } elseif (!$linked) {
            return $render($attributes, $content, $block);
        } else {
            $queried = get_queried_object();
            if (!$queried instanceof WP_Term || $queried->term_taxonomy_id !== $term->term_taxonomy_id) {
                return $render($attributes, $content, $block);
            }
            $term = $queried;
        }

        // Supply a private object to core's get_term() lookup without changing the real context or queried object.
        $block = clone $block;
        $display = clone $term;
        $block->context['termId'] = $display;
        $block->context['taxonomy'] = $display->taxonomy;
        if (!$linked) {
            return $render($attributes, $content, $block);
        }

        // The native renderer reads the label before asking for the link. Permit the permalink filters
        // to see saved fields on just that private object, without generating a second link.
        $saved = $this->savedTerm;
        $restore = static function ($structure, WP_Term $candidate) use ($display, $saved) {
            if ($candidate === $display) {
                $candidate->name = $saved->name;
                $candidate->description = $saved->description;
                if (isset($candidate->cat_name)) {
                    $candidate->cat_name = $saved->name;
                    $candidate->category_description = $saved->description;
                }
            }
            return $structure;
        };
        add_filter('pre_term_link', $restore, PHP_INT_MIN, 2);
        try {
            return $render($attributes, $content, $block);
        } finally {
            remove_filter('pre_term_link', $restore, PHP_INT_MIN);
        }
    }

    public function unbindTermPreview(): void
    {
        foreach ($this->termBlocks as $name => $type) {
            if ($type->render_callback === [$this, 'renderTerm']) {
                $type->render_callback = self::TERM_BLOCKS[$name];
            }
        }
        remove_action('shutdown', [$this, 'unbindTermPreview'], PHP_INT_MAX);
        $this->termBlocks = [];
        $this->term = null;
        $this->savedTerm = null;
    }

    /** Source selection and authorization belong to FrontendPreview, not block rendering. */
    public function bindPreview(int $postId, int $sourceId, bool $saved = false): void
    {
        $this->unbindPreview();
        if ($postId < 1 || $sourceId < 1) {
            return;
        }
        $post = get_post($postId);
        $source = get_post($sourceId);
        if (!$post || !$source) {
            return;
        }
        // Keep the parent clone's filter state raw; get_post() would reload it after display normalization.
        $source = sanitize_post(clone $source);
        $this->post = clone $post;
        foreach (['post_title', 'post_content', 'post_excerpt'] as $field) {
            $this->post->$field = $source->$field;
        }
        $registry = WP_Block_Type_Registry::get_instance();
        $type = $registry->get_registered('core/post-excerpt');
        if (
            $type && $type->render_callback === 'render_block_core_post_excerpt'
            && function_exists('render_block_core_post_excerpt')
        ) {
            $this->excerptBlock = $type;
            $type->render_callback = [$this, 'renderExcerpt'];
        }
        $fields = $saved ? [] : LivePreview::livePostFields($sourceId);
        // Excerpt reads need only text overrides; their native links must retain saved dates and author.
        $this->displayPost = clone $this->post;
        foreach ($fields as $field => $value) {
            $this->displayPost->$field = $value;
        }
        if (array_key_exists('post_author', $fields)) {
            foreach (self::AUTHOR_BLOCKS as $name => $callback) {
                $type = $registry->get_registered($name);
                if ($type && $type->render_callback === $callback && function_exists($callback)) {
                    $this->authorBlocks[$name] = $type;
                    $type->render_callback = [$this, 'renderAuthor'];
                }
            }
        }
        if (isset($fields['post_date'])) {
            // Modern Post Date blocks use the public post-data binding. Older versions
            // delegate directly to object-aware date/permalink functions instead.
            add_filter('block_bindings_source_value', [$this, 'readDateBinding'], 10, 4);
            $type = $registry->get_registered('core/post-date');
            if (
                !get_block_bindings_source('core/post-data') && $type
                && $type->render_callback === 'render_block_core_post_date'
                && function_exists('render_block_core_post_date')
            ) {
                $this->dateBlock = $type;
                $type->render_callback = [$this, 'renderDate'];
            }
        }
        add_action('shutdown', [$this, 'unbindPreview'], PHP_INT_MAX);
    }

    public function readDateBinding($value, string $name, array $args, WP_Block $block)
    {
        if (
            $value === null || $name !== 'core/post-data' || !$this->post
            || ($block->context['postId'] ?? null) !== $this->post->ID
        ) {
            return $value;
        }
        $field = $args['field'] ?? $args['key'] ?? '';
        if ($field === 'date') {
            return esc_attr(get_the_date('c', clone $this->displayPost));
        }
        if ($field === 'modified') {
            return get_the_modified_date('U', $this->displayPost) > get_the_date('U', $this->displayPost)
                ? esc_attr(get_the_modified_date('c', clone $this->displayPost)) : '';
        }
        return $value;
    }

    public function renderDate(array $attributes, string $content, WP_Block $block): string
    {
        if (!$this->displayPost || ($block->context['postId'] ?? null) !== $this->displayPost->ID) {
            return render_block_core_post_date($attributes, $content, $block);
        }
        $block = clone $block;
        $post = clone $this->displayPost;
        $block->context['postId'] = $post;
        if (empty($attributes['isLink'])) {
            return render_block_core_post_date($attributes, $content, $block);
        }
        // Older core uses the same object for date formatting and permalinks. Only that private copy gets this URL.
        $permalink = get_permalink($this->post);
        $link = static fn ($url, WP_Post $candidate) => $candidate === $post ? $permalink : $url;
        foreach (['post_link', 'post_type_link'] as $hook) {
            add_filter($hook, $link, PHP_INT_MAX, 2);
        }
        try {
            return render_block_core_post_date($attributes, $content, $block);
        } finally {
            foreach (['post_link', 'post_type_link'] as $hook) {
                remove_filter($hook, $link, PHP_INT_MAX);
            }
        }
    }

    public function renderExcerpt(array $attributes, string $content, WP_Block $block): string
    {
        if ($this->post && ($block->context['postId'] ?? null) === $this->post->ID) {
            // Only core's private call copy sees an object: get_the_excerpt() and
            // get_the_permalink() accept WP_Post and retain its original parent identity.
            // The real block's integer context, globals and cached post objects stay untouched.
            $block = clone $block;
            $block->context['postId'] = clone $this->post;
        }
        return render_block_core_post_excerpt($attributes, $content, $block);
    }

    public function renderAuthor(array $attributes, string $content, WP_Block $block): string
    {
        if ($this->post && ($block->context['postId'] ?? null) === $this->post->ID) {
            // These native callbacks use object-aware get_post_field(). Explicit avatar
            // users, comment authors and author-archive contexts remain core-owned.
            $block = clone $block;
            $block->context['postId'] = clone $this->displayPost;
        }
        return (self::AUTHOR_BLOCKS[$block->name])($attributes, $content, $block);
    }

    /** Do not overwrite a later theme/plugin renderer when releasing our own binding. */
    public function unbindPreview(): void
    {
        if ($this->excerptBlock && $this->excerptBlock->render_callback === [$this, 'renderExcerpt']) {
            $this->excerptBlock->render_callback = 'render_block_core_post_excerpt';
        }
        if ($this->dateBlock && $this->dateBlock->render_callback === [$this, 'renderDate']) {
            $this->dateBlock->render_callback = 'render_block_core_post_date';
        }
        remove_filter('block_bindings_source_value', [$this, 'readDateBinding'], 10);
        foreach ($this->authorBlocks as $name => $type) {
            if ($type->render_callback === [$this, 'renderAuthor']) {
                $type->render_callback = self::AUTHOR_BLOCKS[$name];
            }
        }
        remove_action('shutdown', [$this, 'unbindPreview'], PHP_INT_MAX);
        $this->authorBlocks = [];
        $this->excerptBlock = null;
        $this->dateBlock = null;
        $this->post = null;
        $this->displayPost = null;
    }
}
