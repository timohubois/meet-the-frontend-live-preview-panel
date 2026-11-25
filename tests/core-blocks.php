<?php

/** Run with `wp eval-file tests/core-blocks.php` on a disposable single-site installation. */

use MeetTheFrontendLivePreviewPanel\Compatibility\CoreBlocks;
use MeetTheFrontendLivePreviewPanel\FrontendPreview;
use MeetTheFrontendLivePreviewPanel\LivePreview;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(CoreBlocks::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a single-site installation with this plugin active.');
}
require_once ABSPATH . 'wp-admin/includes/user.php';
$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$originalUser = get_current_user_id();
// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Preserve the CLI request, not editor input.
$originalGet = $_GET;
$originalPost = $GLOBALS['post'] ?? null;
$originalQuery = $GLOBALS['wp_query'];
$originalHooks = [];
$previewHooks = [
    'mtflpp_frontend_live_preview_source_selected', 'mtflpp_frontend_saved_preview_source_selected',
    'the_preview', 'get_post_metadata', 'shutdown',
];
foreach ($previewHooks as $hook) {
    $originalHooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
}
remove_all_actions('mtflpp_frontend_live_preview_source_selected');
remove_all_actions('mtflpp_frontend_saved_preview_source_selected');
$type = WP_Block_Type_Registry::get_instance()->get_registered('core/post-excerpt');
$check(
    $type && $type->render_callback === 'render_block_core_post_excerpt',
    'The native excerpt renderer is required.'
);
$originalRenderer = $type->render_callback;
$core = new CoreBlocks();
$live = new LivePreview();
$frontend = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $live);
$posts = [];
$user = 0;
$block = static fn (int $id, array $attributes = []): WP_Block => new WP_Block([
    'blockName' => 'core/post-excerpt', 'attrs' => $attributes, 'innerBlocks' => [],
    'innerHTML' => '', 'innerContent' => [],
], ['postId' => $id, 'postType' => 'post']);
$excerpt = static function (string $html): string {
    $document = new DOMDocument();
    $document->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
    $nodes = (new DOMXPath($document))->query('//*[contains(@class,"wp-block-post-excerpt__excerpt")]');
    return trim($nodes->item(0)?->textContent ?? '');
};
$dieHandler = static fn () => static function ($message, $title, $args): void {
    throw new RuntimeException('mtflpp_denied_' . (int) ($args['response'] ?? 0));
};
add_filter('wp_die_handler', $dieHandler, PHP_INT_MAX);
try {
    $user = wp_insert_user([
        'user_login' => 'mtflpp_core_blocks_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(32), 'role' => 'administrator',
    ]);
    $check(!is_wp_error($user), 'Could not create a fixture user.');
    wp_set_current_user($user);
    foreach (['Selected', 'Other', 'Another', 'Control'] as $name) {
        $id = wp_insert_post([
            'post_type' => 'post', 'post_status' => 'publish', 'post_author' => $user,
            'post_title' => 'MTFLPP core excerpt ' . $name,
            'post_content' => '<!-- wp:paragraph --><p>Saved content ' . $name . '</p><!-- /wp:paragraph -->',
            'post_excerpt' => 'Saved excerpt ' . $name,
        ], true);
        $check(!is_wp_error($id) && $id > 0, 'Could not create a fixture post.');
        $posts[] = $id;
    }
    [$postId, $otherId, $anotherId, $controlId] = $posts;
    $autosaveId = _wp_put_post_revision($postId, true);
    $check(is_int($autosaveId) && wp_is_post_autosave($autosaveId) === $postId, 'Recovery fixture failed.');
    $parent = get_post($postId);
    $GLOBALS['wp_query'] = new WP_Query(['p' => $postId]);
    $GLOBALS['wp_query']->post = $parent;
    $GLOBALS['post'] = $parent;
    $parentBefore = clone $parent;
    $cachedBefore = clone wp_cache_get($postId, 'posts');
    $savedBefore = $live->snapshotFingerprint($postId);
    $recoveryBefore = $live->snapshotFingerprint($autosaveId);
    $ordinary = $block($postId)->render();
    $other = $block($otherId)->render();
    $check($excerpt($ordinary) === 'Saved excerpt Selected', 'Ordinary requests must retain saved excerpts.');
    $check($type->render_callback === $originalRenderer, 'Ordinary requests must not replace the renderer.');

    $queryVars = static fn (array $vars): array => array_replace($vars, [
        'post__in' => [$otherId, $anotherId], 'orderby' => 'post__in', 'post_status' => 'publish',
    ]);
    add_filter('query_loop_block_query_vars', $queryVars);
    $loop = '<!-- wp:query {"queryId":912,"query":{"perPage":2,"postType":"post","inherit":false}} -->'
        . '<div class="wp-block-query"><!-- wp:post-template -->'
        . '<!-- wp:post-excerpt /--><!-- /wp:post-template --></div><!-- /wp:query -->';
    $otherLoop = do_blocks($loop);
    $check(
        str_contains($otherLoop, 'Saved excerpt Other') && str_contains($otherLoop, 'Saved excerpt Another'),
        'The native Query Loop fixture must render its own post contexts.'
    );
    $bind = static function (string $text, string $content) use ($live, $frontend, $postId, $check): int {
        $route = '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview';
        $request = new WP_REST_Request('POST', $route);
        $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
        $request->set_body_params([
            'base' => $live->fingerprint($postId), 'post_title' => 'Preview title',
            'excerpt' => $text, 'content' => $content,
        ]);
        $response = rest_do_request($request);
        $check($response->get_status() === 200, 'Could not prepare the isolated preview source.');
        parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $query);
        $_GET = $query;
        $frontend->authorizePreview();
        return (int) $query['mtflpp_revision'];
    };
    $content = '<!-- wp:paragraph --><p>Preview <strong>generated</strong> alpha beta gamma delta.</p>'
        . '<!-- /wp:paragraph --><!-- wp:post-excerpt /-->';
    $sourceId = $bind('Unsaved <em>formatted</em> excerpt with several words.', $content);
    $selectedBlock = $block($postId, [
        'excerptLength' => 3, 'moreText' => 'Continue reading', 'showMoreOnNewLine' => false, 'textAlign' => 'center',
    ]);
    $html = $selectedBlock->render();
    $check(
        str_contains($html, '>' . wp_trim_words('Unsaved formatted excerpt with several words.', 3)),
        'The selected source must retain native formatting and the exact block excerpt length.'
    );
    $check(!str_contains($html, 'Saved excerpt'), 'An explicit preview excerpt must replace the saved value.');
    $check(
        str_contains($html, 'href="' . esc_url(get_permalink($postId)) . '"')
        && str_contains($html, 'Continue reading') && str_contains($html, 'has-text-align-center'),
        'Native length, read-more, alignment and original-post permalink handling must remain intact.'
    );
    $check($selectedBlock->context['postId'] === $postId, 'The real block context must remain an integer ID.');
    $check($block($otherId)->render() === $other, 'Another post context must keep its native excerpt.');
    $check(do_blocks($loop) === $otherLoop, 'Unrelated Query Loops must retain their native contexts and output.');

    $seen = [];
    $before = static function (string $text, WP_Post $post) use (&$seen): string {
        $seen[] = ['before', $text, $post->ID, $post->post_type, $post->post_title, $post->post_content];
        return $text;
    };
    $after = static function (string $text, WP_Post $post) use (&$seen): string {
        $seen[] = ['after', $text, $post->ID];
        return $text . ' FILTERED';
    };
    add_filter('get_the_excerpt', $before, 5, 2);
    add_filter('get_the_excerpt', $after, 10, 2);
    $excerptHooks = $GLOBALS['wp_filter']['get_the_excerpt']->callbacks;
    $sourceId = $bind('', $content);
    $html = $block($postId, ['excerptLength' => 100])->render();
    $check(
        str_contains($excerpt($html), 'Preview generated alpha beta gamma delta.')
        && str_contains($html, 'FILTERED') && !str_contains($html, 'Saved content'),
        'Clearing an excerpt must generate from preview content through native excerpt processing.'
    );
    $check(
        count($seen) === 2 && $seen[0] === ['before', '', $postId, 'post', 'Preview title', $content]
        && $seen[1][0] === 'after' && str_contains($seen[1][1], 'Preview generated'),
        'Existing filters must run once in their original order and receive the preview post with parent identity.'
    );
    $check(
        $GLOBALS['wp_filter']['get_the_excerpt']->callbacks === $excerptHooks,
        'The native excerpt filter chain must not be replaced, reordered or removed.'
    );
    remove_filter('get_the_excerpt', $before, 5);
    remove_filter('get_the_excerpt', $after, 10);
    // Compare against a real saved control post, letting each core version own its length/more behavior.
    $longContent = '<!-- wp:paragraph --><p>' . str_repeat('Preview word ', 120)
        . '[mtflpp_excerpt_fixture]</p><!-- /wp:paragraph -->';
    wp_update_post(['ID' => $controlId, 'post_excerpt' => '', 'post_content' => $longContent]);
    $sourceId = $bind('', $longContent);
    $contentCalls = 0;
    $shortcodeCalls = 0;
    $contentFilter = static function (string $text) use (&$contentCalls): string {
        ++$contentCalls;
        return $text . ' Content filter suffix';
    };
    $shortcode = static function () use (&$shortcodeCalls): string {
        ++$shortcodeCalls;
        return 'SHORTCODE MUST BE STRIPPED';
    };
    $length = static fn (): int => 4;
    $more = static fn (): string => ' [theme-more]';
    add_shortcode('mtflpp_excerpt_fixture', $shortcode);
    add_filter('the_content', $contentFilter, 20);
    add_filter('excerpt_length', $length);
    add_filter('excerpt_more', $more);
    try {
        $check(
            $block($postId, ['excerptLength' => 7])->render() === $block($controlId, ['excerptLength' => 7])->render(),
            'Preview generation must match native saved-post rendering with content, length and more filters.'
        );
        $check($contentCalls === 2 && $shortcodeCalls === 0, 'Native content processing must run once per excerpt.');
    } finally {
        remove_shortcode('mtflpp_excerpt_fixture');
        remove_filter('the_content', $contentFilter, 20);
        remove_filter('excerpt_length', $length);
        remove_filter('excerpt_more', $more);
    }
    $display = static function (string $value, int $id, string $context) use ($postId): string {
        if (
            $context !== 'display' || $value === ''
            || ($id !== $postId && wp_is_post_revision($id) !== $postId)
        ) {
            return $value;
        }
        return 'Display ' . $value;
    };
    foreach (['post_title', 'post_content', 'post_excerpt'] as $field) {
        add_filter($field, $display, 10, 3);
    }
    add_filter('get_the_excerpt', $before, 5, 2);
    try {
        foreach (['Explicit display excerpt', ''] as $text) {
            $sourceId = $bind($text, $content);
            $normalized = $frontend->readPost(clone $parent);
            $check(
                $normalized->post_title === 'Display Preview title'
                && $normalized->post_content === 'Display ' . $content
                && $normalized->post_excerpt === ($text === '' ? '' : 'Display ' . $text),
                'The authorized source must use native display normalization before excerpt rendering.'
            );
            $html = $block($postId, ['excerptLength' => 100])->render();
            $check(
                end($seen) === ['before', $normalized->post_excerpt, $postId, 'post',
                    $normalized->post_title, $normalized->post_content],
                'Native excerpt filters must receive the same normalized fields as the authorized frontend preview.'
            );
            $check(
                $excerpt($html) === trim(wp_strip_all_tags(get_the_excerpt($normalized))),
                'Explicit and generated block excerpts must retain native source display filters.'
            );
        }
    } finally {
        remove_filter('get_the_excerpt', $before, 5);
        foreach (['post_title', 'post_content', 'post_excerpt'] as $field) {
            remove_filter($field, $display, 10);
        }
    }
    $sourceId = $bind(" \n\t ", $content);
    $check(
        str_contains($excerpt($block($postId)->render()), 'Preview generated'),
        'Whitespace must use native generation.'
    );
    $sourceId = $bind('0', $content);
    $check($excerpt($block($postId)->render()) === '0', 'A literal zero must remain an explicit excerpt.');
    $sourceId = $bind('', '');
    $check($excerpt($block($postId)->render()) === '', 'Empty preview content must not revive saved text.');
    $check(
        $parent == $parentBefore && $GLOBALS['post'] === $parent && $parent->ID === $postId
        && wp_cache_get($postId, 'posts') == $cachedBefore,
        'Rendering must not mutate the global post, held post objects or shared cached parent data.'
    );
    $check(
        $live->snapshotFingerprint($postId) === $savedBefore
        && $live->snapshotFingerprint($autosaveId) === $recoveryBefore,
        'Excerpt rendering must not write the saved parent or its recovery autosave.'
    );
    $check(has_action('shutdown', [$core, 'unbindPreview']) === PHP_INT_MAX, 'Bound rendering needs shutdown cleanup.');
    $core->unbindPreview();
    $core->unbindPreview();
    $check(
        $type->render_callback === $originalRenderer && !has_action('shutdown', [$core, 'unbindPreview'])
        && $block($postId)->render() === $ordinary,
        'Repeated cleanup must restore native rendering without leaking the previous source.'
    );
    // A rejected fresh request must not activate this owner.
    $_GET = ['mtflpp_post' => $postId, 'mtflpp_revision' => $sourceId, 'mtflpp_token' => 'invalid'];
    try {
        $frontend->authorizePreview();
        throw new RuntimeException('An invalid preview token was accepted.');
    } catch (RuntimeException $error) {
        $check($error->getMessage() === 'mtflpp_denied_403', 'An invalid preview must be rejected.');
    }
    $check($type->render_callback === $originalRenderer, 'Rejected requests must leave the native renderer inactive.');
    $core->bindPreview($postId, 0);
    $check($type->render_callback === $originalRenderer, 'Missing sources must not install a renderer.');
    $custom = static fn (): string => '<p>Theme-owned excerpt renderer</p>';
    $type->render_callback = $custom;
    $core->bindPreview($postId, $sourceId);
    $check($type->render_callback === $custom, 'A theme-owned renderer must not be replaced.');
    $type->render_callback = $originalRenderer;
    $core->bindPreview($postId, $sourceId);
    $type->render_callback = $custom;
    $core->unbindPreview();
    $check($type->render_callback === $custom, 'Cleanup must not overwrite a later renderer owner.');
    WP_CLI::success('Native excerpt source, generation, filters, other contexts, identity and isolation passed.');
} finally {
    $core->unbindPreview();
    $type->render_callback = $originalRenderer;
    if (isset($before)) {
        remove_filter('get_the_excerpt', $before, 5);
        remove_filter('get_the_excerpt', $after, 10);
    }
    if (isset($queryVars)) {
        remove_filter('query_loop_block_query_vars', $queryVars);
    }
    remove_filter('wp_die_handler', $dieHandler, PHP_INT_MAX);
    remove_action('init', [$frontend, 'authorizePreview'], 20);
    remove_action('template_redirect', [$frontend, 'checkPreviewTarget'], -1);
    foreach ($originalHooks as $hook => $callbacks) {
        if ($callbacks === null) {
            unset($GLOBALS['wp_filter'][$hook]);
        } else {
            $GLOBALS['wp_filter'][$hook] = $callbacks;
        }
    }
    $GLOBALS['wp_query'] = $originalQuery;
    $GLOBALS['post'] = $originalPost;
    $_GET = $originalGet;
    foreach (array_reverse($posts) as $id) {
        wp_delete_post($id, true);
    }
    if (is_int($user) && $user) {
        wp_delete_user($user);
    }
    wp_set_current_user($originalUser);
}
