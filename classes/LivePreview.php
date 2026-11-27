<?php

namespace MeetTheFrontendLivePreviewPanel;

use MeetTheFrontendLivePreviewPanel\Compatibility\Acf;
use MeetTheFrontendLivePreviewPanel\Compatibility\Flynt;
use MeetTheFrontendLivePreviewPanel\Compatibility\Yoast;
use WP_Error;
use WP_Post;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

/** Own isolated live-preview revisions, integrity checks and native-save coordination. */
final class LivePreview
{
    private const POST_STATUS = 'mtflpp-preview';
    public const AUTHOR_META = '_mtflpp_post_author';
    public const DATE_META = '_mtflpp_post_date';
    public const TERMS_META = '_mtflpp_terms';

    private int $autosavePostId = 0;

    /** Native form globals and save hooks are shared across all instances. */
    private static bool $preparingPreview = false;

    /** @var \WeakMap<WP_REST_Request, bool> Whether an HTTP REST request arrived over POST. */
    private \WeakMap $httpPostRequests;

    /** @var \WeakMap<WP_REST_Request, array> */
    private \WeakMap $restSaves;

    public function __construct(
        private readonly Acf $acf = new Acf(),
        private readonly Flynt $flynt = new Flynt(),
        private readonly Yoast $yoast = new Yoast()
    ) {
        $this->httpPostRequests = new \WeakMap();
        $this->restSaves = new \WeakMap();
        add_filter('rest_allowed_cors_headers', [$this, 'rememberHttpMethod'], 10, 2);
        add_filter('rest_request_before_callbacks', [$this, 'trackRestSave'], 10, 3);
        add_filter('rest_post_dispatch', [$this, 'rebaseRestSave'], PHP_INT_MAX, 3);
        add_action('rest_api_init', [$this, 'registerRoutes']);
        add_action('init', [$this, 'registerStatus']);
        add_action('post_updated', [$this, 'deletePreviews']);
        add_action('load-post.php', [$this, 'trackNativePreview']);
        // Core's heartbeat_autosave runs at priority 500.
        add_filter('heartbeat_received', [$this, 'trackAutosave'], 499, 2);
        add_filter('heartbeat_received', [$this, 'rebaseAutosave'], 501);
    }

    /** Core autosave lookups and revision history only select revisions with status inherit. */
    public function registerStatus(): void
    {
        register_post_status(self::POST_STATUS, [
            'internal' => true,
            'public' => false,
            'exclude_from_search' => true,
            'show_in_admin_all_list' => false,
            'show_in_admin_status_list' => false,
        ]);
    }

    public function registerRoutes(): void
    {
        register_rest_route('meet-the-frontend-live-preview-panel/v1', '/posts/(?P<id>\d+)/preview', [
            'methods' => WP_REST_Server::CREATABLE,
            'permission_callback' => [$this, 'canPreparePreview'],
            'callback' => [$this, 'preparePreview'],
            'args' => [
                'id' => ['type' => 'integer', 'minimum' => 1, 'required' => true],
                'base' => ['type' => 'string', 'pattern' => '^[a-f0-9]{64}$', 'required' => true],
                'post_title' => ['type' => 'string'],
                'content' => ['type' => 'string'],
                'excerpt' => ['type' => 'string'],
                'author' => ['type' => 'integer', 'minimum' => 1],
                'date' => ['type' => ['string', 'null'], 'validate_callback' => [$this, 'validateDate']],
                // JSON preserves empty selections through both JSON and native ACF form requests.
                'terms' => ['type' => 'string'],
                'featured_media' => ['type' => 'integer', 'minimum' => 0],
            ],
        ]);
    }

    /** Record the request from serve_request(), not deliberate internal or nested REST dispatches. */
    public function rememberHttpMethod(array $headers, WP_REST_Request $request): array
    {
        // Core has already applied method overrides to $request at this point.
        $this->httpPostRequests[$request] = isset($_SERVER['REQUEST_METHOD'])
            && $_SERVER['REQUEST_METHOD'] === 'POST';
        return $headers;
    }

