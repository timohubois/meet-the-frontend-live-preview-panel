<?php

namespace AFloatingLivePreviewPanel;

/** Enhance the native document only after a preview owner authorizes and matches the request. */
final class PreviewDocument
{
    public function __construct(
        private readonly string $file,
        private readonly string $previewToken
    ) {
    }

    public static function disableCaching(): void
    {
        if (!defined('DONOTCACHEPAGE')) {
            // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- Shared cache flag.
            define('DONOTCACHEPAGE', true);
        }
        nocache_headers();
    }

    public function enhance(bool $isolated, bool $sourceRequested): void
    {
        // Match isolated Gutenberg screens without disabling core's client-side media processing.
        // Older WordPress versions can also be isolated by the Gutenberg plugin.
        if ($isolated) {
            // Preserve site-supplied policies instead of replacing their resource-loading rules.
            $alreadyIsolated = function_exists('wp_is_cross_origin_isolated_request')
                ? wp_is_cross_origin_isolated_request()
                : (bool) preg_grep('/^Document-Isolation-Policy:/i', headers_list());
            if (!$alreadyIsolated) {
                if (function_exists('wp_send_document_isolation_policy_header')) {
                    wp_send_document_isolation_policy_header();
                } else {
                    header('Document-Isolation-Policy: isolate-and-credentialless');
                }
            }
        }
        // Capture only opted-in iframe requests, never ordinary frontend or new-tab previews.
        if ($sourceRequested) {
            add_filter('wp_template_enhancement_output_buffer', [$this, 'captureSource'], PHP_INT_MAX);
        }
        add_filter('show_admin_bar', '__return_false', PHP_INT_MAX);
        add_action('wp_head', function (): void {
            echo '<meta name="a-floating-live-preview-panel" content="' . esc_attr($this->previewToken) . '">';
        });
        add_action('wp_enqueue_scripts', function (): void {
            $asset = require dirname($this->file) . '/build/preview-navigation.asset.php';
            wp_enqueue_script(
                'a-floating-live-preview-panel-navigation',
                plugins_url('build/preview-navigation.js', $this->file),
                $asset['dependencies'],
                $asset['version'],
                false
            );
        });
    }

    /** Carry pre-JavaScript HTML in the existing marker, with no second render or executable injection. */
    public function captureSource(string $output): string
    {
        $status = http_response_code();
        if (
            ($status && ($status < 200 || $status >= 300))
            || preg_match('//u', $output) !== 1
        ) {
            return $output;
        }
        $mediaType = ini_get('default_mimetype');
        foreach (headers_list() as $header) {
            [$name, $value] = array_pad(explode(':', $header, 2), 2, '');
            $name = strtolower(trim($name));
            if ($name === 'content-type') {
                $mediaType = strtolower(trim(explode(';', $value, 2)[0]));
            }
            // Preserve explicit response contracts and already-encoded/native downloads byte for byte.
            if (in_array($name, ['content-length', 'content-encoding', 'content-disposition'], true)) {
                return $output;
            }
        }
        if ($mediaType !== 'text/html') {
            return $output;
        }
        try {
            $processor = new \WP_HTML_Tag_Processor($output);
            $found = false;
            $index = 0;
            while ($processor->next_tag()) {
                $tag = $processor->get_tag();
                if (
                    $tag === 'META' && $processor->get_attribute('name') === 'a-floating-live-preview-panel'
                    && $processor->get_attribute('content') === $this->previewToken
                ) {
                    if ($found || $processor->get_attribute('data-aflpp-source') !== null) {
                        return $output;
                    }
                    $found = $processor->set_bookmark('aflpp-source');
                }
                if (!in_array($tag, ['BASE', 'HEAD', 'LINK', 'META', 'SCRIPT', 'STYLE', 'TITLE'], true)) {
                    // Response-local identities bridge the clean source to elements moved/wrapped by scripts.
                    $processor->set_attribute('data-aflpp-node', (string) ++$index);
                }
            }
            if (!$found || $processor->paused_at_incomplete_token()) {
                return $output;
            }
            $source = wp_json_encode(
                $processor->get_updated_html(),
                JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
            );
            if (!is_string($source) || !$processor->seek('aflpp-source')) {
                return $output;
            }
            // Hex-escaped entities/quotes survive the HTML API's non-double-encoding attribute escape.
            // The payload is inert data, including source text containing </script> or existing entities.
            $processor->set_attribute('data-aflpp-source', $source);
            return $processor->get_updated_html();
        } catch (\Throwable) {
            // Optional navigation assistance must never prevent the actual preview from rendering.
            return $output;
        }
    }
}
