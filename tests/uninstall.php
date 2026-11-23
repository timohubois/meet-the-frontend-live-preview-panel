<?php

/** Destructive: use MTFLPP_TEST_UNINSTALL=1 and prefix mtflpp_test_ on a disposable WP-CLI installation only. */

if (!defined('WP_CLI') || !WP_CLI) {
    throw new RuntimeException('Run this fixture through WP-CLI.');
}
if (getenv('MTFLPP_TEST_UNINSTALL') !== '1') {
    WP_CLI::log('Skipping destructive uninstall checks; explicitly opt in on a disposable test installation.');
    return;
}
global $wpdb;
if ($wpdb->base_prefix !== 'mtflpp_test_') {
    throw new RuntimeException('Uninstall checks require the dedicated mtflpp_test_ table prefix.');
}
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/user.php';
if (is_multisite()) {
    require_once ABSPATH . 'wp-admin/includes/ms.php';
}
$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$plugin = 'meet-the-frontend-live-preview-panel/meet-the-frontend-live-preview-panel.php';
$active = is_plugin_active($plugin);
$network = is_plugin_active_for_network($plugin);
$originalUser = get_current_user_id();
$startingSite = get_current_blog_id();
$users = $fixtures = [];
$createdSite = 0;
$scope = 'meet-the-frontend-live-preview-panel';
$preferences = static fn (int $i): array|string => match ($i) {
    101 => ['core/edit-site' => ['keep' => true]],
    102 => 'Malformed legacy preferences',
    default => [
        '_modified' => '2000-01-01T00:00:00.000Z',
        'core/edit-post' => ['text' => "O'Reilly \\ path", 'nested' => [false, 0]],
        $scope . '-extra' => ['keep' => true], $scope => $i === 100 ? null : ['panelOpen' => true],
    ],
};
$snapshot = static fn (int $id): array => [get_post($id, ARRAY_A), get_post_meta($id)];
try {
    for ($i = 0; $i < 103; $i++) {
        $id = wp_insert_user([
            'user_login' => 'mtflpp_uninstall_' . wp_generate_password(16, false, false),
            'user_pass' => wp_generate_password(32), 'role' => 'subscriber',
        ]);
        $check(!is_wp_error($id), 'Could not create a fixture user.');
        $users[] = $id;
    }
    wp_set_current_user($users[0]);
    $sites = [$startingSite];
    if (is_multisite()) {
        $createdSite = wpmu_create_blog(
            wp_parse_url(home_url(), PHP_URL_HOST),
            '/mtflpp-uninstall/',
            'Uninstall fixture',
            $users[0]
        );
        $check(!is_wp_error($createdSite), 'Could not create a fixture site.');
        $sites[] = $createdSite;
    }
    foreach ($sites as $siteId) {
        if (is_multisite()) {
            switch_to_blog($siteId);
        }
        try {
            $fixtures[$siteId] = ['posts' => [], 'previews' => [], 'protected' => []];
            $create = static function (array $data) use (&$fixtures, $siteId, $check): int {
                $id = wp_insert_post($data + ['post_title' => 'Uninstall fixture'], true);
                $check(!is_wp_error($id) && $id > 0, 'Could not create a fixture post.');
                $fixtures[$siteId]['posts'][] = $id;
                return $id;
            };
            $parent = $create(['post_status' => 'publish', 'post_title' => 'Saved uninstall fixture']);
            $revision = ['post_type' => 'revision', 'post_status' => 'inherit', 'post_parent' => $parent];
            $history = $create($revision + ['post_title' => 'Ordinary history']);
            $recovery = $create($revision + ['post_name' => $parent . '-autosave-v1', 'post_title' => 'Recovery']);
            $otherRevision = $create(array_replace($revision, ['post_status' => 'other-preview']));
            $otherPost = $create(['post_type' => 'post', 'post_status' => 'mtflpp-preview']);
            $check(wp_is_post_autosave($recovery) === $parent, 'The recovery fixture must be a native autosave.');
            foreach ([$parent, $history, $recovery, $otherRevision, $otherPost] as $id) {
                add_metadata('post', $id, 'mtflpp_uninstall_fixture', ['keep' => "O'Reilly \\ path"]);
                $fixtures[$siteId]['protected'][$id] = $snapshot($id);
            }
            for ($i = 0; $i < 101; $i++) {
                $id = $create(array_replace($revision, ['post_status' => 'mtflpp-preview']));
                add_metadata('post', $id, 'mtflpp_uninstall_fixture', ['remove' => true]);
                $fixtures[$siteId]['previews'][] = $id;
            }
            $key = $wpdb->get_blog_prefix() . 'persisted_preferences';
            foreach ($users as $i => $id) {
                update_user_meta($id, $key, wp_slash($preferences($i)));
            }
            $fixtures[$siteId]['key'] = $key;
        } finally {
            if (is_multisite()) {
                restore_current_blog();
            }
        }
    }
    $orphanKey = $wpdb->base_prefix . '999_persisted_preferences';
    update_user_meta($users[0], $orphanKey, [$scope => ['keep' => true]]);
    deactivate_plugins($plugin, true, $network);
    $check(get_post($fixtures[$startingSite]['previews'][0]) !== null, 'Deactivation must keep preview data.');
    unset($GLOBALS['wp_post_statuses']['mtflpp-preview']); // Uninstall must work without plugin registration.
    $check(uninstall_plugin($plugin) === true, 'WordPress must discover and execute uninstall.php.');
    foreach ($fixtures as $siteId => $fixture) {
        if (is_multisite()) {
            switch_to_blog($siteId);
        }
        try {
            foreach ($fixture['previews'] as $id) {
                $check(!get_post($id) && !get_post_meta($id), 'All preview revisions and metadata must be removed.');
            }
            foreach ($fixture['protected'] as $id => $before) {
                $check($snapshot($id) === $before, 'Preserve saved posts, history, recovery and foreign data.');
            }
            foreach ($users as $i => $id) {
                $before = $preferences($i);
                $after = get_user_meta($id, $fixture['key'], true);
                if (is_array($before) && array_key_exists($scope, $before)) {
                    $check(strtotime($after['_modified'] ?? '') > strtotime($before['_modified']), 'New timestamp.');
                    unset($before[$scope], $before['_modified'], $after['_modified']);
                }
                $check($after === $before, 'Preserve unrelated preferences, types and escaping.');
            }
        } finally {
            if (is_multisite()) {
                restore_current_blog();
            }
        }
    }
    $check(get_user_meta($users[0], $orphanKey, true) === [$scope => ['keep' => true]], 'Keep other metadata keys.');
    include dirname(__DIR__) . '/uninstall.php';
    $check(
        get_current_blog_id() === $startingSite && (!is_multisite() || !ms_is_switched()),
        'Repeated cleanup must restore site context.'
    );
    WP_CLI::success('Uninstall preserves content and preferences across batches and test sites.');
} finally {
    foreach ($fixtures as $siteId => $fixture) {
        if (is_multisite()) {
            switch_to_blog($siteId);
        }
        foreach (array_reverse($fixture['posts']) as $id) {
            wp_delete_post($id, true);
        }
        if (is_multisite()) {
            restore_current_blog();
        }
    }
    if (is_int($createdSite) && $createdSite > 0) {
        wpmu_delete_blog($createdSite, true);
    }
    foreach ($users as $id) {
        if (is_multisite()) {
            wpmu_delete_user($id);
        } else {
            wp_delete_user($id);
        }
    }
    wp_set_current_user($originalUser);
    if ($active) {
        $check(!is_wp_error(activate_plugin($plugin, '', $network, true)), 'Restore plugin activation.');
    }
}
