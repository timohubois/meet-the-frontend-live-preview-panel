<?php

namespace MeetTheFrontendLivePreviewPanel;

use WP_Http;
use WP_Post;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

/** Check the published permalink without preview state or following an outbound redirect. */
final class PublicRedirect
{
    private const UNSAFE_URL_CHARACTERS = '/[\x00-\x20\x7f\\\\]/';

    public function __construct()
    {
        add_action('rest_api_init', [$this, 'registerRoute']);
    }

    public static function isAvailable(?WP_Post $post): bool
    {
        return $post && $post->post_status === 'publish' && is_post_publicly_viewable($post);
    }

    public static function endpoint(int $postId): string
    {
        return rest_url('meet-the-frontend-live-preview-panel/v1/posts/' . $postId . '/public-redirect');
    }

    public function registerRoute(): void
    {
        register_rest_route('meet-the-frontend-live-preview-panel/v1', '/posts/(?P<id>\d+)/public-redirect', [
            'methods' => WP_REST_Server::READABLE,
            'permission_callback' => [$this, 'canCheck'],
            'callback' => [$this, 'check'],
            'args' => ['id' => ['type' => 'integer', 'minimum' => 1, 'required' => true]],
        ]);
    }

    public function canCheck(WP_REST_Request $request): bool
    {
        $post = get_post((int) $request['id']);
        return is_user_logged_in() && self::isAvailable($post) && current_user_can('edit_post', $post->ID);
    }

    public function check(WP_REST_Request $request): WP_REST_Response
    {
        $permalink = get_permalink((int) $request['id']);
        $destination = $permalink ? $this->firstDestination($permalink) : null;
        $response = new WP_REST_Response(['destination' => $destination]);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }

    private function firstDestination(string $permalink): ?string
    {
        $origin = self::origin($permalink);
        if (!$origin || $origin !== self::origin(home_url('/'))) {
            return null;
        }
        // Probe only the configured site's published link, with no editor cookies or authorization headers.
        $response = wp_safe_remote_get($permalink, [
            'redirection' => 0,
            'limit_response_size' => 1024,
        ]);
        if (!in_array((int) wp_remote_retrieve_response_code($response), [301, 302, 303, 307, 308], true)) {
            return null;
        }
        $location = wp_remote_retrieve_header($response, 'location');
        if (
            !is_string($location) || $location === '' || str_starts_with($location, '#')
            || preg_match(self::UNSAFE_URL_CHARACTERS, $location)
        ) {
            return null;
        }
        // Core resolves ordinary relative locations. Preserve network-path references with an empty path.
        $url = str_starts_with($location, '//')
            ? wp_parse_url($permalink, PHP_URL_SCHEME) . ':' . $location
            : WP_Http::make_absolute_url($location, $permalink);
        $destinationOrigin = self::origin($url);
        if (!$destinationOrigin || explode('#', $url, 2)[0] === explode('#', $permalink, 2)[0]) {
            return null;
        }
        // Show a path or an external origin and path, never query values, credentials, or fragments.
        $path = wp_parse_url($url, PHP_URL_PATH) ?: '/';
        return ($destinationOrigin === $origin ? '' : $destinationOrigin) . $path;
    }

    private static function origin(string $url): ?string
    {
        if (preg_match(self::UNSAFE_URL_CHARACTERS, $url)) {
            return null;
        }
        $parts = wp_parse_url($url);
        $scheme = strtolower($parts['scheme'] ?? '');
        $host = strtolower($parts['host'] ?? '');
        if (!in_array($scheme, ['http', 'https'], true) || !$host || isset($parts['user']) || isset($parts['pass'])) {
            return null;
        }
        $port = $parts['port'] ?? ($scheme === 'https' ? 443 : 80);
        $default = $scheme === 'https' ? 443 : 80;
        return $scheme . '://' . $host . ($port === $default ? '' : ':' . $port);
    }
}