    public function canPreparePreview(WP_REST_Request $request): bool|WP_Error
    {
        $post = get_post((int) $request['id']);
        if (
            !is_user_logged_in() || !$post || !is_post_type_viewable($post->post_type)
            || !current_user_can('edit_post', $post->ID)
        ) {
            return new WP_Error(
                'mtflpp_cannot_preview',
                __('You cannot preview this post.', 'meet-the-frontend-live-preview-panel'),
                ['status' => rest_authorization_required_code()]
            );
        }
        return true;
    }

    public static function conflictMessage(): string
    {
        return __(
            'The saved post has changed or is no longer available for live preview.',
            'meet-the-frontend-live-preview-panel'
        );
    }

    /** Saved post inputs for editor merges and native-save coordination. */
    public function fingerprint(int $postId): string
    {
        return $this->parentFingerprint($postId, includeAcf: true);
    }

    private function parentFingerprint(int $postId, bool $includeAcf = false): string
    {
        $meta = get_post_meta($postId);
        // Native Custom Fields and arbitrary REST registrations don't describe a shared set of editor inputs.
        $state = [$meta['_thumbnail_id'] ?? [], $meta['_wp_page_template'] ?? []];
        // ACF field settings can differ on the frontend. Only editor requests merge saved rows.
        if ($includeAcf) {
            $state[] = Acf::paginatedRowState($meta);
        }
        return $this->stateHash($postId, $state);
    }

    /** A full check of owned snapshot data, or of writes during one potentially partial native save. */
    public function snapshotFingerprint(int $postId): string
    {
        $meta = get_post_meta($postId);
        ksort($meta);
        return $this->stateHash($postId, $meta);
    }

    private function stateHash(int $postId, array $meta): string
    {
        $taxonomies = get_object_taxonomies(get_post_type($postId));
        $terms = $taxonomies ? wp_get_object_terms($postId, $taxonomies, [
            'fields' => 'tt_ids', 'orderby' => 'term_taxonomy_id',
        ]) : [];
        // WP_Post::to_array() also reads filtered term lists; fingerprint stored fields instead.
        $post = get_post($postId);
        $fields = $post ? get_object_vars($post) : null;
        // Moderating comments updates this derived count without saving the post.
        unset($fields['comment_count']);
        return hash('sha256', (string) wp_json_encode([$fields, $meta, $terms]));
    }

    /** Only the same editor's successful native autosave may advance its known saved state. */
    public function trackAutosave(array $response, array $data): array
    {
        $this->autosavePostId = 0;
        $postId = isset($data['wp_autosave']['post_id']) && is_scalar($data['wp_autosave']['post_id'])
            ? absint($data['wp_autosave']['post_id']) : 0;
        if (
            $postId && isset($data['mtflpp_base']) && is_string($data['mtflpp_base'])
            && current_user_can('edit_post', $postId)
            && hash_equals($this->fingerprint($postId), $data['mtflpp_base'])
        ) {
            $this->autosavePostId = $postId;
        }
        return $response;
    }

    public function rebaseAutosave(array $response): array
    {
        if ($this->autosavePostId && !empty($response['wp_autosave']['success'])) {
            $response['mtflpp_base'] = $this->fingerprint($this->autosavePostId);
        }
        return $response;
    }

    /** Observe only opted-in native post/autosave routes; never reject or replace a native save. */
    public function trackRestSave($response, array $handler, WP_REST_Request $request)
    {
        $postId = (int) $request->get_param('id');
        $post = $postId ? get_post($postId) : null;
        $base = (string) $request->get_header('X-MTFLPP-Base');
        $token = (string) $request->get_header('X-MTFLPP-Request');
        if (
            !$post || !in_array($request->get_method(), ['POST', 'PUT', 'PATCH'], true)
            || !preg_match('/^[a-f0-9]{64}$/D', $base) || !preg_match('/^[a-f0-9]{32}$/D', $token)
            || !current_user_can('edit_post', $postId)
            || !wp_verify_nonce((string) $request->get_header('X-WP-Nonce'), 'wp_rest')
        ) {
            return $response;
        }
        $route = rest_get_route_for_post($post);
        if (!$route || !in_array($request->get_route(), [$route, $route . '/autosaves'], true)) {
            return $response;
        }
        $matches = hash_equals($this->fingerprint($postId), $base);
        $this->restSaves[$request] = [
            'postId' => $postId, 'base' => $base, 'request' => $token,
            'beforeWrite' => $matches ? $this->snapshotFingerprint($postId) : null,
        ];
        return $response;
    }

