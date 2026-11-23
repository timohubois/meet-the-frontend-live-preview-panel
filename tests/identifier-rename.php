<?php

/** Run the migration against a disposable WP-CLI installation only. */

use MeetTheFrontendLivePreviewPanel\Migrations;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(Migrations::class)) {
    throw new RuntimeException('Run through WP-CLI with this plugin active.');
}
global $wpdb;
if (getenv('MTFLPP_TEST_UNINSTALL') !== '1' || $wpdb->base_prefix !== 'mtflpp_test_') {
    WP_CLI::log('Skipping migration cleanup checks outside the opted-in disposable installation.');
    return;
}
require_once ABSPATH . 'wp-admin/includes/user.php';
if (is_multisite()) {
    require_once ABSPATH . 'wp-admin/includes/ms.php';
}

$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$check(has_action('admin_init', [Migrations::class, 'runForSite']) !== false, 'Register the migration runner.');
$stateOption = 'mtflpp_identifier_rename_state';
$initialOption = get_option($stateOption);
$initialUser = get_current_user_id();
$posts = [];
$admin = $subsite = 0;
$blockDeletion = null;
$status = 'aflpp-preview';
try {
    delete_option($stateOption);
    $check(!get_post_status_object($status), 'The old status must not be registered.');
    $admin = wp_insert_user([
        'user_login' => 'mtflpp_migration_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(32), 'role' => 'administrator',
    ]);
    $check(is_int($admin) && $admin > 0, 'Create a test administrator.');
    wp_set_current_user($admin);
    $create = static function (array $fields) use (&$posts, $check): int {
        $id = wp_insert_post($fields + ['post_title' => 'Identifier rename fixture'], true);
        $check(is_int($id) && $id > 0, 'Create a fixture post.');
        $posts[] = $id;
        return $id;
    };
    $parent = $create(['post_status' => 'publish']);
    $revision = ['post_type' => 'revision', 'post_parent' => $parent];
    $protected = [
        $parent,
        $create($revision + ['post_status' => 'inherit', 'post_name' => $parent . '-revision-v1']),
        $create($revision + ['post_status' => 'inherit', 'post_name' => $parent . '-autosave-v1']),
        $create($revision + ['post_status' => 'mtflpp-preview']),
        $create(['post_type' => 'post', 'post_status' => $status]),
    ];
    $previews = [];
    for ($i = 0; $i < 101; $i++) {
        $id = $create($revision + ['post_status' => $status]);
        add_metadata('post', $id, 'migration_fixture', ['remove' => true]);
        $previews[] = $id;
    }

    wp_set_current_user(0);
    Migrations::runForSite();
    $check(get_post($previews[0]) !== null, 'A request without an administrator must not run the migration.');
    $check(!get_option($stateOption), 'Do not start migration on a skipped request.');

    wp_set_current_user($admin);
    $blocked = array_shift($previews);
    $last = array_pop($previews);
    $blockDeletion = static fn ($delete, WP_Post $post) => $post->ID === $blocked ? false : $delete;
    add_filter('pre_delete_post', $blockDeletion, 10, 2);
    Migrations::runForSite();
    $check(get_post($blocked) !== null, 'Respect a deletion veto.');
    $check(get_post($last) !== null, 'Leave snapshots beyond the first batch for a subsequent request.');
    $check((int) get_option($stateOption) === end($previews), 'Persist the first batch cursor.');
    foreach ($previews as $id) {
        $check(!get_post($id) && !get_post_meta($id), 'Remove old snapshots and metadata in the first batch.');
    }

    Migrations::runForSite();
    remove_filter('pre_delete_post', $blockDeletion, 10);
    $check(!get_post($last) && !get_post_meta($last), 'The next batch must proceed past a vetoed snapshot.');
    $check(get_post($blocked) !== null, 'Do not delete the vetoed snapshot until another pass.');
    $retryState = get_option($stateOption);
    $check(($retryState['retry_after'] ?? 0) > time(), 'Delay another pass after a veto.');
    Migrations::runForSite();
    $check(get_post($blocked) !== null, 'Do not retry a vetoed snapshot during the delay.');
    $check(get_option($stateOption) === $retryState, 'Skipped requests must not extend the delay.');

    update_option($stateOption, ['retry_after' => time() - 1], false);
    Migrations::runForSite();
    $check(!get_post($blocked) && !get_post_meta($blocked), 'Remove the remaining snapshot after the delay.');
    $check(get_option($stateOption) === 'complete', 'Record the completed site migration.');
    $check(!get_post_status_object($status), 'The migration must not register the old status.');
    foreach ($protected as $id) {
        $check(get_post($id) !== null, 'Preserve saved content, history, recovery and current previews.');
    }
    if (is_multisite()) {
        $subsite = wpmu_create_blog(
            wp_parse_url(home_url(), PHP_URL_HOST),
            trailingslashit(wp_parse_url(home_url(), PHP_URL_PATH) ?: '/') . 'mtflpp-migration/',
            'Migration fixture',
            $admin,
            [],
            get_current_network_id()
        );
        $check(is_int($subsite) && $subsite > 0, 'Create a fixture subsite.');
        switch_to_blog($subsite);
        try {
            $check(current_user_can('manage_options') && !is_super_admin(), 'Run as a subsite administrator.');
            $check(!get_option($stateOption), 'The subsite must have its own completion marker.');
            $subsitePost = wp_insert_post(['post_title' => 'Subsite saved post', 'post_status' => 'publish'], true);
            $check(is_int($subsitePost) && $subsitePost > 0, 'Create a saved post on the subsite.');
            $subsitePreview = wp_insert_post([
                'post_title' => 'Subsite legacy preview',
                'post_type' => 'revision',
                'post_parent' => $subsitePost,
                'post_status' => $status,
            ], true);
            $check(is_int($subsitePreview) && $subsitePreview > 0, 'Create a legacy snapshot on the subsite.');
            Migrations::runForSite();
            $check(!get_post($subsitePreview), 'Remove the legacy snapshot on the subsite.');
            $check(get_post($subsitePost) !== null, 'Preserve saved posts on the subsite.');
            $check(get_option($stateOption) === 'complete', 'Record completion on the subsite.');
        } finally {
            restore_current_blog();
        }
        $check(get_option($stateOption) === 'complete', 'Keep the main site marker.');
    }
    WP_CLI::success('The identifier migration removes only old temporary previews and records completion per site.');
} finally {
    if ($blockDeletion !== null) {
        remove_filter('pre_delete_post', $blockDeletion, 10);
    }
    foreach (array_reverse($posts) as $id) {
        wp_delete_post($id, true);
    }
    if (is_int($subsite) && $subsite > 0) {
        wpmu_delete_blog($subsite, true);
    }
    if (is_int($admin) && $admin > 0) {
        if (is_multisite()) {
            wpmu_delete_user($admin);
        } else {
            wp_delete_user($admin);
        }
    }
    wp_set_current_user($initialUser);
    if ($initialOption === false) {
        delete_option($stateOption);
    } else {
        update_option($stateOption, $initialOption);
    }
}
