<?php

/** Run with `wp eval-file tests/compatibility.php`; optional dependencies are not required. */

use MeetTheFrontendLivePreviewPanel\Compatibility\Acf;
use MeetTheFrontendLivePreviewPanel\Compatibility\Timber;
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
$user = 0;
$postId = 0;
$live = new LivePreview();
// phpcs:ignore WordPress.Security.NonceVerification.Missing -- Snapshot request globals in the CLI fixture.
[$originalPost, $originalFiles] = [$_POST, $_FILES];
$fixturePost = ['mtflpp_compatibility_fixture' => 'Existing form state'];
$fixtureFiles = ['file' => [
    'name' => 'fixture.txt', 'type' => 'text/plain', 'tmp_name' => '/tmp/fixture', 'error' => UPLOAD_ERR_OK,
    'size' => 1,
]];
try {
    $check(!defined('DOING_AUTOSAVE'), 'Run this fixture before any native autosave.');
    $user = wp_insert_user([
        'user_login' => 'mtflpp_compatibility_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(32), 'role' => 'administrator',
    ]);
    $check(!is_wp_error($user), 'Could not create a fixture user.');
    wp_set_current_user($user);
    $postId = wp_insert_post([
        'post_type' => 'post', 'post_status' => 'draft', 'post_author' => $user,
        'post_title' => 'MTFLPP compatibility fixture', 'post_content' => 'Saved content',
    ], true);
    $check(!is_wp_error($postId) && $postId > 0, 'Could not create a fixture post.');
    update_post_meta($postId, 'mtflpp_compatibility_seed', 'Saved metadata');
    $base = $live->fingerprint($postId);
    $input = ['base' => $base, 'post_title' => "Editor's draft", 'content' => '<p>Unsaved content</p>'];
    $route = '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview';
    $send = static function (array $data, ?string $nonce = null, array $files = []) use ($route): WP_REST_Response {
        $request = new WP_REST_Request('POST', $route);
        $request->set_header('X-WP-Nonce', $nonce ?? wp_create_nonce('wp_rest'));
        $request->set_body_params($data);
        $request->set_file_params($files);
        return rest_do_request($request);
    };
    $revisionId = static function (WP_REST_Response $response): int {
        parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $query);
        return (int) $query['mtflpp_revision'];
    };

    // Serve the HTTP request through core so method overrides and file params follow its real boundary.
    $serve = static function (
        string $method,
        array $query = [],
        array $form = [],
        array $headers = [],
        array $files = [],
        string $body = '',
        ?string $path = null
    ) use ($route): WP_REST_Response {
        // phpcs:ignore WordPress.Security.NonceVerification -- Snapshot request globals in the CLI fixture.
        $previous = [$_SERVER, $_GET, $_POST, $_FILES];
        $previousBody = $GLOBALS['HTTP_RAW_POST_DATA'] ?? null;
        $response = null;
        $capture = static function ($served, WP_REST_Response $result) use (&$response): bool {
            $response = $result;
            return true;
        };
        add_filter('rest_pre_serve_request', $capture, 20, 2);
        try {
            $_SERVER = ['REQUEST_METHOD' => $method, 'HTTP_X_WP_NONCE' => wp_create_nonce('wp_rest')] + $headers;
            $_GET = wp_slash($query);
            $_POST = wp_slash($form);
            $_FILES = $files;
            $GLOBALS['HTTP_RAW_POST_DATA'] = $body;
            rest_get_server()->serve_request($path ?? $route);
            return $response;
        } finally {
            remove_filter('rest_pre_serve_request', $capture, 20);
            [$_SERVER, $_GET, $_POST, $_FILES] = $previous;
            $GLOBALS['HTTP_RAW_POST_DATA'] = $previousBody;
        }
    };
    $history = wp_get_post_revisions($postId);
    $revisionSaves = did_action('save_post_revision');
    foreach (['GET', 'HEAD'] as $method) {
        $check($serve($method, query: $input)->get_status() === 404, "$method must not match the preview write route.");
        $overridden = [
            $serve($method, query: $input + ['_method' => 'POST']),
            $serve($method, query: $input, headers: ['HTTP_X_HTTP_METHOD_OVERRIDE' => 'POST']),
        ];
        foreach ($overridden as $response) {
            $check(
                $response->get_status() === 405 && $response->get_data()['code'] === 'mtflpp_post_required',
                "$method must not become a preview write through a core REST method override."
            );
        }
    }
    $multipartHeaders = ['CONTENT_TYPE' => 'multipart/form-data; boundary=fixture'];
    $uploadResponses = [
        $serve('POST', form: $input, headers: $multipartHeaders, files: $fixtureFiles),
        $send($input, files: $fixtureFiles),
    ];
    foreach ($uploadResponses as $response) {
        $check(
            $response->get_status() === 400 && $response->get_data()['code'] === 'mtflpp_upload_not_supported',
            'HTTP and internal preview requests must both reject file params.'
        );
    }
    $check(
        did_action('save_post_revision') === $revisionSaves && $live->fingerprint($postId) === $base,
        'Rejected HTTP methods and uploads must not reach revision writes or change the parent.'
    );

    $_POST = $fixturePost;
    $_FILES = $fixtureFiles;
    // A core-only submission does not need any optional integration input.
    $response = $send($input);
    $check($response->get_status() === 200, 'Core-only previews must not require a compatibility adapter.');
    $coreId = $revisionId($response);
    $check(
        get_post($coreId)->post_title === $input['post_title']
        && get_post($coreId)->post_content === $input['content'],
        'Core-only writes must retain native title/content handling.'
    );
    $response = $serve('POST', form: $input, headers: $multipartHeaders);
    $check($response->get_status() === 200, 'HTTP POST with string form values must still work.');
    $response = $serve('POST', headers: ['CONTENT_TYPE' => 'application/json'], body: wp_json_encode($input));
    $check($response->get_status() === 200, 'HTTP POST with JSON must still work.');
    $internalPath = '/mtflpp-fixture/v1/internal';
    $dispatchInternal = static function (
        $result,
        WP_REST_Server $server,
        WP_REST_Request $request
    ) use (
        $internalPath,
        $send,
        $input,
        $check,
        $fixtureFiles
    ) {
        if ($request->get_route() !== $internalPath) {
            return $result;
        }
        $response = $send($input);
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert restored CLI globals.
        $check($_FILES === $fixtureFiles, 'An internal preview must leave its caller’s files untouched.');
        return $response;
    };
    $nativeFileChecks = 0;
    $checkNativeFiles = static function () use ($check, &$nativeFileChecks): void {
        ++$nativeFileChecks;
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert scoped CLI globals.
        $check($_FILES === [], 'Native revision saves must not see the outer request’s files.');
    };
    add_filter('rest_pre_dispatch', $dispatchInternal, 10, 3);
    add_action('save_post_revision', $checkNativeFiles);
    try {
        $check(
            $serve('GET', files: $fixtureFiles, path: $internalPath)->get_status() === 200 && $nativeFileChecks === 1,
            'An intentional internal REST dispatch must not inherit the outer HTTP method or file params.'
        );
    } finally {
        remove_filter('rest_pre_dispatch', $dispatchInternal, 10);
        remove_action('save_post_revision', $checkNativeFiles);
    }

    $revisionSaveCallbacks = $GLOBALS['wp_filter']['save_post_revision']->callbacks ?? [];
    $revisionSaves = did_action('save_post_revision');
    $check($send($input, 'invalid')->get_status() === 403, 'Invalid REST nonces must remain rejected.');
    $check(
        $send(array_replace($input, ['base' => str_repeat('a', 64)]))->get_status() === 409,
        'Conflicted preview sources must remain rejected.'
    );
    wp_set_current_user(0);
    $check($send($input)->get_status() === 401, 'Anonymous users cannot prepare previews.');
    wp_set_current_user($user);
    $invalid = ['acf' => 'mtflpp_acf_unavailable', 'yoast_primary_terms' => 'mtflpp_invalid_yoast_primary_terms'];
    foreach ($invalid as $field => $code) {
        $response = $send($input + [$field => []]);
        $check(
            $response->get_status() === 400 && $response->get_data()['code'] === $code,
            'Invalid adapter inputs must fail before a native write.'
        );
    }
    $check(did_action('save_post_revision') === $revisionSaves, 'Denied requests must not reach native writes.');

    // Native hooks may dispatch another preview or update the same revision.
    $nativeSaves = 0;
    $updateRevision = static function (int $id) use ($check, $coreId, $send, $input, &$nativeSaves): void {
        if ($id !== $coreId || ++$nativeSaves !== 1) {
            return;
        }
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Snapshot the owned form during CLI testing.
        $activeForm = $_POST;
        $nested = $send($input + ['excerpt' => 'Nested preview must not overwrite the outer source.']);
        $check(
            $nested->get_status() === 409 && $nested->get_data()['code'] === 'mtflpp_preview_busy',
            'Reentrant writes must be rejected before any preparation starts.'
        );
        $check(
            // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert scoped CLI globals.
            $_POST === $activeForm && $_FILES === [],
            'Rejected nested writes must leave the outer form state intact.'
        );
        update_metadata('post', $id, 'mtflpp_compatibility_seed', 'Unsaved metadata');
        $check(wp_update_post(['ID' => $id], true) === $id, 'A nested native revision update must still succeed.');
    };
    add_action('save_post', $updateRevision, 20);
    try {
        $response = $send($input);
        $check($response->get_status() === 200 && $revisionId($response) === $coreId, 'Reuse the same source.');
    } finally {
        remove_action('save_post', $updateRevision, 20);
    }
    $check(
        $nativeSaves === 2 && get_post_meta($coreId, 'mtflpp_compatibility_seed', true) === 'Unsaved metadata',
        'Seed only once; a nested native update must not overwrite unsaved metadata.'
    );

    $expected = new RuntimeException('Fixture exception in native revision save');
    $throw = static function (int $id) use ($coreId, $expected): void {
        if ($id === $coreId) {
            throw $expected;
        }
    };
    add_action('save_post', $throw, 20);
    try {
        $send($input);
        throw new RuntimeException('The native exception was swallowed.');
    } catch (RuntimeException $error) {
        $check($error === $expected, 'Preserve the original native save exception.');
    } finally {
        remove_action('save_post', $throw, 20);
    }
    $check(
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert restored CLI globals.
        $_POST === $fixturePost && $_FILES === $fixtureFiles
        && ($GLOBALS['wp_filter']['save_post_revision']->callbacks ?? []) === $revisionSaveCallbacks,
        'Native exceptions must restore the caller’s globals and release the temporary revision callback.'
    );
    $response = $send($input);
    $check($response->get_status() === 200, 'A subsequent preview must work after a native save exception.');
    $id = $revisionId($response);
    $check($live->fingerprint($postId) === $base, 'Preview writes must leave the saved parent unchanged.');
    $check(!wp_get_post_autosave($postId, $user), 'Preview writes must not create recovery autosaves.');
    $check(
        array_keys(wp_get_post_revisions($postId)) === array_keys($history),
        'Preview writes must not add or remove normal history revisions.'
    );

    $acf = new Acf();
    if ($acf->isAvailable()) {
        $acf->bindPreview($postId, $id, true);
        $check(
            has_filter('acf/pre_update_metadata', [$acf, 'preventSourceWrite']) === PHP_INT_MAX
            && has_action('shutdown', [$acf, 'unbindPreview']) === PHP_INT_MAX,
            'Saved-source guards must be installed for read-only rendering.'
        );
        $acf->bindPreview($postId, $id, false);
        $check(
            !has_filter('acf/pre_update_metadata', [$acf, 'preventSourceWrite'])
            && !has_filter('acf/pre_delete_metadata', [$acf, 'preventSourceWrite']),
            'Rebinding to live preview must remove old saved-source write guards.'
        );
    }
    $acf->unbindPreview();
    $acf->unbindPreview();
    $check(
        !has_filter('acf/validate_post_id', [$acf, 'readPostId'])
        && !has_filter('acf/pre_load_metadata', [$acf, 'readMetadata'])
        && !has_action('shutdown', [$acf, 'unbindPreview'])
        && $acf->readPostId($postId, $postId) === $postId,
        'ACF cleanup must remove its own read hooks, reset state and be safe to repeat.'
    );
    $timber = new Timber();
    $timber->bindPreview($postId, $id);
    $hasTimber = class_exists(\Timber\Timber::class);
    $hasTimber1 = $hasTimber && method_exists(\Timber\Post::class, 'import_custom');
    $check(
        has_filter('timber/post/import_data', [$timber, 'readPost'])
            === ($hasTimber && !$hasTimber1 ? PHP_INT_MAX : false)
        && has_filter('timber_post_get_meta_pre', [$timber, 'readLegacyPostMeta'])
            === ($hasTimber1 ? PHP_INT_MAX : false)
        && has_filter('timber_post_get_meta_field_pre', [$timber, 'readLegacyPostMetaField'])
            === ($hasTimber1 ? PHP_INT_MAX : false),
        'Only the installed Timber version’s read hooks should be registered.'
    );
    $timber->bindPreview($postId, 0);
    $timber->unbindPreview();
    $check(
        !has_filter('timber/post/import_data', [$timber, 'readPost'])
        && !has_filter('timber_post_get_meta_pre', [$timber, 'readLegacyPostMeta'])
        && !has_filter('timber_post_get_meta_field_pre', [$timber, 'readLegacyPostMetaField'])
        && !has_action('shutdown', [$timber, 'unbindPreview'])
        && $timber->readPost(['post_title' => 'Unchanged'], get_post($postId)) === ['post_title' => 'Unchanged'],
        'Timber cleanup must remove its own read hooks and discard the previous source.'
    );
    // Save the parent in this same process, before any native autosave can set the flag.
    $savedContent = 'Content saved after preview';
    $updated = wp_update_post(['ID' => $postId, 'post_content' => $savedContent], true);
    $check($updated === $postId, 'Could not save the fixture after preparing the preview.');
    $newHistory = array_diff_key(wp_get_post_revisions($postId), $history);
    $revision = reset($newHistory);
    $check(
        count($newHistory) === 1 && $revision->post_content === $savedContent && !wp_is_post_autosave($revision),
        'An ordinary save after preview must create a normal history revision in the same process.'
    );
    WP_CLI::success('Core-only previews, compatibility lifecycle, scoped hooks, errors and later saves passed.');
} finally {
    $_POST = $originalPost;
    $_FILES = $originalFiles;
    if (isset($acf)) {
        $acf->unbindPreview();
    }
    if (isset($timber)) {
        $timber->unbindPreview();
    }
    if (is_int($postId) && $postId) {
        wp_delete_post($postId, true);
    }
    if (is_int($user) && $user) {
        wp_delete_user($user);
    }
    wp_set_current_user($originalUser);
}
