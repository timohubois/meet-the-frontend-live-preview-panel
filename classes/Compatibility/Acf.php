<?php

namespace MeetTheFrontendLivePreviewPanel\Compatibility;

use MeetTheFrontendLivePreviewPanel\LivePreview;
use Closure;
use WP_Error;
use WP_Hook;

/** Keep ACF's field, save and preview contracts outside the preview coordinator. */
final class Acf
{
    private const TERMS_META = '_mtflpp_acf_preview_term_assignments';

    private bool $saving = false;
    private int $savedId = 0;
    private int $writeId = 0;
    private array $restoreSaveHooks = [];
    private ?Closure $restoreFormPostId = null;
    private array $pendingTerms = [];
    private array $savedTerms = [];
    private int $previewPostId = 0;
    private int $sourceId = 0;
    private bool $readOnly = false;
    private ?Closure $restoreTaxonomyLoad = null;

    public function configureEditor(array &$config, array &$dependencies): void
    {
        if (!$this->isAvailable()) {
            return;
        }
        if (wp_script_is('acf-input', 'registered')) {
            $dependencies[] = 'acf-input';
        }
        $config['acfEnabled'] = true;
        $config['strings']['acfRefreshing'] = __(
            'Waiting for ACF to reload repeating fields. If the fields don’t finish loading, reload the editor.',
            'meet-the-frontend-live-preview-panel'
        );
        $config['strings']['nativePreviewAcf'] = __(
            'WordPress Preview saved repeating field changes, but the rows in this editor are still out of date.',
            'meet-the-frontend-live-preview-panel'
        );
        $config['strings']['nativePreviewAcfReload'] = __(
            'Copy any unsaved changes you want to keep, then reload the editor before saving again.',
            'meet-the-frontend-live-preview-panel'
        );
        $config['strings']['acfUnavailable'] = __(
            'The preview can’t read your custom fields.',
            'meet-the-frontend-live-preview-panel'
        );
    }

    public function isAvailable(): bool
    {
        return function_exists('acf');
    }

    /** Saved inputs to ACF's position-based paginated merges, including nested storage paths. */
    public static function paginatedRowState(array $meta): array
    {
        if (!function_exists('acf_get_field_type') || !acf_get_field_type('repeater')) {
            return [];
        }
        $repeaters = [];
        // ACF saves _<storage path> => field key, even when a repeater sits inside another field.
        foreach ($meta as $key => $values) {
            $reference = $values[0] ?? null;
            if (
                !str_starts_with((string) $key, '_') || !is_string($reference) || !str_starts_with($reference, 'field_')
            ) {
                continue;
            }
            $field = acf_get_field($reference);
            if (($field['type'] ?? '') === 'repeater' && !empty($field['pagination']) && !empty($field['sub_fields'])) {
                $repeaters[substr($key, 1)] = true;
            }
        }
        if (!$repeaters) {
            return [];
        }
        $rows = [];
        foreach ($meta as $key => $values) {
            $name = str_starts_with((string) $key, '_') ? substr($key, 1) : (string) $key;
            if (isset($repeaters[$name])) {
                $rows[$key] = $values;
                continue;
            }
            // Match only indexed descendants of a paginated field, not every ACF value on the post.
            preg_match_all('/_[0-9]+(?=_)/', $name, $indices, PREG_OFFSET_CAPTURE);
            foreach ($indices[0] as [, $offset]) {
                if (isset($repeaters[substr($name, 0, $offset)])) {
                    $rows[$key] = $values;
                    break;
                }
            }
        }
        ksort($rows);
        return $rows;
    }

    public static function supportsChoiceSaveVeto(): bool
    {
        return function_exists('acf_get_setting')
            && version_compare((string) acf_get_setting('version'), '6.8.11', '>=');
    }

    /** Extend an authorized, unslashed REST payload using ACF's normal form context. */
    public function preparePayload(array $payload, array $input): array|WP_Error
    {
        $this->saving = array_key_exists('acf', $input);
        if (!$this->saving) {
            return $payload;
        }
        if (
            !$this->isAvailable() || !is_array($input['acf']) || !function_exists('acf_save_post')
            || !isset($input['_acf_nonce']) || !is_string($input['_acf_nonce'])
            || !wp_verify_nonce($input['_acf_nonce'], 'post')
            || (isset($input['_acf_fields']) && !is_array($input['_acf_fields']))
        ) {
            return new WP_Error(
                'mtflpp_acf_unavailable',
                __('The preview can’t read your custom fields.', 'meet-the-frontend-live-preview-panel'),
                ['status' => 400]
            );
        }
        // Preserve row keys and status markers so ACF merges paginated edits with the seeded saved rows.
        $payload['acf'] = $input['acf'];
        $payload['_acf_nonce'] = $input['_acf_nonce'];
        $payload['_acf_changed'] = '1'; // Preserve ACF's classic-preview save context.
        if (isset($input['_acf_fields'])) {
            $payload['_acf_fields'] = $input['_acf_fields'];
        }
        return $payload;
    }

