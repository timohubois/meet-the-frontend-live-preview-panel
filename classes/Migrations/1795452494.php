<?php

namespace MeetTheFrontendLivePreviewPanel\Migrations;

/**
 * Discards obsolete live-preview snapshots after the plugin identifier rename.
 * Only revisions with the old preview status are removed; the status is never registered.
 */
final class Migration1795452494
{
    private const STATE_OPTION = 'mtflpp_identifier_rename_state';
    private const PREVIOUS_PREFERENCE_SCOPE = 'a-floating-live-preview-panel';
    private const PREVIOUS_PREVIEW_STATUS = 'aflpp-preview';
    private const BATCH_SIZE = 100;
    private const COMPLETE = 'complete';

    public static function runForSite(): void
    {
        $state = get_option(self::STATE_OPTION, 0);
        if ($state === self::COMPLETE) {
            return;
        }
        if (is_array($state)) {
            if (($state['retry_after'] ?? 0) > time()) {
                return;
            }
            $state = 0;
        }

        $ids = self::findOldPreviews((int) $state);
        if ($ids === null) {
            return;
        }
        self::discardPreviews($ids);
        if (count($ids) === self::BATCH_SIZE) {
            update_option(self::STATE_OPTION, (int) end($ids), false);
            return;
        }

        // Retry vetoed deletions after a pause, not on every administrator request.
        $remaining = self::findOldPreviews(0, 1);
        if ($remaining !== null) {
            $nextState = $remaining ? ['retry_after' => time() + HOUR_IN_SECONDS] : self::COMPLETE;
            update_option(self::STATE_OPTION, $nextState, false);
        }
    }

    /** @return list<string> Retired preference scopes for the shared uninstall scan. */
    public static function uninstallForSite(): array
    {
        // Check all old snapshots, even if no administrator visited after upgrading.
        $lastId = 0;
        do {
            $ids = self::findOldPreviews($lastId);
            if (!$ids) {
                break;
            }
            self::discardPreviews($ids);
            $lastId = (int) end($ids);
        } while (count($ids) === self::BATCH_SIZE);

        delete_option(self::STATE_OPTION);
        return [self::PREVIOUS_PREFERENCE_SCOPE];
    }

    private static function findOldPreviews(int $lastId, int $limit = self::BATCH_SIZE): ?array
    {
        global $wpdb;

        // WP_Query cannot select an unregistered status. Use core APIs for the actual deletions.
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Migration-only lookup.
        $ids = $wpdb->get_col($wpdb->prepare(
            "SELECT ID FROM {$wpdb->posts} WHERE post_type = 'revision' AND post_status = %s AND ID > %d
                ORDER BY ID ASC LIMIT %d",
            self::PREVIOUS_PREVIEW_STATUS,
            $lastId,
            $limit
        ));
        return $wpdb->last_error === '' ? $ids : null;
    }

    private static function discardPreviews(array $ids): void
    {
        foreach ($ids as $id) {
            $post = get_post((int) $id);
            if ($post && $post->post_type === 'revision' && $post->post_status === self::PREVIOUS_PREVIEW_STATUS) {
                wp_delete_post_revision($post);
            }
        }
    }
}
