<?php

/** Run with `wp eval-file tests/block-editor.php`; fixtures are created and removed on this single site. */

use AFloatingLivePreviewPanel\LivePreview;
use AFloatingLivePreviewPanel\FrontendPreview;

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
$users = [];
$posts = [];
$disableHistory = null;
$live = new LivePreview();
register_post_meta('post', '_aflpp_rejected_meta', [
    'single' => true, 'type' => 'string', 'show_in_rest' => true,
    'auth_callback' => '__return_false',
]);
$server = rest_get_server();
$send = static function (
    string $route,
    array $data,
    ?string $base,
    string $method = 'POST',
    ?string $nonce = null
) use ($server): WP_REST_Response {
    $request = new WP_REST_Request($method, $route);
    $request->set_body_params($data);
    $request->set_header('X-WP-Nonce', $nonce ?? wp_create_nonce('wp_rest'));
    if ($base !== null) {
        $request->set_header('X-AFLPP-Base', $base);
        $request->set_header('X-AFLPP-Request', str_repeat('a', 32));
    }
    return apply_filters('rest_post_dispatch', rest_ensure_response(rest_do_request($request)), $server, $request);
};
$lateMeta = static function (WP_Post $post): void {
    if (get_post_meta($post->ID, '_aflpp_test', true)) {
        update_post_meta($post->ID, '_aflpp_after_rest', 'saved after the core update');
    }
};
add_action('rest_after_insert_post', $lateMeta);
try {
    foreach (['administrator', 'subscriber'] as $role) {
        $id = wp_insert_user([
            'user_login' => 'aflpp_block_' . $role . '_' . wp_generate_password(12, false, false),
            'user_pass' => wp_generate_password(32), 'role' => $role,
        ]);
        $check(!is_wp_error($id), 'Could not create a fixture user.');
        $users[] = $id;
    }
    [$admin, $subscriber] = $users;
    wp_set_current_user($admin);
    $disableHistory = static fn (int $limit, WP_Post $post): int => (int) $post->post_author === $admin ? 0 : $limit;
    add_filter('wp_post_revisions_to_keep', $disableHistory, 10, 2);
    foreach (['draft', 'publish', 'auto-draft'] as $status) {
        $id = wp_insert_post([
            'post_type' => 'post', 'post_status' => $status, 'post_author' => $admin,
            'post_title' => 'AFLPP block editor fixture',
            'post_content' => '<!-- wp:paragraph --><p>Saved</p><!-- /wp:paragraph -->',
        ], true);
        $check(!is_wp_error($id) && $id > 0, 'Could not create a fixture post.');
        $posts[] = $id;
    }
    [$draft, $published, $new] = $posts;
    $check(!wp_revisions_enabled(get_post($draft)), 'The fixture must disable core revision history.');
    $check(!$live->isAvailable(get_post($new)), 'Live previews must still require a first save.');
    $route = rest_get_route_for_post($draft);
    update_post_meta($draft, '_aflpp_test', '1');
    $base = $live->fingerprint($draft);
    $preview = $send('/a-floating-live-preview-panel/v1/posts/' . $draft . '/preview', [
        'base' => $base, 'post_title' => 'Unsaved title',
        'content' => '<!-- wp:paragraph --><p>Unsaved block</p><!-- /wp:paragraph -->', 'excerpt' => 'Unsaved excerpt',
    ], null);
    $check(
        $preview->get_status() === 200,
        'Serialized block content must preview even when core revision history is disabled.'
    );
    $check($live->fingerprint($draft) === $base, 'Preview writes must leave the saved parent untouched.');
    $check(!wp_get_post_autosave($draft, $admin), 'Preview writes must not create a recovery autosave.');
    parse_str(wp_parse_url($preview->get_data()['url'], PHP_URL_QUERY), $query);
    $revision = get_post((int) $query['aflpp_revision']);
    $check(
        $revision
        && str_contains($revision->post_content, '<!-- wp:paragraph -->'),
        'Preview revisions must retain block serialization.'
    );

    $previewRoute = '/a-floating-live-preview-panel/v1/posts/' . $draft . '/preview';
    update_post_meta($draft, '_edit_lock', time() . ':' . $subscriber);
    foreach ([$base, str_repeat('0', 64)] as $lockedBase) {
        $response = $send($previewRoute, ['base' => $lockedBase, 'content' => 'Locked edits'], null);
        $check(
            $response->get_status() === 409 && $response->get_data()['code'] === 'aflpp_post_locked',
            'An edit lock must have its own recoverable response, even when the saved source also changed.'
        );
        $check(
            get_post($revision->ID)->post_content === $revision->post_content && $live->fingerprint($draft) === $base,
            'A locked preview must not change the last preview or the saved parent.'
        );
    }
    wp_set_post_lock($draft);
    $response = $send($previewRoute, ['base' => $base, 'content' => 'Editing after takeover'], null);
    $check($response->get_status() === 200, 'The preview must accept the new editing lock after native takeover.');
    $response = $send($previewRoute, ['base' => str_repeat('0', 64)], null);
    $check(
        $response->get_status() === 409 && $response->get_data()['code'] === 'aflpp_preview_conflict',
        'Resolving an edit lock must not bypass stale-source protection.'
    );
    delete_post_meta($draft, '_edit_lock');

    $images = [];
    foreach (['saved', 'edited'] as $label) {
        $upload = wp_upload_bits(
            'aflpp-image-' . $label . '-' . wp_generate_password(8, false) . '.png',
            null,
            file_get_contents(ABSPATH . 'wp-includes/images/w-logo-blue.png')
        );
        $check(empty($upload['error']), 'Could not create a fixture image.');
        $image = wp_insert_attachment(
            ['post_title' => 'AFLPP image fixture', 'post_mime_type' => 'image/png'],
            $upload['file']
        );
        $check($image > 0, 'Could not create a fixture attachment.');
        $images[] = $image;
        $posts[] = $image;
    }
    update_post_meta($draft, '_thumbnail_id', $images[0]);
    $base = $live->fingerprint($draft);
    foreach ([$images[1], 0, null] as $selection) {
        $data = ['base' => $base, 'content' => '<!-- wp:paragraph --><p>Image preview</p><!-- /wp:paragraph -->'];
        if ($selection !== null) {
            $data['featured_media'] = $selection;
        }
        $response = $send($previewRoute, $data, null);
        $check($response->get_status() === 200, 'Valid featured-image changes must preview.');
        parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $imageQuery);
        $imageRevision = (int) $imageQuery['aflpp_revision'];
        $expected = $selection ?? $images[0];
        $check(
            (int) get_post_meta($imageRevision, '_thumbnail_id', true) === $expected,
            'Featured-image replacement, removal and omitted-input seeding must stay revision-local.'
        );
        $originalHooks = [];
        $previewHooks = ['the_preview', 'timber/post/import_data', 'acf/validate_post_id', 'acf/pre_load_metadata'];
        foreach ($previewHooks as $hook) {
            $originalHooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
        }
        $frontend = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $live);
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Preserve request globals in the CLI fixture.
        $originalGet = $_GET;
        try {
            $_GET = $imageQuery;
            $frontend->authorizePreview();
            $check(
                get_post_thumbnail_id($draft) === $expected,
                'Native frontend image reads must use the authorized live source.'
            );
            $check(
                (int) get_post_meta($draft, '_thumbnail_id', true) === $expected,
                'Themes reading thumbnail metadata directly must see the same live source.'
            );
            $check(get_post_meta($draft, '_aflpp_test', true) === '1', 'Unrelated metadata must not be overlaid.');
            $check(get_post_thumbnail_id($published) === 0, 'Other posts must not inherit the preview image.');
        } finally {
            $_GET = $originalGet;
            remove_action('init', [$frontend, 'authorizePreview'], 20);
            remove_filter('get_post_metadata', [$frontend, 'readRevisionMeta']);
            remove_action('template_redirect', [$frontend, 'checkPreviewTarget'], -1);
            foreach ($originalHooks as $hook => $callbacks) {
                if ($callbacks === null) {
                    unset($GLOBALS['wp_filter'][$hook]);
                } else {
                    $GLOBALS['wp_filter'][$hook] = $callbacks;
                }
            }
        }
        $check(
            $live->fingerprint($draft) === $base && get_post_thumbnail_id($draft) === $images[0],
            'Image previews must leave the parent and its saved image unchanged.'
        );
        $check(!wp_get_post_autosave($draft, $admin), 'Image previews must not create recovery autosaves.');
    }
    $revision = get_post($imageRevision);
    $revisionBase = $live->fingerprint($imageRevision);
    foreach ([-1, [$images[1]], 'invalid', $draft, PHP_INT_MAX] as $invalid) {
        $response = $send($previewRoute, ['base' => $base, 'featured_media' => $invalid], null);
        $check($response->get_status() === 400, 'Invalid or non-image featured media must be rejected.');
        $check(
            $live->fingerprint($draft) === $base && $live->fingerprint($imageRevision) === $revisionBase,
            'Rejected image changes must not alter either the parent or its preview.'
        );
    }

    $response = $send($route, ['title' => 'Native update'], $base, 'PUT');
    $receipt = $response->get_data()['_aflpp_receipt'] ?? [];
    $check($response->get_status() === 200, 'Receipt handling must not replace native REST saves.');
    $check(
        ($receipt['before'] ?? '') === $base
        && ($receipt['request'] ?? '') === str_repeat('a', 32),
        'Receipts must identify exactly their request and initial state.'
    );
    $check(
        ($receipt['after'] ?? '') === $live->fingerprint($draft),
        'The receipt must include metadata saved after the core update.'
    );
    $check(($receipt['available'] ?? false) === true, 'Saved eligible posts must remain available.');
    $check(!get_post($revision->ID), 'Native saves must discard the old internal preview revision.');
    $check(
        wp_get_post_revisions($draft, ['check_enabled' => false]) === [],
        'Previewing and saving must not create native history when revisions are disabled.'
    );

    $base = $live->fingerprint($draft);
    $response = $send($route, ['status' => 'not-a-valid-status'], $base, 'PUT');
    $check(
        $response->get_status() === 400
        && ($response->get_data()['_aflpp_receipt']['after'] ?? '') === $base
        && $live->fingerprint($draft) === $base,
        'Only a correlated unchanged-state receipt can confirm that a rejected save left the baseline intact.'
    );

    $response = $send($route, [
        'title' => 'Saved before the metadata rejection',
        'meta' => ['_aflpp_rejected_meta' => 'Forbidden'],
    ], $base, 'PUT');
    $check(
        $response->get_status() === 403
        && ($response->get_data()['code'] ?? '') === 'rest_cannot_update'
        && get_post($draft)->post_title === 'Saved before the metadata rejection'
        && $live->fingerprint($draft) !== $base
        && !isset($response->get_data()['_aflpp_receipt']),
        'A metadata 403 after wp_update_post must not confirm the old baseline or advance a failed save.'
    );
    unregister_post_meta('post', '_aflpp_rejected_meta');

    $base = $live->fingerprint($draft);
    wp_update_post(['ID' => $draft, 'post_excerpt' => 'External change']);
    $response = $send($route, ['title' => 'Native save still works'], $base, 'PUT');
    $check($response->get_status() === 200, 'A preview conflict must not reject a native save.');
    $check(
        ($response->get_data()['_aflpp_receipt']['after'] ?? '') === 'conflict',
        'An external change must never be silently rebased.'
    );

    foreach ([null, 'bad-base'] as $base) {
        $response = $send($route, ['title' => 'Unmarked native save'], $base, 'PUT');
        $check(
            $response->get_status() === 200
            && !isset($response->get_data()['_aflpp_receipt']),
            'Unmarked or invalid opt-ins must leave native responses unchanged.'
        );
    }
    $response = $send($route, [], $live->fingerprint($draft), 'GET');
    $check(!isset($response->get_data()['_aflpp_receipt']), 'Reads must never advance an editor baseline.');
    $response = $send($route, ['title' => 'No preview authentication'], $live->fingerprint($draft), 'PUT', 'invalid');
    $check(
        !isset($response->get_data()['_aflpp_receipt']),
        'Alternative/internal REST authentication must not bypass our explicit REST nonce contract.'
    );

    $base = $live->fingerprint($draft);
    $response = $send($route . '/autosaves', [
        'title' => 'Draft autosaved', 'content' => '<p>Draft autosave</p>',
    ], $base);
    $check($response->get_status() < 300, 'Native author-draft autosave must work.');
    $check(
        ($response->get_data()['_aflpp_receipt']['after'] ?? '') === $live->fingerprint($draft),
        'Draft autosaves must acknowledge changes to the parent.'
    );
    $check(
        get_post($draft)->post_title === 'Draft autosaved',
        'The fixture must exercise a real parent-writing draft autosave.'
    );

    $base = $live->fingerprint($published);
    foreach (['_encloseme', '_pingme'] as $key) {
        update_post_meta($published, $key, '1');
        $check($live->fingerprint($published) === $base, 'Core queue flags must not invalidate saved-state receipts.');
        delete_post_meta($published, $key);
    }
    foreach (['block-editor', 'classic-editor'] as $editor) {
        update_post_meta($published, 'classic-editor-remember', $editor);
        $response = $send('/a-floating-live-preview-panel/v1/posts/' . $published . '/preview', [
            'base' => $base, 'post_title' => 'Preview after editor preference update',
        ], null);
        $check(
            $response->get_status() === 200 && $live->fingerprint($published) === $base,
            'Remembering or switching editors after enqueue must not invalidate the preview baseline.'
        );
        $check(
            get_post_meta($published, 'classic-editor-remember', true) === $editor,
            'Preview preparation must preserve the saved editor preference.'
        );
    }
    delete_post_meta($published, 'classic-editor-remember');
    update_post_meta($published, 'enclosure', 'https://example.invalid/test.mp3');
    $check($live->fingerprint($published) !== $base, 'Actual enclosure metadata must still invalidate the preview.');
    delete_post_meta($published, 'enclosure');
    $response = $send(rest_get_route_for_post($published) . '/autosaves', [
        'title' => 'Published recovery autosave', 'content' => '<p>Recovery</p>',
    ], $base);
    $check($response->get_status() < 300, 'Published autosaves must work.');
    $check(
        ($response->get_data()['_aflpp_receipt']['after'] ?? '') === $base
        && $live->fingerprint($published) === $base,
        'Published autosaves must keep the unchanged parent baseline.'
    );
    $recovery = wp_get_post_autosave($published, $admin);
    $check(
        $recovery
        && $recovery->post_title === 'Published recovery autosave',
        'Core must retain its recovery autosave.'
    );
    $recoveryBase = $live->fingerprint($recovery->ID);
    $response = $send('/a-floating-live-preview-panel/v1/posts/' . $published . '/preview', [
        'base' => $base, 'post_title' => 'Unsaved changes after recovery autosave',
    ], null);
    $check(
        $response->get_status() === 200 && $live->fingerprint($recovery->ID) === $recoveryBase,
        'Live previews with revisions disabled must leave a genuine recovery autosave intact.'
    );

    $response = $send(
        rest_get_route_for_post($new),
        ['status' => 'draft', 'title' => 'First save'],
        $live->fingerprint($new),
        'PUT'
    );
    $check(
        ($response->get_data()['_aflpp_receipt']['available'] ?? false) === true,
        'A first draft save must enable preview without a reload.'
    );

    wp_set_current_user($subscriber);
    $response = $send($route, ['title' => 'Forbidden'], $live->fingerprint($draft), 'PUT');
    $check(
        $response->get_status() === 403
        && !isset($response->get_data()['_aflpp_receipt']),
        'Unauthorized saves must not receive a receipt.'
    );
    WP_CLI::success('Block-editor receipts, autosaves, first saves and isolated block previews passed.');
} finally {
    if ($disableHistory !== null) {
        remove_filter('wp_post_revisions_to_keep', $disableHistory);
    }
    unregister_post_meta('post', '_aflpp_rejected_meta');
    remove_action('rest_after_insert_post', $lateMeta);
    wp_set_current_user($users[0] ?? $originalUser);
    foreach (array_reverse($posts) as $id) {
        wp_delete_post($id, true);
    }
    foreach ($users as $id) {
        wp_delete_user($id);
    }
    wp_set_current_user($originalUser);
}
