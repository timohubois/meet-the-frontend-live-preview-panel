<?php

/** Run with `wp eval-file tests/yoast.php` on a disposable single-site installation. */

use MeetTheFrontendLivePreviewPanel\Compatibility\Yoast as YoastAdapter;
use MeetTheFrontendLivePreviewPanel\FrontendPreview;
use MeetTheFrontendLivePreviewPanel\LivePreview;
use Yoast\WP\SEO\Generators\Breadcrumbs_Generator;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(LivePreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a single-site installation with this plugin active.');
}
if (!function_exists('YoastSEO') || !class_exists('WPSEO_Primary_Term')) {
    WP_CLI::log('Skipping Yoast checks: Yoast SEO is not available.');
    return;
}
require_once ABSPATH . 'wp-admin/includes/user.php';
$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$originalUser = get_current_user_id();
// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Preserve the CLI request for cleanup.
$originalGet = $_GET;
$originalGlobals = [];
foreach (['wp_query', 'wp_the_query', 'post'] as $key) {
    $originalGlobals[$key] = $GLOBALS[$key] ?? null;
}
$hooks = [];
$previewHooks = [
    'mtflpp_live_preview_form_values', 'mtflpp_live_preview_custom_fields_initialized',
    'mtflpp_live_preview_preparation_error', 'mtflpp_frontend_live_preview_source_selected',
    'mtflpp_frontend_saved_preview_source_selected',
    'the_preview', 'get_post_metadata', 'get_the_terms', 'wpseo_breadcrumb_links', 'wpseo_breadcrumb_indexables',
    'wpseo_should_save_indexable', 'shutdown',
];
foreach ($previewHooks as $hook) {
    $hooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
    if (str_starts_with($hook, 'mtflpp_')) {
        remove_all_filters($hook);
    }
}
$adapter = new YoastAdapter();
$live = new LivePreview();
$frontend = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $live);
$posts = $terms = [];
$user = 0;
$mainTaxonomy = 'category';
$options = static function (array $values) use (&$mainTaxonomy): array {
    $values['post_types-post-maintax'] = $mainTaxonomy;
    return $values;
};
add_filter('option_wpseo_titles', $options);
WPSEO_Options::clear_cache();
$themeSupports = current_theme_supports('yoast-seo-breadcrumbs');
add_theme_support('yoast-seo-breadcrumbs');
register_taxonomy('mtflpp_yoast_topic', 'post', [
    'public' => true, 'hierarchical' => true, 'show_in_rest' => true, 'rest_base' => 'mtflpp_topics',
]);
$prepare = static function (int $postId, array $input) use ($live): WP_REST_Response {
    $request = new WP_REST_Request('POST', '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview');
    $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
    $request->set_body_params(array_merge(['base' => $live->fingerprint($postId)], $input));
    return rest_do_request($request);
};
$bind = static function (int $postId, array $input) use ($prepare, $frontend, $check): int {
    $response = $prepare($postId, $input);
    $check($response->get_status() === 200, 'The Yoast preview request must succeed: ' . wp_json_encode($response));
    parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $query);
    $_GET = $query;
    $frontend->authorizePreview();
    return (int) $query['mtflpp_revision'];
};
$primary = static fn (array $values): array => ['yoast_primary_terms' => wp_json_encode((object) $values)];
$indexables = static function (): array {
    global $wpdb;
    $result = [];
    foreach (['yoast_indexable', 'yoast_primary_term', 'yoast_indexable_hierarchy'] as $table) {
        $order = $table === 'yoast_indexable_hierarchy' ? 'indexable_id, ancestor_id' : 'id';
        $sql = $wpdb->prepare('SELECT * FROM %i', $wpdb->prefix . $table);
        // phpcs:ignore WordPress.DB -- Fresh read-only snapshots of native tables; prepared identifier and fixed ordering.
        $result[$table] = $wpdb->get_results($sql . ' ORDER BY ' . $order, ARRAY_A);
    }
    return $result;
};
$trailIds = static function (array $crumbs): array {
    $terms = array_filter($crumbs, static fn (array $crumb): bool => isset($crumb['term_id']));
    return array_map('intval', array_values(wp_list_pluck($terms, 'term_id')));
};
$deny = null;
try {
    $user = wp_insert_user([
        'user_login' => 'mtflpp_yoast_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(32), 'role' => 'administrator',
    ]);
    $check(!is_wp_error($user), 'Could not create a fixture user.');
    wp_set_current_user($user);
    $choices = [];
    foreach (['Saved', 'Edited', 'New'] as $label) {
        $root = wp_insert_term('MTFLPP ' . $label . ' Root ' . wp_generate_password(8, false, false), 'category');
        $check(!is_wp_error($root), 'Could not create a root term.');
        $terms[] = [$root['term_id'], 'category'];
        $term = wp_insert_term('MTFLPP ' . $label . ' Child ' . wp_generate_password(8, false, false), 'category', [
            'parent' => $root['term_id'],
        ]);
        $check(!is_wp_error($term), 'Could not create a child term.');
        $terms[] = [$term['term_id'], 'category'];
        $choices[$label] = ['id' => (int) $term['term_id'], 'root' => (int) $root['term_id']];
    }
    $topic = wp_insert_term('MTFLPP Topic ' . wp_generate_password(8, false, false), 'mtflpp_yoast_topic');
    $check(!is_wp_error($topic), 'Could not create a custom term.');
    $terms[] = [$topic['term_id'], 'mtflpp_yoast_topic'];
    WPSEO_Taxonomy_Meta::set_value($choices['New']['id'], 'category', 'bctitle', 'Preview & Breadcrumb');
    foreach (['Selected', 'Other', 'Custom', 'Child'] as $label) {
        $postId = wp_insert_post([
            'post_type' => 'post', 'post_status' => 'publish', 'post_author' => $user,
            'post_title' => 'MTFLPP Yoast ' . $label,
            'tax_input' => [
                'category' => [$choices['Saved']['id'], $choices['Edited']['id']],
                'mtflpp_yoast_topic' => [(int) $topic['term_id']],
            ],
            'post_parent' => $label === 'Child' ? $posts[1] : 0,
            'meta_input' => [
                '_yoast_wpseo_primary_category' => $choices['Saved']['id'],
                '_yoast_wpseo_bctitle' => $label === 'Custom' ? 'Custom Saved Crumb' : '',
            ],
        ], true);
        $check(!is_wp_error($postId), 'Could not create a fixture post.');
        $posts[] = $postId;
    }
    [$postId, $otherId, $customId, $childId] = $posts;
    $query = new WP_Query(['p' => $postId]);
    $GLOBALS['wp_query'] = $GLOBALS['wp_the_query'] = $query;
    $GLOBALS['post'] = get_post($postId);
    $check(in_array('category', $adapter->primaryTaxonomies($postId), true), 'Native primary category is exposed.');
    $check(in_array('mtflpp_yoast_topic', $adapter->primaryTaxonomies($postId), true), 'Native custom primaries work.');
    $generator = YoastSEO()->classes->get(Breadcrumbs_Generator::class);
    // Model IDs can be null when Yoast indexing is disabled; make these independent request contexts.
    $memoizer = YoastSEO()->classes->get(\Yoast\WP\SEO\Memoizers\Meta_Tags_Context_Memoizer::class);
    $memoizer->clear();
    $context = YoastSEO()->meta->for_post($postId)->context;
    $memoizer->clear();
    $otherContext = YoastSEO()->meta->for_post($otherId)->context;
    $memoizer->clear();
    $customContext = YoastSEO()->meta->for_post($customId)->context;
    $memoizer->clear();
    $childContext = YoastSEO()->meta->for_post($childId)->context;
    $memoizer->clear();
    $childSaved = $generator->generate($childContext);
    $saved = $generator->generate($context);
    $otherSaved = $generator->generate($otherContext);
    if (YoastSEO()->helpers->indexable->should_index_indexables()) {
        $check(in_array($choices['Saved']['id'], $trailIds($saved), true), 'Warm real saved breadcrumbs.');
    }
    $beforeIndexables = $indexables();
    $before = $live->snapshotFingerprint($postId);
    $recoveryId = _wp_put_post_revision($postId, true);
    $check(is_int($recoveryId), 'Could not create recovery data.');
    $recovery = $live->snapshotFingerprint($recoveryId);
    $sourceId = $bind($postId, $primary(['category' => $choices['Edited']['id']]));
    $check(yoast_get_primary_term_id('category', $postId) === $choices['Edited']['id'], 'Primary-only edits work.');
    $check(yoast_get_primary_term_id('category', $otherId) === $choices['Saved']['id'], 'Other primaries stay saved.');
    $crumbs = $generator->generate($context);
    $check($trailIds($crumbs) === [$choices['Edited']['root'], $choices['Edited']['id']], 'Trail must switch.');
    $check($generator->generate($otherContext) === $otherSaved, 'Other breadcrumb contexts must stay untouched.');
    // Render through the actual public template function, not a replacement HTML formatter.
    $html = yoast_breadcrumb('', '', false);
    $check(str_contains($html, get_term($choices['Edited']['id'])->name), 'Native breadcrumb HTML must update.');
    $check(str_contains($html, esc_url(get_term_link($choices['Edited']['id']))), 'Native links must update.');
    $check(!str_contains($html, get_term($choices['Saved']['id'])->name), 'Old category HTML must disappear.');
    $check($live->snapshotFingerprint($postId) === $before, 'Primary preview must preserve saved metadata and terms.');
    $check($live->snapshotFingerprint($recoveryId) === $recovery, 'Recovery data must remain unchanged.');
    $check($indexables() === $beforeIndexables, 'Neither preparation nor native rendering may rewrite indexables.');
    $check(
        (int) get_post_meta($sourceId, '_yoast_wpseo_primary_category', true) === $choices['Edited']['id'],
        'Only the preview source stores the edited primary term.'
    );
    $bind($postId, array_merge($primary(['category' => $choices['New']['id']]), [
        'terms' => wp_json_encode(['category' => [$choices['New']['id']]]),
    ]));
    $check(yoast_get_primary_term_id('category', $postId) === $choices['New']['id'], 'Unsaved assignments work.');
    $check(get_term($choices['New']['id'])->count === 0, 'Preview must not change term counts.');
    $check($trailIds($generator->generate($context)) === [
        $choices['New']['root'], $choices['New']['id'],
    ], 'Unindexed unsaved selections must have a complete breadcrumb trail.');
    $direct = wp_get_object_terms($postId, 'category', ['fields' => 'ids']);
    sort($direct);
    $expected = [$choices['Saved']['id'], $choices['Edited']['id']];
    sort($expected);
    $check($direct === $expected, 'Direct relationships must stay saved.');
    $bind($postId, array_merge($primary(['category' => 0]), [
        'terms' => wp_json_encode(['category' => [$choices['New']['root'], $choices['New']['id']]]),
        'post_title' => 'MTFLPP Unsaved Breadcrumb Title',
    ]));
    $fallback = $generator->generate($context);
    $check($trailIds($fallback) === [$choices['New']['root'], $choices['New']['id']], 'Deepest-term fallback.');
    $check(in_array('Preview &amp; Breadcrumb', wp_list_pluck($fallback, 'text'), true), 'Safe native term titles.');
    $check(end($fallback)['text'] === 'MTFLPP Unsaved Breadcrumb Title', 'Default post breadcrumb titles update.');
    // Simulate the next frame's request with Yoast's public memoizer reset, not a custom HTML renderer.
    $memoizer->clear();
    $fallbackHtml = yoast_breadcrumb('', '', false);
    $check(str_contains($fallbackHtml, 'Preview &amp; Breadcrumb'), 'Native HTML escapes term titles once.');
    $extra = ['url' => home_url('/extra'), 'text' => 'Keep this custom crumb'];
    $custom = $saved;
    array_splice($custom, -1, 0, [$extra]);
    $check(in_array($extra, $adapter->readBreadcrumbs($custom), true), 'Non-taxonomy custom crumbs stay untouched.');
    $termExtra = [
        'url' => get_term_link($choices['Edited']['id']), 'text' => 'Custom category shortcut',
        'term_id' => $choices['Edited']['id'], 'taxonomy' => 'category',
    ];
    $insert = static function (array $links) use ($termExtra): array {
        array_splice($links, 1, 0, [$termExtra]);
        return $links;
    };
    // Theme filters normally register before preview authorization, including at the default link priority.
    $adapter->unbindPreview();
    add_filter('wpseo_breadcrumb_links', $insert);
    try {
        foreach ([[$choices['New']['id']], []] as $selection) {
            $bind($postId, array_merge($primary(['category' => $selection[0] ?? 0]), [
                'terms' => wp_json_encode(['category' => $selection]),
            ]));
            $customTrail = $generator->generate($context);
            $check(in_array($termExtra, $customTrail, true), 'Custom same-taxonomy crumbs must survive replacement.');
            $check(
                !in_array($choices['Saved']['id'], $trailIds($customTrail), true),
                'Only the actual saved ancestry must be removed.'
            );
            $check($generator->generate($otherContext) === $insert($otherSaved), 'Other contexts retain their crumbs.');
        }
    } finally {
        remove_filter('wpseo_breadcrumb_links', $insert);
    }
    $bind($postId, array_merge($primary(['category' => 0]), [
        'terms' => wp_json_encode(['category' => [$choices['New']['root'], $choices['New']['id']]]),
    ]));
    $mainTaxonomy = '0';
    WPSEO_Options::clear_cache();
    $check($trailIds($generator->generate($context)) === $trailIds($saved), 'Disabled taxonomy trails stay native.');
    $mainTaxonomy = 'category';
    WPSEO_Options::clear_cache();
    $bind($postId, array_merge($primary(['category' => 0]), ['terms' => wp_json_encode(['category' => []])]));
    $check(yoast_get_primary_term_id('category', $postId) === false, 'Clearing removes the primary.');
    $withoutTerms = array_values(array_filter($saved, static fn (array $crumb): bool =>
        ($crumb['taxonomy'] ?? null) !== 'category'));
    $check($generator->generate($context) === $withoutTerms, 'Clearing removes only the taxonomy trail.');
    $bind($postId, []);
    $check(yoast_get_primary_term_id('category', $postId) === $choices['Saved']['id'], 'Saved fallback restored.');
    $check($generator->generate($context) === $saved, 'Omitted selections must restore the native saved trail.');
    $bind($postId, $primary(['mtflpp_yoast_topic' => (int) $topic['term_id']]));
    $check(yoast_get_primary_term_id('mtflpp_yoast_topic', $postId) === $topic['term_id'], 'Custom primaries work.');
    foreach (['[]', 'null', 'false', '{"category":"1"}', '{"category":-1}', '{"category":true}'] as $invalid) {
        $check($prepare($postId, ['yoast_primary_terms' => $invalid])->get_status() === 400, 'Bad input rejected.');
    }
    $check($prepare($postId, $primary(['category' => $choices['New']['id']]))->get_status() === 400, 'Unassigned ID.');
    $check($prepare($postId, $primary(['post_tag' => 0]))->get_status() === 403, 'Disabled primary taxonomy rejected.');
    $deny = static function (array $caps, string $cap, int $userId, array $args) use ($choices): array {
        return $cap === 'assign_term' && ($args[0] ?? 0) === $choices['Edited']['id'] ? ['do_not_allow'] : $caps;
    };
    add_filter('map_meta_cap', $deny, 10, 4);
    $check($prepare($postId, $primary(['category' => $choices['Edited']['id']]))->get_status() === 403, 'Permission.');
    remove_filter('map_meta_cap', $deny);
    $deny = null;
    $blockWrite = static function ($value, int $id, string $key) {
        return get_post_type($id) === 'revision' && $key === '_yoast_wpseo_primary_category' ? false : $value;
    };
    add_filter('update_post_metadata', $blockWrite, 10, 3);
    try {
        $failure = $prepare($postId, $primary(['category' => $choices['Edited']['id']]));
        $check($failure->get_status() === 409, 'Metadata-write failures must be reported, not silently ignored.');
    } finally {
        remove_filter('update_post_metadata', $blockWrite);
    }
    $bind($customId, array_merge($primary(['category' => $choices['Edited']['id']]), [
        'post_title' => 'MTFLPP New Custom Title',
    ]));
    $customCrumbs = $generator->generate($customContext);
    $check(end($customCrumbs)['text'] === 'Custom Saved Crumb', 'Explicit post breadcrumb titles remain native.');
    $bind($childId, $primary(['category' => $choices['Edited']['id']]));
    $check($generator->generate($childContext) === $childSaved, 'Post-parent hierarchy must win over child terms.');
    $historyId = _wp_put_post_revision($postId);
    $check(is_int($historyId), 'Could not create history data.');
    update_metadata('post', $historyId, '_yoast_wpseo_primary_category', $choices['Edited']['id']);
    parse_str(wp_parse_url($frontend->savedPreviewUrl(get_post($postId), $historyId), PHP_URL_QUERY), $savedQuery);
    $_GET = $savedQuery;
    $frontend->authorizePreview();
    $check(yoast_get_primary_term_id('category', $postId) === $choices['Saved']['id'], 'History keeps saved terms.');
    $check($generator->generate($context) === $saved, 'History taxonomy trails remain current saved.');
    $adapter->unbindPreview();
    $check(!has_filter('wpseo_breadcrumb_links', [$adapter, 'readBreadcrumbs']), 'Breadcrumb hooks must release.');
    $check(
        !has_filter('wpseo_breadcrumb_indexables', [$adapter, 'readBreadcrumbIndexables']),
        'Native ancestry observation must release on unbinding.'
    );
    $check(!has_filter('get_post_metadata', [$adapter, 'readPrimaryMeta']), 'Primary hooks must release.');
    $check($indexables() === $beforeIndexables, 'Rebinding, invalid requests and history must not rewrite indexables.');
    $check($live->snapshotFingerprint($postId) === $before, 'All selected-post saved data must remain unchanged.');
    $check($live->snapshotFingerprint($recoveryId) === $recovery, 'Rebinding preserves recovery data.');
    if (YoastSEO()->helpers->indexable->should_index_indexables()) {
        $repository = YoastSEO()->classes->get(\Yoast\WP\SEO\Repositories\Indexable_Repository::class);
        $hierarchy = YoastSEO()->classes->get(\Yoast\WP\SEO\Repositories\Indexable_Hierarchy_Repository::class);
        $model = $repository->query()->where('object_id', $postId)->where('object_type', 'post')->find_one();
        $check((bool) $model, 'The production-mode fixture must have a real saved indexable.');
        // Make only this fixture's model stale. A lazy upgrade must not persist preview values or delete its primary.
        $model->version = 0;
        $model->save();
        $stale = $indexables();
        $bind($postId, array_merge($primary(['category' => 0]), [
            'terms' => wp_json_encode(['category' => [$choices['New']['id']]]),
        ]));
        $memoizer->clear();
        $upgraded = YoastSEO()->meta->for_post($postId)->context;
        $check($trailIds($generator->generate($upgraded)) === [
            $choices['New']['root'], $choices['New']['id'],
        ], 'A guarded lazy upgrade must still render the preview trail.');
        $check($indexables() === $stale, 'Lazy upgrades must not alter stored models, primaries or hierarchy.');
        $hierarchy->clear_ancestors($model->id);
        $model->delete();
        $cold = $indexables();
        $bind($postId, $primary(['category' => $choices['Edited']['id']]));
        $memoizer->clear();
        $missing = YoastSEO()->meta->for_post($postId)->context;
        $check($trailIds($generator->generate($missing)) === [
            $choices['Edited']['root'], $choices['Edited']['id'],
        ], 'A missing model must render the preview without a persisted lazy build.');
        $check($indexables() === $cold, 'Missing post models must remain unpersisted throughout the preview.');
        $bind($postId, []);
        $memoizer->clear();
        $missing = YoastSEO()->meta->for_post($postId)->context;
        $check($generator->generate($missing) == $saved, 'Cold baselines must preserve the native saved trail.');
        $check($indexables() === $cold, 'Even unchanged cold baselines must not write indexables.');
        $child = $repository->query()->where('object_id', $childId)->where('object_type', 'post')->find_one();
        $check((bool) $child, 'The parent-hierarchy fixture must have an indexed child.');
        $hierarchy->clear_ancestors($child->id);
        $child->delete();
        $cold = $indexables();
        $bind($childId, $primary(['category' => $choices['Edited']['id']]));
        $memoizer->clear();
        $missing = YoastSEO()->meta->for_post($childId)->context;
        $check($generator->generate($missing) == $childSaved, 'Cold children must reuse native parent breadcrumbs.');
        $check($indexables() === $cold, 'Cold parent-hierarchy reads must not persist this child’s preview.');
        $other = $repository->query()->where('object_id', $otherId)->where('object_type', 'post')->find_one();
        $check(
            $adapter->allowIndexableSave(true, $other) && !$adapter->allowIndexableSave(false, $other),
            'Unrelated models retain their native save decision.'
        );
        $check($live->snapshotFingerprint($postId) === $before, 'Lazy builds must preserve saved metadata and terms.');
        $check($live->snapshotFingerprint($recoveryId) === $recovery, 'Lazy builds must preserve recovery data.');
        $adapter->unbindPreview();
        $check(!has_filter('wpseo_should_save_indexable', [$adapter, 'allowIndexableSave']), 'Write guard releases.');
    }
    WP_CLI::success('Yoast primaries, native breadcrumbs, hierarchy, permissions, history and indexables passed.');
} finally {
    if ($deny) {
        remove_filter('map_meta_cap', $deny);
    }
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
    foreach ($originalGlobals as $key => $value) {
        if ($value === null) {
            unset($GLOBALS[$key]);
        } else {
            $GLOBALS[$key] = $value;
        }
    }
    wp_set_current_user($user ?: $originalUser);
    foreach (array_reverse($posts) as $id) {
        wp_delete_post($id, true);
    }
    foreach (array_reverse($terms) as [$id, $taxonomy]) {
        wp_delete_term($id, $taxonomy);
    }
    unregister_taxonomy('mtflpp_yoast_topic');
    if (is_int($user) && $user > 0) {
        wp_delete_user($user);
    }
    if (!$themeSupports) {
        remove_theme_support('yoast-seo-breadcrumbs');
    }
    remove_filter('option_wpseo_titles', $options);
    WPSEO_Options::clear_cache();
    wp_set_current_user($originalUser);
}
