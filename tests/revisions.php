<?php

/** Run with `wp eval-file tests/revisions.php` on a disposable single-site installation with this plugin active. */

use MeetTheFrontendLivePreviewPanel\Panel;
use MeetTheFrontendLivePreviewPanel\Compatibility\CoreBlocks;
use MeetTheFrontendLivePreviewPanel\FrontendPreview;
use MeetTheFrontendLivePreviewPanel\LivePreview;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(FrontendPreview::class)) {
    throw new RuntimeException('Run this through WP-CLI with Meet the Frontend – Live Preview Panel active.');
}

if (is_multisite()) {
    WP_CLI::error('Run this fixture on a disposable single-site installation; multisite is not supported.');
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
$posts = [];
$users = [];
$hasTimber = class_exists(\Timber\Timber::class);
$hasLegacyTimber = $hasTimber && method_exists(\Timber\Post::class, 'import_custom');
// Exercise the compatibility subscribers registered by the real plugin bootstrap.
$originalHooks = [];
$previewHooks = [
    'the_preview', 'get_post_metadata', 'timber/post/import_data',
    'timber_post_get_meta_pre', 'timber_post_get_meta_field_pre',
    'acf/validate_post_id', 'acf/pre_load_metadata', 'acf/pre_update_metadata', 'acf/pre_delete_metadata',
];
foreach ($previewHooks as $hook) {
    $originalHooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
}
$livePreview = new LivePreview();
$preview = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $livePreview);
$sources = [];
$observeSource = static function (array $context, bool $readOnly) use ($check, &$sources): void {
    $check(
        array_keys($context) === ['post', 'source']
        && array_keys($context['post']) === ['id'] && array_keys($context['source']) === ['id'],
        'Source events must expose identities only; the hook name identifies live versus saved preview.'
    );
    $sources[] = [$context['post']['id'], $context['source']['id'], $readOnly];
};
$observeLiveSource = static fn (array $context) => $observeSource($context, false);
$observeSavedSource = static fn (array $context) => $observeSource($context, true);
add_action('mtflpp_frontend_live_preview_source_selected', $observeLiveSource, 20);
add_action('mtflpp_frontend_saved_preview_source_selected', $observeSavedSource, 20);
$dieHandler = static fn () => static function ($message, $title, $args): void {
    throw new RuntimeException('mtflpp_denied_' . (int) ($args['response'] ?? 0));
};
add_filter('wp_die_handler', $dieHandler, PHP_INT_MAX);
$denied = static function (array $query) use ($preview, $check, &$sources): void {
    $before = count($sources);
    $_GET = $query;
    try {
        $preview->authorizePreview();
    } catch (RuntimeException $error) {
        $check($error->getMessage() === 'mtflpp_denied_403', 'Denied previews must return HTTP 403.');
        $check(count($sources) === $before, 'Denied requests must never bind compatibility reads.');
        return;
    }
    throw new RuntimeException('An unauthorized preview was accepted.');
};
$query = static function (string $url): array {
    parse_str(wp_parse_url($url, PHP_URL_QUERY), $query);
    return $query;
};

