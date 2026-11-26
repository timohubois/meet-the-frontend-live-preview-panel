<?php

/** Run with `wp eval-file tests/classic-editor.php` on a disposable single-site installation. */

use MeetTheFrontendLivePreviewPanel\ClassicEditor;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(ClassicEditor::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a single-site installation with this plugin active.');
}
require_once ABSPATH . 'wp-admin/includes/screen.php';

$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$output = static function (string $hook, mixed ...$args): string {
    ob_start();
    try {
        do_action($hook, ...$args);
        return ob_get_contents();
    } finally {
        ob_end_clean();
    }
};
$hasLauncher = static fn (mixed ...$posts): bool => str_contains(
    $output('post_submitbox_minor_actions', ...$posts),
    'id="mtflpp-publish-preview"'
);
$hasPanel = static fn (): bool => str_contains($output('admin_footer'), 'id="mtflpp-panel"');
$originalUser = get_current_user_id();
$originalScreen = get_current_screen();
$originalPost = $GLOBALS['post'] ?? null;
$originalPostId = $GLOBALS['post_ID'] ?? null;
$admins = get_users(['role' => 'administrator', 'fields' => 'ID', 'number' => 1]);
$check($admins !== [], 'The fixture needs a site administrator.');
$posts = [];
$configs = [];
$captureConfig = static function (array $config) use (&$configs): array {
    $configs[] = [$config['postId'], $config['postTitle']];
    return $config;
};
add_filter('mtflpp_classic_editor_preview_config', $captureConfig);
register_post_type('mtflpp_hidden', ['public' => false, 'publicly_queryable' => false]);
try {
    wp_set_current_user((int) $admins[0]);
    foreach (['post', 'post', 'mtflpp_hidden'] as $type) {
        $id = wp_insert_post(['post_title' => 'Classic editor fixture', 'post_type' => $type], true);
        $check(is_int($id) && $id > 0, 'Could not create a fixture post.');
        $posts[] = $id;
    }
    [$postId, $otherId, $hiddenId] = $posts;
    set_current_screen('post');
    get_current_screen()->is_block_editor(false);
    $post = get_post($postId);
    $GLOBALS['post'] = $post;
    $GLOBALS['post_ID'] = $postId;
    $check($hasLauncher($post) && $hasPanel(), 'A native post must still get the launcher and panel.');
    $check(!$hasLauncher(get_post($otherId)), 'A different hook post must not get a launcher.');

    $wrapper = new class ((string) $postId) {
        public array $post_type = [];
        public string $post_title = 'Not the saved title';

        public function __construct(public readonly string $ID)
        {
        }
    };
    $check($hasLauncher($wrapper), 'A same-post wrapper passed to the hook must get a launcher.');
    $GLOBALS['post'] = $wrapper;
    $check($hasLauncher($wrapper) && $hasPanel(), 'Replacing global post with a same-post wrapper must be safe.');
    do_action('admin_enqueue_scripts', 'post.php');
    $check($configs === [[$postId, $post->post_title]], 'Preview configuration must use the core post.');
    if (class_exists(\Timber\Timber::class)) {
        $timber = \Timber\Timber::get_post($postId);
        $GLOBALS['post'] = $timber;
        $check($timber instanceof \Timber\Post && $hasLauncher($timber), 'A real Timber post must work too.');
    }
    $GLOBALS['post'] = $wrapper;
    $check(!$hasLauncher(), 'A hook call without a post must not get a launcher.');
    foreach ([null, $postId, ['ID' => $postId], (object) [], (object) ['ID' => $postId . 'x']] as $invalid) {
        $check(!$hasLauncher($invalid), 'Invalid hook arguments must not get a launcher.');
        $GLOBALS['post'] = $invalid;
        $check(!$hasLauncher($post) && !$hasPanel(), 'Invalid global posts must not render preview UI.');
        $GLOBALS['post'] = $wrapper;
    }
    $GLOBALS['post'] = (object) ['ID' => $otherId];
    $check(!$hasLauncher($GLOBALS['post']) && !$hasPanel(), 'Matching wrappers cannot override the screen post ID.');
    $GLOBALS['post'] = $wrapper;
    unset($GLOBALS['post_ID']);
    $check(!$hasLauncher($wrapper) && !$hasPanel(), 'A wrapper alone cannot establish the screen post ID.');
    $GLOBALS['post'] = (object) ['ID' => PHP_INT_MAX];
    $GLOBALS['post_ID'] = PHP_INT_MAX;
    $check(!$hasLauncher($GLOBALS['post']) && !$hasPanel(), 'The matching ID must resolve to an existing post.');

    $GLOBALS['post'] = (object) ['ID' => $hiddenId, 'post_type' => 'post'];
    $GLOBALS['post_ID'] = $hiddenId;
    $check(!$hasLauncher($GLOBALS['post']) && !$hasPanel(), 'Trust the real post type, not the wrapper’s.');

    $GLOBALS['post'] = $wrapper;
    $GLOBALS['post_ID'] = $postId;
    get_current_screen()->is_block_editor(true);
    $check(!$hasLauncher($wrapper), 'The classic launcher must not render in the Block Editor.');
    get_current_screen()->is_block_editor(false);
    wp_set_current_user(0);
    $check(!$hasLauncher($wrapper) && !$hasPanel(), 'The current user must be allowed to edit the post.');
} finally {
    $GLOBALS['post'] = $originalPost;
    $GLOBALS['post_ID'] = $originalPostId;
    $GLOBALS['current_screen'] = $originalScreen;
    remove_filter('mtflpp_classic_editor_preview_config', $captureConfig);
    foreach ($posts as $id) {
        wp_delete_post($id, true);
    }
    unregister_post_type('mtflpp_hidden');
    wp_set_current_user($originalUser);
}

WP_CLI::success('Classic editor launcher and post resolution checks passed.');