    /** Scope guards to the owned source, including native post-meta block saves without form fields. */
    public function beginRevisionWrite(int $revisionId): void
    {
        if (!$this->isAvailable()) {
            return;
        }
        $this->writeId = $revisionId;
        $this->clearRevisionCache($this->writeId);
        add_filter('acf/connect_attachment_to_post', [$this, 'allowAttachmentParent'], PHP_INT_MAX, 3);
        add_action('acf/save_post', [$this, 'recordSave'], PHP_INT_MAX);

        // acf_save_post() sets a request-local form ID without restoring a caller's native save context.
        $form = function_exists('acf_get_store') ? acf_get_store('form') : null;
        if ($form) {
            $formPostId = $form->get('post_id');
            $this->restoreFormPostId = static function () use ($form, $formPostId): void {
                if ($formPostId === null) {
                    $form->remove('post_id');
                } else {
                    $form->set('post_id', $formPostId);
                }
            };
        }

        $types = ['taxonomy'];
        if (function_exists('acf_can_update_bidirectional_target')) {
            add_filter('acf/bidirectional/can_update_target', [$this, 'allowBidirectionalTarget'], PHP_INT_MAX, 3);
        } else {
            // Older ACF has no origin-aware veto. Give native field handlers a local field copy
            // instead of changing a setting that other writes in the same save use.
            $types = ['taxonomy', 'relationship', 'post_object', 'user'];
        }
        if (self::supportsChoiceSaveVeto()) {
            add_filter('acf/fields/allow_append_choices', [$this, 'allowChoiceAppend'], PHP_INT_MAX, 3);
        } else {
            $types = array_merge($types, ['select', 'checkbox', 'radio']);
        }
        foreach ($types as $type) {
            $restore = $this->wrapFieldCallback(
                "acf/update_value/type=$type",
                $type,
                'update_value',
                $this->updateField(...)
            );
            if ($restore) {
                $this->restoreSaveHooks[] = $restore;
            }
        }
        $restore = $this->wrapFieldCallback(
            'acf/save_post',
            'taxonomy',
            'save_post',
            function (callable $native, $postId): void {
                // A native caller may already have queued terms. Don't drain or clear its queue here.
                if (!$this->isWriteTarget($postId)) {
                    $native($postId);
                }
            }
        );
        if ($restore) {
            $this->restoreSaveHooks[] = $restore;
        }
    }

    /** ACF exposes no veto at these callbacks. Replace only the callable in its original hook slot. */
    private function wrapFieldCallback(string $hook, string $type, string $method, Closure $wrap): ?Closure
    {
        global $wp_filter;
        $field = function_exists('acf_get_field_type') ? acf_get_field_type($type) : null;
        $native = [$field, $method];
        $filter = $wp_filter[$hook] ?? null;
        if (!$field || !$filter instanceof WP_Hook) {
            return null;
        }
        // A callable can appear at several priorities. Keep every existing slot and its relative order.
        $slots = [];
        $wrapped = static fn (...$args) => $wrap($native, ...$args);
        foreach ($filter->callbacks as $priority => $callbacks) {
            foreach ($callbacks as $id => $callback) {
                if ($callback['function'] === $native) {
                    $filter->callbacks[$priority][$id]['function'] = $wrapped;
                    $slots[] = [$priority, $id];
                }
            }
        }
        if (!$slots) {
            return null;
        }
        return static function () use ($filter, $slots, $native, $wrapped): void {
            foreach ($slots as [$priority, $id]) {
                if (($filter->callbacks[$priority][$id]['function'] ?? null) === $wrapped) {
                    $filter->callbacks[$priority][$id]['function'] = $native;
                }
            }
        };
    }

    public function allowBidirectionalTarget($allowed, $targetId, $postId)
    {
        return $this->isWriteTarget($postId) ? false : $allowed;
    }

    public function allowAttachmentParent($allowed, $attachmentId, $postId)
    {
        return $this->isWriteTarget($postId) ? false : $allowed;
    }

    public function allowChoiceAppend($allowed, $field, $postId)
    {
        return $this->isWriteTarget($postId) ? false : $allowed;
    }

    private function isWriteTarget($postId): bool
    {
        return $this->writeId && $this->decodedPostId($postId) === $this->writeId;
    }

    private function decodedPostId($acfId): int
    {
        $target = function_exists('acf_decode_post_id') ? acf_decode_post_id($acfId) : [];
        return ($target['type'] ?? '') === 'post' ? (int) $target['id'] : 0;
    }