    /** A private, request-correlated receipt is removed by our middleware before core receives the record. */
    public function rebaseRestSave(
        WP_REST_Response $response,
        WP_REST_Server $server,
        WP_REST_Request $request
    ): WP_REST_Response {
        $save = $this->restSaves[$request] ?? null;
        unset($this->restSaves[$request]);
        $status = $response->get_status();
        if (!$save || !(($status >= 200 && $status < 300) || ($status >= 400 && $status < 500))) {
            return $response;
        }
        $data = $response->get_data();
        if (!is_array($data)) {
            return $response;
        }
        $post = get_post($save['postId']);
        $after = $save['beforeWrite'] !== null && $post ? $this->fingerprint($post->ID) : 'conflict';
        // A 4xx may follow a partial write, even to metadata outside the editor's conflict scope.
        if (
            $status >= 400 && (
                !$post || $after !== $save['base'] || $this->snapshotFingerprint($post->ID) !== $save['beforeWrite']
            )
        ) {
            return $response;
        }
        $data['_mtflpp_receipt'] = [
            'request' => $save['request'],
            'before' => $save['base'],
            'after' => $after,
            'available' => $post && $this->isAvailable($post),
        ];
        $response->set_data($data);
        return $response;
    }

    /** Acknowledge native Preview and Gutenberg's legacy meta-box POST without replacing their save or redirect. */
    public function trackNativePreview(): void
    {
        $postId = isset($_POST['post_ID']) && is_scalar($_POST['post_ID']) ? absint($_POST['post_ID']) : 0;
        // phpcs:disable WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- Exact string contracts below.
        $token = isset($_POST['mtflpp_preview']) && is_string($_POST['mtflpp_preview'])
            ? wp_unslash($_POST['mtflpp_preview']) : '';
        $base = isset($_POST['mtflpp_base']) && is_string($_POST['mtflpp_base'])
            ? wp_unslash($_POST['mtflpp_base']) : '';
        $action = isset($_POST['wp-preview']) && is_string($_POST['wp-preview'])
            ? wp_unslash($_POST['wp-preview']) : '';
        $metaSave = isset($_POST['mtflpp_metabox'], $_GET['meta-box-loader'], $_POST['action'])
            && $_POST['mtflpp_metabox'] === '1' && $_POST['action'] === 'editpost';
        // phpcs:enable WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
        $nonce = isset($_POST['_wpnonce']) && is_string($_POST['_wpnonce'])
            ? sanitize_text_field(wp_unslash($_POST['_wpnonce'])) : '';
        if (
            ($action !== 'dopreview' && !$metaSave) || !$postId
            || !preg_match('/^[a-f0-9]{32}$/D', $token) || !preg_match('/^[a-f0-9]{64}$/D', $base)
            || !current_user_can('edit_post', $postId) || !wp_verify_nonce($nonce, 'update-post_' . $postId)
        ) {
            return;
        }
        $matches = hash_equals($this->fingerprint($postId), $base);
        add_filter('wp_redirect', function ($location) use ($postId, $token, $base, $matches) {
            if ($location && !headers_sent()) {
                // A short-lived, tab/request-specific receipt also works for redirects and non-HTML previews.
                $receipt = $matches ? $base . '.' . $this->fingerprint($postId) : 'conflict';
                setcookie('mtflpp_preview_' . $token, $receipt, [
                    'expires' => time() + MINUTE_IN_SECONDS,
                    'path' => ADMIN_COOKIE_PATH,
                    'secure' => is_ssl(),
                    'samesite' => 'Strict',
                ]);
            }
            return $location;
        }, PHP_INT_MAX);
    }

