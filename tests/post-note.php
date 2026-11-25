<?php

/** Exercise the actual two-file integration example on a disposable single-site installation. */

use MeetTheFrontendLivePreviewPanel\FrontendPreview;
use MeetTheFrontendLivePreviewPanel\LivePreview;

use const LivePreviewExample\PostNote\KEY;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(LivePreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI with the panel active on a disposable single site.');
}
require_once ABSPATH . 'wp-admin/includes/user.php';
if (!class_exists(\LivePreviewExample\PostNote\LiveNote::class)) {
    require dirname(__DIR__) . '/docs/examples/post-note/post-note.php';
    \LivePreviewExample\PostNote\register_field(); // WP-CLI has already run init.
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
$user = 0;
$posts = [];
$sanitizeHook = 'sanitize_post_meta_' . KEY . '_for_post';
try {
    $user = wp_insert_user([
        'user_login' => 'mtflpp_note_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(), 'role' => 'author',
    ]);
    $check(is_int($user), 'Could not create the fixture author.');
    wp_set_current_user($user);
    foreach (['Saved note', 'Unrelated note'] as $note) {
        $id = wp_insert_post(['post_status' => 'publish', 'post_title' => $note, 'post_author' => $user], true);
        $check(is_int($id) && $id > 0, 'Could not create the fixture post.');
        $posts[] = $id;
        update_post_meta($id, KEY, $note);
    }
    [$postId, $otherId] = $posts;
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
        [[KEY => $edit], "EDITOR'S C:\\DRAFT"],
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
    $render = static fn (int $id) => wp_strip_all_tags((new WP_Block($block, ['postId' => $id, 'postType' => 'post']))
        ->render());
    $check($render($postId) === $expected && $render($otherId) === 'Unrelated note', 'Scope the bound Paragraph.');
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
    $other = $send('/meet-the-frontend-live-preview-panel/v1/posts/' . $otherId . '/preview', [
        'base' => $live->fingerprint($otherId), KEY => 'Other draft',
    ]);
    $check($other->get_status() === 200, 'Expected a live preview for the second post.');
    $show($other->get_data()['url']);
    $check($render($postId) === 'Saved note' && $render($otherId) === 'OTHER DRAFT', 'Replace the previous live read.');
    $show($frontend->savedPreviewUrl(get_post($otherId), $otherId));
    $check($render($otherId) === 'Unrelated note', 'A current-saved preview must release the live read.');
    $response = $send('/wp/v2/posts/' . $postId, ['meta' => [KEY => $edit]]);
    $check($response->get_status() === 200 && $render($postId) === $expected, 'Native Save must match the preview.');
    WP_CLI::success('Post note example: live edits, clearing, omission, scoped rendering and native Save passed.');
} finally {
    remove_filter($sanitizeHook, 'strtoupper', 20);
    $_GET = $originalGet;
    foreach ($posts as $id) {
        wp_delete_post($id, true);
    }
    wp_set_current_user($originalUser);
    if (is_int($user) && $user) {
        wp_delete_user($user);
    }
}
