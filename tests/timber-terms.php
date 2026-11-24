<?php

/** Run with `wp eval-file tests/timber-terms.php` on a disposable single-site installation. */

use MeetTheFrontendLivePreviewPanel\Compatibility\Timber as TimberAdapter;
use MeetTheFrontendLivePreviewPanel\Compatibility\TimberPost;
use MeetTheFrontendLivePreviewPanel\FrontendPreview;
use MeetTheFrontendLivePreviewPanel\LivePreview;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(LivePreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a single-site installation with this plugin active.');
}
if (!class_exists(\Timber\Timber::class)) {
    WP_CLI::log('Skipping Timber term checks: Timber is not available.');
    return;
}
require_once ABSPATH . 'wp-admin/includes/user.php';
$legacy = method_exists(\Timber\Post::class, 'import_custom');
$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$originalUser = get_current_user_id();
// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Preserve the CLI request for cleanup.
$originalGet = $_GET;
$hooks = [];
$previewHooks = [
    'mtflpp_frontend_live_preview_source_selected', 'mtflpp_frontend_saved_preview_source_selected',
    'the_preview', 'get_post_metadata', 'get_the_terms',
    'timber/post/import_data', 'timber/post/class', 'shutdown',
];
foreach ($previewHooks as $hook) {
    $hooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
}
remove_all_actions('mtflpp_frontend_live_preview_source_selected');
remove_all_actions('mtflpp_frontend_saved_preview_source_selected');
$adapter = new TimberAdapter();
$live = new LivePreview();
$frontend = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $live);
$posts = $terms = [];
$user = 0;
register_taxonomy('mtflpp_timber_topic', 'post', ['public' => true, 'show_in_rest' => true]);
register_taxonomy('mtflpp_timber_hidden', 'post', ['public' => true, 'show_in_rest' => false]);
$bind = static function (int $id, array|stdClass $selection) use ($live, $frontend, $check): void {
    $request = new WP_REST_Request('POST', '/meet-the-frontend-live-preview-panel/v1/posts/' . $id . '/preview');
    $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
    $request->set_body_params(['base' => $live->fingerprint($id), 'terms' => wp_json_encode($selection)]);
    $response = rest_do_request($request);
    $check($response->get_status() === 200, 'Could not prepare a Timber term preview.');
    parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $query);
    $_GET = $query;
    $frontend->authorizePreview();
};
$ids = static fn (array $list): array => array_map(static fn (object $term): int => (int) $term->ID, $list);
$queryTerms = static fn (\Timber\Post $post, array $query, bool $merge = true): array => $legacy
    ? $post->terms(['query' => $query, 'merge' => $merge])
    : $post->terms($query, ['merge' => $merge]);
