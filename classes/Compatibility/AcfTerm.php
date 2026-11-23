<?php

namespace MeetTheFrontendLivePreviewPanel\Compatibility;

use ReflectionClass;
use WP_Error;
use WP_Term;

/** Normalize a native ACF term form into an in-memory metadata overlay, not a term save. */
final class AcfTerm
{
    public function __construct()
    {
        add_filter('mtflpp_term_editor_preview_config', [$this, 'configureEditor']);
        add_filter('mtflpp_term_editor_preview_script_dependencies', [$this, 'addEditorDependencies'], 10, 2);
        add_filter('mtflpp_term_preview_data', [$this, 'prepare'], 10, 3);
        add_action('mtflpp_frontend_term_preview_source_selected', [$this, 'bind']);
    }

    public function configureEditor(array $config): array
    {
        if (function_exists('acf_get_field_type') && wp_script_is('acf-input', 'registered')) {
            $config['acfTermEnabled'] = true;
            $config['strings']['acfUnavailable'] = $this->unavailable()->get_error_message();
        }
        return $config;
    }

    public function addEditorDependencies(array $dependencies, array $context): array
    {
        return empty($context['config']['acfTermEnabled']) ? $dependencies : [...$dependencies, 'acf-input'];
    }

    private function unavailable(): WP_Error
    {
        return new WP_Error(
            'mtflpp_acf_unavailable',
            __('The preview can’t read your custom fields.', 'meet-the-frontend-live-preview-panel'),
            ['status' => 400]
        );
    }

    public function prepare(array|WP_Error $data, WP_Term $term, array $input): array|WP_Error
    {
        if (is_wp_error($data) || !array_key_exists('acf', $input)) {
            return $data;
        }
        if (
            !function_exists('acf_get_field_type') || !is_array($input['acf'])
            || !is_string($input['_acf_nonce'] ?? null) || !wp_verify_nonce($input['_acf_nonce'], 'taxonomy')
            || !is_array($input['_acf_fields'] ?? [])
        ) {
            return $this->unavailable();
        }

        $id = 'term_' . $term->term_id;
        $screen = ['taxonomy' => $term->taxonomy];
        if (function_exists('acf_filter_save_values')) {
            $values = acf_filter_save_values($input['acf'], [
                'context' => 'taxonomy', 'post_id' => $id, 'render_ids' => [$id],
                'screen' => $screen, 'lists' => $input['_acf_fields'] ?? [],
            ]);
        } else {
            $values = [];
            foreach (acf_get_field_groups($screen) as $group) {
                foreach (acf_get_fields($group) ?: [] as $field) {
                    if (isset($input['acf'][$field['key']])) {
                        $values[$field['key']] = $input['acf'][$field['key']];
                    }
                }
            }
        }
        $valid = true;
        array_walk_recursive($values, static function ($value) use (&$valid): void {
            $valid = $valid && is_string($value);
        });
        if (!$valid) {
            return $this->unavailable();
        }
        if (!$values) {
            return $data;
        }
        // Native ACF save handlers see slashed form input, including JSON inside fields such as Google Map.
        $values = wp_slash($values);
        if (!acf_allow_unfiltered_html()) {
            $values = wp_kses_post_deep($values);
        }

        try {
            return array_replace($data, $this->capture($id, $values));
        } catch (\TypeError | \ValueError) {
            return $this->unavailable();
        }
    }

