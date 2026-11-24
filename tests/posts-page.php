<?php

/** Run with `wp eval-file tests/posts-page.php` on a disposable single-site installation. */

use MeetTheFrontendLivePreviewPanel\FrontendPreview;
use MeetTheFrontendLivePreviewPanel\LivePreview;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(FrontendPreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a single-site installation with this plugin active.');
}
require_once ABSPATH . 'wp-admin/includes/user.php';

$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$live = new LivePreview();
$frontend = new FrontendPreview(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php', $live);
$originalUser = get_current_user_id();
$originalRewrite = $GLOBALS['wp_rewrite'];
$originalOptions = [];
$posts = [];
$userId = 0;
$run = static function (string $url, callable $assertions) use ($frontend): void {
    // phpcs:ignore WordPress.Security -- Restore the CLI request globals after simulating the frontend request.
    $originalGet = $_GET;
    $originalServer = $_SERVER;
    $globals = array_intersect_key($GLOBALS, array_flip(['wp', 'wp_query', 'wp_the_query', 'post']));
    $hooks = array_map(static fn (WP_Hook $hook) => clone $hook, $GLOBALS['wp_filter']);
    try {
        $parts = wp_parse_url($url);
        $_SERVER['REQUEST_METHOD'] = 'GET';
        $_SERVER['HTTP_HOST'] = $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
        $queryString = $parts['query'] ?? '';
        $_SERVER['QUERY_STRING'] = $queryString;
        $_SERVER['REQUEST_URI'] = ($parts['path'] ?? '/') . ($queryString !== '' ? '?' . $queryString : '');
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Populate a synthetic GET request.
        parse_str($queryString, $_GET);
        add_filter('wp_die_handler', static fn () => static function ($message, $title, array $args): void {
            throw new RuntimeException(esc_html((string) $message), (int) $args['response']);
        });
        try {
            $frontend->authorizePreview();
        } catch (RuntimeException $error) {
            $assertions($error->getCode());
            return;
        }
        $wp = $GLOBALS['wp'] = new WP();
        $query = $GLOBALS['wp_the_query'] = $GLOBALS['wp_query'] = new WP_Query();
        $wp->parse_request();
        $wp->query_posts();
        $wp->handle_404();
        $GLOBALS['post'] = $query->post ?? null;
        // Only run our template callback; other callbacks can exit the CLI process.
        if (has_action('template_redirect', [$frontend, 'checkPreviewTarget']) !== false) {
            $frontend->checkPreviewTarget();
        }
        $assertions(is_404() ? 404 : 200);
    } finally {
        $added = array_diff_key(
            $GLOBALS['wp_filter']['shutdown']->callbacks[PHP_INT_MAX] ?? [],
            $hooks['shutdown']->callbacks[PHP_INT_MAX] ?? []
        );
        foreach ($added as $callback) {
            $function = $callback['function'];
            if (is_array($function) && $function[1] === 'unbindPreview') {
                $function();
            }
        }
        $GLOBALS['wp_filter'] = $hooks;
        foreach (['wp', 'wp_query', 'wp_the_query', 'post'] as $name) {
            if (array_key_exists($name, $globals)) {
                $GLOBALS[$name] = $globals[$name];
            } else {
                unset($GLOBALS[$name]);
            }
        }
        $_SERVER = $originalServer;
        $_GET = $originalGet;
    }
};
$setOption = static function (string $option, $value) use (&$originalOptions): void {
    $filter = 'pre_option_' . $option;
    if (!array_key_exists($filter, $originalOptions)) {
        $originalOptions[$filter] = isset($GLOBALS['wp_filter'][$filter]) ? clone $GLOBALS['wp_filter'][$filter] : null;
    }
    remove_all_filters($filter);
    add_filter($filter, static fn () => $value);
};

try {
    $name = 'mtflpp-posts-page-' . wp_generate_password(10, false, false);
    $userId = wp_insert_user([
        'user_login' => $name, 'user_pass' => wp_generate_password(), 'role' => 'administrator',
    ]);
    $check(is_int($userId), 'Could not create the fixture user.');
    wp_set_current_user($userId);
    foreach (['page' => ['Blog index', 'Front page'], 'post' => ['First post', 'Second post']] as $type => $titles) {
        foreach ($titles as $index => $title) {
            $id = wp_insert_post([
                'post_type' => $type, 'post_status' => 'publish', 'post_title' => $title,
                'post_name' => $name . '-' . $type . '-' . $index, 'post_content' => 'Saved content',
            ], true);
            $check(is_int($id), 'Could not create a fixture post.');
            $posts[] = $id;
        }
    }
    [$pageId, $frontId] = $posts;
    $page = get_post($pageId);
    $historicalId = _wp_put_post_revision(['post_title' => 'Historical heading'] + $page->to_array());
    $check(is_int($historicalId) && $historicalId > 0, 'Could not create the historical revision.');
    update_post_meta($pageId, '_thumbnail_id', $posts[2]);

    $setOption('show_on_front', 'page');
    $setOption('page_for_posts', $pageId);
    $setOption('page_on_front', $frontId);
    foreach (['', '/%postname%/'] as $structure) {
        $setOption('permalink_structure', $structure);
        $rewrite = $GLOBALS['wp_rewrite'] = new WP_Rewrite();
        $rewrite->matches = 'matches';
        // A nonempty rules option prevents core from regenerating the saved rules during the test.
        $setOption('rewrite_rules', $structure === '' ? ['index\.php$' => 'index.php'] : $rewrite->rewrite_rules());
        $publicUrl = get_permalink($page);
        $baseline = [];
        $run($publicUrl, static function (int $status) use ($check, $pageId, $publicUrl, &$baseline): void {
            $check(
                $status === 200 && is_home() && get_queried_object_id() === $pageId,
                'Could not resolve the public index: ' . $publicUrl
            );
            $baseline = wp_list_pluck($GLOBALS['wp_query']->posts, 'ID');
            $check($baseline !== [] && get_the_ID() === $baseline[0], 'The public loop must contain real posts.');
        });
        $route = '/meet-the-frontend-live-preview-panel/v1/posts/' . $pageId . '/preview';
        $request = new WP_REST_Request('POST', $route);
        $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
        $request->set_body_params([
            'base' => $live->fingerprint($pageId), 'post_title' => 'Edited heading', 'content' => 'Edited sidebar text',
            'featured_media' => 0,
        ]);
        $response = rest_do_request($request);
        $check($response->get_status() === 200, 'Could not prepare the live preview.');
        $urls = [
            'Edited heading' => $response->get_data()['url'],
            'Historical heading' => $frontend->savedPreviewUrl($page, $historicalId),
        ];
        foreach ($urls as $title => $url) {
            parse_str((string) wp_parse_url($url, PHP_URL_QUERY), $args);
            $check(!isset($args['preview']) && (int) $args['mtflpp_post'] === $pageId, 'Use a signed archive URL.');
            $target = remove_query_arg(['mtflpp_post', 'mtflpp_revision', 'mtflpp_token', 'mtflpp_saved'], $url);
            $check($target === $publicUrl, 'Keep the Posts page permalink.');
            $run(add_query_arg('mtflpp_source', '1', $url), static function (int $status) use (
                $check,
                $pageId,
                $baseline,
                $url,
                $title
            ): void {
                $check($status === 200 && is_home() && !is_singular() && !is_preview(), 'Keep the native index route.');
                $check(
                    wp_list_pluck($GLOBALS['wp_query']->posts, 'ID') === $baseline && get_the_ID() === $baseline[0],
                    'Do not change the posts list or current loop post.'
                );
                $check(get_queried_object_id() === $pageId, 'Keep the queried page identity.');
                $check(single_post_title('', false) === $title, 'Use the edited heading.');
                $check(get_the_title($pageId) === $title, 'Use the edited page title when looked up by ID.');
                $check(str_contains(wp_get_document_title(), $title), 'Use the edited document title.');
                $check(get_the_title() === get_post($baseline[0])->post_title, 'Keep the loop post title saved.');
                $check(get_post($pageId)->post_title === 'Blog index', 'Keep raw post reads saved.');
                $check(has_action('template_redirect', 'redirect_canonical') !== false, 'Keep canonical routing.');
                $check(!redirect_canonical($url, false), 'A signed URL should not need a redirect.');
                $check(has_filter('wp_template_enhancement_output_buffer') !== false, 'Enable preview capture.');
                if ($title === 'Edited heading') {
                    $check(get_queried_object()->post_content === 'Edited sidebar text', 'Overlay page content.');
                    $check(get_post_meta($pageId, '_thumbnail_id', true) === '', 'Bind live metadata.');
                }
            });
        }
        $normal = $frontend->savedPreviewUrl(get_post($frontId), $frontId);
        parse_str((string) wp_parse_url($normal, PHP_URL_QUERY), $normalArgs);
        $check($normalArgs['preview'] === 'true', 'Keep the native preview flag for normal pages.');
        $liveUrl = $urls['Edited heading'];
        $run(add_query_arg('mtflpp_token', 'invalid', $liveUrl), static function (int $status) use ($check): void {
            $check($status === 403, 'Reject an invalid Posts page preview token.');
        });
        parse_str((string) wp_parse_url($liveUrl, PHP_URL_QUERY), $signed);
        unset($signed['page_id']);
        foreach ([add_query_arg($signed, get_permalink($frontId)), add_query_arg('feed', 'rss2', $liveUrl)] as $other) {
            $run($other, static function () use ($check, $pageId, $posts): void {
                $check(get_the_title($pageId) === 'Blog index', 'Do not overlay titles on unrelated or feed requests.');
                $check((int) get_post_meta($pageId, '_thumbnail_id', true) === $posts[2], 'Keep other metadata saved.');
            });
        }
    }
} finally {
    $GLOBALS['wp_rewrite'] = $originalRewrite;
    foreach ($originalOptions as $hook => $original) {
        if ($original) {
            $GLOBALS['wp_filter'][$hook] = $original;
        } else {
            unset($GLOBALS['wp_filter'][$hook]);
        }
    }
    foreach ($posts as $id) {
        $live->deletePreviews($id);
        wp_delete_post($id, true);
    }
    wp_set_current_user($originalUser);
    if (is_int($userId) && $userId > 0) {
        wp_delete_user($userId);
    }
}

WP_CLI::success('Live and saved Posts page previews preserve native routing, the loop and saved data.');
