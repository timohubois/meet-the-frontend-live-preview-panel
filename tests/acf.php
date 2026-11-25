<?php

/** Run with `wp eval-file tests/acf.php` on a single site with ACF Pro or SCF. */

use MeetTheFrontendLivePreviewPanel\Compatibility\Acf;
use MeetTheFrontendLivePreviewPanel\LivePreview;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(LivePreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a single-site installation with this plugin active.');
}
if (
    !function_exists('acf_add_local_field_group') || !function_exists('acf_get_field_type')
    || !acf_get_field_type('repeater')
) {
    WP_CLI::log('Skipping custom field preview checks: ACF-compatible repeater support is not active.');
    return;
}
require_once ABSPATH . 'wp-admin/includes/user.php';
require_once ABSPATH . 'wp-admin/includes/post.php';
$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$originalUser = get_current_user_id();
$user = 0;
$postId = 0;
$related = [];
$independent = [];
$media = [];
$terms = [];
$taxonomy = 'mtflpp_acf_test';
$live = new LivePreview();
$send = static function (int $postId, array $data): WP_REST_Response {
    $request = new WP_REST_Request('POST', '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview');
    $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
    $request->set_body_params($data);
    return rest_do_request($request);
};
// ACF 6.8.11 normally trusts WP-CLI data; exercise its untrusted form-save rules instead.
$untrusted = static fn () => false;
add_filter('acf/is_trusted_save_context', $untrusted);
try {
    $user = wp_insert_user([
        'user_login' => 'mtflpp_acf_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(32), 'role' => 'administrator',
    ]);
    $check(!is_wp_error($user), 'Could not create a fixture user.');
    wp_set_current_user($user);
    register_taxonomy($taxonomy, 'page', ['show_in_rest' => true]);
    foreach (['Saved', 'Preview', 'Additional'] as $label) {
        $term = wp_insert_term($label, $taxonomy);
        $check(!is_wp_error($term), 'Could not create a fixture term.');
        $terms[] = $term['term_id'];
    }
    foreach (['Saved link', 'Preview link', 'Unrelated origin', 'Unrelated target'] as $index => $title) {
        $relatedId = wp_insert_post(['post_title' => $title, 'post_type' => 'page', 'post_status' => 'publish'], true);
        $check(!is_wp_error($relatedId) && $relatedId > 0, 'Could not create a related fixture page.');
        if ($index < 2) {
            $related[] = $relatedId;
        } else {
            $independent[] = $relatedId;
        }
    }
    foreach (['pdf' => 'application/pdf', 'png' => 'image/png'] as $extension => $mime) {
        $attachment = wp_insert_attachment(
            ['post_title' => 'Unattached ACF fixture', 'post_mime_type' => $mime],
            'mtflpp-fixture-' . wp_generate_uuid4() . '.' . $extension,
            0,
            true
        );
        $check(!is_wp_error($attachment) && $attachment > 0, 'Could not create a fixture attachment.');
        $media[] = $attachment;
    }
    acf_add_local_field_group([
        'key' => 'group_mtflpp_acf_test', 'title' => 'Temporary ACF preview test',
        // Unsigned form inputs must belong to a matching field group in ACF 6.8.11+.
        'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'page']]],
        'fields' => [
            ['key' => 'field_mtflpp_acf_test_text', 'name' => 'mtflpp_acf_test_text', 'type' => 'text'],
            [
                'key' => 'field_mtflpp_acf_forward', 'name' => 'mtflpp_acf_forward', 'type' => 'relationship',
                'return_format' => 'id', 'bidirectional' => 1, 'bidirectional_target' => ['field_mtflpp_acf_back'],
            ],
            ['key' => 'field_mtflpp_acf_back', 'name' => 'mtflpp_acf_back', 'type' => 'relationship'],
            ['key' => 'field_mtflpp_acf_file', 'name' => 'mtflpp_acf_file', 'type' => 'file', 'return_format' => 'id'],
            [
                'key' => 'field_mtflpp_acf_image', 'name' => 'mtflpp_acf_image',
                'type' => 'image', 'return_format' => 'id',
            ],
            [
                'key' => 'field_mtflpp_acf_terms', 'name' => 'mtflpp_acf_terms', 'type' => 'taxonomy',
                'taxonomy' => $taxonomy, 'load_terms' => 1, 'save_terms' => 1,
            ],
            [
                'key' => 'field_mtflpp_acf_terms_extra', 'name' => 'mtflpp_acf_terms_extra', 'type' => 'taxonomy',
                'taxonomy' => $taxonomy, 'save_terms' => 1,
            ],
            [
                'key' => 'field_mtflpp_acf_test_rows', 'name' => 'mtflpp_acf_test_rows', 'type' => 'repeater',
                'pagination' => 1, 'rows_per_page' => 1,
                'sub_fields' => [
                    ['key' => 'field_mtflpp_acf_test_row', 'name' => 'text', 'type' => 'text'],
                ],
            ],
            [
                'key' => 'field_mtflpp_acf_group', 'name' => 'mtflpp_acf_group', 'type' => 'group',
                'sub_fields' => [[
                    'key' => 'field_mtflpp_acf_nested', 'name' => 'rows', 'type' => 'repeater',
                    'pagination' => 1, 'rows_per_page' => 1,
                    'sub_fields' => [['key' => 'field_mtflpp_acf_nested_row', 'name' => 'text', 'type' => 'text']],
                ]],
            ],
        ],
    ]);
    $postId = wp_insert_post([
        'post_type' => 'page', 'post_status' => 'publish', 'post_author' => $user,
        'post_title' => 'MTFLPP ACF preview fixture',
    ], true);
    $check(!is_wp_error($postId) && $postId > 0, 'Could not create a fixture page.');
    update_field('field_mtflpp_acf_test_text', 'Saved text', $postId);
    update_field('field_mtflpp_acf_test_rows', [['text' => 'First row'], ['text' => 'Second row']], $postId);
    update_field('field_mtflpp_acf_group', [
        'rows' => [['text' => 'Nested first'], ['text' => 'Nested second']],
    ], $postId);
    update_field('field_mtflpp_acf_forward', [$related[0]], $postId);
    update_field('field_mtflpp_acf_terms', [$terms[0]], $postId);
    $relatedMeta = array_map('get_post_meta', $related);
    $check(
        array_map('intval', get_post_meta($related[0], 'mtflpp_acf_back', true)) === [$postId]
        && wp_get_object_terms($postId, $taxonomy, ['fields' => 'ids']) === [$terms[0]],
        'Fixture setup must exercise native bidirectional and term assignment APIs.'
    );
    $recovery = _wp_put_post_revision(
        array_replace(get_post($postId, ARRAY_A), ['post_content' => 'Recovery text']),
        true
    );
    $check(is_int($recovery) && $recovery > 0, 'Could not create a native recovery autosave.');
    update_metadata('post', $recovery, 'mtflpp_acf_test_text', 'Recovery field');
    $recoveryBase = [$live->snapshotFingerprint($recovery), wp_get_post_autosave($postId, $user)->ID];
    $base = $live->fingerprint($postId);
    $parentSnapshot = $live->snapshotFingerprint($postId);
    $unchanged = static function (int $revisionId) use (
        $check,
        $live,
        $parentSnapshot,
        $postId,
        $related,
        $relatedMeta,
        $recovery,
        $recoveryBase,
        $user,
        $taxonomy,
        $terms,
        $media
    ): void {
        $check($live->snapshotFingerprint($postId) === $parentSnapshot, 'Preview must not change the saved page.');
        $check(
            array_map('get_post_meta', $related) === $relatedMeta,
            'Preview must not change reverse relationship metadata.'
        );
        foreach ($media as $attachment) {
            $check((int) get_post($attachment)->post_parent === 0, 'Preview must not reparent media.');
        }
        $check(
            wp_get_object_terms($postId, $taxonomy, ['fields' => 'ids']) === [$terms[0]]
            && wp_get_object_terms($revisionId, $taxonomy, ['fields' => 'ids']) === [],
            'Preview must not change real term relationships, even on the revision.'
        );
        $check(
            [$live->snapshotFingerprint($recovery), wp_get_post_autosave($postId, $user)->ID] === $recoveryBase,
            'Preview must not change native recovery content, metadata or identity.'
        );
    };
    $taxonomyUpdate = [acf_get_field_type('taxonomy'), 'update_value'];
    $nativeTaxonomyPriority = has_filter('acf/update_value/type=taxonomy', $taxonomyUpdate);
    $setting = acf_get_setting('enable_bidirection');
    // SCF registers a backwards-compatibility filter before any preview runs.
    $writeGuardHooks = static fn (): array => [
        $GLOBALS['wp_filter']['acf/bidirectional/can_update_target']->callbacks ?? [],
        $GLOBALS['wp_filter']['acf/connect_attachment_to_post']->callbacks ?? [],
    ];
    $originalHooks = $writeGuardHooks();
    $assertGuardsReleased = static function () use (
        $check,
        $taxonomyUpdate,
        $nativeTaxonomyPriority,
        $setting,
        $writeGuardHooks,
        $originalHooks
    ): void {
        $check(
            acf_get_setting('enable_bidirection') === $setting
            && $writeGuardHooks() === $originalHooks
            && has_filter('acf/update_value/type=taxonomy', $taxonomyUpdate) === $nativeTaxonomyPriority,
            'Preview completion must release its write guards and restore the native taxonomy writer.'
        );
    };
    $data = [
        'base' => $base, '_acf_nonce' => wp_create_nonce('post'),
        'acf' => [
            'field_mtflpp_acf_test_text' => 'Unsaved text',
            'field_mtflpp_acf_forward' => [$related[1]],
            'field_mtflpp_acf_file' => $media[0],
            'field_mtflpp_acf_image' => $media[1],
            'field_mtflpp_acf_terms' => [$terms[1]],
            'field_mtflpp_acf_terms_extra' => [$terms[2]],
            'field_mtflpp_acf_test_rows' => [
                'row-0' => ['field_mtflpp_acf_test_row' => 'Unsaved first row'],
            ],
            'field_mtflpp_acf_group' => ['field_mtflpp_acf_nested' => [
                'row-0' => ['field_mtflpp_acf_nested_row' => 'Unsaved nested first'],
            ]],
        ],
    ];
    $nestedResponses = [];
    $nested = static function ($id) use ($check, $send, $postId, $data, $independent, &$nestedResponses): void {
        if (get_post_status($id) !== 'mtflpp-preview') {
            return;
        }
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Inspect isolation, not uploaded data.
        $check($_FILES === [], 'A preview save must not inherit caller uploads.');
        $nestedResponses[] = $send($postId, $data);
        $nestedResponses[] = $send($postId, array_replace($data, ['_acf_nonce' => 'invalid']));
        update_field('field_mtflpp_acf_forward', [$independent[1]], $independent[0]);
    };
    $injectZero = static fn ($value, $id, $field) => $field['key'] === 'field_mtflpp_acf_terms_extra'
        ? [0, ...$value] : $value;
    $observed = [];
    $observe = static function ($value, $id, $field) use (&$observed) {
        if ($field['key'] === 'field_mtflpp_acf_terms_extra') {
            $value = array_values($value);
            $observed[] = $value;
        }
        return $value;
    };
    add_action('acf/save_post', $nested, 12);
    add_filter('acf/update_value', $injectZero, 9, 3);
    add_filter('acf/update_value/type=taxonomy', $observe, $nativeTaxonomyPriority, 3);
    // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Preserve the test runner's original form state.
    $originalFiles = $_FILES;
    $callerFiles = ['mtflpp_fixture' => ['error' => UPLOAD_ERR_NO_FILE]];
    try {
        $_FILES = $callerFiles;
        $response = $send($postId, $data);
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Inspect isolation, not uploaded data.
        $check($_FILES === $callerFiles, 'Preview must restore caller uploads.');
        // Probe the same filter after cleanup without enqueueing an assignment.
        $field = acf_get_field('field_mtflpp_acf_terms_extra');
        $field['save_terms'] = 0;
        apply_filters('acf/update_value/type=taxonomy', [0, $terms[2]], $postId, $field);
    } finally {
        $_FILES = $originalFiles;
        remove_action('acf/save_post', $nested, 12);
        remove_filter('acf/update_value', $injectZero, 9);
        remove_filter('acf/update_value/type=taxonomy', $observe, $nativeTaxonomyPriority);
    }
    $check(
        $response->get_status() === 200,
        'Valid ACF form data must preview through the native save path: ' . wp_json_encode($response->get_data())
    );
    $check(count($nestedResponses) === 2, 'The outer ACF preview must exercise both nested requests.');
    foreach ($nestedResponses as $nestedResponse) {
        $check(
            $nestedResponse->get_status() === 409 && $nestedResponse->get_data()['code'] === 'mtflpp_preview_busy',
            'Nested preview requests, including invalid ACF payloads, must not enter the save lifecycle.'
        );
    }
    $check($observed === [[$terms[2]], [$terms[2]]], 'Same-priority taxonomy callbacks must retain their order.');
    $check(
        array_map('intval', get_post_meta($independent[1], 'mtflpp_acf_back', true)) === [$independent[0]],
        'A bidirectional update from an unrelated origin must still work during an owned preview save.'
    );
    parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $query);
    $revisionId = (int) $query['mtflpp_revision'];
    $check(
        get_post($revisionId)->post_status === 'mtflpp-preview'
        && get_metadata('post', $revisionId, 'mtflpp_acf_test_text', true) === 'Unsaved text',
        'Native ACF hooks must save the unsaved value only to the isolated preview revision.'
    );
    $check(
        get_metadata('post', $revisionId, 'mtflpp_acf_test_rows_0_text', true) === 'Unsaved first row'
        && get_metadata('post', $revisionId, 'mtflpp_acf_test_rows_1_text', true) === 'Second row',
        'A partial paginated repeater must merge edited rows with the saved rows.'
    );
    $check(
        $live->fingerprint($postId) === $base && get_field('mtflpp_acf_test_text', $postId) === 'Saved text',
        'Previewing ACF values must not alter the saved page or its metadata.'
    );
    $unchanged($revisionId);
    $assertGuardsReleased();
    $check(
        get_post_meta($revisionId, 'mtflpp_acf_group_rows_0_text', true) === 'Unsaved nested first'
        && get_post_meta($revisionId, 'mtflpp_acf_group_rows_1_text', true) === 'Nested second',
        'A nested paginated repeater must also merge against its saved storage path.'
    );
    $revisionBase = $live->snapshotFingerprint($revisionId);
    $rowField = acf_get_field('field_mtflpp_acf_test_rows');
    $frontendPagination = static function (array $field): array {
        $field['pagination'] = 0;
        return $field;
    };
    $fieldFilter = 'acf/load_field/key=' . $rowField['key'];
    $authorized = static fn () => $live->authorizedSource($postId, $revisionId, $query['mtflpp_token']);
    add_filter($fieldFilter, $frontendPagination);
    try {
        // Start with cold caches as in a frontend request with a different field definition.
        acf_flush_field_cache($rowField);
        clean_post_cache($postId);
        clean_post_cache($revisionId);
        $check(
            empty(acf_get_field($rowField['key'])['pagination']) && $live->fingerprint($postId) !== $base,
            'The frontend field definition must give a different editor baseline.'
        );
        $check(
            $live->snapshotFingerprint($postId) === $parentSnapshot && $authorized() !== null,
            'A frontend field definition must not invalidate an unchanged prepared snapshot.'
        );
        $template = get_post_meta($postId, '_wp_page_template', true);
        update_post_meta($postId, '_wp_page_template', 'fixture-template');
        try {
            $check($authorized() === null, 'A native parent template change must invalidate the read token.');
        } finally {
            if ($template === '') {
                delete_post_meta($postId, '_wp_page_template');
            } else {
                update_post_meta($postId, '_wp_page_template', $template);
            }
        }
        $sourceRow = 'mtflpp_acf_test_rows_0_text';
        update_metadata('post', $revisionId, $sourceRow, 'Tampered snapshot row');
        try {
            $check($authorized() === null, 'Changing a row in the owned snapshot must invalidate the read token.');
        } finally {
            update_metadata('post', $revisionId, $sourceRow, 'Unsaved first row');
        }
    } finally {
        remove_filter($fieldFilter, $frontendPagination);
        acf_flush_field_cache($rowField);
    }
    $externalRowEdits = [
        ['mtflpp_acf_test_rows_0_text' => 'Second row', 'mtflpp_acf_test_rows_1_text' => 'First row'],
        ['mtflpp_acf_group_rows_1_text' => 'Externally edited nested row'],
    ];
    foreach ($externalRowEdits as $changes) {
        $originalRows = [];
        foreach ($changes as $key => $value) {
            $originalRows[$key] = get_post_meta($postId, $key, true);
            update_post_meta($postId, $key, $value);
        }
        try {
            $check($authorized() !== null, 'A parent row change must leave the already prepared snapshot readable.');
            $response = $send($postId, $data);
            $check(
                $response->get_status() === 409 && $response->get_data()['code'] === 'mtflpp_preview_conflict'
                && $live->snapshotFingerprint($revisionId) === $revisionBase,
                'Externally reordered or edited rows must not silently receive an old paginated delta.'
            );
        } finally {
            foreach ($originalRows as $key => $value) {
                update_post_meta($postId, $key, $value);
            }
        }
    }
    update_post_meta($postId, 'mtflpp_acf_test_text', 'Externally edited ordinary ACF value');
    $check($live->fingerprint($postId) === $base, 'An ordinary ACF value is not a paginated merge dependency.');
    update_post_meta($postId, 'mtflpp_acf_test_text', 'Saved text');
    $invalidRequests = [
        ['_acf_nonce' => 'invalid'], ['_acf_nonce' => null],
        ['acf' => 'invalid'], ['_acf_fields' => 'invalid'],
    ];
    foreach ($invalidRequests as $invalid) {
        $response = $send($postId, array_replace($data, $invalid));
        $check(
            $response->get_status() === 400
            && ($response->get_data()['code'] ?? '') === 'mtflpp_acf_unavailable',
            'Invalid ACF form data or nonces must still be rejected.'
        );
        $check(
            $live->snapshotFingerprint($postId) === $parentSnapshot
            && $live->snapshotFingerprint($revisionId) === $revisionBase,
            'Rejected ACF requests must not alter either the saved page or the existing preview.'
        );
    }
    // ACF 6.8.11 accepts a parent-signed field rendered outside matching location rules, not a tampered list.
    if (function_exists('_acf_get_field_list_nonce_action')) {
        $key = 'field_mtflpp_acf_signed';
        acf_add_local_field_group([
            'key' => 'group_mtflpp_acf_signed', 'title' => 'Temporary signed fixture',
            'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'post']]],
            'fields' => [['key' => $key, 'name' => 'mtflpp_acf_signed', 'type' => 'text']],
        ]);
        $signed = $data;
        $signed['acf'][$key] = 'Parent-signed value';
        $signed['_acf_fields'] = [$postId => [$key . '|invalid']];
        $check($send($postId, $signed)->get_status() === 200, 'ACF must still save otherwise authorized values.');
        $check(!get_post_meta($revisionId, 'mtflpp_acf_signed', true), 'ACF must reject a tampered field list.');
        $nonce = wp_create_nonce(_acf_get_field_list_nonce_action($postId, $key));
        $signed['_acf_fields'] = [$postId => [$key . '|' . $nonce]];
        $check($send($postId, $signed)->get_status() === 200, 'A parent-signed field list must survive native save.');
        $check(
            get_post_meta($revisionId, 'mtflpp_acf_signed', true) === 'Parent-signed value',
            'The signed field must be saved.'
        );
    }

    $readFields = static function (array $expectedTerms) use ($check, $postId, $related, $media): void {
        $check(get_field('mtflpp_acf_forward', $postId) === [$related[1]], 'The forward relationship must render.');
        $check((int) get_field('mtflpp_acf_file', $postId) === $media[0], 'The selected file must render.');
        $check((int) get_field('mtflpp_acf_image', $postId) === $media[1], 'The selected image must render.');
        $check(
            (get_field('mtflpp_acf_terms', $postId) ?: []) === $expectedTerms,
            'Load Terms must read the preview assignments.'
        );
    };
    // Prewarm both parent caches before binding, and compare actual ACF loads for colliding encoded IDs.
    $termsField = acf_get_field('field_mtflpp_acf_terms');
    $parentAlias = 'post_' . $postId;
    $check(
        acf_get_value($postId, $termsField) === [$terms[0]]
        && get_field($termsField['key'], $postId) === [$terms[0]]
        && acf_get_value($parentAlias, $termsField) === [$terms[0]]
        && get_field($termsField['key'], $parentAlias) === [$terms[0]],
        'The parent raw and formatted caches must start with saved assignments.'
    );
    $collisions = ['user_' . $postId => [$terms[0]], 'term_' . $revisionId => false];
    $checkCollisionReads = static function () use ($check, $collisions, $termsField): void {
        foreach ($collisions as $acfId => $expected) {
            // Cold reads catch an overlay even when the cached value was correct before binding.
            acf_flush_value_cache($acfId, $termsField['name']);
            $check(
                acf_get_value($acfId, $termsField) === $expected,
                'Load Terms must not overlay a user or term with a colliding numeric ID: ' . $acfId
            );
        }
    };
    $checkCollisionReads();
    // Lower-level ACF reads (used by post-meta blocks) must use the same authorized source.
    $reader = new Acf();
    $reader->bindPreview($postId, $revisionId);
    try {
        $readFields([$terms[1], $terms[2]]);
        $check(
            array_map('intval', get_field('mtflpp_acf_terms_extra', $postId)) === [$terms[2]],
            'Save Terms must retain the field value independently of the preview assignment.'
        );
        $check(
            acf_get_value($postId, $termsField) === [$terms[1], $terms[2]]
            && acf_get_value($parentAlias, $termsField) === [$terms[1], $terms[2]]
            && get_field($termsField['key'], $parentAlias) === [$terms[1], $terms[2]],
            'Load Terms must work for lower-level reads with either encoding of a post ID.'
        );
        $checkCollisionReads();
        $field = acf_get_field('field_mtflpp_acf_test_text');
        $check(acf_get_value($postId, $field) === 'Unsaved text', 'Raw ACF value reads must use the preview source.');
        $check(
            acf_get_metadata($postId, 'mtflpp_acf_test_text', true) === $field['key'],
            'Raw ACF field references must use the preview source too.'
        );
        delete_metadata('post', $revisionId, 'mtflpp_acf_test_text');
        $reader->clearRevisionCache($postId);
        $reader->clearRevisionCache($revisionId);
        $check(
            acf_get_metadata($postId, 'mtflpp_acf_test_text') === null,
            'Absent source metadata must not fall back to the parent.'
        );
    } finally {
        $reader->unbindPreview();
    }
    $check(
        acf_get_value($postId, $termsField) === [$terms[0]]
        && get_field($termsField['key'], $postId) === [$terms[0]]
        && acf_get_value($parentAlias, $termsField) === [$terms[0]],
        'After unbinding, raw and formatted parent reads must use saved assignments again.'
    );
    $reused = $data;
    $reused['acf']['field_mtflpp_acf_terms'] = [];
    $reused['acf']['field_mtflpp_acf_terms_extra'] = [];
    $response = $send($postId, $reused);
    $check($response->get_status() === 200, 'A reused preview must be writable with empty taxonomy selections.');
    parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $query);
    $check((int) $query['mtflpp_revision'] === $revisionId, 'Expected to exercise a reused source.');
    $unchanged($revisionId);
    $assertGuardsReleased();
    $reader->bindPreview($postId, $revisionId);
    try {
        $readFields([]);
        $check(
            get_field('mtflpp_acf_test_rows', $postId) === [['text' => 'Unsaved first row'], ['text' => 'Second row']],
            'A reused source must still render both paginated repeater rows.'
        );
    } finally {
        $reader->unbindPreview();
    }
    // Core-only refreshes must drop the previous ACF term overlay, then use core selections or saved relationships.
    foreach ([[], ['terms' => wp_json_encode([$taxonomy => [$terms[2]]])]] as $selection) {
        $check($send($postId, ['base' => $base] + $selection)->get_status() === 200, 'Core-only refresh failed.');
        $reader->bindPreview($postId, $revisionId);
        try {
            $check(
                get_field('mtflpp_acf_terms', $postId) === [$selection ? $terms[2] : $terms[0]],
                'Without ACF input, Load Terms must follow core preview selections or saved terms.'
            );
        } finally {
            $reader->unbindPreview();
        }
        $unchanged($revisionId);
    }
    if (function_exists('acf_register_block_type')) {
        acf_register_block_type([
            'name' => 'mtflpp-meta-fixture', 'title' => 'MTFLPP metadata fixture', 'use_post_meta' => true,
            'render_callback' => static function (): void {
                echo esc_html(get_field('mtflpp_block_text'));
                echo esc_html(implode(',', (array) get_field('mtflpp_block_terms')));
            },
        ]);
        acf_add_local_field_group([
            'key' => 'group_mtflpp_block_fixture', 'title' => 'MTFLPP block fields',
            'location' => [[['param' => 'block', 'operator' => '==', 'value' => 'acf/mtflpp-meta-fixture']]],
            'fields' => [
                ['key' => 'field_mtflpp_block_text', 'name' => 'mtflpp_block_text', 'type' => 'text'],
                [
                    'key' => 'field_mtflpp_block_terms', 'name' => 'mtflpp_block_terms', 'type' => 'taxonomy',
                    'taxonomy' => $taxonomy, 'load_terms' => 1, 'save_terms' => 1,
                ],
            ],
        ]);
        $block = ['name' => 'acf/mtflpp-meta-fixture', 'id' => 'block_mtflpp_fixture'];
        $response = $send($postId, [
            'base' => $base,
            'content' => '<!-- wp:acf/mtflpp-meta-fixture ' . wp_json_encode($block + ['data' => [
                'field_mtflpp_block_text' => 'Unsaved block meta', 'field_mtflpp_block_terms' => [$terms[1], $terms[2]],
            ]]) . ' /-->',
        ]);
        $check($response->get_status() === 200, 'ACF post-meta blocks must use their native content-save hooks.');
        parse_str(wp_parse_url($response->get_data()['url'], PHP_URL_QUERY), $blockQuery);
        $blockRevision = (int) $blockQuery['mtflpp_revision'];
        $check(
            get_post_meta($blockRevision, 'mtflpp_block_text', true) === 'Unsaved block meta',
            'Native ACF block hooks must save only to the preview revision.'
        );
        $unchanged($blockRevision);
        $reader->bindPreview($postId, $blockRevision);
        $originalPost = $GLOBALS['post'] ?? null;
        try {
            $GLOBALS['post'] = get_post($postId);
            // Omit inline data to exercise the native block reader's lower-level post-meta path.
            $html = do_blocks('<!-- wp:acf/mtflpp-meta-fixture ' . wp_json_encode($block) . ' /-->');
            $check(
                str_contains($html, 'Unsaved block meta' . $terms[1] . ',' . $terms[2]),
                'Native ACF block rendering must read preview metadata and Load Terms.'
            );
        } finally {
            $GLOBALS['post'] = $originalPost;
            $reader->unbindPreview();
        }
    }
    $skip = static fn ($skip, $id) => $id === $revisionId ? true : $skip;
    add_filter('acf/form-post/skip_save', $skip, 10, 2);
    try {
        $response = $send($postId, $data);
        $check(
            ($response->get_data()['code'] ?? '') === 'mtflpp_acf_not_saved',
            'A native ACF save skipped after initialization must return a preview error.'
        );
    } finally {
        remove_filter('acf/form-post/skip_save', $skip, 10);
    }
    $assertGuardsReleased();
    $unchanged($revisionId);

    $throw = static function ($id) use ($revisionId): void {
        if ($id === $revisionId) {
            throw new RuntimeException('Fixture exception after native ACF field updates');
        }
    };
    add_action('acf/save_post', $throw, 12);
    try {
        $send($postId, $data);
        $check(false, 'The fixture must throw during the guarded save.');
    } catch (RuntimeException $exception) {
        $check(
            $exception->getMessage() === 'Fixture exception after native ACF field updates',
            'Unexpected save exception.'
        );
    } finally {
        remove_action('acf/save_post', $throw, 12);
    }
    $assertGuardsReleased();
    $unchanged($revisionId);

    $throwVerifier = static function ($error, array $context) use ($revisionId) {
        if (($context['source']['id'] ?? 0) === $revisionId) {
            throw new RuntimeException('Fixture exception before the ACF verifier');
        }
        return $error;
    };
    $afterCleanup = false;
    $finish = static function (array $context) use ($assertGuardsReleased, $revisionId, &$afterCleanup): void {
        if (($context['source']['id'] ?? 0) === $revisionId) {
            $assertGuardsReleased();
            $afterCleanup = true;
        }
    };
    add_filter('mtflpp_live_preview_preparation_error', $throwVerifier, 5, 2);
    add_action('mtflpp_live_preview_preparation_finished', $finish);
    try {
        $send($postId, $data);
        $check(false, 'The fixture must throw before ACF can verify.');
    } catch (RuntimeException $exception) {
        $check(
            $exception->getMessage() === 'Fixture exception before the ACF verifier',
            'Unexpected verifier error.'
        );
    } finally {
        remove_filter('mtflpp_live_preview_preparation_error', $throwVerifier, 5);
        remove_action('mtflpp_live_preview_preparation_finished', $finish);
    }
    $check($afterCleanup, 'An early verifier exception must still trigger ACF cleanup.');
    $unchanged($revisionId);
    $check($send($postId, $data)->get_status() === 200, 'A sequential preview must recover after verifier failure.');

    // Dispatch an owned preview inside an explicit native save, after ACF has queued the caller's terms.
    $taxonomyField = acf_get_field_type('taxonomy');
    $nestedInNative = false;
    $nativeObserver = static function ($id) use (
        $check,
        $live,
        $postId,
        $send,
        $taxonomy,
        $terms,
        $taxonomyField,
        &$nestedInNative
    ): void {
        if ($id !== $postId) {
            return;
        }
        $queue = $taxonomyField->save_post_terms;
        $check(($queue[$taxonomy] ?? []) === [$terms[1], $terms[2]], 'Native ACF must have queued its assignments.');
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Inspect caller state, not fixture input.
        $post = $_POST;
        $preview = $send($postId, [
            'base' => $live->fingerprint($postId), '_acf_nonce' => wp_create_nonce('post'),
            'acf' => ['field_mtflpp_acf_terms' => [$terms[0]]],
        ]);
        $check($preview->get_status() === 200, 'A preview inside native ACF Save must be writable.');
        parse_str(wp_parse_url($preview->get_data()['url'], PHP_URL_QUERY), $query);
        $source = (int) $query['mtflpp_revision'];
        $check(
            $taxonomyField->save_post_terms === $queue
            && wp_get_object_terms($source, $taxonomy, ['fields' => 'ids']) === [],
            'The nested preview must neither drain nor clear the native caller’s ACF term queue.'
        );
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Compare caller state, not fixture input.
        $formRestored = $_POST === $post && acf_get_form_data('post_id') === $postId;
        $check($formRestored, 'The nested preview must restore the caller’s native form context.');
        $nestedInNative = true;
    };
    $termsAtNativePriority = null;
    $afterDrain = static function ($id) use ($postId, $taxonomy, &$termsAtNativePriority): void {
        if ($id === $postId) {
            $termsAtNativePriority = wp_get_object_terms($postId, $taxonomy, ['fields' => 'ids']);
            sort($termsAtNativePriority);
        }
    };
    $drainPriority = has_action('acf/save_post', [$taxonomyField, 'save_post']);
    $originalSaveCallbacks = $GLOBALS['wp_filter']['acf/save_post']->callbacks;
    $duplicateDrainPriority = $drainPriority + 5;
    add_action('acf/save_post', [$taxonomyField, 'save_post'], $duplicateDrainPriority);
    add_action('acf/save_post', $nativeObserver, 12);
    add_action('acf/save_post', $afterDrain, $drainPriority);
    // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Preserve the test runner's original form state.
    $originalPost = $_POST;
    try {
        $_POST = wp_slash(['post_ID' => $postId, '_acf_nonce' => wp_create_nonce('post'), 'acf' => $data['acf']]);
        $id = wp_update_post(['ID' => $postId, 'post_title' => 'Explicit ACF Save'], true);
        $check($id === $postId, 'Native Save failed.');
    } finally {
        $_POST = $originalPost;
        remove_action('acf/save_post', $nativeObserver, 12);
        remove_action('acf/save_post', $afterDrain, $drainPriority);
        remove_action('acf/save_post', [$taxonomyField, 'save_post'], $duplicateDrainPriority);
    }
    $check(
        $GLOBALS['wp_filter']['acf/save_post']->callbacks === $originalSaveCallbacks,
        'Every guarded native callback slot must be restored without changing its order.'
    );
    $check($nestedInNative, 'The native save must exercise a nested preview with a preexisting term queue.');
    $check(
        $termsAtNativePriority === [$terms[1], $terms[2]],
        'The native term drain must keep its same-priority order.'
    );
    $check(
        get_field('mtflpp_acf_test_text', $postId) === 'Unsaved text',
        'Native Save must still update the parent field.'
    );
    $check(
        array_map('intval', get_post_meta($related[1], 'mtflpp_acf_back', true)) === [$postId]
        && !get_post_meta($related[0], 'mtflpp_acf_back', true),
        'Native Save must update and remove reverse relationships.'
    );
    foreach ($media as $attachment) {
        $check((int) get_post($attachment)->post_parent === $postId, 'Native Save must still attach selected media.');
    }
    $savedTermIds = wp_get_object_terms($postId, $taxonomy, ['fields' => 'ids']);
    sort($savedTermIds);
    $check($savedTermIds === [$terms[1], $terms[2]], 'Native Save must still assign selected terms.');
    WP_CLI::success('ACF ' . acf_get_setting('version') . ': preview saves, repeater merging, native block meta, '
        . 'side-effect isolation, cleanup and explicit native Save passed.');
} finally {
    remove_filter('acf/is_trusted_save_context', $untrusted);
    if (is_int($postId) && $postId) {
        wp_delete_post($postId, true);
    }
    foreach ($media as $attachment) {
        wp_delete_attachment($attachment, true);
    }
    foreach (array_merge($related, $independent) as $relatedId) {
        wp_delete_post($relatedId, true);
    }
    foreach ($terms as $termId) {
        wp_delete_term($termId, $taxonomy);
    }
    if (taxonomy_exists($taxonomy)) {
        unregister_taxonomy($taxonomy);
    }
    if (is_int($user) && $user) {
        wp_delete_user($user);
    }
    wp_set_current_user($originalUser);
}