    private function capture(string $savedId, array $values): array
    {
        global $wp_filter;
        // ACF's block ID has no persistent term/post backing, even if an unsupported handler is encountered.
        $id = 'block_mtflpp-' . wp_generate_uuid4();
        $overlay = [];
        $assignments = [];
        $path = trailingslashit(realpath(acf_get_path()) ?: acf_get_path());
        $handlers = [];
        $handler = static function (array $field) use (&$handlers, $path) {
            $type = $field['type'];
            if (!array_key_exists($type, $handlers)) {
                $instance = acf_get_field_type($type);
                $file = $instance ? (new ReflectionClass($instance))->getFileName() : false;
                $handlers[$type] = $file && str_starts_with($file, $path) ? $instance : null;
            }
            return $handlers[$type];
        };

        // Only call ACF's own value transformers. Do not dispatch site save/update/delete callbacks.
        $mutationHooks = [
            'acf/pre_update_value', 'acf/delete_value', 'acf/pre_update_metadata', 'acf/pre_delete_metadata',
        ];
        $hooks = array_intersect_key($wp_filter, array_flip($mutationHooks));
        foreach ($mutationHooks as $hook) {
            unset($wp_filter[$hook]);
        }
        $read = static function ($value, $target, $name, $hidden) use ($id, $savedId, &$overlay) {
            if ($target !== $id) {
                return $value;
            }
            [$key, $present] = self::metaKey($overlay, $name, $hidden);
            return ($present ? $overlay[$key] : acf_get_metadata($savedId, $name, $hidden)) ?? '__return_null';
        };
        add_filter('acf/pre_load_metadata', $read, PHP_INT_MAX, 4);
        $hasVeto = Acf::supportsChoiceSaveVeto();
        $allowAppend = static fn ($allowed, $field, $target) => $target === $id ? false : $allowed;
        if ($hasVeto) {
            add_filter('acf/fields/allow_append_choices', $allowAppend, PHP_INT_MAX, 3);
        }
        $write = static function ($check, $target, $name, $value, $hidden) use ($id, &$overlay) {
            if ($target !== $id) {
                return $check;
            }
            $overlay[($hidden ? '_' : '') . $name] = self::storedValue($value);
            return true;
        };
        add_filter('acf/pre_update_metadata', $write, 10, 5);
        add_filter('acf/pre_delete_metadata', static function ($check, $target, $name, $hidden) use ($id, &$overlay) {
            if ($target !== $id) {
                return $check;
            }
            $overlay[($hidden ? '_' : '') . $name] = null;
            return true;
        }, 10, 4);
        add_action('acf/delete_value', static function ($target, $name, $field) use ($id, $handler): void {
            if ($target === $id && is_callable([$native = $handler($field), 'delete_value'])) {
                $native->delete_value($target, $name, $field);
            }
        }, 10, 3);
        $update = function ($check, $value, $target, $field) use ($id, $handler, &$overlay, &$assignments, $hasVeto) {
            if ($target !== $id) {
                return $check;
            }
            $native = $handler($field);
            if (!$native || $field['name'] === '') {
                return false;
            }
            if (is_callable([$native, 'update_value'])) {
                // Collect Save Terms the way ACF combines fields, without assigning terms to any object.
                if ($field['type'] === 'taxonomy' && !empty($field['save_terms'])) {
                    $taxonomy = $field['taxonomy'];
                    $ids = array_filter(
                        array_map('intval', acf_get_array($value)),
                        static fn (int $id) => $id > 0
                    );
                    $assignments[$taxonomy] = array_merge($assignments[$taxonomy] ?? [], $ids);
                }
                // Use a field copy so native Save keeps these settings. Preview must not affect other objects.
                $field['bidirectional'] = $field['save_terms'] = 0;
                if (!$hasVeto) {
                    $field['save_other_choice'] = $field['save_custom'] = $field['save_options'] = 0;
                }
                $value = $this->normalize($native, $value, $target, $field);
            }
            if ($value === null) {
                return acf_delete_value($target, $field);
            }
            $overlay[$field['name']] = self::storedValue($value);
            $overlay['_' . $field['name']] = $field['key'];
            acf_flush_value_cache($target, $field['name']);
            return true;
        };
        add_filter('acf/pre_update_value', $update, 10, 4);
        try {
            acf_update_values($values, $id);
        } finally {
            remove_filter('acf/pre_load_metadata', $read, PHP_INT_MAX);
            if ($hasVeto) {
                remove_filter('acf/fields/allow_append_choices', $allowAppend, PHP_INT_MAX);
            }
            foreach ($mutationHooks as $hook) {
                unset($wp_filter[$hook]);
            }
            $wp_filter += $hooks;
            $this->clearValues(static fn ($target): bool => $target === $id);
        }
        return ['acf' => $overlay, 'acfTerms' => $assignments];
    }

