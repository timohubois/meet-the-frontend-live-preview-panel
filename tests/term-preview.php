<?php

/** Run with `wp eval-file tests/term-preview.php` on a disposable installation. */

namespace AFloatingLivePreviewPanel;

use RuntimeException;
use WP_Block;
use WP_Block_Type_Registry;
use WP_CLI;
use WP_Query;
use WP_Term;
use WP_REST_Request;
use WP_REST_Response;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(TermPreview::class) || is_multisite()) {
    throw new RuntimeException('Run through WP-CLI on a disposable single site with the plugin active.');
}

$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$file = dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php';
$preview = new TermPreview($file);
remove_action('init', [$preview, 'authorizePreview'], 20);
remove_action('rest_api_init', [$preview, 'registerRoutes']);
remove_filter('rest_allowed_cors_headers', [$preview, 'rememberHttpMethod'], 10);
$route = static fn (int $id): string => '/a-floating-live-preview-panel/v1/terms/' . $id . '/preview';
$prepare = static function (int $id, $name = 'Edited term', $description = '', array $extra = []) use ($route) {
    $request = new WP_REST_Request('POST', $route($id));
    $request->set_header('X-WP-Nonce', wp_create_nonce('wp_rest'));
    $request->set_body_params(['name' => $name, 'description' => $description, 'slug' => 'not-the-archive'] + $extra);
    return rest_do_request($request);
};
$withRequest = static function (string $url, array $query, callable $assertions) use ($preview): void {
    $hooks = ['template_redirect', 'term_name', 'term_description', 'wp_head', 'wp_enqueue_scripts',
        'show_admin_bar', 'wp_template_enhancement_output_buffer', 'wp_die_handler'];
    foreach ($hooks as $hook) {
        $originalHooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
    }
    $termCleanup = $GLOBALS['wp_filter']['shutdown']->callbacks[PHP_INT_MAX] ?? [];
    $originalQuery = $GLOBALS['wp_query'];
    $originalGet = $_GET; // phpcs:ignore WordPress.Security -- Restore request globals unchanged after the fixture.
    try {
        $params = [];
        parse_str((string) wp_parse_url($url, PHP_URL_QUERY), $params);
        $_GET = $params + ['aflpp_source' => '1'];
        // Test only our template callback; unrelated callbacks can issue actual CLI redirects.
        unset($GLOBALS['wp_filter']['template_redirect']);
        add_filter('wp_die_handler', static fn () => static function ($message, $title, $args): void {
            throw new RuntimeException(esc_html((string) $message), (int) $args['response']);
        });
        try {
            $preview->authorizePreview();
        } catch (RuntimeException $error) {
            $assertions($error->getCode());
            return;
        }
        $GLOBALS['wp_query'] = new WP_Query($query);
        do_action('template_redirect');
        $assertions(200);
    } finally {
        // Release only adapter bindings added by this simulated frontend request.
        $hooksNow = $GLOBALS['wp_filter']['shutdown']->callbacks[PHP_INT_MAX] ?? [];
        foreach (array_diff_key($hooksNow, $termCleanup) as $hook) {
            if (is_array($hook['function']) && $hook['function'][1] === 'unbindTermPreview') {
                ($hook['function'])();
            }
        }
        $_GET = $originalGet;
        $GLOBALS['wp_query'] = $originalQuery;
        foreach ($originalHooks as $hook => $original) {
            if ($original === null) {
                unset($GLOBALS['wp_filter'][$hook]);
            } else {
                $GLOBALS['wp_filter'][$hook] = $original;
            }
        }
    }
};

$termBlock = static function (string $name, ?WP_Term $term = null): ?WP_Block {
    if (!WP_Block_Type_Registry::get_instance()->is_registered($name)) {
        return null;
    }
    return new WP_Block([
        'blockName' => $name, 'attrs' => $name === 'core/term-name' ? ['isLink' => true] : [],
        'innerBlocks' => [], 'innerHTML' => '', 'innerContent' => [],
    ], $term ? ['termId' => $term->term_id, 'taxonomy' => $term->taxonomy] : []);
};