    private function updateField(callable $native, $value, $postId, array $field)
    {
        if ($this->isWriteTarget($postId)) {
            $field['bidirectional'] = 0;
            if (!self::supportsChoiceSaveVeto()) {
                $field['save_options'] = $field['save_custom'] = $field['save_other_choice'] = 0;
            }
            if ($field['type'] === 'taxonomy' && !empty($field['save_terms'])) {
                // Match ACF's per-save combination without enqueueing real term assignments.
                $taxonomy = $field['taxonomy'];
                $this->pendingTerms[$taxonomy] = array_merge(
                    $this->pendingTerms[$taxonomy] ?? [],
                    array_filter(array_map('intval', acf_get_array($value)), static fn (int $id) => $id > 0)
                );
                $field['save_terms'] = 0;
            }
        }
        return $native($value, $postId, $field);
    }

    /** Metadata seeding must also invalidate this revision's request-local ACF value cache. */
    public function clearRevisionCache(int $revisionId): void
    {
        if ($revisionId < 1 || !function_exists('acf_get_store')) {
            return;
        }
        $store = acf_get_store('values');
        if (!$store) {
            return;
        }
        // ACF's flush helper targets one named field, not a source (including absent/default values).
        // Keep invalidation source-scoped rather than resetting unrelated objects' cached values.
        $ids = [];
        foreach (array_keys($store->get_data()) as $key) {
            $acfId = strstr($key, ':', true);
            if ($acfId !== false && ($ids[$acfId] ??= $this->decodedPostId($acfId)) === $revisionId) {
                $store->remove($key);
            }
        }
    }

    public function recordSave($postId): void
    {
        if ($this->isWriteTarget($postId)) {
            $this->savedId = $this->writeId;
            $this->savedTerms = array_replace($this->savedTerms, $this->pendingTerms);
            $this->pendingTerms = [];
        }
    }

    public function resetSave(): void
    {
        if ($this->writeId) {
            remove_filter('acf/bidirectional/can_update_target', [$this, 'allowBidirectionalTarget'], PHP_INT_MAX);
            remove_filter('acf/connect_attachment_to_post', [$this, 'allowAttachmentParent'], PHP_INT_MAX);
            remove_filter('acf/fields/allow_append_choices', [$this, 'allowChoiceAppend'], PHP_INT_MAX);
            remove_action('acf/save_post', [$this, 'recordSave'], PHP_INT_MAX);
        }
        foreach (array_reverse($this->restoreSaveHooks) as $restore) {
            $restore();
        }
        $this->restoreSaveHooks = [];
        if ($this->restoreFormPostId) {
            ($this->restoreFormPostId)();
            $this->restoreFormPostId = null;
        }
        $this->saving = false;
        $this->savedId = 0;
        $this->writeId = 0;
        $this->pendingTerms = [];
        $this->savedTerms = [];
    }

    /** The coordinator still owns and verifies the exact preview revision. */
    public function verifySave(int $revisionId): ?WP_Error
    {
        $saved = !$this->saving || $revisionId === $this->savedId;
        if ($saved && $revisionId === $this->writeId && $this->savedTerms) {
            update_metadata('post', $revisionId, self::TERMS_META, $this->savedTerms);
            $saved = get_metadata('post', $revisionId, self::TERMS_META, true) === $this->savedTerms;
        }
        return $saved ? null : new WP_Error(
            'mtflpp_acf_not_saved',
            __('We couldn’t add your field changes to the preview.', 'meet-the-frontend-live-preview-panel'),
            ['status' => 409]
        );
    }

    /** Bind only an authorized source; saved history must also reject redirected ACF writes. */
    public function bindPreview(int $postId, int $sourceId, bool $readOnly = false): void
    {
        $this->unbindPreview();
        // Check at use time: optional plugins may load after our bootstrap.
        if (
            !$this->isAvailable() || !function_exists('acf_decode_post_id') || !function_exists('acf_get_metadata')
            || $postId < 1 || $sourceId < 1
        ) {
            return;
        }
        $this->previewPostId = $postId;
        $this->sourceId = $sourceId;
        $this->readOnly = $readOnly;
        add_filter('acf/validate_post_id', [$this, 'readPostId'], PHP_INT_MAX, 2);
        // ACF post-meta blocks use the lower-level value APIs without validating a post ID first.
        add_filter('acf/pre_load_metadata', [$this, 'readMetadata'], PHP_INT_MAX, 4);
        $this->clearRevisionCache($postId);
        if ($sourceId !== $postId) {
            $this->clearRevisionCache($sourceId);
        }
        if ($readOnly) {
            add_filter('acf/pre_update_metadata', [$this, 'preventSourceWrite'], PHP_INT_MAX, 2);
            add_filter('acf/pre_delete_metadata', [$this, 'preventSourceWrite'], PHP_INT_MAX, 2);
        } else {
            $this->restoreTaxonomyLoad = $this->wrapFieldCallback(
                'acf/load_value/type=taxonomy',
                'taxonomy',
                'load_value',
                $this->loadTaxonomy(...)
            );
        }
        add_action('shutdown', [$this, 'unbindPreview'], PHP_INT_MAX);
    }