    private static function storedValue($value)
    {
        // Mirror WordPress metadata storage: unslash once, then read scalar values as strings.
        // Arrays retain their element types through metadata serialization.
        $value = wp_unslash($value);
        return is_scalar($value) ? (string) $value : $value;
    }

    private function normalize(object $native, $value, string $id, array $field)
    {
        if ($field['type'] !== 'repeater' || empty($field['pagination']) || did_action('acf/save_post')) {
            return $native->update_value($value, $id, $field);
        }
        // ACF's repeater only treats submitted rows as a delta during a save. Select that branch
        // without dispatching the save action or pretending WordPress is saving the actual term.
        global $wp_actions;
        $previous = $wp_actions['acf/save_post'] ?? null;
        $wp_actions['acf/save_post'] = 1;
        try {
            return $native->update_value($value, $id, $field);
        } finally {
            if ($previous === null) {
                unset($wp_actions['acf/save_post']);
            } else {
                $wp_actions['acf/save_post'] = $previous;
            }
        }
    }

    public function bind(array $context): void
    {
        $overlay = $context['data']['acf'] ?? [];
        if (!$overlay || !function_exists('acf_decode_post_id')) {
            return;
        }
        $termId = $context['saved']->term_id;
        $site = get_current_blog_id();
        $matches = static function ($target) use ($termId, $site): bool {
            if (get_current_blog_id() !== $site) {
                return false;
            }
            $decoded = acf_decode_post_id($target);
            return $decoded['type'] === 'term' && (int) $decoded['id'] === $termId;
        };
        $savedMeta = acf_get_meta('term_' . $termId) ?: [];
        $this->clearValues($matches);
        add_filter('acf/pre_load_metadata', static function ($value, $target, $name, $hidden) use ($matches, $overlay) {
            if ($matches($target)) {
                [$key, $present] = self::metaKey($overlay, $name, $hidden);
                if ($present) {
                    return $overlay[$key] ?? '__return_null';
                }
            }
            return $value;
        }, PHP_INT_MAX, 4);
        add_filter('acf/pre_load_meta', static function ($value, $target) use ($matches, $overlay, $savedMeta) {
            return $matches($target) ? array_filter(
                array_replace(is_array($value) ? $value : $savedMeta, $overlay),
                static fn ($item): bool => $item !== null
            ) : $value;
        }, PHP_INT_MAX, 2);
        $assignments = $context['data']['acfTerms'] ?? [];
        if ($assignments) {
            $loadSelection = static function ($value, $target, $field) use ($matches, $assignments) {
                if ($field['type'] !== 'taxonomy' || empty($field['load_terms']) || !$matches($target)) {
                    return $value;
                }
                $selection = $assignments[$field['taxonomy']] ?? null;
                return $selection === null ? $value : Acf::loadTermSelection(
                    $selection,
                    acf_get_metadata($target, $field['name']),
                    $field
                );
            };
            add_filter('acf/pre_load_value', $loadSelection, PHP_INT_MAX, 3);
        }
    }

    private static function metaKey(array $overlay, string $name, bool $hidden): array
    {
        $key = ($hidden ? '_' : '') . $name;
        return [$key, array_key_exists($key, $overlay)];
    }

    private function clearValues(callable $matches): void
    {
        $store = acf_get_store('values');
        $matched = [];
        foreach (array_keys($store->get_data()) as $key) {
            $id = strstr($key, ':', true);
            if ($id !== false && ($matched[$id] ??= $matches($id))) {
                $store->remove($key);
            }
        }
    }
}