    public function isAvailable(WP_Post $post): bool
    {
        // Preview snapshots are separate from WordPress's saved revision history.
        return in_array($post->post_status, ['draft', 'pending', 'publish', 'private', 'future'], true);
    }

    private function sourceAction(int $postId, int $revisionId, string $parentState): string
    {
        return 'mtflpp_read_' . $postId . '_' . $revisionId . '_' . $parentState
            . '_' . $this->snapshotFingerprint($revisionId);
    }

    /** Read display fields only after the caller has authorized a live source. */
    public static function livePostFields(int $sourceId): array
    {
        $fields = [];
        if (metadata_exists('post', $sourceId, self::AUTHOR_META)) {
            $fields['post_author'] = (int) get_post_meta($sourceId, self::AUTHOR_META, true);
        }
        $dates = get_post_meta($sourceId, self::DATE_META, true);
        if (is_array($dates)) {
            foreach (['post_date', 'post_date_gmt'] as $field) {
                if (isset($dates[$field]) && is_string($dates[$field])) {
                    $fields[$field] = $dates[$field];
                }
            }
        }
        return $fields;
    }

    /** Native REST dates, plus an empty form value for Gutenberg's null/immediate selection. */
    public function validateDate($value): bool|WP_Error
    {
        if ($value === null || $value === '') {
            return true;
        }
        $valid = rest_validate_value_from_schema($value, ['type' => 'string', 'format' => 'date-time'], 'date');
        if (is_wp_error($valid)) {
            return $valid;
        }
        $parts = date_parse($value);
        if ($parts['error_count'] || $parts['warning_count']) {
            return new WP_Error(
                'rest_invalid_date',
                __('Invalid date.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 400]
            );
        }
        return true;
    }

    /** Snapshot post-local assignments without writing term relationships or creating terms. */
    private function previewTerms(WP_Post $post, ?string $value): array|WP_Error
    {
        $input = $value === null ? new \stdClass() : json_decode($value);
        if (!$input instanceof \stdClass) {
            return new WP_Error(
                'rest_invalid_param',
                __('The preview can’t read your taxonomy selections.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 400]
            );
        }
        $taxonomies = get_object_taxonomies($post->post_type, 'objects');
        $result = [];
        foreach ((array) $input as $name => $ids) {
            $taxonomy = $taxonomies[$name] ?? null;
            if (!$taxonomy || !$taxonomy->show_in_rest) {
                return new WP_Error(
                    'rest_invalid_taxonomy',
                    __('Invalid taxonomy.', 'meet-the-frontend-live-preview-panel'),
                    ['status' => 400]
                );
            }
            if (!is_array($ids) || !array_is_list($ids)) {
                return new WP_Error(
                    'rest_invalid_param',
                    __('The preview can’t read your taxonomy selections.', 'meet-the-frontend-live-preview-panel'),
                    ['status' => 400]
                );
            }
            $schema = ['type' => 'array', 'items' => ['type' => 'integer', 'minimum' => 1]];
            $valid = rest_validate_value_from_schema($ids, $schema, 'terms.' . $name);
            if (is_wp_error($valid)) {
                $valid->add_data(['status' => 400]);
                return $valid;
            }
            if (!current_user_can($taxonomy->cap->assign_terms)) {
                return new WP_Error(
                    'rest_cannot_assign_term',
                    __('Sorry, you are not allowed to assign terms.', 'meet-the-frontend-live-preview-panel'),
                    ['status' => 403]
                );
            }
            $ids = rest_sanitize_value_from_schema($ids, $schema);
            foreach ($ids as $id) {
                $term = get_term($id, $name);
                if (!$term || is_wp_error($term)) {
                    return new WP_Error(
                        'rest_invalid_term',
                        __('Invalid term ID.', 'meet-the-frontend-live-preview-panel'),
                        ['status' => 400]
                    );
                }
                if (!current_user_can('assign_term', $id)) {
                    return new WP_Error(
                        'rest_cannot_assign_term',
                        __('Sorry, you are not allowed to assign terms.', 'meet-the-frontend-live-preview-panel'),
                        ['status' => 403]
                    );
                }
            }
            $result[$name] = array_values(array_unique($ids));
        }
        // Omitted taxonomies are seeded anew, so a reused source cannot retain old selections.
        foreach ($taxonomies as $name => $taxonomy) {
            if ($taxonomy->show_in_rest && !array_key_exists($name, $result)) {
                $ids = wp_get_object_terms($post->ID, $name, ['fields' => 'ids']);
                if (is_wp_error($ids)) {
                    return $ids;
                }
                $result[$name] = $ids;
            }
        }
        return $result;
    }

    public function preparePreview(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        // Editor writes require their REST nonce, including internal or alternative-auth requests.
        if (!wp_verify_nonce((string) $request->get_header('X-WP-Nonce'), 'wp_rest')) {
            return new WP_Error(
                'mtflpp_invalid_nonce',
                __('This preview has expired.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 403]
            );
        }
        $httpPost = $this->httpPostRequests[$request] ?? null;
        if ($httpPost === false) {
            return new WP_Error(
                'mtflpp_post_required',
                __('Preview writes require an HTTP POST request.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 405]
            );
        }
        if ($request->get_file_params()) {
            return new WP_Error(
                'mtflpp_upload_not_supported',
                __('File uploads aren’t supported in live previews.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 400]
            );
        }
        if (self::$preparingPreview) {
            return new WP_Error(
                'mtflpp_preview_busy',
                __('A live preview is already being prepared.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 409]
            );
        }

        // An internal dispatch can have no file params while its caller still has uploaded files.
        $originalFiles = $_FILES;
        self::$preparingPreview = true;
        $_FILES = [];
        try {
            return $this->preparePreviewWrite($request);
        } finally {
            $this->flynt->clearSaveEvidence();
            $_FILES = $originalFiles;
            self::$preparingPreview = false;
        }
    }

    private function preparePreviewWrite(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $postId = (int) $request['id'];
        $post = get_post($postId);
        $input = $request->get_params();

        require_once ABSPATH . 'wp-admin/includes/post.php';

        if (wp_check_post_lock($postId)) {
            return new WP_Error(
                'mtflpp_post_locked',
                __(
                    'Another user is editing this post. Take over editing to continue.',
                    'meet-the-frontend-live-preview-panel'
                ),
                ['status' => 409]
            );
        }
        $base = $input['base'];
        if (!$post || !$this->isAvailable($post) || !hash_equals($base, $this->fingerprint($postId))) {
            return new WP_Error(
                'mtflpp_preview_conflict',
                self::conflictMessage(),
                ['status' => 409]
            );
        }
        $fields = $this->previewFields($post, $input);
        if (is_wp_error($fields)) {
            return $fields;
        }
        $revisionId = $this->savePreview($post, $input, $fields);
        if (is_wp_error($revisionId)) {
            return $revisionId;
        }

        // Metadata writers can fail or be short-circuited; a source ID alone does not prove the snapshot was saved.
        if (
            get_post_meta($revisionId, self::AUTHOR_META, true) !== (string) $fields['author']
            || get_post_meta($revisionId, self::DATE_META, true) !== $fields['dates']
            || get_post_meta($revisionId, self::TERMS_META, true) !== $fields['terms']
        ) {
            return new WP_Error(
                'mtflpp_preview_fields_not_saved',
                __(
                    'Some preview fields couldn’t be prepared. Please try again.',
                    'meet-the-frontend-live-preview-panel'
                ),
                ['status' => 409]
            );
        }
        $parentState = $this->parentFingerprint($postId);
        if (!hash_equals($base, $this->fingerprint($postId))) {
            return new WP_Error(
                'mtflpp_source_changed',
                __('The saved post changed while the preview was loading.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 409]
            );
        }
        $action = $this->sourceAction($postId, $revisionId, $parentState);
        $result = [
            // Our state token authorizes this revision; native autosave parameters would select recovery data.
            'url' => FrontendPreview::previewUrl($post, [
                'mtflpp_post' => $postId,
                'mtflpp_revision' => $revisionId,
                'mtflpp_token' => wp_create_nonce($action),
            ]),
        ];
        $rowText = $this->rowDisplayText($request);
        if ($rowText) {
            $result['rowDisplayText'] = $rowText;
        }
        // Evidence describes the accepted snapshot; the adapter cannot replace the destination.
        $rowMarkers = $this->flynt->rowMarkers($revisionId, $input);
        if ($rowMarkers) {
            $result['rowMarkers'] = $rowMarkers;
        }
        return new WP_REST_Response($result);
    }

    /** Use only submitted body values and the native, non-shortcode WYSIWYG formatting steps. */
    private function rowDisplayText(WP_REST_Request $request): array
    {
        $body = $request->get_body_params();
        $requested = $body['mtflpp_row_text_fields'] ?? null;
        $names = is_string($requested) ? json_decode($requested, true, 4) : null;
        if (!is_array($names) || !array_is_list($names)) {
            return [];
        }
        $result = [];
        $seen = [];
        foreach ($names as $name) {
            if (!is_string($name) || isset($seen[$name]) || !preg_match('/^[\w-]+(?:\[[\w-]+\])+$/D', $name)) {
                continue;
            }
            $seen[$name] = true;
            $value = $body;
            foreach (explode('[', str_replace(']', '', $name)) as $part) {
                $value = is_array($value) ? ($value[$part] ?? null) : null;
            }
            if (!is_string($value) || $value === '') {
                continue;
            }
            try {
                $formatted = wpautop(wptexturize($value));
                if (trim($formatted) !== trim($value)) {
                    $result[$name] = $formatted;
                }
            } catch (\Throwable) {
                // Formatting evidence is optional; a formatter must not fail a prepared preview.
            }
        }
        return $result;
    }

    /** Validate and resolve display fields before preparing the isolated write. */
    private function previewFields(WP_Post $post, array $input): array|WP_Error
    {
        $dates = $this->previewDates($post, $input);
        if (is_wp_error($dates)) {
            return $dates;
        }
        $terms = $this->previewTerms($post, $input['terms'] ?? null);
        if (is_wp_error($terms)) {
            return $terms;
        }
        $authorId = $this->previewAuthor($post, $input);
        if (is_wp_error($authorId)) {
            return $authorId;
        }
        // Match the native featured-image contract, without calling parent-redirecting post-meta writers.
        $imageId = $input['featured_media'] ?? null;
        if (
            $imageId !== null && $imageId && (
                !get_post($imageId) || get_post_type($imageId) !== 'attachment'
                || !current_user_can('read_post', $imageId) || !wp_get_attachment_image($imageId, 'thumbnail')
            )
        ) {
            return new WP_Error(
                'rest_invalid_featured_media',
                __('The featured image can’t be used in this preview.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 400]
            );
        }

        return ['author' => $authorId, 'dates' => $dates, 'terms' => $terms, 'image' => $imageId];
    }

    private function previewDates(WP_Post $post, array $input): array|WP_Error
    {
        if (!array_key_exists('date', $input)) {
            return ['post_date' => $post->post_date, 'post_date_gmt' => $post->post_date_gmt];
        }
        $date = $input['date'];
        $now = current_time('mysql');
        $parsed = $date === null || $date === ''
            ? [$now, get_gmt_from_date($now)] : rest_get_date_with_gmt($date);
        if (!$parsed) {
            return new WP_Error(
                'rest_invalid_date',
                __('Invalid date.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 400]
            );
        }
        return array_combine(['post_date', 'post_date_gmt'], $parsed);
    }

    private function previewAuthor(WP_Post $post, array $input): int|WP_Error
    {
        if (!isset($input['author'])) {
            return (int) $post->post_author;
        }
        $authorId = $input['author'];
        if (!get_userdata($authorId)) {
            return new WP_Error(
                'rest_invalid_author',
                __('Invalid author ID.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 400]
            );
        }
        $type = get_post_type_object($post->post_type);
        if ($authorId !== get_current_user_id() && !current_user_can($type->cap->edit_others_posts)) {
            return new WP_Error(
                'rest_cannot_edit_others',
                __('Sorry, you are not allowed to edit posts as this user.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 403]
            );
        }
        return $authorId;
    }

    /** Keep native form state, temporary save hooks and their cleanup in one scope. */
    private function savePreview(WP_Post $post, array $input, array $fields): int|WP_Error
    {
        $postId = $post->ID;
        // REST values are unslashed. Native save APIs sanitize HTML and need slashed form data.
        $payload = [
            'post_ID' => $postId,
            'post_type' => $post->post_type,
            'post_status' => $post->post_status,
            'post_author' => $fields['author'],
            'post_title' => $post->post_title,
            'content' => $post->post_content,
            'excerpt' => $post->post_excerpt,
            'wp-preview' => 'dopreview',
        ];
        foreach (['post_title', 'content', 'excerpt'] as $key) {
            if (isset($input[$key])) {
                $payload[$key] = $input[$key];
            }
        }
        // Native form-save hooks read $_POST; scope both preparation and saving to this operation.
        // phpcs:ignore WordPress.Security.NonceVerification.Missing -- REST nonce verified by preparePreview().
        $originalPost = $_POST;
        try {
            try {
                $payload = $this->acf->preparePayload($payload, $input);
                if (is_wp_error($payload)) {
                    return $payload;
                }
                $error = $this->yoast->preparePrimaryTerms($postId, $input);
                if ($error) {
                    return $error;
                }
                $payload = wp_slash($payload);
                $seeded = false;
                $seed = function (int $revisionId) use ($postId, $fields, $input, &$seeded): void {
                    // Native save callbacks can update the same revision again. Seed only once.
                    if ($seeded || !$this->ownsRevision($postId, $revisionId)) {
                        return;
                    }
                    $seeded = true;
                    $this->seedPreviewMeta($postId, $revisionId, $fields);
                    if (!$this->ownsRevision($postId, $revisionId)) {
                        return;
                    }
                    $this->acf->beginRevisionWrite($revisionId);
                    $this->flynt->observeSave($revisionId, $input);
                    $this->yoast->savePrimaryTerms($revisionId, $postId);
                    if ($this->ownsRevision($postId, $revisionId)) {
                        $this->writePreviewFields($revisionId, $fields);
                    }
                };
                add_action('save_post_revision', $seed, 0);
                $_POST = $payload;
                try {
                    $revisionId = $this->writeRevision($postId, $payload);
                } finally {
                    remove_action('save_post_revision', $seed, 0);
                    $_POST = $originalPost;
                }
                if (is_wp_error($revisionId)) {
                    return new WP_Error('mtflpp_preview_failed', $revisionId->get_error_message(), ['status' => 400]);
                }
                if (!$revisionId || !$this->ownsRevision($postId, $revisionId)) {
                    return $this->revisionUnavailable();
                }
                $error = $this->acf->verifySave($revisionId);
            } finally {
                // Release the native ACF guards before any Yoast verification reads.
                $_POST = $originalPost;
                $this->acf->resetSave();
            }
            $error ??= $this->yoast->verifySave($revisionId);
            if ($error) {
                return $error;
            }
            return $this->ownsRevision($postId, $revisionId) ? $revisionId : $this->revisionUnavailable();
        } finally {
            $_POST = $originalPost;
            $this->yoast->resetSave();
            $this->flynt->stopObserving();
        }
    }

    private function revisionUnavailable(): WP_Error
    {
        return new WP_Error(
            'mtflpp_revision_unavailable',
            __('We couldn’t prepare the preview.', 'meet-the-frontend-live-preview-panel'),
            ['status' => 409]
        );
    }

    /** Revision authors identify the editor/owner, not the post's selected author. */
    private function writePreviewFields(int $revisionId, array $fields): void
    {
        update_metadata('post', $revisionId, self::AUTHOR_META, $fields['author']);
        update_metadata('post', $revisionId, self::DATE_META, $fields['dates']);
        update_metadata('post', $revisionId, self::TERMS_META, $fields['terms']);
        $imageId = $fields['image'];
        if ($imageId === null) {
            return;
        }
        if ($imageId) {
            update_metadata('post', $revisionId, '_thumbnail_id', $imageId);
            return;
        }
        delete_metadata('post', $revisionId, '_thumbnail_id');
    }

    private function revisionName(int $postId): string
    {
        return $postId . '-mtflpp-preview-' . get_current_user_id();
    }

    /** Reuse one internal revision per post/user without reading or overwriting recovery autosaves. */
    private function writeRevision(int $postId, array $payload): int|WP_Error
    {
        $revisions = get_posts([
            'post_type' => 'revision',
            'post_status' => self::POST_STATUS,
            'post_parent' => $postId,
            'author' => get_current_user_id(),
            'name' => $this->revisionName($postId),
            'posts_per_page' => 1,
            'fields' => 'ids',
        ]);

        // The payload is already slashed; wp_insert_post applies the native post sanitization filters.
        return wp_insert_post([
            'ID' => $revisions[0] ?? 0,
            'post_type' => 'revision',
            'post_status' => self::POST_STATUS,
            'post_parent' => $postId,
            'post_name' => $this->revisionName($postId),
            'post_author' => get_current_user_id(),
            'post_title' => $payload['post_title'],
            'post_content' => $payload['content'],
            'post_excerpt' => $payload['excerpt'],
        ], true);
    }

    /** Saved changes invalidate preview URLs; discard only our internal revisions at that point. */
    public function deletePreviews(int $postId): void
    {
        if (!get_post_status_object(self::POST_STATUS) || wp_is_post_revision($postId)) {
            return;
        }
        $revisions = get_posts([
            'post_type' => 'revision',
            'post_status' => self::POST_STATUS,
            'post_parent' => $postId,
            'posts_per_page' => -1,
            'fields' => 'ids',
        ]);
        foreach ($revisions as $revisionId) {
            $revision = get_post($revisionId);
            if (
                $revision && $revision->post_type === 'revision' && $revision->post_status === self::POST_STATUS
                && (int) $revision->post_parent === $postId
            ) {
                wp_delete_post_revision($revisionId);
            }
        }
    }

    /** Start from saved metadata before save hooks overlay submitted fields, including on reused previews. */
    private function seedPreviewMeta(int $postId, int $revisionId, array $fields): void
    {
        $source = get_post_meta($postId);
        unset($source['_edit_lock'], $source['_edit_last']);
        $preview = get_post_meta($revisionId);
        // These preview-only values are always written and verified separately.
        $retain = [
            self::AUTHOR_META => (string) $fields['author'],
            self::DATE_META => maybe_serialize($fields['dates']),
            self::TERMS_META => maybe_serialize($fields['terms']),
        ];
        foreach (array_unique(array_merge(array_keys($source), array_keys($preview))) as $key) {
            if (
                ($source[$key] ?? []) === ($preview[$key] ?? [])
                || (isset($retain[$key]) && !array_key_exists($key, $source) && $preview[$key] === [$retain[$key]])
            ) {
                continue;
            }
            // Use metadata APIs directly: post-meta write helpers redirect revisions to their parent.
            delete_metadata('post', $revisionId, $key);
            // Individual parent-key reads may be overlaid by an already-bound preview.
            foreach ($source[$key] ?? [] as $value) {
                add_metadata('post', $revisionId, $key, wp_slash(maybe_unserialize($value)));
            }
        }
    }

    private function ownsRevision(int $postId, int $revisionId): bool
    {
        $revision = get_post($revisionId);
        return $revision && $revision->post_type === 'revision'
            && $revision->post_status === self::POST_STATUS && (int) $revision->post_parent === $postId
            && (int) $revision->post_author === get_current_user_id()
            && $revision->post_name === $this->revisionName($postId);
    }

    /** Keep mutable live-source ownership and state-token validation together. */
    public function authorizedSource(int $postId, int $revisionId, string $token): ?WP_Post
    {
        if (
            !is_user_logged_in() || !$postId || !get_post($postId)
            || !current_user_can('edit_post', $postId) || !$revisionId
            || !$this->ownsRevision($postId, $revisionId)
        ) {
            return null;
        }
        $action = $this->sourceAction($postId, $revisionId, $this->parentFingerprint($postId));
        return wp_verify_nonce($token, $action) ? get_post($revisionId) : null;
    }
}
