<?php

namespace AFloatingLivePreviewPanel;

use WP_Error;
use WP_REST_Request;
use WP_REST_Server;
use WP_Term;

/** Store one short-lived source per editor and term, and bind it only to its own frontend archive. */
final class TermPreview
{
    /** @var \WeakMap<WP_REST_Request, true> HTTP requests whose original method was not POST. */
    private \WeakMap $nonPostRequests;

    public function __construct(private readonly string $file)
    {
        $this->nonPostRequests = new \WeakMap();
        add_filter('rest_allowed_cors_headers', [$this, 'rememberHttpMethod'], 10, 2);
        add_action('rest_api_init', [$this, 'registerRoutes']);
        add_action('init', [$this, 'authorizePreview'], 20);
    }

    public function registerRoutes(): void
    {
        register_rest_route('a-floating-live-preview-panel/v1', '/terms/(?P<id>\d+)/preview', [
            'methods' => WP_REST_Server::CREATABLE,
            'permission_callback' => [$this, 'canPreparePreview'],
            'callback' => [$this, 'preparePreview'],
            'args' => [
                'name' => ['type' => 'string', 'required' => true],
                'description' => ['type' => 'string', 'required' => true],
            ],
        ]);
    }

    public function rememberHttpMethod(array $headers, WP_REST_Request $request): array
    {
        // Core has already applied method overrides. Track only HTTP, not internal REST dispatches.
        // phpcs:ignore WordPress.Security.ValidatedSanitizedInput -- Compare the transport method exactly.
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
            $this->nonPostRequests[$request] = true;
        }
        return $headers;
    }

    public function canEdit(WP_Term $term): bool
    {
        return is_user_logged_in() && is_taxonomy_viewable($term->taxonomy)
            && current_user_can('edit_term', $term->term_id);
    }

    public function canPreparePreview(WP_REST_Request $request): bool|WP_Error
    {
        $term = get_term((int) $request->get_url_params()['id']);
        if (!$term instanceof WP_Term || !$this->canEdit($term)) {
            return new WP_Error(
                'aflpp_cannot_preview',
                __('You cannot preview this term.', 'meet-the-frontend-live-preview-panel'),
                ['status' => rest_authorization_required_code()]
            );
        }
        return true;
    }

    public function preparePreview(WP_REST_Request $request): array|WP_Error
    {
        if (!wp_verify_nonce((string) $request->get_header('X-WP-Nonce'), 'wp_rest')) {
            return new WP_Error(
                'aflpp_invalid_nonce',
                __('This preview has expired.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 403]
            );
        }
        if (isset($this->nonPostRequests[$request])) {
            return new WP_Error(
                'aflpp_post_required',
                __('Preview writes require an HTTP POST request.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 405]
            );
        }

        $term = get_term((int) $request->get_url_params()['id']);
        if (!$term instanceof WP_Term) {
            return new WP_Error(
                'aflpp_cannot_preview',
                __('This term no longer exists.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 404]
            );
        }
        $url = get_term_link($term);
        if (is_wp_error($url)) {
            return $url;
        }

        // Core's term-save filters expect slashed input. Never invoke the term write path.
        $name = sanitize_term_field('name', wp_slash($request['name']), $term->term_id, $term->taxonomy, 'db');
        $description = wp_slash($request['description']);
        /**
         * Supply the editor's sanitization result when its native save filters are absent in REST.
         *
         * @param ?string $sanitized Slashed result, or null to use the native term-save filters.
         * @param string  $description Slashed input.
         * @param WP_Term $term Saved term being previewed.
         */
        $sanitized = apply_filters('aflpp_term_preview_pre_sanitize_description', null, $description, $term);
        $fields = [
            'name' => wp_unslash($name),
            'description' => wp_unslash($sanitized ?? sanitize_term_field(
                'description',
                $description,
                $term->term_id,
                $term->taxonomy,
                'db'
            )),
        ];
        // Internal integrations can contribute request-local display data, never a destination or token.
        $input = $request->get_json_params() ?? $request->get_body_params();
        $data = apply_filters('aflpp_term_preview_data', [], $term, $input);
        if (is_wp_error($data)) {
            return $data;
        }
        $fields['data'] = $data;
        $key = bin2hex(random_bytes(16));
        $token = $key . '-' . wp_create_nonce($this->nonceAction($term, $key));
        if (!set_transient($this->storageKey($term), $fields + ['token' => $token], 15 * MINUTE_IN_SECONDS)) {
            return new WP_Error(
                'aflpp_term_preview_failed',
                __('Couldn’t prepare the term preview. Try refreshing it.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 500]
            );
        }
        return ['url' => add_query_arg(['aflpp_term' => $term->term_id, 'aflpp_token' => $token], $url)];
    }

    private function storageKey(WP_Term $term): string
    {
        return 'aflpp_term_' . $term->term_taxonomy_id . '_' . get_current_user_id();
    }

    private function nonceAction(WP_Term $term, string $key): string
    {
        return 'aflpp_term_preview_' . $term->term_taxonomy_id . '_' . $key;
    }

    public function authorizePreview(): void
    {
        if (is_admin() || !isset($_GET['aflpp_term'])) {
            return;
        }
        PreviewDocument::disableCaching();

        // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Read-only lookup, authorized below.
        $id = filter_var(wp_unslash($_GET['aflpp_term']), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        // phpcs:disable WordPress.Security.NonceVerification.Recommended, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- Exact token contract verified below.
        $token = isset($_GET['aflpp_token']) && is_string($_GET['aflpp_token'])
            ? wp_unslash($_GET['aflpp_token']) : '';
        // phpcs:enable WordPress.Security.NonceVerification.Recommended, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
        $term = $id ? get_term($id) : null;
        if (
            !$term instanceof WP_Term || !$this->canEdit($term)
            || !preg_match('/^([a-f0-9]{32})-([a-f0-9]{10})$/D', $token, $parts)
            || !wp_verify_nonce($parts[2], $this->nonceAction($term, $parts[1]))
        ) {
            $this->expired();
            return;
        }

        $source = get_transient($this->storageKey($term));
        if (!is_array($source) || !hash_equals($source['token'] ?? '', $token)) {
            $this->expired();
            return;
        }
        $isolated = isset($_GET['aflpp_isolated']) && $_GET['aflpp_isolated'] === '1';
        $capture = isset($_GET['aflpp_source']) && $_GET['aflpp_source'] === '1';
        add_action('template_redirect', function () use ($term, $source, $isolated, $capture): void {
            $this->renderArchive($term, $source, $isolated, $capture);
        }, -1);
    }

    private function expired(): void
    {
        wp_die(
            esc_html__(
                'This term preview has expired or can’t be opened. Refresh it from the term editor.',
                'meet-the-frontend-live-preview-panel'
            ),
            '',
            ['response' => 403]
        );
    }

    private function renderArchive(WP_Term $term, array $source, bool $isolated, bool $capture): void
    {
        global $wp_query;

        $queried = get_queried_object();
        if (
            !is_archive() || is_feed() || is_embed() || is_search() || is_404()
            || !$queried instanceof WP_Term || $queried->term_taxonomy_id !== $term->term_taxonomy_id
        ) {
            return;
        }

        // Leave routing and raw term reads alone, including writes that reload the saved term.
        $preview = clone $queried;
        foreach (['name', 'description'] as $field) {
            $preview->$field = $source[$field];
            // Feed the native display pipeline before WordPress applies typography and auto-paragraphs.
            add_filter(
                'term_' . $field,
                static function ($value, $id = 0, $taxonomy = '') use ($term, $source, $field) {
                    return (int) $id === $term->term_id && $taxonomy === $term->taxonomy ? $source[$field] : $value;
                },
                PHP_INT_MIN,
                3
            );
        }
        if (isset($preview->cat_name)) {
            $preview->cat_name = $preview->name;
            $preview->category_description = $preview->description;
        }
        $wp_query->queried_object = $preview;
        // Internal adapters receive detached display and routing terms only after the authorized archive matches.
        do_action('aflpp_frontend_term_preview_source_selected', [
            'term' => clone $preview,
            'saved' => clone $queried,
            'data' => $source['data'] ?? [],
        ]);
        (new PreviewDocument($this->file, $source['token']))->enhance($isolated, $capture);
    }
}
