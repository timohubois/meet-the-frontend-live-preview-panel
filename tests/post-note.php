<?php

/** Exercise the actual two-file integration example on a disposable WordPress installation. */

use LivePreviewExample\PostNote\LiveNote;
use MeetTheFrontendLivePreviewPanel\FrontendPreview;
use MeetTheFrontendLivePreviewPanel\LivePreview;

use const LivePreviewExample\PostNote\KEY;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(LivePreview::class)) {
    throw new RuntimeException('Run through WP-CLI with the panel active on a disposable installation.');
}
if (is_multisite()) {
    global $wpdb;
    if ($wpdb->base_prefix !== 'mtflpp_test_' || getenv('MTFLPP_TEST_UNINSTALL') !== '1') {
        throw new RuntimeException('Create a fixture subsite only on the opted-in disposable test network.');
    }
    require_once ABSPATH . 'wp-admin/includes/ms.php';
}
require_once ABSPATH . 'wp-admin/includes/user.php';
if (!class_exists(LiveNote::class)) {
    require dirname(__DIR__) . '/docs/examples/post-note/post-note.php';
    (new LiveNote())->registerField(); // WP-CLI ran init before loading the example.
}
$check = static function (bool $ok, string $message): void {
    if (!$ok) {
        throw new RuntimeException(esc_html($message));
    }
};
$live = new LivePreview();
$frontend = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $live);
$originalUser = get_current_user_id();
// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Restore the CLI request after frontend reads.
$originalGet = $_GET;
$user = $peer = 0;
$posts = [];
$sanitizeHook = 'sanitize_post_meta_' . KEY . '_for_post';
$field = get_registered_meta_keys('post', 'post')[KEY];
try {
    register_post_meta('post', KEY, ['default' => 'Default note'] + $field);
    $user = wp_insert_user([
        'user_login' => 'mtflpp_note_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(), 'role' => 'author',
    ]);
    $check(is_int($user), 'Could not create the fixture author.');
    wp_set_current_user($user);
    foreach (['Saved note', 'No stored note'] as $title) {
        $id = wp_insert_post(['post_status' => 'publish', 'post_title' => $title, 'post_author' => $user], true);
        $check(is_int($id) && $id > 0, 'Could not create the fixture post.');
        $posts[] = $id;
    }
    [$postId, $otherId] = $posts;
    update_post_meta($postId, KEY, 'Saved note');
    $recoveryId = _wp_put_post_revision($postId, true);
    $check(is_int($recoveryId) && $recoveryId > 0, 'Could not create the fixture recovery autosave.');
    $recovery = $live->snapshotFingerprint($recoveryId);
    $parent = $live->snapshotFingerprint($postId);
    $base = $live->fingerprint($postId);
    $send = static function (string $route, array $data): WP_REST_Response {
        $request = new WP_REST_Request('POST', $route);
        $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
        $request->set_header('Content-Type', 'application/json');
        $request->set_body(wp_json_encode($data));
        return rest_do_request($request);
    };
    $prepare = static fn (array $data) => $send(
        '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview',
        ['base' => $base] + $data
    );
    $check($prepare([KEY => null])->get_status() === 400, 'Null is not a text edit or an omitted note.');
    $authHook = 'auth_post_meta_' . KEY . '_for_post';
    add_filter($authHook, '__return_false');
    try {
        $check($prepare([KEY => 'Denied'])->get_status() === 403, 'Post editing alone must not grant field access.');
        $check($prepare([])->get_status() === 200, 'An unchanged note needs no field edit permission.');
    } finally {
        remove_filter($authHook, '__return_false');
    }
    $blockWrite = static fn ($check, int $id, string $key) => $key === KEY && wp_is_post_revision($id) ? false : $check;
    add_filter('update_post_metadata', $blockWrite, 10, 3);
    try {
        $failed = $prepare([KEY => 'Not stored']);
        $check(
            $failed->get_status() === 409 && $failed->get_data()['code'] === 'example_note_not_saved',
            'Do not report a usable note when the preview metadata write was refused.'
        );
    } finally {
        remove_filter('update_post_metadata', $blockWrite, 10);
    }
    add_filter($sanitizeHook, 'strtoupper', 20);
    $sourceId = null;
    $edit = "<b>Editor's</b> C:\\draft";
    $cases = [
        [[KEY => 'New'], 'NEW'], [[KEY => ''], ''], [[], 'Saved note'],
        [[KEY => $edit, 'excerpt' => 'Preview excerpt'], "EDITOR'S C:\\DRAFT"],
    ];
    foreach ($cases as [$input, $expected]) {
        $response = $prepare($input);
        $check($response->get_status() === 200, 'Expected a live preview URL.');
        parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $query);
        $id = (int) $query['mtflpp_revision'];
        $sourceId ??= $id;
        $check($id === $sourceId && get_post_meta($id, KEY, true) === $expected, 'Wrong note on reused source.');
    }
    $check(
        $live->snapshotFingerprint($postId) === $parent && $live->snapshotFingerprint($recoveryId) === $recovery,
        'Editing, clearing and omitting the note must leave the parent and recovery autosave unchanged.'
    );
    $show = static function (string $url) use ($frontend): void {
        parse_str(wp_parse_url($url, PHP_URL_QUERY), $query);
        $_GET = $query;
        $frontend->authorizePreview();
    };
    $show($response->get_data()['url']);
    $block = parse_blocks('<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta",'
        . '"args":{"key":"example_post_note"}}}}} --><p></p><!-- /wp:paragraph -->')[0];
    $render = static fn (int $id, ?array $parsed = null) => wp_strip_all_tags(
        (new WP_Block($parsed ?? $block, ['postId' => $id, 'postType' => 'post']))->render()
    );
    $check($render($postId) === $expected && $render($otherId) === 'Default note', 'Scope the bound Paragraph.');
    if (is_multisite()) {
        $peer = wp_insert_site([
            'domain' => wp_parse_url(home_url(), PHP_URL_HOST), 'path' => '/mtflpp-post-note-' . $user . '/',
            'title' => 'Post note fixture', 'user_id' => $user,
        ]);
        $check(is_int($peer) && $peer > 0, 'Could not create the fixture subsite.');
        // Bind document-only reads (including password handling) on the authorized site.
        $previousQuery = $GLOBALS['wp_query'];
        try {
            $GLOBALS['wp_query'] = new WP_Query(['p' => $postId, 'preview' => true]);
            $frontend->checkPreviewTarget();
        } finally {
            $GLOBALS['wp_query'] = $previousQuery;
        }
        $requiresPassword = static function (int $id): bool {
            $post = clone get_post($id);
            $post->post_password = 'fixture-password';
            return post_password_required($post);
        };
        $check(!$requiresPassword($postId), 'The matching preview document must bind its password exception.');
        $excerpt = parse_blocks('<!-- wp:post-excerpt /-->')[0];
        switch_to_blog($peer);
        try {
            $id = wp_insert_post([
                'import_id' => $postId, 'post_title' => 'Peer post', 'post_excerpt' => 'Peer excerpt',
                'post_status' => 'publish',
            ], true);
            $check($id === $postId, 'Use matching numeric post IDs on the two sites.');
            update_post_meta($id, KEY, 'PEER NOTE');
            $check($render($id) === 'PEER NOTE', 'A switched site must read its own saved note.');
            update_post_meta($id, '_thumbnail_id', 42);
            $check(get_post_thumbnail_id($id) === 42, 'A switched site must keep its own featured image.');
            $check(
                apply_filters('the_preview', clone get_post($id))->post_title === 'Peer post',
                'A switched site must keep its own post fields.'
            );
            $check(trim($render($id, $excerpt)) === 'Peer excerpt', 'Core blocks must render the switched post.');
            $check($requiresPassword($id), 'The preview must not unlock a protected post on the switched site.');
        } finally {
            restore_current_blog();
        }
        $check(
            $render($postId) === $expected && trim($render($postId, $excerpt)) === 'Preview excerpt',
            'Restoring the preview site must restore its live reads.'
        );
    }
    // The parent-key read is still bound to the live revision; it cannot stand in for the saved baseline.
    add_filter('add_post_metadata', $blockWrite, 10, 3);
    try {
        $failed = $prepare([]);
        $check(
            $failed->get_status() === 409 && $failed->get_data()['code'] === 'example_note_not_saved',
            'Omitting the note must not authorize a reused revision when copying the saved note failed.'
        );
    } finally {
        remove_filter('add_post_metadata', $blockWrite, 10);
    }
    $otherRoute = '/meet-the-frontend-live-preview-panel/v1/posts/' . $otherId . '/preview';
    $otherBase = $live->fingerprint($otherId);
    $defaultCases = [
        [[], 'Default note', false],
        [[KEY => ''], '', true],
    ];
    foreach ($defaultCases as [$input, $text, $exists]) {
        $other = $send($otherRoute, ['base' => $otherBase] + $input);
        $check($other->get_status() === 200, 'Expected a live preview for the second post.');
        $show($other->get_data()['url']);
        $check($render($otherId) === $text, 'Use the post default only when no note was stored.');
        $check(metadata_exists('post', $otherId, KEY) === $exists, 'A cleared note exists; an omitted one does not.');
    }
    $check($render($postId) === 'Saved note', 'Replace the previous live read.');
    $show($frontend->savedPreviewUrl(get_post($otherId), $otherId));
    $check($render($otherId) === 'Default note', 'A current-saved preview must release the live read.');
    $response = $send('/wp/v2/posts/' . $postId, ['meta' => [KEY => $edit]]);
    $check($response->get_status() === 200 && $render($postId) === $expected, 'Native Save must match the preview.');
    WP_CLI::success('Post note example: live edits, clearing, omission, scoped rendering and native Save passed.');
} finally {
    remove_filter($sanitizeHook, 'strtoupper', 20);
    register_post_meta('post', KEY, $field);
    $_GET = $originalGet;
    foreach ($posts as $id) {
        wp_delete_post($id, true);
    }
    if (is_int($peer) && $peer > 0) {
        wp_delete_site($peer);
    }
    wp_set_current_user($originalUser);
    if (is_int($user) && $user) {
        if (is_multisite()) {
            wpmu_delete_user($user);
        } else {
            wp_delete_user($user);
        }
    }
}
