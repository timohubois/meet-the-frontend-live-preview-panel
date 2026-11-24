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
$originalHooks = [];
$hooks = [
    'mtflpp_live_preview_form_values', 'mtflpp_live_preview_custom_fields_initialized',
    'mtflpp_live_preview_preparation_error', 'mtflpp_live_preview_preparation_finished',
    'mtflpp_frontend_live_preview_source_selected',
    'mtflpp_frontend_saved_preview_source_selected',
];
foreach ($hooks as $hook) {
    $originalHooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
    remove_all_filters($hook);
}
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
    // No compatibility subscribers: the preview engine must work on its own.
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
    $events = [];
    $saveError = null;
    $lastSave = null;
    add_filter('mtflpp_live_preview_form_values', static function (
        $payload,
        array $context
    ) use (
        $check,
        $postId,
        &$events
    ) {
        $events[] = 'payload';
        if (is_wp_error($payload)) {
            return $payload;
        }
        $check(
            array_keys($context) === ['post', 'source', 'input']
            && $context['post'] === ['id' => $postId] && $context['source'] === null
            && $payload['post_title'] === "Editor's draft"
            && $context['input']['post_title'] === "Editor's draft",
            'Payload filters must receive the authorized parent and unslashed editor/form values.'
        );
        $context['post']['id'] = 999;
        $payload['content'] = '<p>Adapted editor content</p>';
        return $payload;
    }, 10, 2);
    add_action('mtflpp_live_preview_custom_fields_initialized', static function (
        array $context
    ) use (
        $check,
        $postId,
        &$events
    ): void {
        $events[] = 'seeded';
        $check(!defined('DOING_AUTOSAVE'), 'Native preview writes must not set the autosave flag.');
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Compare the unmodified fixture values.
        $form = $_POST;
        $check(
            ($form['post_ID'] ?? null) === $postId && ($form['post_title'] ?? null) === wp_slash("Editor's draft"),
            'Native save hooks must see the scoped, slashed preview form values.'
        );
        $id = $context['source']['id'];
        $revision = get_post($id);
        $check(
            array_keys($context) === ['post', 'source']
            && $context['post'] === ['id' => $postId] && $revision->post_type === 'revision'
            && $revision->post_status === 'mtflpp-preview' && (int) $revision->post_parent === $postId
            && get_post_meta($id, 'mtflpp_compatibility_seed', true) === 'Saved metadata',
            'Cache hooks must receive only identities after saved fields initialize the owned source.'
        );
    });
    add_filter('mtflpp_live_preview_preparation_error', static function (
        $error,
        array $context
    ) use (
        $check,
        $fixturePost,
        $revisionSaveCallbacks,
        &$events,
        &$lastSave,
        &$saveError
    ) {
        $check(!defined('DOING_AUTOSAVE'), 'Preview cleanup must leave the autosave flag undefined.');
        $check(
            // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert restored CLI globals.
            $_POST === $fixturePost && ($GLOBALS['wp_filter']['save_post_revision']->callbacks ?? [])
            === $revisionSaveCallbacks,
            'Preview cleanup must restore form globals and native revision save callbacks before verification.'
        );
        $check(array_keys($context) === ['post', 'source'], 'Verification must not retain submitted input.');
        $events[] = 'verified';
        $lastSave = [$error, $context];
        return $error ?? $saveError;
    }, 20, 2);
    $finishedContexts = [];
    add_action('mtflpp_live_preview_preparation_finished', static function (array ...$args) use (
        $check,
        &$events,
        &$finishedContexts
    ): void {
        $check(count($args) === 1, 'Preparation cleanup must receive only its context.');
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert scoped CLI globals.
        $check($_FILES === [], 'Preparation cleanup must remain isolated from the caller’s files.');
        $events[] = 'finished';
        $finishedContexts[] = $args[0];
    }, 10, 2);
    // A save integration can write fields and then update the same revision through WordPress.
    $nativeSaves = 0;
    $updateRevision = static function (int $id) use ($check, $coreId, &$nativeSaves): void {
        if ($id !== $coreId || ++$nativeSaves !== 1) {
            return;
        }
        update_metadata('post', $id, 'mtflpp_compatibility_seed', 'Unsaved metadata');
        $check(wp_update_post(['ID' => $id], true) === $id, 'The nested native revision update must succeed.');
    };
    add_action('save_post', $updateRevision, 20);
    try {
        $response = $send($input);
    } finally {
        remove_action('save_post', $updateRevision, 20);
    }
    $check($response->get_status() === 200, 'A compatible payload extension must succeed.');
    $id = $revisionId($response);
    $check($nativeSaves === 2, 'The fixture must exercise both the outer and nested native revision saves.');
    $check(
        get_post_meta($id, 'mtflpp_compatibility_seed', true) === 'Unsaved metadata'
        && $live->fingerprint($postId) === $base,
        'A nested native update must not overwrite preview metadata with the saved parent values.'
    );
    $check(
        $id === $coreId && $events === ['payload', 'seeded', 'verified', 'finished']
        && $lastSave === [null, ['post' => ['id' => $postId], 'source' => ['id' => $id]]]
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert restored CLI globals.
        && $finishedContexts === [$lastSave[1]] && $_FILES === $fixtureFiles
        && get_post($id)->post_content === '<p>Adapted editor content</p>',
        'Preview lifecycle hooks must run in order once when updating the existing isolated source.'
    );

    $before = $events;
    $check($send($input, 'invalid')->get_status() === 403, 'Invalid REST nonces must remain rejected.');
    $check(
        $send(array_replace($input, ['base' => str_repeat('a', 64)]))->get_status() === 409,
        'Conflicted preview sources must remain rejected.'
    );
    wp_set_current_user(0);
    $check($send($input)->get_status() === 401, 'Anonymous users must not reach compatibility callbacks.');
    wp_set_current_user($user);
    $check($events === $before, 'Rejected permissions, nonces and conflicts must not run compatibility hooks.');

    // Try both an otherwise successful and an otherwise rejected reentrant preparation during the native write.
    $rejected = new WP_Error('mtflpp_test_payload', 'Fixture payload rejection.', ['status' => 400]);
    $rejectNested = static fn ($payload, array $context) => isset($context['input']['fixture_reject'])
        ? $rejected : $payload;
    $attempted = false;
    $dispatchNested = static function () use ($send, $input, $check, &$attempted): void {
        if ($attempted) {
            return;
        }
        $attempted = true;
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Snapshot the active preview's form values.
        $activeForm = $_POST;
        $nested = $input + ['excerpt' => 'Nested preview must not overwrite the outer source.'];
        foreach ([$nested, $nested + ['fixture_reject' => true]] as $data) {
            $response = $send($data);
            $check(
                $response->get_status() === 409 && $response->get_data()['code'] === 'mtflpp_preview_busy',
                'Reentrant writes must be rejected before payload filters or cleanup callbacks run.'
            );
        }
        $check(
            // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert the outer preview's form state.
            $_POST === $activeForm && $_FILES === [],
            'Rejected nested writes must leave outer preview globals in place.'
        );
    };
    add_filter('mtflpp_live_preview_form_values', $rejectNested, 5, 2);
    add_action('mtflpp_live_preview_custom_fields_initialized', $dispatchNested, 20);
    $events = [];
    try {
        $response = $send($input);
        $check(
            $attempted && $response->get_status() === 200 && $revisionId($response) === $id
            && get_post($id)->post_excerpt === get_post($postId)->post_excerpt
            // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert restored CLI globals.
            && $events === ['payload', 'seeded', 'verified', 'finished'] && $_FILES === $fixtureFiles,
            'Rejected nested writes must leave the outer preview write and cleanup intact.'
        );
    } finally {
        remove_filter('mtflpp_live_preview_form_values', $rejectNested, 5);
        remove_action('mtflpp_live_preview_custom_fields_initialized', $dispatchNested, 20);
    }

    // Model an integration that must remove its temporary hook even if a public verifier never reaches it.
    $temporaryHook = static fn () => null;
    $install = static fn () => add_action('save_post', $temporaryHook);
    $cleanup = static fn () => remove_action('save_post', $temporaryHook);
    add_action('mtflpp_live_preview_custom_fields_initialized', $install);
    add_action('mtflpp_live_preview_preparation_finished', $cleanup, PHP_INT_MIN, 0);
    try {
        $throwingHooks = [
            'mtflpp_live_preview_preparation_error' => 5,
            'mtflpp_live_preview_preparation_finished' => 20,
        ];
        foreach ($throwingHooks as $hook => $priority) {
            $expected = new RuntimeException('Fixture exception in ' . $hook);
            $fail = static function () use ($expected, $check, $priority, $temporaryHook): void {
                $check(
                    has_action('save_post', $temporaryHook) === ($priority === 5 ? 10 : false),
                    'Integration state must exist during verification and be gone before normal cleanup subscribers.'
                );
                throw $expected;
            };
            $events = [];
            $finishedContexts = [];
            add_filter($hook, $fail, $priority);
            try {
                $send($input);
                throw new RuntimeException('The lifecycle exception was swallowed.');
            } catch (RuntimeException $error) {
                $check($error === $expected, 'Verifier and cleanup exceptions must propagate.');
                $check(
                    // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert restored CLI globals.
                    $_POST === $fixturePost && $_FILES === $fixtureFiles && !has_action('save_post', $temporaryHook)
                    && ($GLOBALS['wp_filter']['save_post_revision']->callbacks ?? []) === $revisionSaveCallbacks,
                    'Lifecycle exceptions must restore caller globals and leave no temporary save hooks.'
                );
                $check(
                    $finishedContexts === [['post' => ['id' => $postId], 'source' => ['id' => $id]]]
                    && in_array('verified', $events, true) === ($priority !== 5),
                    'The finished action must receive the established source even when early verification throws.'
                );
            } finally {
                remove_filter($hook, $fail, $priority);
            }
            $check($send($input)->get_status() === 200, 'Sequential previews must work after lifecycle exceptions.');
        }
    } finally {
        remove_action('mtflpp_live_preview_custom_fields_initialized', $install);
        remove_action('mtflpp_live_preview_preparation_finished', $cleanup, PHP_INT_MIN);
        $cleanup();
    }

    // ACF's adapter is present even when ACF itself is not installed: it must preserve prior errors.
    $acf = new Acf();
    $reject = static fn () => $rejected;
    add_filter('mtflpp_live_preview_form_values', $reject, 5);
    $events = [];
    $finishedContexts = [];
    $response = $send($input);
    $check(
        $response->get_status() === 400 && $response->get_data()['code'] === $rejected->get_error_code()
        && $events === ['payload', 'verified', 'finished']
        && $lastSave === [$rejected, ['post' => ['id' => $postId], 'source' => null]]
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert restored CLI globals.
        && $finishedContexts === [$lastSave[1]] && $_FILES === $fixtureFiles,
        'Payload errors must survive later adapters and finish preparation without seeding or writing.'
    );
    remove_filter('mtflpp_live_preview_form_values', $reject, 5);

    if (function_exists('acf_save_post')) {
        // A later adapter may reject after ACF has prepared its native save monitor.
        add_filter('mtflpp_live_preview_form_values', $reject, 20);
        $response = $send($input + ['acf' => [], '_acf_nonce' => wp_create_nonce('post')]);
        $check(
            $response->get_data()['code'] === $rejected->get_error_code()
            && !has_action('acf/save_post', [$acf, 'recordSave']),
            'Rejected payloads must clean up ACF preparation state and preserve the rejection.'
        );
        remove_filter('mtflpp_live_preview_form_values', $reject, 20);
    }

    $throw = static function (): void {
        throw new RuntimeException('Fixture preparation exception.');
    };
    add_filter('mtflpp_live_preview_form_values', $throw, 20);
    $finishedContexts = [];
    try {
        $data = function_exists('acf_save_post') ? ['acf' => [], '_acf_nonce' => wp_create_nonce('post')] : [];
        $send($input + $data);
        throw new RuntimeException('The preparation exception was swallowed.');
    } catch (RuntimeException $error) {
        $check($error->getMessage() === 'Fixture preparation exception.', 'Preparation exceptions must propagate.');
        $check(
            // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert restored CLI globals, not editor input.
            $_POST === $fixturePost && $_FILES === $fixtureFiles && !has_action('acf/save_post', [$acf, 'recordSave']),
            'Preparation exceptions must restore form globals and remove temporary ACF save monitors.'
        );
        $check(
            $lastSave[1] === ['post' => ['id' => $postId], 'source' => null]
            && $finishedContexts === [$lastSave[1]],
            'Exceptions before source initialization must keep a null cleanup source.'
        );
    } finally {
        remove_filter('mtflpp_live_preview_form_values', $throw, 20);
    }

    $live->deletePreviews($postId);
    $previousSource = null;
    foreach ([false, true] as $reuse) {
        $initializedSource = null;
        $lastSave = null;
        $finishedContexts = [];
        $throwInitialized = static function (array $context) use (&$initializedSource): void {
            $initializedSource = $context['source'];
            $context['source']['id'] = 999;
            throw new RuntimeException('Fixture initialized-source exception.');
        };
        add_action('mtflpp_live_preview_custom_fields_initialized', $throwInitialized, 20);
        try {
            $send($input + $data);
            throw new RuntimeException('The initialized-source exception was swallowed.');
        } catch (RuntimeException $error) {
            $check(
                $error->getMessage() === 'Fixture initialized-source exception.',
                'Exceptions after source initialization must propagate.'
            );
            $check(
                $initializedSource !== null && get_post($initializedSource['id']) !== null
                && $lastSave[1] === ['post' => ['id' => $postId], 'source' => $initializedSource]
                && $finishedContexts === [$lastSave[1]],
                'Cleanup must retain the established source after initialization throws, ignoring context mutations.'
            );
            $check(
                !$reuse || $initializedSource === $previousSource,
                'The failure path must also preserve the identity of a reused source.'
            );
            $check(
                // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Check restored CLI globals, not request input.
                $_POST === $fixturePost && $_FILES === $fixtureFiles
                && !has_action('acf/save_post', [$acf, 'recordSave']),
                'Initialized-source exceptions must restore form globals and remove temporary ACF save monitors.'
            );
            $check(
                $live->fingerprint($postId) === $base,
                'Failed initialization must leave the saved parent unchanged.'
            );
            $check(!wp_get_post_autosave($postId, $user), 'Failed initialization must not create recovery autosaves.');
            $previousSource = $initializedSource;
        } finally {
            remove_action('mtflpp_live_preview_custom_fields_initialized', $throwInitialized, 20);
        }
    }
    $response = $send($input);
    $check($response->get_status() === 200, 'A later write must work after preparation cleanup.');
    $id = $revisionId($response);
    $check(!has_action('acf/save_post', [$acf, 'recordSave']), 'Successful writes must remove the save monitor.');

    $saveError = new WP_Error('mtflpp_test_save', 'Fixture save verification failure.', ['status' => 409]);
    $finishedContexts = [];
    add_filter('mtflpp_live_preview_preparation_error', static fn () => $saveError, 5);
    $response = $send($input);
    $check(
        $response->get_status() === 409 && $response->get_data()['code'] === $saveError->get_error_code()
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Assert restored CLI globals.
        && $finishedContexts === [$lastSave[1]] && $_FILES === $fixtureFiles,
        'Failed integration save verification must not return a successful preview URL.'
    );
    $check($live->fingerprint($postId) === $base, 'Compatibility hooks must leave the saved parent unchanged.');
    $check(!wp_get_post_autosave($postId, $user), 'Compatibility hooks must not create recovery autosaves.');
    $check(
        array_keys(wp_get_post_revisions($postId)) === array_keys($history),
        'Preview writes must not add or remove normal history revisions.'
    );

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
    foreach ($originalHooks as $hook => $callbacks) {
        if ($callbacks === null) {
            unset($GLOBALS['wp_filter'][$hook]);
        } else {
            $GLOBALS['wp_filter'][$hook] = $callbacks;
        }
    }
    if (is_int($postId) && $postId) {
        wp_delete_post($postId, true);
    }
    if (is_int($user) && $user) {
        wp_delete_user($user);
    }
    wp_set_current_user($originalUser);
}