    /** Keep read overlays through rendering, then remove only this adapter's hooks and cached values. */
    public function unbindPreview(): void
    {
        remove_filter('acf/validate_post_id', [$this, 'readPostId'], PHP_INT_MAX);
        remove_filter('acf/pre_load_metadata', [$this, 'readMetadata'], PHP_INT_MAX);
        remove_filter('acf/pre_update_metadata', [$this, 'preventSourceWrite'], PHP_INT_MAX);
        remove_filter('acf/pre_delete_metadata', [$this, 'preventSourceWrite'], PHP_INT_MAX);
        if ($this->restoreTaxonomyLoad) {
            ($this->restoreTaxonomyLoad)();
            $this->restoreTaxonomyLoad = null;
        }
        remove_action('shutdown', [$this, 'unbindPreview'], PHP_INT_MAX);
        foreach (array_unique([$this->previewPostId, $this->sourceId]) as $postId) {
            if ($postId) {
                $this->clearRevisionCache($postId);
            }
        }
        $this->previewPostId = 0;
        $this->sourceId = 0;
        $this->readOnly = false;
    }

    /** Supply Load Terms at the ACF boundary, before the encoded object type is lost. */
    private function loadTaxonomy(callable $native, $value, $postId, array $field)
    {
        $id = $this->decodedPostId($postId);
        if (!$id || ($id !== $this->sourceId && $id !== $this->previewPostId) || empty($field['load_terms'])) {
            return $native($value, $postId, $field);
        }
        $taxonomy = $field['taxonomy'];
        $acfTerms = get_metadata('post', $this->sourceId, self::TERMS_META, true);
        $coreTerms = get_metadata('post', $this->sourceId, LivePreview::TERMS_META, true);
        $selection = $acfTerms[$taxonomy] ?? $coreTerms[$taxonomy] ?? null;
        if (!is_array($selection)) {
            // Native Load Terms reads the saved assignments, ordering by the preview field's value.
            return $native($value, $this->previewPostId, $field);
        }
        return self::loadTermSelection($selection, $value, $field);
    }

    /** Read a simulated Save Terms selection with ACF's native Load Terms ordering and field shape. */
    public static function loadTermSelection(array $selection, $value, array $field)
    {
        $taxonomy = $field['taxonomy'];
        $ids = $selection ? get_terms([
            'taxonomy' => $taxonomy, 'include' => $selection, 'fields' => 'ids',
            'hide_empty' => false, 'orderby' => 'none',
        ]) : [];
        if (!$ids || is_wp_error($ids)) {
            return false;
        }
        // Match native Load Terms ordering by the stored field value, including combined selections.
        $stored = acf_get_valid_terms($value, $taxonomy);
        if ($stored) {
            $order = array_map(static fn ($id) => array_search($id, $stored), $ids);
            array_multisort($order, $ids);
        }
        return in_array($field['field_type'], ['select', 'radio'], true) ? reset($ids) : $ids;
    }

    /** Cover values, field references and repeater children without affecting other ACF objects. */
    public function preventSourceWrite($check, $postId)
    {
        if (!$this->readOnly || !$this->sourceId || !function_exists('acf_decode_post_id')) {
            return $check;
        }
        $target = acf_decode_post_id($postId);
        return $target['type'] === 'post' && (int) $target['id'] === $this->sourceId ? false : $check;
    }

    public function readMetadata($value, $postId, string $name, bool $hidden)
    {
        if (
            $value !== null || !$this->previewPostId || !$this->sourceId
            || !function_exists('acf_decode_post_id') || !function_exists('acf_get_metadata')
        ) {
            return $value;
        }
        $target = acf_decode_post_id($postId);
        if (
            $target['type'] !== 'post' || (int) $target['id'] !== $this->previewPostId
            || $this->sourceId === $this->previewPostId
        ) {
            return $value;
        }
        // ACF's null sentinel prevents a missing source field from falling back to saved parent data.
        return acf_get_metadata($this->sourceId, $name, $hidden) ?? '__return_null';
    }

    public function readPostId($postId, $original)
    {
        if (!$this->previewPostId || !$this->sourceId) {
            return $postId;
        }
        if (is_object($original)) {
            // Match ACF's post-object distinction; users, terms and comments keep their own IDs.
            if (!isset($original->post_type, $original->ID)) {
                return $postId;
            }
            $original = $original->ID;
        }
        if (
            $this->decodedPostId($original) === $this->previewPostId
            || (!$original && is_numeric($postId) && get_the_ID() === $this->previewPostId)
        ) {
            return $this->sourceId;
        }
        return $postId;
    }
}
