<?php

/** Run with `wp eval-file tests/preview-source.php`; no database fixtures are created. */

namespace MeetTheFrontendLivePreviewPanel;

use ReflectionClass;
use ReflectionProperty;
use RuntimeException;
use WP_CLI;
use WP_HTML_Tag_Processor;
use WP_Post;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(FrontendPreview::class)) {
    throw new RuntimeException('Run through WP-CLI with Meet the Frontend – Live Preview Panel active.');
}

// Exercise native registration and HTTP response guards without sending CLI headers.
final class PreviewSourceFixture
{
    public static bool $target = true;
    public static int $status = 200;
    public static array $headers = ['Content-Type: text/html; charset=UTF-8'];
}

function headers_list(): array
{
    return PreviewSourceFixture::$headers;
}

function http_response_code(): int
{
    return PreviewSourceFixture::$status;
}

function is_preview(): bool
{
    return PreviewSourceFixture::$target;
}

function is_singular(): bool
{
    return true;
}

function get_queried_object_id(): int
{
    return 123;
}

$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$file = dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php';
$makeDocument = static fn (): PreviewDocument => new PreviewDocument($file, 'source-token');
$makePreview = static function (bool $requested) use ($file): FrontendPreview {
    $preview = (new ReflectionClass(FrontendPreview::class))->newInstanceWithoutConstructor();
    $properties = [
        'file' => $file,
        'previewPostId' => 123,
        'previewToken' => 'source-token',
        'sourceRequested' => $requested,
        'source' => new WP_Post((object) ['ID' => 123]),
    ];
    foreach ($properties as $name => $value) {
        (new ReflectionProperty(FrontendPreview::class, $name))->setValue($preview, $value);
    }
    return $preview;
};
$html = '<!doctype html><html lang="en"><head>'
    . '<meta name="meet-the-frontend-live-preview-panel" content="source-token">'
    . '<script>window.previewInitialization = "native";</script></head><body><main>'
    . '<h1>Quotes &quot; &amp; Unicode: Grüße 日本語</h1>'
    . '<p>&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;</p>'
    . '<section><p>Server-rendered content</p></section></main></body></html>';
$readSource = static function (string $output): ?string {
    $processor = new WP_HTML_Tag_Processor($output);
    while ($processor->next_tag('META')) {
        if ($processor->get_attribute('name') === 'meet-the-frontend-live-preview-panel') {
            $payload = $processor->get_attribute('data-mtflpp-source');
            return is_string($payload) ? json_decode($payload, true, 512, JSON_THROW_ON_ERROR) : null;
        }
    }
    return null;
};
$hooks = [
    'template_include', 'wp_template_enhancement_output_buffer', 'show_admin_bar', 'wp_head', 'wp_enqueue_scripts',
    'shutdown',
];
$originalHooks = [];
foreach ($hooks as $hook) {
    $originalHooks[$hook] = isset($GLOBALS['wp_filter'][$hook]) ? clone $GLOBALS['wp_filter'][$hook] : null;
}