try {
    // Inspect the real rendered view, not PHP source formatting or obsolete CSS class names.
    $panelTitle = 'Preview "<strong>literal text</strong>" & more';
    ob_start();
    (new Panel(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php'))->render($panelTitle);
    $document = new DOMDocument();
    $document->loadHTML(ob_get_clean(), LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
    $xpath = new DOMXPath($document);
    $byClass = static fn (string $name): DOMNodeList => $xpath->query(
        '//*[contains(concat(" ", normalize-space(@class), " "), " ' . $name . ' ")]'
    );
    foreach (['mtflpp-move-control', 'mtflpp-caption', 'mtflpp-resize'] as $class) {
        $check($byClass($class)->length === 1, 'The rendered panel needs one ' . $class . ' binding.');
    }
    $panel = $document->getElementById('mtflpp-panel');
    $launcher = $document->getElementById('mtflpp-toggle');
    $check(
        $launcher && $launcher->tagName === 'div' && $launcher->hasAttribute('hidden')
        && $launcher->getAttribute('data-title') === $panelTitle
        && $launcher->getAttribute('data-move-help') !== '' && !$launcher->getElementsByTagName('button')->length,
        'The escaped launcher mount must wait for native controls, not render its own button.'
    );
    $caption = $byClass('mtflpp-caption')->item(0);
    $check(
        $caption->tagName === 'h2' && $caption->textContent === $panelTitle && !$caption->childElementCount
        && $caption->getAttribute('id') !== '' && $panel
        && $panel->getAttribute('aria-labelledby') === $caption->getAttribute('id')
        && !$panel->hasAttribute('aria-label'),
        'The panel must be labelled by its visible heading, including before JavaScript initializes.'
    );
    $header = $byClass('mtflpp-header')->item(0);
    $check(
        $xpath->query('.//header//*[@class="mtflpp-controls"]', $panel)->length === 1
        && $xpath->query('.//footer//*[@class="mtflpp-device-controls"]', $panel)->length === 1,
        'Header and viewport controls must remain scoped to the labelled panel.'
    );
    $check(
        $header && $xpath->query('.//button | .//*[@tabindex >= 0]', $header)->length === 0,
        'The initial titlebar must not contain keyboard resize controls or interactive title buttons.'
    );
    $buttons = $xpath->query('//section//button');
    $check($buttons->length === 1, 'The shell must have exactly one keyboard resize control.');
    $resize = $buttons->item(0);
    $check(trim($resize->getAttribute('aria-label')) !== '', 'Keyboard resizing needs an accessible label.');
    $help = $document->getElementById($resize->getAttribute('aria-describedby'));
    $check($help && trim($help->textContent) !== '', 'Keyboard resizing needs linked instructions.');
    $edges = $xpath->query('//*[@data-resize-edge]');
    $directions = [];
    foreach ($edges as $edge) {
        $directions[] = $edge->getAttribute('data-resize-edge');
        $check(
            $edge->tagName !== 'button'
            && (!$edge->hasAttribute('tabindex') || (int) $edge->getAttribute('tabindex') < 0)
            && $edge->getAttribute('aria-hidden') === 'true',
            'Pointer resize edges must stay out of the keyboard and accessibility navigation.'
        );
    }
    sort($directions);
    $check(
        $directions === ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'],
        'Every pointer resize edge must be rendered once.'
    );
    $statuses = $xpath->query('//*[@role="status"]');
    $check(
        $statuses->length === 1 && $statuses->item(0)->getAttribute('aria-hidden') !== 'true'
        && !$statuses->item(0)->hasAttribute('hidden'),
        'The shell needs one accessible status region.'
    );

    $suffix = wp_generate_password(12, false, false);
    foreach (['administrator', 'subscriber'] as $role) {
        $id = wp_insert_user([
            'user_login' => 'mtflpp_revision_test_' . $role . '_' . $suffix,
            'user_pass' => wp_generate_password(32),
            'role' => $role,
        ]);
        $check(!is_wp_error($id), 'Could not create the temporary test user.');
        $users[] = $id;
    }
    [$admin, $subscriber] = $users;
    wp_set_current_user($admin);
    foreach (['Selected post', 'Unrelated post'] as $title) {
        $id = wp_insert_post([
            'post_type' => 'post', 'post_status' => 'draft', 'post_author' => $admin,
            'post_title' => 'MTFLPP test — ' . $title,
            'post_content' => 'Saved content', 'post_excerpt' => 'Saved excerpt',
        ], true);
        $check(!is_wp_error($id) && $id > 0, 'Could not create the temporary test post.');
        $posts[] = $id;
    }
    [$postId, $otherId] = $posts;
    $revisionId = _wp_put_post_revision($postId);
    $check(!is_wp_error($revisionId) && $revisionId > 0, 'Could not create a test revision.');
    wp_update_post([
        'ID' => $revisionId, 'post_author' => $subscriber, 'post_title' => 'Historical title',
        'post_content' => 'Historical content', 'post_excerpt' => 'Historical excerpt',
    ]);
    $generatedRevisionId = _wp_put_post_revision($postId);
    $check(is_int($generatedRevisionId) && $generatedRevisionId > 0, 'Could not create an empty-excerpt revision.');
    wp_update_post([
        'ID' => $generatedRevisionId, 'post_excerpt' => '',
        'post_content' => '<p>Historical generated excerpt</p>',
    ]);
    $excerptBlock = static fn (): string => (new WP_Block([
        'blockName' => 'core/post-excerpt', 'attrs' => [], 'innerBlocks' => [],
        'innerHTML' => '', 'innerContent' => [],
    ], ['postId' => $postId, 'postType' => 'post']))->render();
    $internalId = wp_insert_post([
        'post_type' => 'revision', 'post_status' => 'mtflpp-preview', 'post_parent' => $postId,
        'post_author' => $admin, 'post_name' => $postId . '-mtflpp-preview-' . $admin,
        'post_title' => 'Internal live preview', 'post_excerpt' => 'Internal live excerpt',
    ]);
    $posts[] = $internalId;
    $foreignInternalId = wp_insert_post([
        'post_type' => 'revision', 'post_status' => 'mtflpp-preview', 'post_parent' => $postId,
        'post_author' => $subscriber, 'post_name' => $postId . '-mtflpp-preview-' . $subscriber,
    ]);
    $posts[] = $foreignInternalId;
    $autosaveId = wp_insert_post([
        'post_type' => 'revision', 'post_status' => 'inherit', 'post_parent' => $postId,
        'post_author' => $admin, 'post_name' => $postId . '-autosave-v1', 'post_title' => 'Recovery autosave',
    ]);
    $check(wp_is_post_autosave($autosaveId) === $postId, 'Recovery autosave fixture failed.');
    $check(!isset(wp_get_post_revisions($postId)[$internalId]), 'Internal previews must stay out of history.');
    register_post_meta('post', 'mtflpp_revision_test_meta', [
        'type' => 'string', 'single' => true, 'show_in_rest' => true, 'revisions_enabled' => true,
    ]);
    register_post_meta('post', 'mtflpp_revision_test_array', [
        'type' => 'array', 'single' => true, 'revisions_enabled' => true,
        'show_in_rest' => ['schema' => ['type' => 'array', 'items' => ['type' => 'string']]],
    ]);
    register_post_meta('post', 'mtflpp_revision_test_missing', [
        'type' => 'string', 'single' => true, 'show_in_rest' => true, 'revisions_enabled' => true,
    ]);
    update_post_meta($postId, 'mtflpp_revision_test_array', ['Saved array']);
    update_metadata('post', $revisionId, 'mtflpp_revision_test_array', ['Historical', 'array']);
    update_post_meta($postId, 'mtflpp_revision_test_missing', 'Not present in history');
    update_post_meta($postId, 'mtflpp_revision_test_meta', 'Saved metadata');
    update_metadata('post', $revisionId, 'mtflpp_revision_test_meta', 'Historical metadata');
    update_post_meta($postId, 'mtflpp_unrevisioned_test_meta', 'Current unrevisioned metadata');
    update_metadata('post', $revisionId, 'mtflpp_unrevisioned_test_meta', 'Must not be used');
    update_post_meta($otherId, 'mtflpp_revision_test_meta', 'Unrelated metadata');
    update_metadata('post', $internalId, 'mtflpp_revision_test_meta', 'Live preview metadata');
    update_metadata('post', $internalId, 'mtflpp_revision_test_array', ['Live preview', 'array']);
    update_metadata('post', $internalId, 'mtflpp_revision_test_missing', '');
    update_post_meta($postId, 'mtflpp_revision_test_deleted', 'Saved value to delete');
    update_metadata('post', $internalId, 'mtflpp_revision_test_deleted', 'Saved value to delete');
    $check(delete_metadata('post', $internalId, 'mtflpp_revision_test_deleted'), 'Remove the key, not just its value.');
    update_metadata('post', $internalId, LivePreview::AUTHOR_META, (string) $admin);

    if (function_exists('acf_add_local_field_group')) {
        acf_add_local_field_group([
            'key' => 'group_mtflpp_revision_test', 'title' => 'Temporary revision test',
            'fields' => [
                ['key' => 'field_mtflpp_revision_test_text', 'name' => 'mtflpp_revision_test_text', 'type' => 'text'],
                [
                    'key' => 'field_mtflpp_revision_test_rows',
                    'name' => 'mtflpp_revision_test_rows', 'type' => 'repeater',
                    'sub_fields' => [
                        [
                            'key' => 'field_mtflpp_revision_test_row', 'name' => 'text', 'type' => 'text',
                        ],
                    ],
                ],
            ],
        ]);
        foreach ([$postId => 'Saved', $revisionId => 'Historical', $internalId => 'Live'] as $id => $prefix) {
            update_field('field_mtflpp_revision_test_text', $prefix . ' ACF text', $id);
            update_field('field_mtflpp_revision_test_rows', [['text' => $prefix . ' ACF row']], $id);
        }
    }

    $post = get_post($postId);
    $savedUrl = $preview->savedPreviewUrl($post, $revisionId);
    $currentUrl = $preview->savedPreviewUrl($post, $postId);
    $check(is_string($savedUrl) && is_string($currentUrl), 'Saved sources should have preview URLs.');
    $check(is_string($preview->savedPreviewUrl($post, $autosaveId)), 'Recovery autosaves should be readable.');
    $check($preview->savedPreviewUrl($post, $internalId) === null, 'History must not expose internal previews.');
    $check($preview->savedPreviewUrl(get_post($otherId), $revisionId) === null, 'Foreign revisions must be rejected.');

    $customStatuses = [
        'mtflpp-test-public' => ['public' => true],
        'mtflpp-test-protected' => ['protected' => true],
        'mtflpp-test-private' => ['private' => true],
        'mtflpp-test-internal' => ['internal' => true],
    ];
    foreach ($customStatuses as $name => $args) {
        register_post_status($name, $args);
    }
    $otherRevisionId = _wp_put_post_revision($otherId);
    $check(!is_wp_error($otherRevisionId) && $otherRevisionId > 0, 'Could not create a custom-status revision.');
    $statusCases = [
        'mtflpp-test-public' => true, 'mtflpp-test-protected' => true, 'mtflpp-test-private' => true,
        'mtflpp-test-internal' => false, 'mtflpp-unregistered' => false, 'auto-draft' => false, 'trash' => false,
    ];
    foreach ($statusCases as $status => $eligible) {
        wp_update_post(['ID' => $otherId, 'post_status' => $status]);
        $other = get_post($otherId);
        $statusUrl = $preview->savedPreviewUrl($other, $otherRevisionId);
        $check(is_string($statusUrl) === $eligible, 'Revision URL eligibility failed for ' . $status);
        $check(
            is_string($preview->savedPreviewUrl($other, $otherId)) === $eligible,
            'Current-post URL eligibility failed for ' . $status
        );
        if ($eligible) {
            $_GET = $query($statusUrl);
            $preview->authorizePreview();
            $check(
                $preview->readPost(clone $other)->post_title === get_post($otherRevisionId)->post_title,
                'Custom-status authorization failed for ' . $status
            );
        } else {
            $denied([
                'mtflpp_post' => (string) $otherId, 'mtflpp_revision' => (string) $otherRevisionId,
                'mtflpp_saved' => '1',
                'mtflpp_token' => wp_create_nonce('mtflpp_saved_' . $otherId . '_' . $otherRevisionId),
            ]);
        }
    }
    wp_update_post(['ID' => $otherId, 'post_status' => 'draft']);

    $savedQuery = $query($savedUrl);
    $tampered = $savedQuery;
    $tampered['mtflpp_token'] = 'invalid';
    $denied($tampered);
    $tampered = $savedQuery;
    $tampered['mtflpp_post'] = $otherId;
    $denied($tampered);
    $tampered = $savedQuery;
    unset($tampered['mtflpp_saved']);
    $denied($tampered); // Saved nonces must not authorize the live-preview path.
    $tampered = $savedQuery;
    $tampered['mtflpp_revision'] = $internalId;
    $tampered['mtflpp_token'] = wp_create_nonce('mtflpp_saved_' . $postId . '_' . $internalId);
    $denied($tampered); // Even a valid saved-source nonce cannot expose internal revisions.
    $tampered = $savedQuery;
    $tampered['mtflpp_saved'] = ['1'];
    $denied($tampered);

    foreach ([$subscriber, 0] as $userId) {
        wp_set_current_user($userId);
        $check($preview->savedPreviewUrl($post, $revisionId) === null, 'Non-editors must not get preview URLs.');
        $denied($savedQuery);
    }
    wp_set_current_user($admin);
    $stateAction = new ReflectionMethod(LivePreview::class, 'stateAction');
    $internalQuery = [
        'mtflpp_post' => (string) $postId, 'mtflpp_revision' => (string) $foreignInternalId,
        'mtflpp_token' => wp_create_nonce($stateAction->invoke($livePreview, $postId, $foreignInternalId)),
    ];
    $denied($internalQuery);
    $internalQuery['mtflpp_revision'] = (string) $internalId;
    $internalQuery['mtflpp_token'] = wp_create_nonce($stateAction->invoke($livePreview, $postId, $internalId));
    $_GET = $internalQuery;
    $preview->authorizePreview();
    $check($preview->readPost(clone $post)->post_title === 'Internal live preview', 'Live preview regressed.');
    $renderer = WP_Block_Type_Registry::get_instance()->get_registered('core/post-excerpt')->render_callback;
    $coreBlocks = is_array($renderer) ? $renderer[0] : null;
    $check($coreBlocks instanceof CoreBlocks, 'The real bootstrap must bind the native block compatibility owner.');
    $check(str_contains($excerptBlock(), 'Internal live excerpt'), 'Live core excerpts must use the selected source.');
    $check(end($sources) === [$postId, $internalId, false], 'Live-source context must not be read-only.');
    $check(
        apply_filters('timber/post/import_data', ['post_title' => 'Saved title'], $post)['post_title']
            === ($hasTimber ? 'Internal live preview' : 'Saved title'),
        'Timber must use the authorized live source only when the dependency is available.'
    );
    if ($hasLegacyTimber) {
        // Themes can construct Post directly, without passing through a Timber factory.
        $timberPost = new \Timber\Post($postId);
        $check(
            (int) $timberPost->ID === $postId
            && $timberPost->mtflpp_revision_test_meta === 'Live preview metadata'
            && $timberPost->mtflpp_revision_test_array === ['Live preview', 'array']
            && $timberPost->mtflpp_revision_test_missing === ''
            && !array_key_exists(LivePreview::AUTHOR_META, $timberPost->custom),
            'Timber 1 must eagerly import the matching live snapshot with native metadata shapes.'
        );
        $check(
            (new \Timber\Post($otherId))->mtflpp_revision_test_meta === 'Unrelated metadata'
            && get_post_meta($postId, 'mtflpp_revision_test_meta', true) === 'Saved metadata',
            'Timber 1 live imports must not change other posts or ordinary metadata reads.'
        );
        $check(
            !array_key_exists('mtflpp_revision_test_deleted', $timberPost->custom)
            && \Timber\Timber::compile_string('{{ post.mtflpp_revision_test_deleted }}', ['post' => $timberPost]) === ''
            && get_post_meta($postId, 'mtflpp_revision_test_deleted', true) === 'Saved value to delete',
            'A deleted metadata key must stay absent in Twig without changing ordinary reads.'
        );
        $check(
            apply_filters('timber_post_get_meta_field_pre', null, $postId, 'mtflpp_revision_test_deleted') === false
            && apply_filters('timber_post_get_meta_field_pre', 'Earlier value', $postId, 'mtflpp_revision_test_deleted')
                === 'Earlier value',
            'Only short-circuit the native metadata fallback, not earlier Timber filters.'
        );
        $virtualMeta = static fn ($value, int $id, string $key) => $id === $postId && $key === 'mtflpp_virtual_meta'
            ? ['Virtual value'] : $value;
        add_filter('get_post_metadata', $virtualMeta, 20, 3);
        try {
            $check(
                get_post_meta($postId, 'mtflpp_virtual_meta', true) === 'Virtual value'
                && apply_filters('timber_post_get_meta_field_pre', null, $postId, 'mtflpp_virtual_meta') === null,
                'Virtual metadata is not a deleted key and must retain the native read path.'
            );
        } finally {
            remove_filter('get_post_metadata', $virtualMeta, 20);
        }
        if (function_exists('get_field')) {
            $check(
                $timberPost->mtflpp_revision_test_text === 'Live ACF text'
                && $timberPost->meta('mtflpp_revision_test_text') === 'Live ACF text',
                'Direct Timber 1 properties must agree with explicit ACF metadata reads.'
            );
        }
    } elseif ($hasTimber) {
        $legacyImports = did_filter('timber_post_get_meta_pre');
        $check(
            \Timber\Timber::get_post($postId)->post_title === 'Internal live preview'
            && did_filter('timber_post_get_meta_pre') === $legacyImports,
            'Timber 2 must import core fields without calling the legacy metadata hook.'
        );
    }
    if (function_exists('get_field')) {
        $check(
            update_field('field_mtflpp_revision_test_text', 'Writable live ACF text', $postId) !== false
            && get_post_meta($internalId, 'mtflpp_revision_test_text', true) === 'Writable live ACF text',
            'Saved-source guards must not block live-preview writes after rebinding.'
        );
        $check(
            delete_field('field_mtflpp_revision_test_text', $postId),
            'Live-preview deletions must remain writable.'
        );
    }

    $attemptAcfWrites = static function (int $sourceId) use ($postId, $check): void {
        $changes = [
            'field_mtflpp_revision_test_text' => 'Must not persist',
            'field_mtflpp_revision_test_rows' => [['text' => 'Must not persist'], ['text' => 'Rejected extra row']],
        ];
        foreach (array_unique([$postId, $sourceId, 'post_' . $sourceId]) as $target) {
            foreach ($changes as $field => $value) {
                $check(update_field($field, $value, $target) === false, 'Saved-source ACF updates must be rejected.');
                $check(delete_field($field, $target) === false, 'Saved-source ACF deletions must be rejected.');
            }
        }
        $check(
            acf_update_metadata($sourceId, 'mtflpp_revision_test_text', 'Must not persist') === false
            && acf_delete_metadata($sourceId, 'mtflpp_revision_test_text', true) === false,
            'Direct ACF metadata operations must also be rejected for the saved source.'
        );
        foreach (['acf/pre_update_metadata', 'acf/pre_delete_metadata'] as $hook) {
            foreach (['user_', 'term_', 'comment_', 'option_'] as $prefix) {
                $check(
                    apply_filters($hook, null, $prefix . $sourceId) === null,
                    'Non-post ACF objects must remain unaffected by saved-source guards.'
                );
            }
        }
    };

    // Raw database snapshots detect writes without being affected by request-local read filters.
    global $wpdb;
    $snapshot = static function () use ($wpdb, $postId): array {
        // phpcs:disable WordPress.DB.DirectDatabaseQuery -- Assert raw persisted state, bypassing preview filters.
        return [
            $wpdb->get_results($wpdb->prepare(
                "SELECT * FROM {$wpdb->posts} WHERE ID = %d OR post_parent = %d ORDER BY ID",
                $postId,
                $postId
            ), ARRAY_A),
            $wpdb->get_results($wpdb->prepare(
                "SELECT * FROM {$wpdb->postmeta} WHERE post_id IN (
                    SELECT ID FROM {$wpdb->posts} WHERE ID = %d OR post_parent = %d
                ) ORDER BY meta_id",
                $postId,
                $postId
            ), ARRAY_A),
        ];
        // phpcs:enable WordPress.DB.DirectDatabaseQuery
    };
    $before = $snapshot();
    $_GET = $savedQuery;
    $preview->authorizePreview();
    $rendered = $preview->readPost(clone $post);
    $check($rendered->post_title === 'Historical title', 'Core title must come from the selected revision.');
    $check($rendered->post_content === 'Historical content', 'Core content must come from the selected revision.');
    $check($rendered->post_excerpt === 'Historical excerpt', 'Core excerpt must come from the selected revision.');
    $check(
        str_contains($excerptBlock(), 'Historical excerpt') && !str_contains($excerptBlock(), 'Saved excerpt'),
        'The native Post Excerpt block must render the selected historical excerpt.'
    );
    $check($rendered->ID === $postId, 'The parent identity must remain stable.');
    $check(end($sources) === [$postId, $revisionId, true], 'History must expose the selected read-only source.');
    $import = ['ID' => $postId, 'custom' => 'Keep me'];
    $expected = $hasTimber ? $import + [
        'post_title' => 'Historical title', 'post_content' => 'Historical content',
        'post_excerpt' => 'Historical excerpt',
    ] : $import;
    $check(
        apply_filters('timber/post/import_data', $import, $post) === $expected,
        'Timber must preserve unrelated data, and stay inert when its dependency is absent.'
    );
    if ($hasLegacyTimber) {
        $timberSaved = new \Timber\Post($postId);
        $check(
            $timberSaved->mtflpp_revision_test_meta === 'Saved metadata'
            && $timberSaved->mtflpp_revision_test_deleted === 'Saved value to delete'
            && apply_filters('timber_post_get_meta_field_pre', null, $postId, 'mtflpp_revision_test_deleted') === null,
            'The Timber 1 live metadata overlay must be removed on rebinding to saved history.'
        );
    } elseif ($hasTimber) {
        $timberPost = \Timber\Timber::get_post($postId);
        $check(
            $timberPost->post_title === 'Historical title'
            && $timberPost->post_content === 'Historical content'
            && $timberPost->post_excerpt === 'Historical excerpt',
            'Installed Timber must import the same selected source through its native API.'
        );
    }
    $unrelated = ['post_title' => 'Unrelated title', 'custom' => 'Keep me'];
    $check(
        apply_filters('timber/post/import_data', $unrelated, get_post($otherId)) === $unrelated,
        'Timber compatibility must leave unrelated posts untouched.'
    );
    $check(
        get_post_meta($postId, 'mtflpp_revision_test_meta', true) === 'Historical metadata',
        'Revisioned meta failed.'
    );
    $check(
        get_post_meta($postId, 'mtflpp_revision_test_array', true) === ['Historical', 'array'],
        'Single array-valued metadata must not be unwrapped twice.'
    );
    $check(
        get_post_meta($postId, 'mtflpp_revision_test_array', false) === [['Historical', 'array']],
        'Multi-value metadata reads must keep their native shape.'
    );
    $check(
        get_post_meta($postId, 'mtflpp_revision_test_missing', true) === '',
        'Missing historical metadata must not fall back to the saved post.'
    );
    $check(
        !metadata_exists('post', $postId, 'mtflpp_revision_test_missing')
        && metadata_exists('post', $postId, 'mtflpp_revision_test_array'),
        'Historical metadata existence must reflect the selected source.'
    );
    $check(
        get_post_meta($postId, 'mtflpp_unrevisioned_test_meta', true) === 'Current unrevisioned metadata',
        'Unrevisioned metadata must stay current.'
    );
    if (function_exists('get_field')) {
        $attemptAcfWrites($revisionId);
        $check(
            update_field('field_mtflpp_revision_test_text', 'Unrelated writable ACF text', $otherId) !== false
            && get_post_meta($otherId, 'mtflpp_revision_test_text', true) === 'Unrelated writable ACF text',
            'Saved-source guards must not block unrelated post writes.'
        );
        $check(delete_field('field_mtflpp_revision_test_text', $otherId), 'Unrelated deletions must remain writable.');
        $check(get_field('mtflpp_revision_test_text', $postId) === 'Historical ACF text', 'ACF source binding failed.');
        $rows = get_field('mtflpp_revision_test_rows', $postId);
        $check(($rows[0]['text'] ?? '') === 'Historical ACF row', 'Historical repeater values failed.');
    }
    $_GET = $query($preview->savedPreviewUrl($post, $generatedRevisionId));
    $preview->authorizePreview();
    $check(
        str_contains($excerptBlock(), 'Historical generated excerpt')
        && !str_contains($excerptBlock(), 'Saved excerpt'),
        'An empty historical excerpt must generate from the selected historical content.'
    );
    $_GET = $query($currentUrl);
    $preview->authorizePreview();
    $check(
        str_contains($excerptBlock(), 'Saved excerpt') && !str_contains($excerptBlock(), 'Historical'),
        'Current saved selection must not retain the historical block excerpt.'
    );
    $check($preview->readPost(clone $post)->post_title === $post->post_title, 'Current-post source failed.');
    $check(end($sources) === [$postId, $postId, true], 'Current saved sources must also be read-only.');
    $check(
        apply_filters('timber/post/import_data', ['post_title' => $post->post_title], $post)['post_title']
            === $post->post_title,
        'Timber must rebind to the saved parent without retaining historical fields.'
    );
    $check(
        get_post_meta($postId, 'mtflpp_revision_test_meta', true) === 'Saved metadata',
        'Current metadata failed.'
    );
    if (function_exists('get_field')) {
        $attemptAcfWrites($postId);
        $check(get_field('mtflpp_revision_test_text', $postId) === 'Saved ACF text', 'Current ACF source failed.');
    }
    $check($before === $snapshot(), 'Reading revision previews changed saved posts or metadata.');
    WP_CLI::success(
        'Panel markup, revision permissions, core/Timber fields, metadata, optional ACF and read-only behavior passed.'
    );
} finally {
    if (isset($coreBlocks) && $coreBlocks instanceof CoreBlocks) {
        $coreBlocks->unbindPreview();
    }
    $_GET = $originalGet;
    remove_filter('wp_die_handler', $dieHandler, PHP_INT_MAX);
    remove_action('mtflpp_frontend_live_preview_source_selected', $observeLiveSource, 20);
    remove_action('mtflpp_frontend_saved_preview_source_selected', $observeSavedSource, 20);
    remove_action('init', [$preview, 'authorizePreview'], 20);
    remove_action('template_redirect', [$preview, 'checkPreviewTarget'], -1);
    foreach ($originalHooks as $hook => $callbacks) {
        if ($callbacks === null) {
            unset($GLOBALS['wp_filter'][$hook]);
        } else {
            $GLOBALS['wp_filter'][$hook] = $callbacks;
        }
    }
    foreach (array_reverse($posts) as $postId) {
        wp_delete_post($postId, true);
    }
    foreach ($users as $userId) {
        wp_delete_user($userId);
    }
    wp_set_current_user($originalUser);
}
