<?php

/** Run with `wp eval-file tests/acf-choices.php` on a disposable site with ACF active. */

use AFloatingLivePreviewPanel\Compatibility\Acf;
use AFloatingLivePreviewPanel\LivePreview;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(LivePreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a disposable single site with the plugin active.');
}
if (!function_exists('acf_update_field_group')) {
    WP_CLI::log('Skipping ACF choice preview checks: ACF is not active.');
    return;
}
require_once ABSPATH . 'wp-admin/includes/user.php';
$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$send = static function (string $subject, array $body): WP_REST_Response {
    $request = new WP_REST_Request('POST', '/a-floating-live-preview-panel/v1/' . $subject . '/preview');
    $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
    $request->set_body_params($body);
    return rest_do_request($request);
};
$suffix = strtolower(wp_generate_password(8, false));
$taxonomy = 'aflpp_acf_choices';
$previousUser = get_current_user_id();
$user = $groupId = $termId = $postId = $revisionId = 0;
$transient = '';
try {
    $user = wp_insert_user([
        'user_login' => 'aflpp_choices_' . $suffix, 'user_pass' => wp_generate_password(), 'role' => 'administrator',
    ]);
    $check(is_int($user), 'Create a preview editor.');
    wp_set_current_user($user);
    register_taxonomy($taxonomy, 'post', ['public' => true]);
    $group = acf_update_field_group([
        'key' => 'group_aflpp_choices_' . $suffix, 'title' => 'Temporary preview choice fields',
        'location' => [
            [['param' => 'taxonomy', 'operator' => '==', 'value' => $taxonomy]],
            [['param' => 'post_type', 'operator' => '==', 'value' => 'post']],
        ],
    ]);
    $groupId = $group['ID'];
    $choiceSettings = [
        'select' => ['ui' => 1, 'multiple' => 1, 'create_options' => 1, 'save_options' => 1],
        'checkbox' => ['allow_custom' => 1, 'save_custom' => 1],
        'radio' => ['other_choice' => 1, 'save_other_choice' => 1],
    ];
    $fields = [];
    foreach ($choiceSettings as $type => $settings) {
        $fields[$type] = acf_update_field($settings + [
            'key' => 'field_aflpp_' . $type . '_' . $suffix, 'parent' => $groupId, 'type' => $type,
            'name' => 'aflpp_' . $type, 'label' => $type, 'choices' => ['existing' => 'Existing choice'],
        ]);
    }
    $snapshot = static fn (): array => array_map(static function (array $field): array {
        return maybe_unserialize(get_post_field('post_content', $field['ID'], 'raw'))['choices'];
    }, $fields);
    $values = [];
    foreach ($fields as $type => $field) {
        $values[$field['key']] = $type === 'radio' ? '  Draft radio choice  ' : ['Draft ' . $type . ' choice'];
    }

    $termId = wp_insert_term('Choice preview ' . $suffix, $taxonomy)['term_id'];
    $term = get_term($termId);
    $transient = 'aflpp_term_' . $term->term_taxonomy_id . '_' . $user;
    $postId = wp_insert_post(['post_title' => 'Choice preview ' . $suffix, 'post_status' => 'publish']);
    $baseline = $snapshot();
    $termResponse = $send('terms/' . $termId, [
        'name' => 'Draft term', 'description' => '', '_acf_nonce' => wp_create_nonce('taxonomy'), 'acf' => $values,
    ]);
    $check($termResponse->get_status() === 200, 'Prepare custom choices for a term.');
    $check($snapshot() === $baseline, 'A term preview must leave every shared field definition unchanged.');
    $overlay = get_transient($transient)['data']['acf'];

    $postResponse = $send('posts/' . $postId, [
        'base' => (new LivePreview())->fingerprint($postId), '_acf_nonce' => wp_create_nonce('post'), 'acf' => $values,
    ]);
    $check($postResponse->get_status() === 200, 'Prepare custom choices for a post.');
    $check($snapshot() === $baseline, 'A post preview must leave every shared field definition unchanged.');
    parse_str((string) wp_parse_url($postResponse->get_data()['url'], PHP_URL_QUERY), $query);
    $revisionId = (int) $query['aflpp_revision'];
    foreach ($fields as $field) {
        $draft = get_post_meta($revisionId, $field['name'], true);
        $check($draft !== '' && $overlay[$field['name']] === $draft, 'Draft choices must match in both previews.');
        $check(!metadata_exists('post', $postId, $field['name']), 'Do not persist the draft choice on the saved post.');
        $check(!metadata_exists('term', $termId, $field['name']), 'Do not persist the draft choice on the saved term.');
    }

    // Native saves still append choices when the editor explicitly saves outside the preview lifecycle.
    acf_save_post('term_' . $termId, wp_slash($values));
    $afterSave = $snapshot();
    foreach ($fields as $type => $field) {
        $label = 'Draft ' . $type . ' choice';
        $check(($afterSave[$type][$label] ?? null) === $label, 'Native ACF save must still append the choice.');
        if (Acf::supportsChoiceSaveVeto() || $type !== 'radio') {
            $check(
                get_term_meta($termId, $field['name'], true) === $overlay[$field['name']],
                'Draft choices must use native field value normalization.'
            );
        }
    }
    WP_CLI::success('Choice fields stay isolated in both previews and append normally on native ACF saves.');
} finally {
    if ($transient) {
        delete_transient($transient);
    }
    if ($revisionId) {
        wp_delete_post($revisionId, true);
    }
    if ($postId) {
        wp_delete_post($postId, true);
    }
    if ($termId) {
        wp_delete_term($termId, $taxonomy);
    }
    if ($groupId) {
        acf_delete_field_group($groupId);
    }
    wp_set_current_user($previousUser);
    if ($user) {
        wp_delete_user($user);
    }
}