try {
    $preview = $makeDocument();
    $output = $preview->captureSource($html);
    $source = $readSource($output);
    $check(is_string($source), 'The actual HTML API buffer must expose a decodable source.');
    $check(str_starts_with($output, '<!doctype html>'), 'Do not prepend markup that would change document mode.');
    $check(!str_contains($source, 'data-mtflpp-source='), 'Do not recursively include the source payload.');
    $check(str_contains($source, 'Grüße 日本語'), 'Unicode source text must survive the attribute/JSON round trip.');
    $check(substr_count($output, '<script>') === 1, 'The payload must not inject executable script tags.');
    $check($preview->captureSource($output) === $output, 'Do not recursively process a captured response.');
    $processor = new WP_HTML_Tag_Processor($source);
    $ids = [];
    while ($processor->next_tag()) {
        $id = $processor->get_attribute('data-mtflpp-node');
        if ($id !== null) {
            $check(
                is_string($id) && ctype_digit($id) && !isset($ids[$id]),
                'Source identities must be unique response-local integers.'
            );
            $ids[$id] = true;
        }
    }
    $check(count($ids) === 7, 'Annotate content and document ancestors, not executable/head resources.');
    $processor = new WP_HTML_Tag_Processor($output);
    $liveIds = [];
    while ($processor->next_tag()) {
        $id = $processor->get_attribute('data-mtflpp-node');
        if ($id !== null) {
            $liveIds[$id] = true;
        }
    }
    $check($liveIds === $ids, 'The clean source and live response must carry identical element identities.');

    $longHtml = str_replace(
        '<section><p>Server-rendered content</p></section>',
        str_repeat('<section><h2>Section</h2><p>Repeated content</p></section>', 1500),
        $html
    );
    $check(
        is_string($readSource($makeDocument()->captureSource($longHtml))),
        'Long pages must retain the source bookmark.'
    );

    $largeHtml = str_replace('<body>', '<body><!--' . str_repeat(' ', 2 * 1024 * 1024) . '-->', $html);
    $check(
        is_string($readSource($makeDocument()->captureSource($largeHtml))),
        'Capture must not silently switch modes at an arbitrary HTML size.'
    );

    foreach ([301, 403, 500] as $status) {
        PreviewSourceFixture::$status = $status;
        $check($makeDocument()->captureSource($html) === $html, 'Do not rewrite redirects or error responses.');
    }
    PreviewSourceFixture::$status = 200;
    $headerCases = [
        ['Content-Type: application/pdf'], ['Content-Type: application/json'],
        ['Content-Type: application/xhtml+xml'], ['Content-Length: ' . strlen($html)],
        ['Content-Encoding: gzip'], ['Content-Disposition: attachment; filename="preview.html"'],
    ];
    foreach ($headerCases as $headers) {
        PreviewSourceFixture::$headers = $headers;
        $check($makeDocument()->captureSource($html) === $html, 'Preserve non-HTML and explicit response contracts.');
    }
    PreviewSourceFixture::$headers = ['Content-Type: text/html; charset=UTF-8'];
    $unavailableCases = [
        str_replace('source-token', 'wrong-token', $html),
        str_replace(
            '</head>',
            '<meta name="meet-the-frontend-live-preview-panel" content="source-token"></head>',
            $html
        ),
        str_replace('meet-the-frontend-live-preview-panel', 'unrelated-marker', $html),
        $html . '<script>incomplete',
        $html . "\xFF",
    ];
    foreach ($unavailableCases as $unavailable) {
        $check(
            $makeDocument()->captureSource($unavailable) === $unavailable,
            'Unverified, partial and invalid UTF-8 HTML must use the unmodified fallback.'
        );
    }

    // Exercise the required core buffer and respect its streaming opt-out.
    $check(\function_exists('wp_start_template_enhancement_output_buffer'), 'WordPress 6.9 or later is required.');
    $preview = $makeDocument();
    add_filter('wp_template_enhancement_output_buffer', [$preview, 'captureSource'], PHP_INT_MAX);
    ob_start();
    $check(wp_start_template_enhancement_output_buffer(), 'The real native buffer must start.');
    echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Trusted test response.
    ob_end_flush();
    $check(is_string($readSource(ob_get_clean())), 'The real native buffer must expose the source.');

    // Core owns buffer phases: cleaning must not publish a source.
    ob_start();
    $check(wp_start_template_enhancement_output_buffer(), 'The native cleanup fixture must start.');
    echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Trusted test response.
    ob_end_clean();
    $check(ob_get_clean() === '', 'Native buffer cleaning must discard output without capturing it.');

    add_filter('wp_should_output_buffer_template_for_enhancement', '__return_false', PHP_INT_MAX);
    try {
        $level = ob_get_level();
        $check(!wp_start_template_enhancement_output_buffer(), 'Respect the native streaming opt-out.');
        $check(ob_get_level() === $level, 'Do not start another buffer when native capture is disabled.');
    } finally {
        remove_filter('wp_should_output_buffer_template_for_enhancement', '__return_false', PHP_INT_MAX);
        remove_filter('wp_template_enhancement_output_buffer', [$preview, 'captureSource'], PHP_INT_MAX);
    }

    foreach ([false, true] as $requested) {
        foreach ([false, true] as $target) {
            PreviewSourceFixture::$target = $target;
            $preview = $makePreview($requested);
            $level = ob_get_level();
            $preview->checkPreviewTarget();
            $expected = $requested && $target;
            $check(
                (($GLOBALS['wp_filter']['wp_template_enhancement_output_buffer'] ?? null)
                    != $originalHooks['wp_template_enhancement_output_buffer']) === $expected,
                'Use native buffering only for opted-in target previews.'
            );
            $check(ob_get_level() === $level, 'Register the core filter without starting a custom buffer.');
            foreach (['template_include', 'shutdown'] as $hook) {
                $check(
                    ($GLOBALS['wp_filter'][$hook] ?? null) == $originalHooks[$hook],
                    'Leave template loading and shutdown hooks unchanged.'
                );
            }
            if ($expected) {
                $check(
                    is_string($readSource(apply_filters('wp_template_enhancement_output_buffer', $html, $html))),
                    'The native filter must accept its real one-argument callback registration.'
                );
            }
            if ($originalHooks['wp_template_enhancement_output_buffer'] === null) {
                unset($GLOBALS['wp_filter']['wp_template_enhancement_output_buffer']);
            } else {
                $GLOBALS['wp_filter']['wp_template_enhancement_output_buffer'] =
                    clone $originalHooks['wp_template_enhancement_output_buffer'];
            }
        }
    }
} finally {
    foreach ($originalHooks as $hook => $original) {
        if ($original === null) {
            unset($GLOBALS['wp_filter'][$hook]);
        } else {
            $GLOBALS['wp_filter'][$hook] = $original;
        }
    }
}
WP_CLI::success('Preview source capture preserves native rendering, inert data, identities and streaming opt-outs.');
