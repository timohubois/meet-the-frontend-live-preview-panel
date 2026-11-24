<?php

/** Run with `wp eval-file tests/date-terms.php` on a disposable single-site installation. */

use MeetTheFrontendLivePreviewPanel\FrontendPreview;
use MeetTheFrontendLivePreviewPanel\LivePreview;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(LivePreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a single-site installation with this plugin active.');
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
$users = [];
$posts = [];
$terms = [];
$hooks = [];
foreach (['the_preview', 'get_post_metadata', 'get_the_terms', 'timber/post/import_data'] as $hook) {
    $hooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
}
$timezone = static fn (): string => 'Europe/Berlin';
add_filter('pre_option_timezone_string', $timezone);
$permalinks = static fn (): string => '/%year%/%monthnum%/%author%/%postname%/';
add_filter('pre_option_permalink_structure', $permalinks);
register_taxonomy('mtflpp_topic', 'post', [
    'public' => true, 'show_in_rest' => true, 'rest_base' => 'preview_topics',
]);
register_taxonomy('mtflpp_restricted', 'post', [
    'public' => true, 'show_in_rest' => true, 'capabilities' => ['assign_terms' => 'manage_options'],
]);
register_taxonomy('mtflpp_hidden', 'post', ['public' => true, 'show_in_rest' => false]);
register_taxonomy('mtflpp_ordered', 'post', [
    'public' => true, 'show_in_rest' => true, 'args' => ['orderby' => 'id', 'order' => 'DESC'],
]);
$live = new LivePreview();
$frontend = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $live);
$send = static function (string $route, array $data, string $method = 'POST'): WP_REST_Response {
    $request = new WP_REST_Request($method, $route);
    $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
    $request->set_body_params($data);
    return rest_ensure_response(rest_do_request($request));
};
$block = static fn (string $name, int $postId, array $attrs): WP_Block => new WP_Block([
    'blockName' => $name, 'attrs' => $attrs, 'innerBlocks' => [], 'innerHTML' => '', 'innerContent' => [],
], ['postId' => $postId, 'postType' => 'post']);
$bind = static function (int $id, array $input = []) use ($send, $live, $frontend, $check): array {
    $response = $send('/meet-the-frontend-live-preview-panel/v1/posts/' . $id . '/preview', [
        'base' => $live->fingerprint($id), ...$input,
    ]);
    $check($response->get_status() === 200, 'Preview failed: ' . wp_json_encode($response->get_data()));
    parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $query);
    $_GET = $query;
    $frontend->authorizePreview();
    return $query;
};
try {
    foreach (['administrator', 'author'] as $role) {
        $id = wp_insert_user([
            'user_login' => 'mtflpp_date_terms_' . $role . '_' . wp_generate_password(12, false, false),
            'user_pass' => wp_generate_password(32), 'role' => $role,
        ]);
        $check(!is_wp_error($id), 'Could not create a fixture user.');
        $users[] = $id;
    }
    [$admin, $author] = $users;
    wp_set_current_user($admin);
    $choices = [];
    foreach (['category', 'post_tag', 'mtflpp_topic', 'mtflpp_restricted'] as $taxonomy) {
        foreach (['Saved', 'Edited'] as $label) {
            $term = wp_insert_term('MTFLPP ' . $label . ' ' . wp_generate_password(10, false, false), $taxonomy);
            $check(!is_wp_error($term), 'Could not create fixture terms.');
            $choices[$taxonomy][$label] = (int) $term['term_id'];
            $terms[] = [$term['term_id'], $taxonomy];
        }
    }
    $ordered = [];
    foreach (['Alpha', 'Beta', 'Gamma'] as $label) {
        $term = wp_insert_term('MTFLPP ' . $label . ' ' . wp_generate_password(10, false, false), 'mtflpp_ordered');
        $check(!is_wp_error($term), 'Could not create ordered terms.');
        $ordered[] = (int) $term['term_id'];
        $terms[] = [$term['term_id'], 'mtflpp_ordered'];
    }
    foreach (['publish', 'draft', 'future'] as $status) {
        $id = wp_insert_post([
            'post_type' => 'post', 'post_status' => $status, 'post_author' => $author,
            'post_title' => 'MTFLPP date/terms fixture', 'post_content' => 'Saved content',
            'post_date' => $status === 'future' ? '2035-01-10 13:00:00' : '2020-01-10 13:00:00',
            'post_date_gmt' => $status === 'future' ? '2035-01-10 12:00:00' : '2020-01-10 12:00:00',
        ], true);
        $check(!is_wp_error($id), 'Could not create a fixture post.');
        $posts[] = $id;
        foreach ($choices as $taxonomy => $ids) {
            wp_set_object_terms($id, [$ids['Saved']], $taxonomy);
        }
    }
    [$postId, $otherId, $scheduledId] = $posts;
    wp_set_object_terms($postId, array_slice($ordered, 0, 2), 'mtflpp_ordered');
    $nativeOrder = wp_list_pluck(get_the_terms($postId, 'mtflpp_ordered'), 'term_id');
    $check($nativeOrder === [$ordered[1], $ordered[0]], 'The registered descending order must be active.');
    $bind($postId);
    $check(
        wp_list_pluck(get_the_terms($postId, 'mtflpp_ordered'), 'term_id') === $nativeOrder,
        'Unchanged selections must retain registered taxonomy ordering.'
    );
    $decorate = static function ($list, int $id, string $taxonomy) use ($postId) {
        if ($id === $postId && $taxonomy === 'mtflpp_ordered' && is_array($list)) {
            $list = array_reverse($list);
        }
        return $list;
    };
    add_filter('get_the_terms', $decorate, 0, 3);
    try {
        $check(
            wp_list_pluck(get_the_terms($postId, 'mtflpp_ordered'), 'term_id') === array_reverse($nativeOrder),
            'Unchanged selections must preserve earlier term-list filters.'
        );
    } finally {
        remove_filter('get_the_terms', $decorate, 0);
    }
    $bind($postId, ['terms' => wp_json_encode(['mtflpp_ordered' => [$ordered[0], $ordered[2]]])]);
    $check(
        wp_list_pluck(get_the_terms($postId, 'mtflpp_ordered'), 'term_id') === [$ordered[2], $ordered[0]],
        'Changed selections must also respect registered ordering, including unassigned terms.'
    );
    $check(
        wp_list_pluck(get_object_term_cache($postId, 'mtflpp_ordered'), 'term_id') === $nativeOrder,
        'Ordered preview reads must leave the relationship cache native.'
    );
    $bind($postId);
    $recoveryId = _wp_put_post_revision($postId, true);
    $check(is_int($recoveryId), 'Could not create a recovery fixture.');
    $recovery = $live->fingerprint($recoveryId);
    $scheduled = wp_next_scheduled('publish_future_post', [$scheduledId]);
    $counts = array_map(static fn (array $item): int => get_term($item[0], $item[1])->count, $terms);
    foreach ($posts as $id) {
        $base = $live->fingerprint($id);
        $parent = clone get_post($id);
        $sourceId = 0;
        foreach (['2024-07-15T13:45:00', '2024-01-15T13:45:00+03:00', '2036-07-15T13:45:00Z'] as $date) {
            $params = $bind($id, ['date' => $date, 'author' => $admin]);
            $source = (int) $params['mtflpp_revision'];
            $check(!$sourceId || $source === $sourceId, 'Date changes must reuse the owned source.');
            $sourceId = $source;
            [$local, $utc] = rest_get_date_with_gmt($date);
            $display = $frontend->readPost(clone get_post($id));
            $check(
                $display->post_date === $local && $display->post_date_gmt === $utc,
                'Dates must use native local/UTC conversion.'
            );
            $check(
                $display->post_modified === $parent->post_modified,
                'Last modified must continue to reflect actual saves.'
            );
            $check(get_the_date('Y-m-d H:i:s', $display) === $local, 'Date reads must see the selected date.');
            $check(get_post_time('Y-m-d H:i:s', true, $display) === $utc, 'GMT reads must see the selected date.');
            $dateBlock = $block('core/post-date', $id, ['format' => 'Y-m-d H:i:s', 'isLink' => true]);
            $context = $dateBlock->context;
            $html = $dateBlock->render();
            $check($dateBlock->context === $context, 'The real date block context must remain unchanged.');
            $check(str_contains($html, $local), 'The native Post Date block must display the preview date.');
            $check(str_contains($html, esc_url(get_permalink($id))), 'Date block links must retain parent routing.');
            $excerptHtml = $block('core/post-excerpt', $id, ['moreText' => 'Read more'])->render();
            $check(
                str_contains($excerptHtml, 'href="' . esc_url(get_permalink($id)) . '"'),
                'Excerpt links must use saved-parent routing despite unsaved author/date permalink tokens.'
            );
            $check($live->fingerprint($id) === $base, 'Date preview must not update parent fields or relationships.');
            $check(get_post($source)->post_status === 'mtflpp-preview', 'Date selection must not schedule the source.');
            $check(get_post($id) == $parent, 'The saved parent and cached fields must remain unchanged.');
            $import = apply_filters('timber/post/import_data', (array) $parent, $parent);
            if (class_exists(\Timber\Timber::class) && !method_exists(\Timber\Post::class, 'import_custom')) {
                $check(
                    $import['post_date'] === $local && $import['post_date_gmt'] === $utc,
                    'Timber 2 must import both publication dates.'
                );
            }
        }
        foreach ([null, ''] as $reset) {
            $params = $bind($id, ['date' => $reset]);
            $display = $frontend->readPost(clone get_post($id));
            $check(abs(time() - get_post_timestamp($display)) < 5, 'Reset dates must display the current time.');
            $check(get_post_status($id) === $parent->post_status, 'Date resets must not change publication status.');
        }
        $bind($id);
        $check(
            $frontend->readPost(clone get_post($id))->post_date === $parent->post_date,
            'Omitting date must reseed the saved date.'
        );
        $check($live->fingerprint($id) === $base, 'Date resets must stay preview-local.');
    }
    $check(
        wp_next_scheduled('publish_future_post', [$scheduledId]) === $scheduled,
        'Preview dates must not change publishing events.'
    );
    if (get_block_bindings_source('core/post-data')) {
        $explicit = $block('core/post-date', $scheduledId, [
            'datetime' => '2001-01-01T12:00:00Z', 'format' => 'Y-m-d',
        ])->render();
        $check(str_contains($explicit, '2001-01-01'), 'Explicit block dates must not be overridden.');
        $otherBlock = $block('core/post-date', $otherId, []);
        $value = apply_filters('block_bindings_source_value', 'Unchanged', 'core/post-data', [
            'field' => 'date',
        ], $otherBlock);
        $check($value === 'Unchanged', 'Other-post date bindings must remain unchanged.');
    }
    $bind($scheduledId, ['date' => '2020-01-01T12:00:00']);
    $modified = $block('core/post-date', $scheduledId, ['displayType' => 'modified', 'format' => 'Y-m-d'])->render();
    $check(
        str_contains($modified, substr(get_post($scheduledId)->post_modified, 0, 10)),
        'Modified-date blocks must retain the saved timestamp while comparing against the preview publication date.'
    );
    $nestedHtml = '';
    $nestedDate = static function ($date, $format, WP_Post $post) use ($scheduledId, $otherId, $block, &$nestedHtml) {
        if ($post->ID === $scheduledId) {
            $nestedHtml = $block('core/post-date', $otherId, ['isLink' => true])->render();
        }
        return $date;
    };
    add_filter('get_the_date', $nestedDate, 10, 3);
    try {
        $block('core/post-date', $scheduledId, ['isLink' => true])->render();
        $check(
            str_contains($nestedHtml, esc_url(get_permalink($otherId))),
            'Nested date blocks must retain their own permalink while private routing hooks are active.'
        );
    } finally {
        remove_filter('get_the_date', $nestedDate);
    }
    $linkHooks = [];
    foreach (['post_link', 'post_type_link'] as $hook) {
        $linkHooks[$hook] = $GLOBALS['wp_filter'][$hook]->callbacks ?? [];
    }
    $throwDate = static function ($date, $format, WP_Post $post) use ($scheduledId) {
        if ($post->ID === $scheduledId) {
            throw new RuntimeException('mtflpp_date_fixture');
        }
        return $date;
    };
    add_filter('get_the_date', $throwDate, PHP_INT_MAX, 3);
    try {
        $thrown = false;
        try {
            $block('core/post-date', $scheduledId, ['isLink' => true])->render();
        } catch (RuntimeException $error) {
            $thrown = $error->getMessage() === 'mtflpp_date_fixture';
        }
        $check($thrown, 'The native date callback must actually throw for the cleanup test.');
        foreach ($linkHooks as $hook => $callbacks) {
            $check(
                ($GLOBALS['wp_filter'][$hook]->callbacks ?? []) === $callbacks,
                'Date routing hooks must release after exceptions without removing unrelated filters.'
            );
        }
    } finally {
        remove_filter('get_the_date', $throwDate, PHP_INT_MAX);
    }
    $base = $live->fingerprint($postId);
    $selection = array_map(static fn (array $ids): array => [$ids['Edited']], $choices);
    $params = $bind($postId, ['terms' => wp_json_encode($selection)]);
    $sourceId = (int) $params['mtflpp_revision'];
    foreach ($choices as $taxonomy => $ids) {
        wp_cache_delete($postId, $taxonomy . '_relationships');
        $list = get_the_terms($postId, $taxonomy);
        $check(wp_list_pluck($list, 'term_id') === [$ids['Edited']], 'Native term lists must use the selection.');
        $check(
            get_object_term_cache($postId, $taxonomy)[0]->term_id === $ids['Saved'],
            'Relationship caches must retain saved terms.'
        );
        $check(
            wp_get_object_terms($postId, $taxonomy, ['fields' => 'ids']) === [$ids['Saved']],
            'Direct relationship queries must remain saved.'
        );
        $check(
            get_the_terms($otherId, $taxonomy)[0]->term_id === $ids['Saved'],
            'Other post term contexts must remain saved.'
        );
        $html = $block('core/post-terms', $postId, ['term' => $taxonomy])->render();
        $check(str_contains($html, get_term($ids['Edited'], $taxonomy)->name), 'Term blocks must use the selection.');
        $check(str_contains($html, esc_url(get_term_link($ids['Edited'], $taxonomy))), 'Term links must stay valid.');
    }
    $check($live->fingerprint($postId) === $base, 'Term previews must not write relationships.');
    $bind($postId, ['terms' => '{"category":[],"post_tag":[],"mtflpp_topic":[]}']);
    foreach (['category', 'post_tag', 'mtflpp_topic'] as $taxonomy) {
        $check(get_the_terms($postId, $taxonomy) === false, 'Empty selections must remove term lists.');
        $check(
            $block('core/post-terms', $postId, ['term' => $taxonomy])->render() === '',
            'Cleared term blocks must be empty.'
        );
    }
    $check(
        $live->authorizedSource($postId, $sourceId, $params['mtflpp_token']) === null,
        'Changed terms must invalidate earlier source tokens.'
    );
    $params = $bind($postId);
    $check(
        get_the_terms($postId, 'category')[0]->term_id === $choices['category']['Saved'],
        'Omitted terms must reseed saved assignments.'
    );
    $sourceBase = $live->fingerprint($sourceId);
    $invalidInputs = [
        ['date' => 'not-a-date'], ['date' => []], ['date' => '2024-13-15T10:00:00'],
        ['date' => '2024-02-30T10:00:00'],
        ['terms' => 'invalid'], ['terms' => '[]'], ['terms' => '{"category":1}'],
        ['terms' => '{"category":[-1]}'], ['terms' => '{"category":[1.5]}'],
        ['terms' => '{"category":[2147483647]}'], ['terms' => '{"unknown":[]}'],
        ['terms' => '{"mtflpp_hidden":[]}'],
        ['terms' => wp_json_encode(['category' => [$choices['post_tag']['Edited']]])],
    ];
    foreach ($invalidInputs as $input) {
        $response = $send('/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview', [
            'base' => $base, ...$input,
        ]);
        $check($response->get_status() === 400, 'Invalid input must be rejected: ' . wp_json_encode($input));
        $check(
            $live->fingerprint($sourceId) === $sourceBase && $live->fingerprint($postId) === $base,
            'Rejected inputs must not change any source.'
        );
    }
    wp_set_current_user($author);
    $response = $send('/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview', [
        'base' => $base, 'terms' => '{"mtflpp_restricted":[]}',
    ]);
    $check($response->get_status() === 403, 'Clearing assignments must require the taxonomy capability.');
    $bind($postId, ['terms' => wp_json_encode(['category' => [$choices['category']['Edited']]])]);
    wp_set_current_user($admin);
    $denyTerm = static function (array $caps, string $cap, int $userId, array $args) use ($choices): array {
        return $cap === 'assign_term' && ($args[0] ?? null) === $choices['category']['Edited']
            ? ['do_not_allow'] : $caps;
    };
    add_filter('map_meta_cap', $denyTerm, 10, 4);
    try {
        $response = $send('/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview', [
            'base' => $base, 'terms' => wp_json_encode(['category' => [$choices['category']['Edited']]]),
        ]);
        $check($response->get_status() === 403, 'Per-term assignment restrictions must remain effective.');
    } finally {
        remove_filter('map_meta_cap', $denyTerm, 10);
    }
    $check($live->fingerprint($recoveryId) === $recovery, 'Date/term previews must preserve recovery autosaves.');
    foreach ($terms as $i => [$termId, $taxonomy]) {
        $check(get_term($termId, $taxonomy)->count === $counts[$i], 'Preview selections must not change term counts.');
    }

    $historyId = _wp_put_post_revision($postId);
    $check(is_int($historyId), 'Could not create a saved-history fixture.');
    update_metadata('post', $historyId, LivePreview::DATE_META, ['post_date' => '1990-01-01 00:00:00']);
    update_metadata('post', $historyId, LivePreview::TERMS_META, $selection);
    parse_str(wp_parse_url($frontend->savedPreviewUrl(get_post($postId), $historyId), PHP_URL_QUERY), $saved);
    $_GET = $saved;
    $frontend->authorizePreview();
    $check(
        $frontend->readPost(clone get_post($postId))->post_date === get_post($postId)->post_date,
        'History must retain the saved publication date.'
    );
    $check(
        get_the_terms($postId, 'category')[0]->term_id === $choices['category']['Saved'],
        'History must retain saved taxonomy assignments.'
    );

    $params = $bind($postId, ['date' => '2024-07-15T13:45:00']);
    wp_set_object_terms($postId, [$choices['category']['Edited']], 'category');
    $check($live->fingerprint($postId) !== $base, 'A term-only saved change must alter the baseline.');
    $check(
        $live->authorizedSource($postId, (int) $params['mtflpp_revision'], $params['mtflpp_token']) === null,
        'External term changes must expire old previews.'
    );
    $response = $send('/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview', ['base' => $base]);
    $check($response->get_status() === 409, 'Stale taxonomy baselines must not be silently rebased.');
    remove_filter('get_the_terms', [$frontend, 'readTerms'], 10);
    $response = $send(rest_get_route_for_post($postId), [
        'date' => '2024-07-15T13:45:00', 'categories' => [$choices['category']['Edited']],
        'tags' => [$choices['post_tag']['Edited']], 'preview_topics' => [$choices['mtflpp_topic']['Edited']],
    ], 'PUT');
    $check($response->get_status() === 200, 'Native date and taxonomy saving must remain intact.');
    $response = $send(rest_get_route_for_post($postId), [], 'GET');
    $saved = $response->get_data();
    $check($saved['date'] === '2024-07-15T13:45:00', 'Reopening must retain the saved publication date.');
    $check(
        $saved['preview_topics'] === [$choices['mtflpp_topic']['Edited']],
        'Reopening must retain custom taxonomy assignments.'
    );
    WP_CLI::success('Dates, timezones, native blocks, term lists, caches, permissions and save/reopen passed.');
} finally {
    $_GET = $originalGet;
    remove_filter('pre_option_timezone_string', $timezone);
    remove_filter('pre_option_permalink_structure', $permalinks);
    remove_action('init', [$frontend, 'authorizePreview'], 20);
    remove_action('template_redirect', [$frontend, 'checkPreviewTarget'], -1);
    foreach ($hooks as $hook => $callbacks) {
        if ($callbacks === null) {
            unset($GLOBALS['wp_filter'][$hook]);
        } else {
            $GLOBALS['wp_filter'][$hook] = $callbacks;
        }
    }
    wp_set_current_user($users[0] ?? $originalUser);
    foreach (array_reverse($posts) as $id) {
        wp_delete_post($id, true);
    }
    foreach ($terms as [$id, $taxonomy]) {
        wp_delete_term($id, $taxonomy);
    }
    foreach (['mtflpp_topic', 'mtflpp_restricted', 'mtflpp_hidden', 'mtflpp_ordered'] as $taxonomy) {
        unregister_taxonomy($taxonomy);
    }
    foreach ($users as $id) {
        wp_delete_user($id);
    }
    wp_set_current_user($originalUser);
}
