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
    $sourceId = null;
    $cases = [
        [[KEY => 'New'], 'New'], [[KEY => ''], ''], [[], 'Saved note'],
        [[KEY => "<b>Editor's</b> C:\\draft"], "Editor's C:\\draft"],
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
    $_GET = $query;
    $frontend->authorizePreview();
    $block = parse_blocks('<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta",'
        . '"args":{"key":"example_post_note"}}}}} --><p></p><!-- /wp:paragraph -->')[0];
    $render = static fn (int $id) => wp_strip_all_tags((new WP_Block($block, ['postId' => $id, 'postType' => 'post']))
        ->render());
    $check($render($postId) === $expected && $render($otherId) === 'Unrelated note', 'Scope the bound Paragraph.');
    parse_str(wp_parse_url($frontend->savedPreviewUrl(get_post($postId), $postId), PHP_URL_QUERY), $savedQuery);
    $_GET = $savedQuery;
    $frontend->authorizePreview();
    $check($render($postId) === 'Saved note', 'A current-saved preview must release the live read.');
    $response = $send('/wp/v2/posts/' . $postId, ['meta' => [KEY => 'Explicit save']]);
    $check($response->get_status() === 200 && $render($postId) === 'Explicit save', 'Native Save owns persistence.');
    WP_CLI::success('Post note example: live edits, clearing, omission, scoped rendering and native Save passed.');
} finally {
    $_GET = $originalGet;
    foreach ($posts as $id) {
        wp_delete_post($id, true);
    }
    wp_set_current_user($originalUser);
    if (is_int($user) && $user) {
        wp_delete_user($user);
    }
}
