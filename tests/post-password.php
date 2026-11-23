<?php

/** Run with `wp eval-file tests/post-password.php` on a disposable WordPress installation with this plugin active. */

use MeetTheFrontendLivePreviewPanel\FrontendPreview;
use MeetTheFrontendLivePreviewPanel\LivePreview;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(FrontendPreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a disposable single site with the plugin active.');
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
$originalQuery = $GLOBALS['wp_query'];
$hooks = [
    'post_password_required', 'the_preview', 'template_redirect', 'get_post_metadata', 'get_the_terms',
    'wp_head', 'wp_enqueue_scripts', 'show_admin_bar', 'wp_die_handler',
];
$originalHooks = [];
foreach ($hooks as $hook) {
    $originalHooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
}
$resetHooks = static function () use ($originalHooks): void {
    foreach ($originalHooks as $hook => $callbacks) {
        if ($callbacks === null) {
            unset($GLOBALS['wp_filter'][$hook]);
        } else {
            $GLOBALS['wp_filter'][$hook] = clone $callbacks;
        }
    }
};

$posts = [];
$live = new LivePreview();
$preview = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $live);
try {
    $editor = wp_insert_user([
        'user_login' => 'mtflpp_password_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(32), 'role' => 'editor',
    ]);
    $check(is_int($editor), 'Could not create the fixture editor.');
    wp_set_current_user($editor);
    $password = wp_generate_password(20, false, false);
    foreach (['Selected post', 'Unrelated post'] as $title) {
        $id = wp_insert_post([
            'post_title' => $title, 'post_password' => $password, 'post_status' => 'publish',
            'post_content' => 'Saved content', 'post_author' => $editor,
        ], true);
        $check(is_int($id) && $id > 0, 'Could not create a protected post fixture.');
        $posts[] = $id;
    }
    [$postId, $otherId] = $posts;
    $post = get_post($postId);
    $revisionId = _wp_put_post_revision($postId);
    $check(is_int($revisionId) && $revisionId > 0, 'Could not create the saved revision fixture.');
    wp_update_post(['ID' => $revisionId, 'post_content' => 'Historical content']);
    $savedUrl = $preview->savedPreviewUrl($post, $revisionId);
    $check(is_string($savedUrl), 'Could not create the saved preview URL.');

    $request = new WP_REST_Request('POST', '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview');
    $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
    $request->set_body_params(['base' => $live->fingerprint($postId), 'content' => 'Unsaved content']);
    $response = rest_do_request($request);
    $check($response->get_status() === 200, 'Could not prepare the live preview.');

    foreach ([$savedUrl => 'Historical content', $response->get_data()['url'] => 'Unsaved content'] as $url => $text) {
        parse_str(wp_parse_url($url, PHP_URL_QUERY), $params);
        $_GET = $params;
        $preview->authorizePreview();
        $GLOBALS['wp_query'] = new WP_Query(['p' => $postId]);
        $preview->checkPreviewTarget();
        $check(post_password_required($postId), 'A non-preview query must not unlock the post.');

        $GLOBALS['wp_query'] = new WP_Query(['p' => $otherId, 'preview' => true]);
        $preview->checkPreviewTarget();
        $check(post_password_required($postId), 'A preview routed to another post must not unlock the source.');

        $GLOBALS['wp_query'] = new WP_Query(['p' => $postId, 'preview' => true]);
        $preview->checkPreviewTarget();
        $check(!post_password_required($postId), 'The authorized preview must not require a password.');
        $content = get_the_content(null, false, $GLOBALS['wp_query']->post);
        $check($content === $text, 'Core must render the selected preview content.');
        $check(post_password_required($otherId), 'Other posts must stay protected even with the same password.');
        $resetHooks();

        wp_set_current_user(0);
        add_filter('wp_die_handler', static fn () => static function ($message, $title, $args): void {
            throw new RuntimeException('Preview request rejected.', (int) ($args['response'] ?? 0));
        });
        $status = null;
        try {
            $preview->authorizePreview();
        } catch (RuntimeException $error) {
            $status = $error->getCode();
        }
        $check($status === 403, 'A preview link must not grant access to a logged-out visitor.');
        $_GET = [];
        $preview->authorizePreview();
        $GLOBALS['wp_query'] = new WP_Query(['p' => $postId]);
        $content = get_the_content(null, false, $GLOBALS['wp_query']->post);
        $check(str_contains($content, 'post-password-form'), 'The public post must still show its password form.');
        $resetHooks();
        wp_set_current_user($editor);
    }
    $check(get_post($postId)->post_password === $password, 'Previewing must not change the saved password.');
    WP_CLI::success('Password-protected live previews, saved revisions and public access passed.');
} finally {
    $resetHooks();
    $_GET = $originalGet;
    $GLOBALS['wp_query'] = $originalQuery;
    foreach ($posts as $id) {
        wp_delete_post($id, true);
    }
    if (is_int($editor ?? null)) {
        wp_delete_user($editor);
    }
    wp_set_current_user($originalUser);
}