$previousUser = get_current_user_id();
$users = [];
$terms = [];
$taxonomies = ['aflpp_public', 'aflpp_hidden'];
register_taxonomy('aflpp_public', 'post', ['public' => true]);
register_taxonomy('aflpp_hidden', 'post', ['public' => false, 'show_ui' => true]);
$prefix = 'aflpp-term-' . wp_generate_password(8, false);
$expectForbidden = static function (int $status) use ($check): void {
    $check($status === 403, 'Expired, tampered or unauthorized URLs must be rejected.');
};
try {
    foreach (['administrator', 'administrator', 'subscriber'] as $index => $role) {
        $id = wp_insert_user([
            'user_login' => $prefix . $index, 'user_pass' => wp_generate_password(), 'role' => $role,
        ]);
        $check(is_int($id), 'Could not create fixture user.');
        $users[] = $id;
    }
    wp_set_current_user($users[0]);
    foreach (['category', 'post_tag', ...$taxonomies] as $taxonomy) {
        $result = wp_insert_term('Saved ' . $prefix, $taxonomy, ['description' => 'Saved description']);
        $check(is_array($result), 'Could not create fixture term.');
        $terms[$taxonomy] = get_term($result['term_id'], $taxonomy);
    }
    $otherCategory = wp_insert_term('Other ' . $prefix, 'category');
    $check(is_array($otherCategory), 'Could not create an unrelated category.');
    $terms['other_category'] = get_term($otherCategory['term_id'], 'category');
    $hidden = $terms['aflpp_hidden'];
    $check($prepare($hidden->term_id)->get_status() === 403, 'A non-viewable term must not be previewable.');
    $term = $terms['category'];
    $check($prepare($term->term_id, ['invalid'])->get_status() === 400, 'Reject non-string fields.');

    $input = ['name' => 'Edited title', 'description' => 'Edited description'];
    $path = $route($term->term_id);
    $request = new WP_REST_Request('POST', $path);
    $request->set_body_params($input);
    foreach (['', 'invalid'] as $nonce) {
        if ($nonce !== '') {
            $request->set_header('X-WP-Nonce', $nonce);
        }
        $result = rest_do_request($request);
        $check(
            $result->get_status() === 403 && $result->get_data()['code'] === 'aflpp_invalid_nonce',
            'Reject a missing or invalid editor nonce even on an authenticated internal dispatch.'
        );
    }

    // Use core's HTTP entry point so native method overrides are applied before the write guard.
    $serve = static function (string $method, array $query = [], array $headers = []) use ($input, $path) {
        // phpcs:ignore WordPress.Security.NonceVerification -- Snapshot request globals in the CLI fixture.
        $previous = [$_SERVER, $_GET, $_POST];
        $result = null;
        $capture = static function ($served, WP_REST_Response $response) use (&$result): bool {
            $result = $response;
            return true;
        };
        add_filter('rest_pre_serve_request', $capture, 20, 2);
        try {
            $_SERVER = ['REQUEST_METHOD' => $method, 'HTTP_X_WP_NONCE' => wp_create_nonce('wp_rest')] + $headers;
            $_GET = wp_slash($query);
            $_POST = $method === 'POST' ? wp_slash($input) : [];
            rest_get_server()->serve_request($path);
            return $result;
        } finally {
            remove_filter('rest_pre_serve_request', $capture, 20);
            [$_SERVER, $_GET, $_POST] = $previous;
        }
    };
    foreach (['GET', 'HEAD'] as $method) {
        $responses = [
            $serve($method, $input + ['_method' => 'POST']),
            $serve($method, $input, ['HTTP_X_HTTP_METHOD_OVERRIDE' => 'POST']),
        ];
        foreach ($responses as $result) {
            $check(
                $result->get_status() === 405 && $result->get_data()['code'] === 'aflpp_post_required',
                "$method must not become a preview write through a core REST method override."
            );
        }
    }
    $storageKey = 'aflpp_term_' . $term->term_taxonomy_id . '_' . $users[0];
    $check(get_transient($storageKey) === false, 'Rejected requests must not write a term preview transient.');
    $check($serve('POST')->get_status() === 200, 'An actual authenticated HTTP POST should prepare the preview.');

    foreach (['category', 'post_tag', 'aflpp_public'] as $taxonomy) {
        $term = $terms[$taxonomy];
        $query = ['taxonomy' => $taxonomy, 'term' => $term->slug];
        $name = "Changed O'Reilly";
        $description = 'First paragraph with <strong>emphasis</strong>.';
        $response = $prepare($term->term_id, $name, $description);
        $check($response->get_status() === 200, 'Editable archive preview should be prepared.');
        $url = $response->get_data()['url'];
        $check(
            remove_query_arg(['aflpp_term', 'aflpp_token'], $url) === get_term_link($term),
            'Preview must retain the actual native archive URL.'
        );
        $withRequest($url, $query, static function (int $status) use ($check, $term, $name, $termBlock, $terms): void {
            $titleFilter = match ($term->taxonomy) {
                'category' => 'single_cat_title',
                'post_tag' => 'single_tag_title',
                default => 'single_term_title',
            };
            $check(
                $status === 200 && single_term_title('', false) === apply_filters($titleFilter, $name),
                'Native term titles must see edits and retain formatting.'
            );
            $check(
                str_contains(get_the_archive_description(), '<p>First paragraph with <strong>emphasis</strong>.</p>'),
                'Native archive descriptions must retain formatting.'
            );
            $queried = get_queried_object();
            $check(
                $queried->name === $name && $queried->slug === $term->slug && $queried->parent === $term->parent,
                'Update the queried term copy without changing its routing fields.'
            );
            $stored = get_term($term->term_id, $term->taxonomy);
            $check(
                $stored->name === $term->name && $stored->description === $term->description,
                'Keep raw reads saved.'
            );
            $check(has_filter('wp_template_enhancement_output_buffer'), 'Capture opted-in previews.');

            $other = $terms[$term->taxonomy === 'category' ? 'other_category' : 'category'];
            $block = $termBlock('core/term-name', $term);
            if ($block) {
                $html = $block->render();
                $check(str_contains($html, $name), 'A contextual Term Name block must show the edit.');
                $check(str_contains($html, esc_url(get_term_link($term))), 'The term name link stays saved.');
                $check($block->context['termId'] === $term->term_id, 'Keep the real block context intact.');
                $otherBlock = $termBlock('core/term-name', $other);
                $check(str_contains($otherBlock->render(), $other->name), 'Keep other names.');
            }
            $block = $termBlock('core/term-description', $term);
            $check(str_contains($block->render(), '<strong>emphasis</strong>'), 'Contextual descriptions update too.');
            if (class_exists(\Timber\Timber::class)) {
                $direct = \Timber\Timber::get_term($term->term_id);
                $check($direct->name === $name && $direct->link() === get_term_link($term), 'Adapt Timber ID imports.');
                $check(\Timber\Timber::get_term()->name === $name, 'Adapt Timber’s current archive lookup.');
                $listing = get_terms([
                    'taxonomy' => $term->taxonomy, 'include' => [$term->term_id], 'hide_empty' => false,
                ]);
                $check(\Timber\Timber::get_term($listing[0])->title() === $name, 'Adapt a Flynt-style filter label.');
                $check($listing[0]->name === $term->name, 'Do not mutate the term passed into Timber.');
                $check(
                    str_contains($direct->description(), '<strong>emphasis</strong>'),
                    'Timber’s description retains its native formatting.'
                );
                $check(\Timber\Timber::get_term($other->term_id)->name === $other->name, 'Keep other Timber terms.');
                $customClass = static fn () => \stdClass::class;
                add_filter('timber/term/class', $customClass);
                try {
                    $check(
                        apply_filters('timber/term/class', \Timber\Term::class, $term) === \stdClass::class,
                        'Preserve theme-selected Timber term classes.'
                    );
                } finally {
                    remove_filter('timber/term/class', $customClass);
                }
            }
        });
        $withRequest($url, ['pagename' => 'nonexistent'], static function (int $status) use ($check, $term): void {
            $check($status === 200 && !has_filter('wp_template_enhancement_output_buffer'), 'Skip other URLs.');
            $check(!str_contains(term_description($term->term_id), 'First paragraph'), 'No off-target overlay.');
            if (class_exists(\Timber\Timber::class)) {
                $check(\Timber\Timber::get_term($term->term_id)->name === $term->name, 'No off-target Timber overlay.');
            }
        });
        $withRequest(get_term_link($term), $query, static function (int $status) use ($check, $term): void {
            $check(single_term_title('', false) === $term->name && $status === 200, 'Keep the public archive saved.');
            $check(get_the_archive_description() === "<p>Saved description</p>\n", 'Leave public description intact.');
            if (class_exists(\Timber\Timber::class)) {
                $check(\Timber\Timber::get_term()->name === $term->name, 'Public Timber imports stay saved.');
            }
            $type = WP_Block_Type_Registry::get_instance()->get_registered('core/term-description');
            $check($type->render_callback === 'render_block_core_term_description', 'Release the native binding.');
        });
        wp_set_current_user($users[1]);
        $withRequest($url, $query, $expectForbidden);
        wp_set_current_user($users[2]);
        $check($prepare($term->term_id)->get_status() === 403, 'Edit permission is required.');
        $withRequest($url, $query, $expectForbidden);
        wp_set_current_user(0);
        $check($prepare($term->term_id)->get_status() === 401, 'Authentication is required.');
        $withRequest($url, $query, $expectForbidden);
        wp_set_current_user($users[0]);

        $withRequest(add_query_arg('aflpp_token', 'invalid', $url), $query, $expectForbidden);
        $updated = $prepare($term->term_id)->get_data()['url'];
        $withRequest($url, $query, $expectForbidden);
        $withRequest($updated, $query, static function (int $status) use ($check): void {
            $check($status === 200 && get_the_archive_description() === '', 'Allow an explicit description clear.');
        });
        delete_transient('aflpp_term_' . $term->term_taxonomy_id . '_' . $users[0]);
        $withRequest($updated, $query, $expectForbidden);
    }

    $term = $terms['category'];
    $name = 'Unsaved link label';
    $nameLink = static fn (string $url, WP_Term $candidate): string => $candidate->term_id === $term->term_id
        ? home_url('/term-label/' . sanitize_title($candidate->name) . '/') : $url;
    add_filter('term_link', $nameLink, 10, 2);
    try {
        $savedLink = get_term_link($term);
        $response = $prepare($term->term_id, $name, 'Unsaved link description');
        $check($response->get_status() === 200, 'Prepare a preview with a name-dependent permalink.');
        $url = $response->get_data()['url'];
        $check(remove_query_arg(['aflpp_term', 'aflpp_token'], $url) === $savedLink, 'Open the saved archive.');
        $withRequest(
            $url,
            ['taxonomy' => $term->taxonomy, 'term' => $term->slug],
            static function (int $status) use ($check, $term, $termBlock, $name, $savedLink): void {
                $check($status === 200, 'The saved archive matches.');
                foreach ([$term, null] as $contextTerm) {
                    $block = $termBlock('core/term-name', $contextTerm);
                    if ($block) {
                        $html = $block->render();
                        $check(str_contains($html, '>' . $name . '</a>'), 'Render the unsaved block link label.');
                        $check(str_contains($html, 'href="' . esc_url($savedLink) . '"'), 'Keep the saved block URL.');
                    }
                }
                $check(get_queried_object()->name === $name, 'Do not change the queried term during link generation.');
                if (class_exists(\Timber\Timber::class)) {
                    foreach ([$term->term_id, get_queried_object()] as $inputTerm) {
                        $item = \Timber\Timber::get_term($inputTerm);
                        $check($item->link() === $savedLink && $item->title() === $name, 'Keep the saved Timber URL.');
                    }
                    $timberLink = static fn (string $url, \Timber\Term $item): string => $item->ID === $term->term_id
                        ? $url . '?label=' . sanitize_title($item->name) : $url;
                    add_filter('timber/term/link', $timberLink, 10, 2);
                    try {
                        $expected = $savedLink . '?label=' . sanitize_title($term->name);
                        $check($item->link() === $expected, 'Timber’s native link filter must see the saved name.');
                        $check($item->title() === $name, 'Link generation leaves the Timber display name unchanged.');
                    } finally {
                        remove_filter('timber/term/link', $timberLink);
                    }
                }
            }
        );
    } finally {
        remove_filter('term_link', $nameLink);
    }

    if (class_exists(\Timber\Timber::class)) {
        $descriptionLink = static fn (string $url, \Timber\Term $item): string => $item->ID === $term->term_id
            ? add_query_arg('description-label', sanitize_title($item->description()), $url) : $url;
        $formatDescription = static fn (string $value, int $id): string => $id === $term->term_id
            ? str_replace('Saved description', 'Formatted saved description', $value) : $value;
        add_filter('timber/term/link', $descriptionLink, 10, 2);
        add_filter('category_description', $formatDescription, 10, 2);
        try {
            $savedLink = \Timber\Timber::get_term($term->term_id)->link();
            $check(str_contains($savedLink, 'description-label=formatted-saved-description'), 'Use native formatting.');
            $draft = 'Unsaved link description';
            $response = $prepare($term->term_id, $term->name, $draft);
            $check($response->get_status() === 200, 'Prepare a description-only preview.');
            $withRequest(
                $response->get_data()['url'],
                ['taxonomy' => $term->taxonomy, 'term' => $term->slug],
                static function (int $status) use ($check, $term, $draft, $savedLink): void {
                    $item = \Timber\Timber::get_term($term->term_id);
                    $check($status === 200 && $item->description() === $draft, 'Render the draft description.');
                    $check($item->link() === $savedLink, 'Keep the saved URL for a description-only edit.');
                    $check($item->description() === $draft, 'Do not reset the Timber description.');
                    $check(str_contains(get_the_archive_description(), $draft), 'Keep the draft archive description.');
                }
            );
        } finally {
            remove_filter('category_description', $formatDescription);
            remove_filter('timber/term/link', $descriptionLink);
        }
    }

    $description = '<h3>Heading</h3><ul><li>List item</li></ul>'
        . '<img src="https://example.org/image.png" alt="Example" onerror="void(0)">';
    $saveHooks = $GLOBALS['wp_filter']['pre_term_description']->callbacks;
    $customFilter = static fn (string $value): string => str_replace('List item', 'Filtered list item', $value);
    add_filter('pre_category_description', $customFilter);
    try {
        $response = $prepare($term->term_id, $term->name, $description);
    } finally {
        remove_filter('pre_category_description', $customFilter);
    }
    $check($response->get_status() === 200, 'The formatted description preview should be prepared.');
    $check(
        $GLOBALS['wp_filter']['pre_term_description']->callbacks === $saveHooks,
        'Preview preparation must leave the native save filters and their order unchanged.'
    );
    $yoast = function_exists('YoastSEO');
    $withRequest(
        $response->get_data()['url'],
        ['taxonomy' => 'category', 'term' => $term->slug],
        static function (int $status) use ($check, $term, $yoast): void {
            $output = get_the_archive_description();
            $check($status === 200 && str_contains($output, 'Filtered list item'), 'Run native taxonomy filters.');
            foreach (['<h3>Heading</h3>', '<ul>', '<li>Filtered list item</li>', '<img '] as $markup) {
                $check(str_contains($output, $markup) === $yoast, 'Match the native term editor’s HTML policy.');
            }
            $check(!str_contains($output, 'onerror'), 'Strip unsafe attributes with either policy.');
            $check(get_term($term->term_id)->description === 'Saved description', 'Do not save formatted edits.');
        }
    );

    if ($yoast) {
        $generator = YoastSEO()->classes->get(\Yoast\WP\SEO\Generators\Breadcrumbs_Generator::class);
        $context = YoastSEO()->meta->for_term($term->term_id)->context;
        $savedTrail = $generator->generate($context);
        $check(in_array($term->name, array_column($savedTrail, 'text'), true), 'Warm the native term breadcrumb.');
        $name = 'Preview breadcrumb name';
        $response = $prepare($term->term_id, $name);
        $url = $response->get_data()['url'];
        $query = ['taxonomy' => 'category', 'term' => $term->slug];
        $withRequest($url, $query, static function (int $status) use ($check, $generator, $context, $term, $name) {
            $labels = array_column($generator->generate($context), 'text');
            $check($status === 200 && in_array($name, $labels, true), 'Preview the default crumb.');
            $check($context->indexable->breadcrumb_title === $term->name, 'Do not mutate the shared indexable.');
        });
        $check($generator->generate($context) === $savedTrail, 'Release the Yoast breadcrumb binding.');
        // Explicitly configuring the same display text must still keep it out of the preview overlay.
        \WPSEO_Taxonomy_Meta::set_value($term->term_id, $term->taxonomy, 'bctitle', $term->name);
        $withRequest($url, $query, static function (int $status) use ($check, $generator, $context, $savedTrail): void {
            $check($status === 200 && $generator->generate($context) === $savedTrail, 'Keep custom breadcrumb titles.');
        });
    }

    if (!function_exists('acf_add_local_field_group')) {
        WP_CLI::log('Skipping ACF term coexistence checks: ACF is not active.');
    } else {
        $term = $terms['aflpp_public'];
        $group = 'group_aflpp_term_preview_fixture';
        $fieldKey = 'field_aflpp_term_preview_note';
        $fieldName = 'aflpp_term_preview_note';
        $acfId = 'term_' . $term->term_id;
        $saved = 'Saved ACF term note';
        acf_add_local_field_group([
            'key' => $group,
            'title' => 'Term preview fixture',
            'location' => [[['param' => 'taxonomy', 'operator' => '==', 'value' => $term->taxonomy]]],
            'fields' => [['key' => $fieldKey, 'name' => $fieldName, 'type' => 'text']],
        ]);
        update_field($fieldKey, $saved, $acfId);
        $check(get_field($fieldName, $acfId) === $saved, 'The fixture must have a saved native ACF value.');
        $unexpectedSave = static function (): void {
            throw new RuntimeException('Preparing or rendering a core term preview must not run ACF saves.');
        };
        add_action('acf/save_post', $unexpectedSave);
        try {
            $response = $prepare($term->term_id, 'New name', 'New description', [
                '_acf_nonce' => wp_create_nonce('taxonomy'), 'acf' => [$fieldKey => 'Unsaved ACF term note'],
            ]);
            $check($response->get_status() === 200, 'ACF must not prevent a core term preview.');
            $withRequest(
                $response->get_data()['url'],
                ['taxonomy' => $term->taxonomy, 'term' => $term->slug],
                static function (int $status) use ($check, $term, $fieldKey, $fieldName, $acfId, $saved): void {
                    $check($status === 200 && single_term_title('', false) === 'New name', 'Preview the core name.');
                    $check(str_contains(get_the_archive_description(), 'New description'), 'Preview the description.');
                    $check(get_field($fieldName, $acfId) === $saved, 'Leave ACF reads on the saved term.');
                    $check(get_term_meta($term->term_id, $fieldName, true) === $saved, 'Do not write ACF term values.');
                    $check(get_term_meta($term->term_id, '_' . $fieldName, true) === $fieldKey, 'Preserve references.');
                }
            );
        } finally {
            remove_action('acf/save_post', $unexpectedSave);
            acf_remove_local_field_group($group);
        }
        WP_CLI::log('ACF term coexistence checks passed.');
    }
} finally {
    wp_set_current_user($previousUser);
    foreach ($terms as $term) {
        foreach ($users as $user) {
            delete_transient('aflpp_term_' . $term->term_taxonomy_id . '_' . $user);
        }
        wp_delete_term($term->term_id, $term->taxonomy);
    }
    foreach ($taxonomies as $taxonomy) {
        unregister_taxonomy($taxonomy);
    }
    require_once ABSPATH . 'wp-admin/includes/user.php';
    foreach ($users as $user) {
        wp_delete_user($user);
    }
}
WP_CLI::success('Term previews use authorized, isolated data on category, tag and public custom taxonomy archives.');
