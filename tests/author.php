<?php

/** Run with `wp eval-file tests/author.php` on a disposable single-site installation. */

use MeetTheFrontendLivePreviewPanel\Compatibility\CoreBlocks;
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
$originalHooks = [];
foreach (['the_preview', 'get_post_metadata', 'timber/post/import_data'] as $hook) {
    $originalHooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
}
$renderers = [];
$blockNames = [
    'core/post-excerpt', 'core/post-author', 'core/post-author-name', 'core/post-author-biography', 'core/avatar',
];
foreach ($blockNames as $name) {
    $type = WP_Block_Type_Registry::get_instance()->get_registered($name);
    $check($type !== null, 'The native block is required: ' . $name);
    $renderers[$name] = $type->render_callback;
}
$users = [];
$posts = [];
$live = new LivePreview();
$frontend = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $live);
$send = static function (string $route, array $data, string $method = 'POST'): WP_REST_Response {
    $request = new WP_REST_Request($method, $route);
    $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
    $request->set_body_params($data);
    return rest_ensure_response(rest_do_request($request));
};
$query = static function (WP_REST_Response $response) use ($check): array {
    $check(
        $response->get_status() === 200,
        'Could not prepare an author preview: ' . wp_json_encode($response->get_data())
    );
    parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $query);
    return $query;
};
$block = static fn (string $name, int $postId, array $attributes = []): WP_Block => new WP_Block([
    'blockName' => $name, 'attrs' => $attributes, 'innerBlocks' => [], 'innerHTML' => '', 'innerContent' => [],
], ['postId' => $postId, 'postType' => 'post']);
try {
    foreach (['administrator', 'author', 'subscriber'] as $role) {
        $id = wp_insert_user([
            'user_login' => 'mtflpp_author_' . $role . '_' . wp_generate_password(12, false, false),
            'user_pass' => wp_generate_password(32), 'role' => $role,
            'display_name' => 'MTFLPP ' . $role, 'description' => 'Biography ' . $role,
        ]);
        $check(!is_wp_error($id), 'Could not create a fixture user.');
        $users[] = $id;
    }
    [$admin, $author, $subscriber] = $users;
    wp_set_current_user($admin);
    foreach ([$admin, $author] as $owner) {
        $id = wp_insert_post([
            'post_type' => 'post', 'post_status' => 'publish', 'post_author' => $owner,
            'post_title' => 'MTFLPP author fixture', 'post_content' => 'Saved content',
        ], true);
        $check(!is_wp_error($id), 'Could not create a fixture post.');
        $posts[] = $id;
    }
    [$postId, $otherId] = $posts;
    $route = '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview';
    $autosaveId = _wp_put_post_revision($postId, true);
    $check(is_int($autosaveId), 'Could not create the recovery fixture.');
    $base = $live->fingerprint($postId);
    $recovery = $live->fingerprint($autosaveId);
    $sourceId = 0;
    $previous = null;
    foreach ([$author, $subscriber, $admin, $author, null] as $selected) {
        $data = ['base' => $base, 'content' => 'Preview content'];
        if ($selected !== null) {
            $data['author'] = $selected;
        }
        $params = $query($send($route, $data));
        $id = (int) $params['mtflpp_revision'];
        $check(!$sourceId || $sourceId === $id, 'Changing author must reuse the editor-owned source.');
        $sourceId = $id;
        $expected = $selected ?? $admin;
        $check((int) get_post($id)->post_author === $admin, 'Selected authors must not replace revision ownership.');
        $check(
            (int) get_post_meta($id, LivePreview::AUTHOR_META, true) === $expected,
            'The source must retain the effective author.'
        );
        $check(
            $live->authorizedSource($postId, $id, $params['mtflpp_token']) !== null,
            'The owning editor must retain access.'
        );
        if ($previous !== null) {
            $check(
                $live->authorizedSource($postId, $id, $previous['mtflpp_token']) === null,
                'Changed authors must invalidate earlier source tokens.'
            );
        }
        $previous = $params;
        $_GET = $params;
        $frontend->authorizePreview();
        $display = apply_filters('the_preview', clone get_post($postId));
        $check((int) $display->post_author === $expected, 'The frontend post must use the selected author.');
        $check(
            (int) $frontend->readPost(clone get_post($otherId))->post_author === $author,
            'Other posts must retain their own author.'
        );
        $hasTimber2 = class_exists(\Timber\Timber::class) && !method_exists(\Timber\Post::class, 'import_custom');
        $import = apply_filters('timber/post/import_data', ['post_author' => $admin], get_post($postId));
        $check(
            (int) $import['post_author'] === ($hasTimber2 ? $expected : $admin),
            'The Timber 2 import must use the same live author.'
        );
        foreach (['core/post-author', 'core/post-author-name', 'core/post-author-biography', 'core/avatar'] as $name) {
            $attributes = ['isLink' => true, 'showBio' => true];
            $selectedBlock = $block($name, $postId, $attributes);
            $context = $selectedBlock->context;
            $html = $selectedBlock->render();
            $needle = $name === 'core/post-author-biography'
                ? get_the_author_meta('description', $expected) : get_the_author_meta('display_name', $expected);
            $check(str_contains($html, $needle), 'The native block must render the selected author: ' . $name);
            if ($name !== 'core/post-author-biography') {
                $check(
                    str_contains($html, esc_url(get_author_posts_url($expected))),
                    'Author links must follow the selection.'
                );
            }
            $check($selectedBlock->context === $context, 'Real block context must remain unchanged.');
            $otherHtml = $block($name, $otherId, $attributes)->render();
            $check(
                str_contains($otherHtml, $name === 'core/post-author-biography' ? 'Biography author' : 'MTFLPP author'),
                'Other block contexts must keep their own author.'
            );
        }
        $explicitAvatar = $block('core/avatar', $postId, ['userId' => $subscriber])->render();
        $check(str_contains($explicitAvatar, 'MTFLPP subscriber'), 'An explicit avatar user must not be overridden.');
        $check($live->fingerprint($postId) === $base, 'Author previews must never update the parent or its cache.');
        $check($live->fingerprint($autosaveId) === $recovery, 'Author previews must not change recovery data.');
    }
    $sourceBase = $live->fingerprint($sourceId);
    foreach ([0, -1, 1.5, 'invalid', [$author], PHP_INT_MAX] as $invalid) {
        $response = $send($route, ['base' => $base, 'author' => $invalid]);
        $check($response->get_status() === 400, 'Invalid/nonexistent authors must be rejected.');
        $check(
            $live->fingerprint($sourceId) === $sourceBase && $live->fingerprint($postId) === $base,
            'Rejected authors must not alter saved or preview state.'
        );
    }
    wp_set_current_user($author);
    $ownRoute = '/meet-the-frontend-live-preview-panel/v1/posts/' . $otherId . '/preview';
    $ownBase = $live->fingerprint($otherId);
    $response = $send($ownRoute, ['base' => $ownBase, 'author' => $subscriber]);
    $check($response->get_status() === 403, 'Authors without edit_others_posts must not assign other users.');
    $query($send($ownRoute, ['base' => $ownBase, 'author' => $author]));
    $check(
        $live->authorizedSource($postId, $sourceId, $params['mtflpp_token']) === null,
        'Selecting a user must not transfer source access.'
    );
    wp_set_current_user($subscriber);
    $check(
        $send($route, ['base' => $base, 'author' => $subscriber])->get_status() === 403,
        'Subscribers must not gain preview write access.'
    );
    wp_set_current_user($admin);

    // Native history records the revision's editor, not the original post-author selection.
    $historyId = _wp_put_post_revision($postId);
    $check(is_int($historyId), 'Could not create the history fixture.');
    wp_update_post(['ID' => $historyId, 'post_author' => $subscriber]);
    update_metadata('post', $historyId, LivePreview::AUTHOR_META, $author);
    parse_str(wp_parse_url($frontend->savedPreviewUrl(get_post($postId), $historyId), PHP_URL_QUERY), $savedParams);
    $_GET = $savedParams;
    $frontend->authorizePreview();
    $check(
        (int) $frontend->readPost(clone get_post($postId))->post_author === $admin,
        'Saved history must not use the revision editor or live-source metadata as post author.'
    );
    $check(
        str_contains($block('core/post-author-name', $postId)->render(), 'MTFLPP administrator'),
        'Saved author blocks must retain the saved parent author.'
    );
    $import = apply_filters('timber/post/import_data', ['post_author' => $admin], get_post($postId));
    $check((int) $import['post_author'] === $admin, 'Timber rebinding must discard the old live author.');

    $response = $send(rest_get_route_for_post($postId), ['author' => $author], 'PUT');
    $check(
        $response->get_status() === 200 && (int) get_post($postId)->post_author === $author,
        'Native author saving must remain intact.'
    );
    $read = $send(rest_get_route_for_post($postId), [], 'GET');
    $check((int) $read->get_data()['author'] === $author, 'Reopening the saved post must return the new author.');
    $check(!get_post($sourceId), 'Native saving must discard the old live source.');
    $params = $query($send($route, ['base' => $live->fingerprint($postId)]));
    $_GET = $params;
    $frontend->authorizePreview();
    $check(
        (int) $frontend->readPost(clone get_post($postId))->post_author === $author,
        'Omitted author input must seed the newly saved author.'
    );
    $renderer = WP_Block_Type_Registry::get_instance()->get_registered('core/post-author-name')->render_callback;
    $check(is_array($renderer) && $renderer[0] instanceof CoreBlocks, 'The real bootstrap must own author adaptation.');
    $core = $renderer[0];
    $custom = static fn (): string => 'Custom author';
    $type = WP_Block_Type_Registry::get_instance()->get_registered('core/post-author-name');
    $type->render_callback = $custom;
    $core->unbindPreview();
    $check($type->render_callback === $custom, 'Cleanup must not overwrite a later custom renderer.');
    $core->bindPreview($postId, (int) $params['mtflpp_revision']);
    $check($type->render_callback === $custom, 'Custom author renderers must not be wrapped.');
    $core->unbindPreview();
    foreach ($renderers as $name => $callback) {
        if ($name !== 'core/post-author-name') {
            $check(
                WP_Block_Type_Registry::get_instance()->get_registered($name)->render_callback === $callback,
                'Cleanup must restore native callbacks.'
            );
        }
    }
    WP_CLI::success('Live authors, native blocks, Timber, permissions, ownership, history and save/reopen passed.');
} finally {
    $_GET = $originalGet;
    remove_action('init', [$frontend, 'authorizePreview'], 20);
    remove_action('template_redirect', [$frontend, 'checkPreviewTarget'], -1);
    foreach ($originalHooks as $hook => $callbacks) {
        if ($callbacks === null) {
            unset($GLOBALS['wp_filter'][$hook]);
        } else {
            $GLOBALS['wp_filter'][$hook] = $callbacks;
        }
    }
    foreach ($renderers as $name => $callback) {
        WP_Block_Type_Registry::get_instance()->get_registered($name)->render_callback = $callback;
    }
    wp_set_current_user($users[0] ?? $originalUser);
    foreach (array_reverse($posts) as $id) {
        wp_delete_post($id, true);
    }
    foreach ($users as $id) {
        wp_delete_user($id);
    }
    wp_set_current_user($originalUser);
}
