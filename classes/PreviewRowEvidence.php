<?php

namespace MeetTheFrontendLivePreviewPanel;

use WP_HTML_Processor;
use WP_HTML_Tag_Processor;

/** Correlate accepted row submissions with rendered roots in an authorized preview. */
final class PreviewRowEvidence
{
    private const ATTRIBUTE = 'data-mtflpp-evidence-row';
    private const ROW_DATA = '__mtflpp_row_evidence';

    private int $writing = 0;
    private array $fields = [];
    private array $rendered = [];

    public function configureEditor(array &$config): void
    {
        if ($this->renderFilter()) {
            $config['previewRowEvidence'] = true;
        }
    }

    private function renderFilter(): ?array
    {
        if (!function_exists('acf_get_field_type') || !acf_get_field_type('flexible_content')) {
            return null;
        }
        /**
         * Choose the theme or plugin's HTML filter for a single rendered row.
         *
         * @param array{name: string, rowArgument: int}|null $filter Hook name and one-based position of the row.
         */
        $filter = apply_filters('Mtflpp/previewRowRenderFilter', null);
        return is_array($filter) && is_string($filter['name'] ?? null) && trim($filter['name']) !== ''
            && is_int($filter['rowArgument'] ?? null) && $filter['rowArgument'] >= 2 ? $filter : null;
    }

    public function clearSaveEvidence(): void
    {
        $this->fields = [];
    }

    public function observeSave(int $sourceId, array $input): void
    {
        if (!empty($input['acf']) && ($input['mtflpp_row_markers'] ?? '') === '1' && $this->renderFilter()) {
            $this->writing = $sourceId;
            // Observe the actual rows and storage path just before ACF's native type update at priority 10.
            add_filter('acf/update_value/type=flexible_content', [$this, 'savedField'], 9, 3);
        }
    }

    public function stopObserving(): void
    {
        remove_filter('acf/update_value/type=flexible_content', [$this, 'savedField'], 9);
        $this->writing = 0;
    }

    public function savedField(mixed $value, mixed $postId, array $field): mixed
    {
        if ((string) $postId === (string) $this->writing && is_array($value) && $value) {
            try {
                $key = $field['key'];
                // The native field callback still receives the slashed form payload.
                $fingerprint = self::fingerprint(wp_unslash($value));
                $this->fields[$key][$fingerprint] = array_key_exists($fingerprint, $this->fields[$key] ?? [])
                    ? null : $field['name'];
            } catch (\Throwable) {
                // An unreadable hint must not affect ACF's native write.
            }
        }
        return $value;
    }

    public function rowMarkers(int $sourceId, array $input): array
    {
        if (!$this->fields || !is_array($input['acf'] ?? null)) {
            return [];
        }
        $result = [];
        try {
            $key = self::snapshotKey($sourceId);
            $matches = [];
            $this->submittedFields($input['acf'], 'acf', $matches);
            foreach ($matches as $match) {
                if (!$match) {
                    continue;
                }
                [$fieldKey, $path, $name, $rows] = $match;
                $markers = $this->orderedMarkers($sourceId, $key, $fieldKey, $path, $name, $rows);
                if ($markers) {
                    $result['acf-layout-order:' . $path] = $markers;
                }
            }
        } catch (\Throwable) {
            // Rendered row hints must never turn an accepted preview write into an error.
            return [];
        }
        return $result;
    }

    /** Match the full submitted path, including nested instances of a field key. */
    private function submittedFields(array $data, string $path, array &$matches): void
    {
        foreach ($data as $part => $value) {
            if (!is_array($value) || !preg_match('/^[\w-]+$/D', (string) $part)) {
                continue;
            }
            $child = $path . '[' . $part . ']';
            if (isset($this->fields[$part])) {
                $fingerprint = self::fingerprint($value);
                $name = $this->fields[$part][$fingerprint] ?? null;
                if ($name !== null) {
                    // Two identical submitted occurrences cannot identify one saved field.
                    $identity = $part . ':' . $fingerprint;
                    $matches[$identity] = array_key_exists($identity, $matches)
                        ? null : [$part, $child, $name, $value];
                }
            }
            $this->submittedFields($value, $child, $matches);
        }
    }

