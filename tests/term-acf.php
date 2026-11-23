<?php

/** Run with `wp eval-file tests/term-acf.php` on a disposable site with ACF active. */

use MeetTheFrontendLivePreviewPanel\TermPreview;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(TermPreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a disposable single site with the plugin active.');
}
if (!function_exists('acf_add_local_field_group')) {
    WP_CLI::log('Skipping ACF term preview checks: ACF is not active.');
    return;
}
$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
require_once ABSPATH . 'wp-admin/includes/user.php';
$props = static fn ($name, $type, array $settings = []): array => [
    'key' => 'field_mtflpp_term_' . $name, 'name' => $name, 'type' => $type,
] + $settings;
$fields = [
    $props('heading', 'text'),
    $props('intro', 'wysiwyg'),
    $props('tone', 'select', ['choices' => ['a' => 'Alpha', 'b' => 'Beta'], 'return_format' => 'label']),
    $props('fresh', 'text'),
    $props('stays', 'text'),
    $props('select_terms', 'taxonomy', [
        'field_type' => 'multi_select', 'taxonomy' => 'post_tag', 'load_terms' => 1, 'save_terms' => 1,
        'bidirectional' => 1, 'bidirectional_target' => ['field_mtflpp_term_back'],
    ]),
    $props('also_assign', 'taxonomy', [
        'field_type' => 'multi_select', 'taxonomy' => 'post_tag', 'save_terms' => 1,
    ]),
    $props('load_only', 'taxonomy', [
        'field_type' => 'multi_select', 'taxonomy' => 'category', 'load_terms' => 1,
    ]),
    $props('related', 'relationship', [
        'return_format' => 'id', 'bidirectional' => 1, 'bidirectional_target' => ['field_mtflpp_term_back'],
    ]),
    $props('back', 'relationship'),
    $props('featured', 'post_object', ['return_format' => 'id']),
    $props('location', 'google_map'),
    $props('group', 'group', ['sub_fields' => [$props('group_text', 'text')]]),
];
$pro = (bool) acf_get_field_type('repeater');
if ($pro) {
    $fields[] = $props('rows', 'repeater', [
        'pagination' => 1, 'rows_per_page' => 1, 'sub_fields' => [$props('row_text', 'text')],
    ]);
    $fields[] = $props('layout', 'flexible_content', ['layouts' => [
        ['key' => 'layout_mtflpp_term_first', 'name' => 'first', 'sub_fields' => [$props('first_text', 'text')]],
        ['key' => 'layout_mtflpp_term_second', 'name' => 'second', 'sub_fields' => [$props('second_text', 'text')]],
    ]]);
}
$taxonomy = 'mtflpp_acf_term';
register_taxonomy($taxonomy, 'post', ['public' => true]);
acf_add_local_field_group([
    'key' => 'group_mtflpp_term_preview', 'title' => 'MTFLPP term preview',
    'location' => [[['param' => 'taxonomy', 'operator' => '==', 'value' => $taxonomy]]],
    'fields' => $fields,
]);
acf_add_local_field_group([
    'key' => 'group_mtflpp_term_elsewhere', 'title' => 'MTFLPP other fields',
    'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'post']]],
    'fields' => [$props('elsewhere', 'text')],
]);
$previousUser = get_current_user_id();
$user = $id = $neighbor = $related = $tag = $otherTag = 0;
$storageKey = '';
try {
    $user = wp_insert_user([
        'user_login' => 'mtflpp_term_acf_' . wp_generate_password(8, false),
        'user_pass' => wp_generate_password(), 'role' => 'editor',
    ]);
    $check(is_int($user), 'Create an editor fixture.');
    wp_set_current_user($user)->add_cap('unfiltered_html', false);
    $tag = wp_insert_term('Term ACF fixture tag', 'post_tag')['term_id'];
    $otherTag = wp_insert_term('Another ACF fixture tag', 'post_tag')['term_id'];
    $id = wp_insert_term('Term ACF fixture archive', $taxonomy)['term_id'];
    $neighbor = wp_insert_term('Term ACF neighboring archive', $taxonomy)['term_id'];
    $related = wp_insert_post(['post_title' => 'Related to term ACF fixture', 'post_status' => 'publish']);
    $term = get_term($id);
    $acfId = 'term_' . $id;
    $storageKey = 'mtflpp_term_' . $term->term_taxonomy_id . '_' . $user;

    $savedFields = [
        'heading' => 'Saved heading', 'stays' => 'Not submitted', 'intro' => 'Saved intro', 'tone' => 'a',
        'group' => ['group_text' => 'Saved group'],
    ];
    foreach ($savedFields as $field => $value) {
        update_field('field_mtflpp_term_' . $field, $value, $acfId);
    }
    if ($pro) {
        $rows = [['row_text' => 'First'], ['row_text' => 'Keep'], ['row_text' => 'Last']];
        update_field('field_mtflpp_term_rows', $rows, $acfId);
        update_field('field_mtflpp_term_layout', [['acf_fc_layout' => 'first', 'first_text' => 'Old layout']], $acfId);
    }
    update_field('field_mtflpp_term_heading', 'Other archive', 'term_' . $neighbor);
    update_field('field_mtflpp_term_heading', 'Other object type', $related);
    $saved = get_term_meta($id);
    $oldPostMeta = get_post_meta($related);
    $oldTagMeta = get_term_meta($tag);
    $oldTermAssignment = wp_get_object_terms($id, 'post_tag', ['fields' => 'ids']);
    $loadOnlyAssignment = get_field('field_mtflpp_term_load_only', $acfId);

    $saveHookCalls = 0;
    $observeSave = static function ($value = null) use (&$saveHookCalls) {
        ++$saveHookCalls;
        return $value;
    };
    $saveHooks = [
        'acf/save_post', 'acf/pre_update_value', 'acf/update_value', 'acf/delete_value', 'acf/pre_update_metadata',
    ];
    foreach ($saveHooks as $hook) {
        add_filter($hook, $observeSave);
    }
    $post = static function (array $extra) use ($id): WP_REST_Response {
        $request = new WP_REST_Request('POST', '/meet-the-frontend-live-preview-panel/v1/terms/' . $id . '/preview');
        $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
        $request->set_header('Content-Type', 'application/json');
        $request->set_body(wp_json_encode($extra + ['name' => 'Draft archive', 'description' => '']));
        return rest_do_request($request);
    };
    $map = ['address' => 'Draft "quoted" street', 'lat' => 30.5, 'lng' => 12.5, 'zoom' => 11];
    $input = ['acf' => [
        'field_mtflpp_term_heading' => "Draft O’Reilly \\ heading",
        'field_mtflpp_term_intro' => '<strong>Draft rich text</strong><script></script>',
        'field_mtflpp_term_tone' => 'b',
        'field_mtflpp_term_fresh' => 'Never previously saved',
        'field_mtflpp_term_select_terms' => [(string) $tag],
        'field_mtflpp_term_also_assign' => [(string) $otherTag],
        'field_mtflpp_term_load_only' => [(string) get_option('default_category')],
        'field_mtflpp_term_related' => [(string) $related],
        'field_mtflpp_term_featured' => (string) $related,
        'field_mtflpp_term_location' => wp_json_encode($map),
        'field_mtflpp_term_group' => ['field_mtflpp_term_group_text' => ''],
        'field_mtflpp_term_elsewhere' => 'Not allowed on this taxonomy',
    ]];
    if ($pro) {
        $input['acf']['field_mtflpp_term_rows'] = [
            'row-0' => ['acf_deleted' => '1'],
            'row-2' => ['field_mtflpp_term_row_text' => 'Moved', 'acf_reordered' => '0'],
            'acf-1' => ['field_mtflpp_term_row_text' => 'New'],
        ];
        $input['acf']['field_mtflpp_term_layout'] = [
            'row-0' => ['acf_fc_layout' => 'second', 'field_mtflpp_term_second_text' => 'New layout'],
        ];
    }
    $check($post($input)->get_status() === 400, 'Reject a missing native ACF form nonce.');
    $check(get_transient($storageKey) === false, 'Rejected ACF data must not be stored.');
    $response = $post($input + ['_acf_nonce' => wp_create_nonce('taxonomy')]);
    $check($response->get_status() === 200, 'Prepare native ACF inputs for any public taxonomy.');
    $check($saveHookCalls === 0, 'Do not run any persistent ACF update, save or delete callbacks.');
    foreach ($saveHooks as $hook) {
        $check(has_filter($hook, $observeSave) === 10, 'Restore the original hook after normalization.');
        remove_filter($hook, $observeSave);
    }
    $check(get_field('heading', $acfId) === 'Saved heading', 'Preparation does not overlay admin or ordinary reads.');
    $check(get_term_meta($id) === $saved, 'Preparation does not write term metadata.');
    $check(get_post_meta($related) === $oldPostMeta, 'Do not write bidirectional post relations.');
    $check(get_term_meta($tag) === $oldTagMeta, 'Do not write reverse term relations.');
    $check(
        wp_get_object_terms($id, 'post_tag', ['fields' => 'ids']) === $oldTermAssignment,
        'Do not assign taxonomy terms.'
    );

    $preview = new TermPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php');
    $original = get_transient($storageKey);
    $url = $response->get_data()['url'];
    // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Simulate an authorized frontend request.
    parse_str((string) wp_parse_url($url, PHP_URL_QUERY), $_GET);
    remove_all_actions('template_redirect');
    $preview->authorizePreview();
    $GLOBALS['wp_query'] = new WP_Query(['taxonomy' => $taxonomy, 'term' => get_term($neighbor)->slug]);
    do_action('template_redirect');
    $check(get_field('heading', $acfId) === 'Saved heading', 'Do not bind draft fields on a different archive.');
    remove_all_actions('template_redirect');
    $preview->authorizePreview();
    $GLOBALS['wp_query'] = new WP_Query(['taxonomy' => $taxonomy, 'term' => $term->slug]);
    do_action('template_redirect');

    $check(get_field('heading', $acfId) === $input['acf']['field_mtflpp_term_heading'], 'Read draft by field name.');
    $check(get_field('heading', $term) === get_field('heading', $acfId), 'Read draft by a WP_Term object.');
    $check(get_field('heading', $taxonomy . '_' . $id) === get_field('heading', $acfId), 'Read draft by legacy ID.');
    $check(get_field('tone', $acfId) === 'Beta', 'Keep native ACF return formats.');
    $check(str_contains(get_field('intro', $acfId), '<strong>Draft rich text</strong>'), 'Keep rich text formatting.');
    $check(!str_contains(get_field('intro', $acfId), '<script'), 'Apply the ACF HTML policy for restricted users.');
    $check(get_field('group', $acfId) === ['group_text' => ''], 'Preserve explicit clears in nested fields.');
    $check(get_fields($acfId)['fresh'] === 'Never previously saved', 'Include new values in get_fields().');
    $check(get_field('fresh', $acfId) === 'Never previously saved', 'Resolve unsaved field references by name.');
    $check(get_field('stays', $acfId) === 'Not submitted', 'Omitted fields keep their saved values.');
    $check(!isset($original['data']['acf']['elsewhere']), 'Reject fields outside the taxonomy form.');
    $draftAssignments = get_field('select_terms', $acfId);
    sort($draftAssignments);
    $check($draftAssignments === [$tag, $otherTag], 'Load Terms sees the combined draft Save Terms selection.');
    $check(get_field('load_only', $acfId) === $loadOnlyAssignment, 'Load Terms alone uses saved assignments.');
    $check(wp_get_object_terms($id, 'post_tag', ['fields' => 'ids']) === $oldTermAssignment, 'Keep assignments saved.');
    $check(get_field('related', $acfId) === [$related], 'Read draft relationships through native ACF.');
    $check(get_field('location', $acfId) === $map, 'Decode a native map input without stripping its JSON escapes.');
    $check(get_field('featured', $acfId, false) === (string) $related, 'Raw IDs match native scalar metadata.');
    if ($pro) {
        $check(
            array_column(get_field('rows', $acfId), 'row_text') === ['Moved', 'Keep', 'New'],
            'Merge repeater row deltas.'
        );
        $check(
            get_field('layout', $acfId) === [['acf_fc_layout' => 'second', 'second_text' => 'New layout']],
            'Switch layouts.'
        );
    }
    $check(get_term_meta($id) === $saved, 'Raw WordPress metadata stays saved even in the matching archive.');
    $check(get_field('heading', 'term_' . $neighbor) === 'Other archive', 'Keep unrelated term fields saved.');
    $check(get_field('heading', $related) === 'Other object type', 'Keep unrelated post fields saved.');
    WP_CLI::success('ACF term previews preserve formatting, nested edits, isolation, and native save behavior.');
} finally {
    if ($storageKey) {
        delete_transient($storageKey);
    }
    foreach ([$id, $neighbor] as $fixture) {
        if ($fixture) {
            wp_delete_term($fixture, $taxonomy);
        }
    }
    foreach ([$tag, $otherTag] as $fixture) {
        if ($fixture) {
            wp_delete_term($fixture, 'post_tag');
        }
    }
    if ($related) {
        wp_delete_post($related, true);
    }
    wp_set_current_user($previousUser);
    if ($user) {
        wp_delete_user($user);
    }
}
