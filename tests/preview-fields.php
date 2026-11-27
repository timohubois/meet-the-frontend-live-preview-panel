<?php

/** Run with `wp eval-file tests/preview-fields.php` on a disposable single-site installation. */

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
$users = [];
$postId = 0;
$termId = 0;
$live = new LivePreview();
try {
    foreach (['administrator', 'author'] as $role) {
        $id = wp_insert_user([
            'user_login' => 'mtflpp_fields_' . wp_generate_password(12, false, false),
            'user_pass' => wp_generate_password(32), 'role' => $role,
        ]);
        $check(!is_wp_error($id), 'Could not create a fixture user.');
        $users[] = $id;
    }
    [$admin, $author] = $users;
    wp_set_current_user($admin);
    $term = wp_insert_term('MTFLPP fields ' . wp_generate_password(12, false, false), 'category');
    $check(!is_wp_error($term), 'Could not create a fixture term.');
    $termId = (int) $term['term_id'];
    $postId = wp_insert_post([
        'post_title' => 'MTFLPP preview fields', 'post_status' => 'publish', 'post_author' => $author,
        'post_date' => '2020-01-10 13:00:00', 'post_date_gmt' => '2020-01-10 13:00:00',
    ], true);
    $check(!is_wp_error($postId), 'Could not create a fixture post.');
    $base = $live->fingerprint($postId);
    $parentSnapshot = $live->snapshotFingerprint($postId);
    $recoveryId = _wp_put_post_revision($postId, true);
    $check(is_int($recoveryId), 'Could not create a recovery fixture.');
    $recovery = $live->snapshotFingerprint($recoveryId);
    $route = '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview';
    $prepare = static function (array $input = []) use ($route, $base): WP_REST_Response {
        $request = new WP_REST_Request('POST', $route);
        $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
        // WordPress supplies the unslashed, PHP-parsed POST values to REST as body parameters.
        $request->set_body_params(['base' => $base, ...$input]);
        return rest_ensure_response(rest_do_request($request));
    };
    $rich = "<h2>Heading</h2>\nUse the editor's options... <code>1x2...</code>";
    $field = 'fixture[row-1][body]';
    $rowBody = ['fixture' => ['row-1' => ['body' => $rich, 'unrequested' => 'Leave this unchanged...']]];
    $check(!isset($prepare($rowBody)->get_data()['rowDisplayText']), 'Do not format row hints without opt-in.');
    $typography = $prepare($rowBody + ['mtflpp_row_text_fields' => wp_json_encode([
        $field, $field, 'fixture[row-1]', 'fixture[row-2][body]', 'fixture[row-1][body][]', 123,
    ])]);
    $formatted = wpautop(wptexturize($rich));
    $check(
        $typography->get_status() === 200 && $typography->get_data()['rowDisplayText'] === [$field => $formatted]
        && str_contains($formatted, '<code>1x2...</code>') && str_contains($formatted, '<p>'),
        'Return only requested native variants and leave code text intact.'
    );
    $check($live->fingerprint($postId) === $base, 'Row display hints must not write to the saved post.');
    $input = ['author' => $admin, 'date' => '2030-07-15T13:45:00Z', 'terms' => wp_json_encode([
        'category' => [$termId],
    ])];
    foreach ([LivePreview::AUTHOR_META, LivePreview::DATE_META, LivePreview::TERMS_META] as $key) {
        foreach ([false, true] as $reuse) {
            $live->deletePreviews($postId);
            if ($reuse) {
                $check($prepare()->get_status() === 200, 'Could not create the reused-source baseline.');
            }
            $writes = 0;
            $blockWrite = static function ($value, int $id, string $metaKey) use ($key, &$writes) {
                if (get_post_type($id) === 'revision' && $metaKey === $key) {
                    ++$writes;
                    return false;
                }
                return $value;
            };
            add_filter('update_post_metadata', $blockWrite, 10, 3);
            try {
                $failure = $prepare($input);
                $check($writes > 0, 'The fixture must actually block the requested write.');
                $check($failure->get_status() === 409, 'Failed field writes must return HTTP 409: ' . $key);
                $check(
                    $failure->get_data()['code'] === 'mtflpp_preview_fields_not_saved',
                    'Failed snapshots must report the preparation error, not a usable preview URL.'
                );
            } finally {
                remove_filter('update_post_metadata', $blockWrite);
            }
            $success = $prepare($input);
            $check($success->get_status() === 200, 'Retrying after a failed write must recover.');
            parse_str(wp_parse_url($success->get_data()['url'], PHP_URL_QUERY), $query);
            $sourceId = (int) $query['mtflpp_revision'];
            $check(
                $live->authorizedSource($postId, $sourceId, $query['mtflpp_token']) instanceof WP_Post,
                'A fully persisted snapshot must yield an authorized source.'
            );
            $check((int) get_post_meta($sourceId, LivePreview::AUTHOR_META, true) === $admin, 'Author persisted.');
            $check(
                get_post_meta($sourceId, LivePreview::DATE_META, true)['post_date_gmt'] === '2030-07-15 13:45:00',
                'Both date fields must be persisted.'
            );
            $check(
                get_post_meta($sourceId, LivePreview::TERMS_META, true)['category'] === [$termId],
                'Assignments must be persisted without touching saved relationships.'
            );
            $check(
                $live->snapshotFingerprint($postId) === $parentSnapshot
                && $live->snapshotFingerprint($recoveryId) === $recovery,
                'Failure and retry must preserve the saved parent and recovery data.'
            );
        }
    }
    // A false update result can also mean unchanged. Seed the same author before core attempts its update.
    $sameAuthorCalls = 0;
    $sameAuthor = static function (int $id) use ($admin, $check, &$sameAuthorCalls): void {
        ++$sameAuthorCalls;
        update_metadata('post', $id, LivePreview::AUTHOR_META, $admin);
        $check(
            update_metadata('post', $id, LivePreview::AUTHOR_META, $admin) === false,
            'The fixture must exercise the native unchanged-value return.'
        );
    };
    add_action('save_post_revision', $sameAuthor, -1);
    try {
        $check($prepare($input)->get_status() === 200, 'Identical persisted values must not be treated as failures.');
        $check($sameAuthorCalls > 0, 'The unchanged-value fixture must actually run before snapshot persistence.');
    } finally {
        remove_action('save_post_revision', $sameAuthor, -1);
    }
    $keys = [LivePreview::AUTHOR_META, LivePreview::DATE_META, LivePreview::TERMS_META];
    $recordChurn = static function ($metaId, int $id, string $key) use ($sourceId, $keys, $check): void {
        $check($id !== $sourceId || !in_array($key, $keys, true), 'Unchanged preview fields must not be recreated.');
    };
    add_action('added_post_meta', $recordChurn, 10, 3);
    add_action('deleted_post_meta', $recordChurn, 10, 3);
    try {
        $title = 'Only the title changed';
        $repeat = $prepare($input + ['post_title' => $title]);
        $check($repeat->get_status() === 200, 'Unchanged fields must remain usable.');
        $check(get_post($sourceId)->post_title === $title, 'The new title must be saved on the same preview source.');
    } finally {
        remove_action('added_post_meta', $recordChurn);
        remove_action('deleted_post_meta', $recordChurn);
    }
    // A matching first value does not excuse duplicate rows left by integrations or older data.
    add_metadata('post', $sourceId, LivePreview::AUTHOR_META, $author);
    $check($prepare($input)->get_status() === 200, 'A duplicate preview field must be repaired.');
    $check(get_post_meta($sourceId, LivePreview::AUTHOR_META, false) === [(string) $admin], 'Keep one author value.');

    $reset = ['author' => $author, 'date' => '2020-01-10T13:00:00Z', 'terms' => wp_json_encode(['category' => []])];
    $check($prepare($reset)->get_status() === 200, 'Reverting fields and clearing assignments must work on reuse.');
    $check(get_post_meta($sourceId, LivePreview::AUTHOR_META, true) === (string) $author, 'Restore the saved author.');
    $check(
        get_post_meta($sourceId, LivePreview::DATE_META, true)['post_date_gmt'] === '2020-01-10 13:00:00',
        'Restore the saved date.'
    );
    $check(get_post_meta($sourceId, LivePreview::TERMS_META, true)['category'] === [], 'Store the explicit clear.');

    // Also reject a later save callback changing a successfully written snapshot.
    $corrupt = static function (int $id) use ($postId): void {
        if (wp_get_post_parent_id($id) === $postId && get_post_status($id) === 'mtflpp-preview') {
            update_metadata('post', $id, LivePreview::DATE_META, ['post_date' => 'invalid']);
        }
    };
    add_action('save_post_revision', $corrupt, PHP_INT_MAX);
    try {
        $check($prepare($input)->get_status() === 409, 'Post-save snapshot corruption must be rejected.');
    } finally {
        remove_action('save_post_revision', $corrupt, PHP_INT_MAX);
    }
    $check($prepare($input)->get_status() === 200, 'A retry must replace a corrupt source.');
    $check($live->snapshotFingerprint($postId) === $parentSnapshot, 'Saved data must remain unchanged throughout.');
    $check($live->snapshotFingerprint($recoveryId) === $recovery, 'Recovery data must remain unchanged throughout.');
    wp_update_post(['ID' => $postId, 'post_author' => 0]);
    $check((int) get_post($postId)->post_author === 0, 'The orphaned-author fixture must have author zero.');
    $blockZero = static fn ($value, int $id, string $key) =>
        get_post_type($id) === 'revision' && $key === LivePreview::AUTHOR_META ? false : $value;
    add_filter('update_post_metadata', $blockZero, 10, 3);
    try {
        $request = new WP_REST_Request('POST', $route);
        $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
        $request->set_body_params(['base' => $live->fingerprint($postId)]);
        $check(
            rest_do_request($request)->get_status() === 409,
            'Missing metadata must not compare equal to author zero.'
        );
    } finally {
        remove_filter('update_post_metadata', $blockZero);
    }
    WP_CLI::success('Field persistence failures, reused sources, no-op updates, corruption and recovery passed.');
} finally {
    if (is_int($postId) && $postId > 0) {
        wp_delete_post($postId, true);
    }
    if ($termId) {
        wp_delete_term($termId, 'category');
    }
    foreach ($users as $id) {
        wp_delete_user($id);
    }
    wp_set_current_user($originalUser);
}