    private function orderedMarkers(
        int $sourceId,
        string $key,
        string $fieldKey,
        string $path,
        string $name,
        array $rows
    ): array {
        if (get_post_meta($sourceId, '_' . $name, true) !== $fieldKey) {
            return [];
        }
        unset($rows['acfcloneindex']); // ACF removes only its template row before assigning native indexes.
        $layouts = $disabled = $markers = [];
        foreach ($rows as $rowKey => $row) {
            $layout = $row['acf_fc_layout'] ?? null;
            if (!is_string($layout) || $layout === '' || !preg_match('/^[\w-]+$/D', (string) $rowKey)) {
                return [];
            }
            $index = count($layouts);
            $layouts[] = $layout;
            if (!empty($row['acf_fc_layout_disabled'])) {
                $disabled[] = $index;
            } else {
                $markers[$path . '[' . $rowKey . '][acf_fc_layout]'] = self::marker($key, $fieldKey, $name, $index);
            }
        }
        $layoutMeta = get_post_meta($sourceId, '_' . $name . '_layout_meta', true);
        return count($markers) >= 2 && $layouts === get_post_meta($sourceId, $name, true)
            && $disabled === ($layoutMeta['disabled'] ?? []) ? $markers : [];
    }

    public function markPreview(int $sourceId): void
    {
        if (!($filter = $this->renderFilter())) {
            return;
        }
        try {
            $key = self::snapshotKey($sourceId);
        } catch (\Throwable) {
            return;
        }
        $site = get_current_blog_id();
        $format = static function ($rows, $postId, $field) use ($key, $sourceId, $site) {
            if (!is_array($rows) || (string) $postId !== (string) $sourceId || get_current_blog_id() !== $site) {
                return $rows;
            }
            foreach ($rows as $index => $row) {
                if (is_int($index) && is_array($row) && !array_key_exists(self::ROW_DATA, $row)) {
                    $rows[$index][self::ROW_DATA] = self::marker($key, $field['key'], $field['name'], $index);
                }
            }
            return $rows;
        };
        add_filter('acf/format_value/type=flexible_content', $format, PHP_INT_MAX, 3);
        $argument = $filter['rowArgument'];
        $mark = function ($html, ...$args) use ($argument, $site) {
            return get_current_blog_id() === $site ? $this->markRow($html, $args[$argument - 2] ?? null) : $html;
        };
        add_filter($filter['name'], $mark, PHP_INT_MAX, $argument);
        add_filter('wp_template_enhancement_output_buffer', [$this, 'discardDuplicates'], PHP_INT_MAX - 1);
    }

    private function markRow(mixed $html, mixed $data): mixed
    {
        $marker = is_array($data) ? ($data[self::ROW_DATA] ?? null) : null;
        if (!is_string($html) || !is_string($marker) || !preg_match('/^[a-f0-9]{64}$/D', $marker)) {
            return $html;
        }
        $this->rendered[$marker] = ($this->rendered[$marker] ?? 0) + 1;
        $fragment = WP_HTML_Processor::create_fragment($html);
        $index = 0;
        while ($fragment && $fragment->next_tag()) {
            if (count($fragment->get_breadcrumbs()) === 3) {
                if (
                    $fragment->get_attribute(self::ATTRIBUTE) !== null
                    || !$fragment->set_attribute(self::ATTRIBUTE, $marker . ':' . $index++)
                ) {
                    return $html;
                }
            }
        }
        return $index && !$fragment->get_last_error() ? $fragment->get_updated_html() : $html;
    }

    public function discardDuplicates(string $html): string
    {
        $duplicates = array_filter($this->rendered, static fn (int $count): bool => $count > 1);
        if (!$duplicates) {
            return $html;
        }
        $tags = new WP_HTML_Tag_Processor($html);
        while ($tags->next_tag()) {
            $value = $tags->get_attribute(self::ATTRIBUTE);
            if (is_string($value) && isset($duplicates[strstr($value, ':', true)])) {
                $tags->remove_attribute(self::ATTRIBUTE);
            }
        }
        return $tags->get_updated_html();
    }

    private static function fingerprint(array $values): string
    {
        return hash('sha256', wp_json_encode($values, JSON_THROW_ON_ERROR));
    }

    private static function snapshotKey(int $sourceId): string
    {
        $meta = get_post_meta($sourceId);
        ksort($meta);
        // The revision ID and preview nonce can be reused. Bind to the actual saved snapshot, not the URL.
        return wp_hash(get_current_blog_id() . ':' . $sourceId . ':' . self::fingerprint($meta), 'nonce', 'sha256');
    }

    private static function marker(string $key, string $fieldKey, string $name, int $index): string
    {
        return hash_hmac('sha256', $fieldKey . ':' . $name . ':' . $index, $key);
    }
}
