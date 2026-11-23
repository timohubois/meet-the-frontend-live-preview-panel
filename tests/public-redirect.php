<?php

/** Run with `wp eval-file tests/public-redirect.php` on a disposable installation. */

use MeetTheFrontendLivePreviewPanel\PublicRedirect;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(PublicRedirect::class)) {
    throw new RuntimeException('Run through WP-CLI with Meet the Frontend – Live Preview Panel active.');
}
$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$previousUser = get_current_user_id();
$admins = get_users(['role' => 'administrator', 'fields' => 'ID', 'number' => 1]);
$check(!empty($admins), 'The fixture needs a site administrator.');
wp_set_current_user((int) $admins[0]);
$posts = [];
$requests = [];
$result = [];
$permalink = home_url('/example/base/');
$overrideLink = static function (string $url, WP_Post $post) use (&$posts, &$permalink): string {
    return in_array($post->ID, $posts, true) ? $permalink : $url;
};
$intercept = static function ($pre, array $args, string $url) use (&$requests, &$result) {
    $requests[] = [$url, $args];
    return $result;
};
$defaultTimeout = static fn (): int => 7;
$dispatch = static function (int $postId): WP_REST_Response {
    $route = '/meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/public-redirect';
    $request = new WP_REST_Request('GET', $route);
    return rest_do_request($request);
};
try {
    foreach (['publish', 'draft', 'private'] as $status) {
        $id = wp_insert_post(['post_title' => 'MTFLPP public routing fixture', 'post_status' => $status], true);
        $check(is_int($id) && $id > 0, 'Create a valid fixture for each post status.');
        $posts[$status] = $id;
    }
    add_filter('post_link', $overrideLink, 10, 2);
    add_filter('pre_http_request', $intercept, 10, 3);
    add_filter('http_request_timeout', $defaultTimeout);

    foreach (['draft', 'private'] as $status) {
        $check($dispatch($posts[$status])->is_error(), 'Do not probe nonpublic posts.');
    }
    wp_set_current_user(0);
    $check($dispatch($posts['publish'])->get_status() === 401, 'Anonymous requests cannot trigger a probe.');
    wp_set_current_user((int) $admins[0]);
    $denyEdit = static function (array $caps, string $cap): array {
        return $cap === 'edit_post' ? ['do_not_allow'] : $caps;
    };
    add_filter('map_meta_cap', $denyEdit, 10, 2);
    $check($dispatch($posts['publish'])->get_status() === 403, 'The signed-in user must be allowed to edit this post.');
    remove_filter('map_meta_cap', $denyEdit, 10);
    $check($requests === [], 'Rejected requests must not contact any URL.');

    $cases = [
        [301, '/example/Base/?private=not-shown#fragment', '/example/Base/'],
        [302, '../elsewhere/', '/example/elsewhere/'],
        [307, 'https://another.example/page/?token=not-shown', 'https://another.example/page/'],
        [308, '//another.example', wp_parse_url($permalink, PHP_URL_SCHEME) . '://another.example/'],
        [200, '/misleading-location/', null],
        [304, '/not-a-redirect/', null],
        [302, '#section', null],
        [302, $permalink . '#section', null],
        [302, 'https://user:pass@another.example/', null],
        [302, 'javascript:alert(1)', null],
        [302, '', null],
        [null, null, null],
    ];
    foreach ($cases as [$status, $location, $expected]) {
        $result = $status ? ['response' => ['code' => $status], 'headers' => ['location' => $location]]
            : new WP_Error('http_request_failed', 'The fixture is offline.');
        $requests = [];
        $response = $dispatch($posts['publish']);
        $check(
            $response->get_status() === 200 && $response->get_data() === ['destination' => $expected],
            'Report only the first confirmed HTTP redirect.'
        );
        $check(
            count($requests) === 1 && $requests[0][0] === $permalink,
            'Request the saved permalink once; do not visit the target.'
        );
        $args = $requests[0][1];
        $check(
            $args['method'] === 'GET' && $args['redirection'] === 0 && $args['reject_unsafe_urls']
            && $args['timeout'] === 7 && empty($args['cookies']) && empty($args['headers']),
            'Probe with the safe HTTP API and its configured timeout, no editor credentials, and no redirect following.'
        );
    }
    $permalink = 'https://another.example/do-not-probe/';
    $requests = [];
    $check(
        $dispatch($posts['publish'])->get_data() === ['destination' => null] && $requests === [],
        'Never probe a permalink on another origin.'
    );
} finally {
    remove_filter('post_link', $overrideLink, 10);
    remove_filter('pre_http_request', $intercept, 10);
    remove_filter('http_request_timeout', $defaultTimeout);
    foreach ($posts as $id) {
        wp_delete_post($id, true);
    }
    wp_set_current_user($previousUser);
}
WP_CLI::success('Public redirect authorization and anonymous HTTP checks passed.');