try {
    $user = wp_insert_user([
        'user_login' => 'mtflpp_timber_terms_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(32), 'role' => 'administrator',
    ]);
    $check(!is_wp_error($user), 'Could not create a fixture user.');
    wp_set_current_user($user);
    $choices = [];
    foreach (['category', 'post_tag', 'mtflpp_timber_topic', 'mtflpp_timber_hidden'] as $taxonomy) {
        foreach (['Saved', 'Edited'] as $label) {
            $term = wp_insert_term('MTFLPP ' . $label . ' ' . wp_generate_password(10, false, false), $taxonomy);
            $check(!is_wp_error($term), 'Could not create fixture terms.');
            $choices[$taxonomy][$label] = (int) $term['term_id'];
            $terms[] = [$term['term_id'], $taxonomy];
        }
    }
    foreach (['Selected', 'Other'] as $label) {
        $id = wp_insert_post([
            'post_type' => 'post', 'post_status' => 'publish', 'post_author' => $user,
            'post_title' => 'MTFLPP Timber terms ' . $label,
        ], true);
        $check(!is_wp_error($id), 'Could not create a fixture post.');
        $posts[] = $id;
        foreach ($choices as $taxonomy => $selection) {
            wp_set_object_terms($id, [$selection['Saved']], $taxonomy);
        }
    }
    [$postId, $otherId] = $posts;
    $base = $live->fingerprint($postId);
    $recoveryId = _wp_put_post_revision($postId, true);
    $check(is_int($recoveryId), 'Could not create the recovery fixture.');
    $recovery = $live->fingerprint($recoveryId);
    $check(get_class(\Timber\Timber::get_post($postId)) === \Timber\Post::class, 'Ordinary imports stay native.');
    $selection = [];
    foreach (['category', 'post_tag', 'mtflpp_timber_topic'] as $taxonomy) {
        $selection[$taxonomy] = [$choices[$taxonomy]['Edited']];
    }
    $bind($postId, $selection);
    $post = \Timber\Timber::get_post($postId);
    $check(
        has_filter('pre_get_terms', [$adapter, 'readLegacyTermQuery']) === ($legacy ? PHP_INT_MIN : false),
        'Only Timber 1 should install the legacy query hook.'
    );
    $check(
        $legacy ? get_class($post) === \Timber\Post::class : $post instanceof TimberPost,
        'Only Timber 2 should use the preview-only subclass.'
    );
    if ($legacy) {
        $check(
            $ids((new \Timber\Post($postId))->terms('category')) === $selection['category'],
            'Timber 1 must also support direct construction.'
        );
    }
    $check($post->category()->ID === $choices['category']['Edited'], 'category() must use unsaved terms.');
    $check($ids($post->categories()) === $selection['category'], 'categories() must use the selection.');
    $check($ids($post->terms('tags')) === $selection['post_tag'], 'Native taxonomy aliases must remain supported.');
    $check($ids($post->terms('mtflpp_timber_topic')) === $selection['mtflpp_timber_topic'], 'Custom taxonomies work.');
    $html = \Timber\Timber::compile_string(
        '{{ post.category.name }}|{{ post.category.link }}|'
        . '{% for tag in post.terms("tag") %}{{ tag.name }}{% endfor %}',
        ['post' => $post]
    );
    $check(str_contains($html, get_term($choices['category']['Edited'])->name), 'The real Twig byline must update.');
    $check(str_contains($html, get_term_link($choices['category']['Edited'])), 'The Twig category link must update.');
    $check(str_contains($html, get_term($choices['post_tag']['Edited'])->name), 'The real Twig tag loop must update.');
    $check(!str_contains($html, get_term($choices['category']['Saved'])->name), 'The old category must disappear.');
    $header = get_template_directory() . '/Components/BlockPostHeader/index.twig';
    if (is_readable($header)) {
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Local template fixture.
        $headerHtml = \Timber\Timber::compile_string(file_get_contents($header), [
            'post' => $post, 'labels' => ['postedBy' => 'By', 'postedIn' => 'In', 'readingTime' => '%d min read'],
        ]);
        $check(
            str_contains($headerHtml, get_term($choices['category']['Edited'])->name)
            && !str_contains($headerHtml, get_term($choices['category']['Saved'])->name),
            'The actual Flynt header template from the reported screenshot must use the selected category.'
        );
    }
    $other = \Timber\Timber::get_post($otherId);
    $check(get_class($other) === \Timber\Post::class, 'Other posts must retain their original Timber class.');
    $check($other->category()->ID === $choices['category']['Saved'], 'Other post categories must remain saved.');
    $check(
        $adapter->postClass('ThemeSpecificPost', get_post($postId)) === 'ThemeSpecificPost',
        'Theme-specific post classes must not be replaced.'
    );
    $check(
        $ids($post->terms('mtflpp_timber_hidden')) === [$choices['mtflpp_timber_hidden']['Saved']],
        'Other taxonomies stay saved.'
    );
    $grouped = $queryTerms($post, ['taxonomy' => ['category', 'post_tag']], false);
    $check($ids($grouped['category']) === $selection['category'], 'Native taxonomy grouping must be preserved.');
    $check($ids($grouped['post_tag']) === $selection['post_tag'], 'Grouped tags must use the same source.');
    if (!$legacy) {
        $check(
            $queryTerms($post, ['taxonomy' => 'category', 'fields' => 'ids']) === $selection['category'],
            'ID fields stay native.'
        );
    }
    $check(
        $queryTerms($post, ['taxonomy' => 'category', 'exclude' => $selection['category']]) === [],
        'Exclusions work.'
    );
    $check(
        $queryTerms($post, ['taxonomy' => 'category', 'include' => [$choices['category']['Saved']]]) === [],
        'Include must intersect the preview selection.'
    );

    $savedCategory = [$choices['category']['Saved']];
    $check(
        $ids($queryTerms($post, ['taxonomy' => 'category', 'fields' => 'all_with_object_id'])) === $savedCategory,
        'Relationship-object fields must retain native reads.'
    );
    $check(
        $ids($queryTerms($post, ['taxonomy' => 'category', 'orderby' => 'term_order'])) === $savedCategory,
        'Relationship ordering must retain native reads.'
    );

    // Nested native reads during the adapted query must never see a fake relationship query/cache.
    $nested = false;
    $during = static function () use (&$nested, $postId, $choices, $check): void {
        if ($nested) {
            return;
        }
        $nested = true;
        $actual = wp_get_object_terms($postId, 'category', ['fields' => 'ids']);
        $check($actual === [$choices['category']['Saved']], 'Nested direct relationship queries must remain saved.');
        get_the_terms($postId, 'category');
    };
    wp_cache_delete($postId, 'category_relationships');
    add_action('pre_get_terms', $during);
    try {
        $check($post->category()->ID === $choices['category']['Edited'], 'Nested queries must not break the byline.');
    } finally {
        remove_action('pre_get_terms', $during);
    }
    $check(
        get_object_term_cache($postId, 'category')[0]->term_id === $choices['category']['Saved'],
        'Caches stay saved.'
    );
    $nativeHooks = $GLOBALS['wp_filter']['pre_get_terms']->callbacks ?? [];
    $nativeFilters = $GLOBALS['wp_filter']['terms_pre_query']->callbacks ?? [];
    $throw = static function (): void {
        throw new RuntimeException('mtflpp_timber_terms_throw');
    };
    add_action('pre_get_terms', $throw);
    try {
        $post->categories();
        throw new RuntimeException('The throwing-query fixture did not run.');
    } catch (RuntimeException $error) {
        $check($error->getMessage() === 'mtflpp_timber_terms_throw', 'Native query exceptions must be preserved.');
    } finally {
        remove_action('pre_get_terms', $throw);
    }
    $check(
        ($GLOBALS['wp_filter']['pre_get_terms']->callbacks ?? []) === $nativeHooks
        && ($GLOBALS['wp_filter']['terms_pre_query']->callbacks ?? []) === $nativeFilters,
        'Query hooks must not leak on failure.'
    );
    $check(
        wp_get_object_terms($postId, 'category', ['fields' => 'ids']) === [$choices['category']['Saved']],
        'Direct reads stay saved.'
    );
    $check($live->fingerprint($postId) === $base, 'Timber preview reads must not change the saved parent.');
    $check($live->fingerprint($recoveryId) === $recovery, 'Timber preview reads must preserve recovery data.');
    foreach (['category', 'post_tag', 'mtflpp_timber_topic'] as $taxonomy) {
        $check(get_term($choices[$taxonomy]['Edited'])->count === 0, 'Preview-only terms must retain zero counts.');
    }
    $multiple = $selection;
    $multiple['category'][] = $choices['category']['Saved'];
    $bind($postId, $multiple);
    $check(
        $ids($queryTerms($post, ['taxonomy' => 'category', 'orderby' => 'term_id', 'order' => 'DESC', 'number' => 1]))
            === $selection['category'],
        'Native ordering and limits must apply to multiple selected terms.'
    );
    $bind($postId, ['category' => [], 'post_tag' => [], 'mtflpp_timber_topic' => []]);
    $check(
        $post->category() === null && $post->terms('tag') === [],
        'Rebinding/clearing must update existing bridges.'
    );
    $emptyGroups = $queryTerms($post, ['taxonomy' => ['category', 'post_tag']], false);
    // Some Timber versions omit empty groups. Preserve native grouping without restoring saved relationships.
    $check($emptyGroups === [] || $emptyGroups === ['category' => [], 'post_tag' => []], 'Both groups stay empty.');
    $check(
        wp_get_object_terms($postId, 'category', ['fields' => 'ids']) === $savedCategory,
        'The empty-result filter must not affect direct relationship reads.'
    );
    $bind($postId, new stdClass());
    $check($post->category()->ID === $choices['category']['Saved'], 'Omitted selections must reseed saved terms.');
    $historyId = _wp_put_post_revision($postId);
    $check(is_int($historyId), 'Could not create a history fixture.');
    update_metadata('post', $historyId, LivePreview::TERMS_META, $selection);
    parse_str(wp_parse_url($frontend->savedPreviewUrl(get_post($postId), $historyId), PHP_URL_QUERY), $saved);
    $_GET = $saved;
    $frontend->authorizePreview();
    $savedPost = \Timber\Timber::get_post($postId);
    $check(get_class($savedPost) === \Timber\Post::class, 'Saved history must not create a live term bridge.');
    $check($savedPost->category()->ID === $choices['category']['Saved'], 'History categories must remain saved.');
    $check($post->category()->ID === $choices['category']['Saved'], 'Old bridges must release their live source.');
    $adapter->unbindPreview();
    $check(
        !has_filter('timber/post/class', [$adapter, 'postClass'])
        && !has_filter('pre_get_terms', [$adapter, 'readLegacyTermQuery'])
        && !has_filter('terms_pre_query', [$adapter, 'emptyLegacyTermQuery']),
        'Class and query bindings must be released.'
    );
    WP_CLI::success('Timber/Twig categories, tags, query delegation, caches, custom classes and rebinding passed.');
} finally {
    $adapter->unbindPreview();
    $_GET = $originalGet;
    remove_action('init', [$frontend, 'authorizePreview'], 20);
    remove_action('template_redirect', [$frontend, 'checkPreviewTarget'], -1);
    foreach ($hooks as $hook => $callbacks) {
        if ($callbacks === null) {
            unset($GLOBALS['wp_filter'][$hook]);
        } else {
            $GLOBALS['wp_filter'][$hook] = $callbacks;
        }
    }
    wp_set_current_user($user ?: $originalUser);
    foreach (array_reverse($posts) as $id) {
        wp_delete_post($id, true);
    }
    foreach ($terms as [$id, $taxonomy]) {
        wp_delete_term($id, $taxonomy);
    }
    unregister_taxonomy('mtflpp_timber_topic');
    unregister_taxonomy('mtflpp_timber_hidden');
    if (is_int($user) && $user > 0) {
        wp_delete_user($user);
    }
    wp_set_current_user($originalUser);
}
