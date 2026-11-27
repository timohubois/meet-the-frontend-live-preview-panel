<?php

/** Run with `wp eval-file tests/row-evidence.php` on a disposable single site with ACF Pro or SCF. */

use MeetTheFrontendLivePreviewPanel\LivePreview;
use MeetTheFrontendLivePreviewPanel\PreviewRowEvidence;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(PreviewRowEvidence::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a single-site installation with this plugin active.');
}
if (!function_exists('acf_get_field_type') || !acf_get_field_type('flexible_content')) {
    WP_CLI::log('Skipping row evidence: ACF-compatible Flexible Content is not active.');
    return;
}

$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
require_once ABSPATH . 'wp-admin/includes/user.php';
$originalUser = get_current_user_id();
$postId = $user = 0;
$field = 'field_mtflpp_renderer_rows';
$text = 'field_mtflpp_renderer_text';
$policy = 'Mtflpp/previewRowRenderFilter';
$renderer = 'ExampleTheme/renderRow';
$selection = $renderer;
$select = static function () use (&$selection) {
    return $selection;
};
add_filter($policy, $select, 20);
if (!class_exists('Flynt\\Api')) {
    $flyntApi = new class () {
    };
    class_alias($flyntApi::class, 'Flynt\\Api');
}
$html = "<h2><span>Heading</span></h2>\n<p>Copy</p>";
$flyntRenderer = 'Flynt/renderComponent';
$renderFlynt = static function ($output, string $componentName, array $row) use ($html) {
    return $componentName === 'Fixture' && $row['label'] === "Second's row" ? $html : $output;
};
try {
    $user = wp_insert_user([
        'user_login' => 'mtflpp_renderer_' . wp_generate_password(12, false, false),
        'user_pass' => wp_generate_password(32), 'role' => 'administrator',
    ]);
    $check(is_int($user), 'Could not create a fixture user.');
    wp_set_current_user($user);
    acf_add_local_field_group([
        'key' => 'group_mtflpp_renderer', 'title' => 'External renderer fixture',
        'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'page']]],
        'fields' => [[
            'key' => $field, 'name' => 'mtflpp_renderer_rows', 'type' => 'flexible_content',
            'layouts' => [[
                'key' => 'layout_mtflpp_renderer', 'name' => 'item', 'label' => 'Item',
                'sub_fields' => [['key' => $text, 'name' => 'label', 'type' => 'text']],
            ]],
        ]],
    ]);
    $postId = wp_insert_post([
        'post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'External renderer fixture',
    ], true);
    $check(is_int($postId) && $postId > 0, 'Could not create a fixture page.');
    $rows = [
        'row-1' => ['acf_fc_layout' => 'item', $text => 'First'],
        'row-2' => ['acf_fc_layout' => 'item', $text => "Second's row"],
    ];
    $check(update_field($field, array_values($rows), $postId), 'Could not seed native ACF rows.');
    $live = new LivePreview();
    $base = $live->fingerprint($postId);
    $send = static function (bool $requestMarkers) use ($base, $postId, $field, $rows): WP_REST_Response {
        $route = '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/preview';
        $request = new WP_REST_Request('POST', $route);
        $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
        $input = [
            'base' => $base, '_acf_nonce' => wp_create_nonce('post'), 'acf' => [$field => array_reverse($rows, true)],
        ];
        if ($requestMarkers) {
            $input['mtflpp_row_markers'] = '1';
        }
        $request->set_body_params($input);
        return rest_do_request($request);
    };

    $evidence = new PreviewRowEvidence();
    $config = [];
    $evidence->configureEditor($config);
    $check(($config['previewRowEvidence'] ?? false) === true, 'A renderer can opt in through the public filter.');
    $check(apply_filters($renderer, $html, []) === $html, 'Ordinary renders are not marked.');
    $plain = $send(false);
    $check($plain->get_status() === 200 && !isset($plain->get_data()['rowMarkers']), 'No evidence without opt-in.');
    foreach ([null, '', ' ', ['name' => $renderer]] as $invalid) {
        $selection = $invalid;
        $config = [];
        $evidence->configureEditor($config);
        $check(!isset($config['previewRowEvidence']), 'Null or invalid values disable evidence even on Flynt.');
        $plain = $send(true);
        $check(
            $plain->get_status() === 200 && !isset($plain->get_data()['rowMarkers']),
            'An invalid renderer selection must not block the preview or return evidence.'
        );
    }
    $selection = $renderer;
    $response = $send(true);
    $result = $response->get_data();
    $check(
        $response->get_status() === 200 && !empty($result['rowMarkers']),
        'Accepted native rows must return markers.'
    );
    parse_str(wp_parse_url($result['url'], PHP_URL_QUERY), $query);
    $sourceId = (int) $query['mtflpp_revision'];
    $check($query['mtflpp_row_markers'] === '1', 'The preview URL with accepted evidence opts in to marking.');
    $check($live->fingerprint($postId) === $base, 'Do not change the saved post.');
    $markers = $result['rowMarkers']['acf-layout-order:acf[' . $field . ']'];
    $marker = $markers['acf[' . $field . '][row-2][acf_fc_layout]'];
    $check(count($markers) === 2 && strlen($marker) === 64, 'Use an opaque marker keyed to the submitted row.');

    // Exercise the selected filter with real ACF formatting of the accepted snapshot.
    acf_flush_value_cache($sourceId, 'mtflpp_renderer_rows');
    $evidence->markPreview($sourceId);
    $accepted = get_field($field, $sourceId);
    $check($accepted[0]['label'] === "Second's row", 'ACF must read the reordered snapshot.');
    $updated = apply_filters($renderer, $html, $accepted[0]);
    $attribute = ' data-mtflpp-evidence-row="' . $marker . ':';
    $expected = '<h2' . $attribute . '0"><span>Heading</span></h2>' . "\n" . '<p' . $attribute . '1">Copy</p>';
    $check($updated === $expected, 'Mark existing roots only, with no wrapper or descendant changes.');
    $check(apply_filters($renderer, $html) === $html, 'A renderer without a row argument stays unmarked.');
    $check(apply_filters($renderer, $html, 'not a row') === $html, 'A non-array row stays unmarked.');
    $check(
        apply_filters($renderer, $html, ['label' => $accepted[0]['label']]) === $html,
        'Rebuilt rows stay unmarked.'
    );
    $check(apply_filters($renderer, $html, get_field($field, $postId)[0]) === $html, 'Saved rows stay unmarked.');
    $check($evidence->discardDuplicates($updated) === $expected, 'Split roots from one render belong to the same row.');
    $duplicate = apply_filters($renderer, $html, $accepted[0]);
    $check(
        str_replace(['<h2 >', '<p >'], ['<h2>', '<p>'], $evidence->discardDuplicates($updated . $duplicate))
            === $html . $html,
        'Never follow either copy of a row rendered more than once.'
    );

    // Flynt starts with null output, then its normal renderer produces HTML at priority 10.
    add_filter($flyntRenderer, $renderFlynt, 10, 3);
    $check(
        apply_filters($flyntRenderer, null, 'Fixture', $accepted[0]) === $html,
        'An explicit hook selection takes precedence over built-in Flynt.'
    );
    remove_filter($policy, $select, 20);
    $config = [];
    $evidence = new PreviewRowEvidence();
    $evidence->configureEditor($config);
    $check(($config['previewRowEvidence'] ?? false) === true, 'Flynt opts in without a public filter callback.');
    $response = $send(true);
    $result = $response->get_data();
    $check($response->get_status() === 200 && !empty($result['rowMarkers']), 'Flynt receives accepted row evidence.');
    parse_str(wp_parse_url($result['url'], PHP_URL_QUERY), $query);
    $sourceId = (int) $query['mtflpp_revision'];
    acf_flush_value_cache($sourceId, 'mtflpp_renderer_rows');
    $evidence->markPreview($sourceId);
    $accepted = get_field($field, $sourceId);
    $flyntMarkers = $result['rowMarkers']['acf-layout-order:acf[' . $field . ']'];
    $flyntMarker = $flyntMarkers['acf[' . $field . '][row-2][acf_fc_layout]'];
    $check(
        apply_filters($flyntRenderer, null, 'Fixture', $accepted[0]) === str_replace($marker, $flyntMarker, $expected),
        'The Flynt adapter marks the rendered HTML using the row in the third argument.'
    );
} finally {
    remove_filter($policy, $select, 20);
    remove_filter($flyntRenderer, $renderFlynt, 10);
    if (is_int($postId) && $postId > 0) {
        wp_delete_post($postId, true);
    }
    wp_set_current_user($originalUser);
    if (is_int($user) && $user > 0) {
        wp_delete_user($user);
    }
}
WP_CLI::success('Custom and Flynt render filters mark accepted rows and ignore missing or repeated evidence.');
