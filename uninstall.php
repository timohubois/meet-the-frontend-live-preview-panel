<?php

/** Remove plugin-owned preview data without touching content or recovery autosaves. */

namespace MeetTheFrontendLivePreviewPanel;

defined('WP_UNINSTALL_PLUGIN') || exit;

require_once __DIR__ . '/classes/Migrations.php';

// The deactivated plugin has not registered this status; WP_Query ignores unregistered statuses.
register_post_status('mtflpp-preview', ['internal' => true]);

$mtflppCleanupSite = static function (): void {
    global $wpdb;

    $scopes = array_fill_keys(
        array_merge(['meet-the-frontend-live-preview-panel'], Migrations::uninstallForSite()),
        true
    );

    $offset = 0;
    do {
        $revisions = get_posts([
            'post_type' => 'revision',
            'post_status' => 'mtflpp-preview',
            'posts_per_page' => 100,
            'offset' => $offset,
            'orderby' => 'ID',
            'order' => 'ASC',
            'fields' => 'ids',
        ]);
        foreach ($revisions as $revisionId) {
            $revision = get_post($revisionId);
            if (
                !$revision || $revision->post_type !== 'revision' || $revision->post_status !== 'mtflpp-preview'
                || !wp_delete_post_revision($revisionId)
            ) {
                // Skip unexpected records or vetoed deletions rather than retrying them forever.
                ++$offset;
            }
        }
    } while (count($revisions) === 100);

    $metaKey = $wpdb->get_blog_prefix() . 'persisted_preferences';
    $page = 1;
    do {
        $userIds = get_users([
            'blog_id' => 0,
            // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key -- Bounded, uninstall-only preference scan.
            'meta_key' => $metaKey,
            'number' => 100,
            'paged' => $page++,
            'orderby' => 'ID',
            'order' => 'ASC',
            'fields' => 'ID',
        ]);
        foreach ($userIds as $userId) {
            $preferences = get_user_meta($userId, $metaKey, true);
            if (!is_array($preferences) || !array_intersect_key($preferences, $scopes)) {
                continue;
            }
            $previous = $preferences;
            $preferences = array_diff_key($preferences, $scopes);
            // Prefer the cleaned server copy over WordPress's older browser-local preference backup.
            $preferences['_modified'] = current_datetime()->format('Y-m-d\TH:i:s.vP');
            update_user_meta($userId, $metaKey, wp_slash($preferences), $previous);
        }
    } while (count($userIds) === 100);
};

if (!is_multisite()) {
    $mtflppCleanupSite();
    return;
}

$mtflppOffset = 0;
do {
    $mtflppSiteIds = get_sites([
        'fields' => 'ids',
        'number' => 100,
        'offset' => $mtflppOffset,
        'orderby' => 'id',
        'order' => 'ASC',
    ]);
    foreach ($mtflppSiteIds as $mtflppSiteId) {
        switch_to_blog($mtflppSiteId);
        try {
            $mtflppCleanupSite();
        } finally {
            restore_current_blog();
        }
    }
    $mtflppOffset += count($mtflppSiteIds);
} while (count($mtflppSiteIds) === 100);
