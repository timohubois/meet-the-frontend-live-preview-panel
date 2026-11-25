<?php

/** Run with `wp eval-file tests/preview-isolation.php`; no database fixtures are created. */

namespace MeetTheFrontendLivePreviewPanel;

use ReflectionClass;
use ReflectionProperty;
use RuntimeException;
use WP_CLI;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(FrontendPreview::class)) {
    throw new RuntimeException('Run through WP-CLI with Meet the Frontend – Live Preview Panel active.');
}

// Namespaced HTTP/core doubles exercise both supported core versions without sending CLI headers.
final class IsolationHeadersFixture
{
    public static bool $coreApi = false;
    public static bool $coreIsolated = false;
    public static bool $target = true;
    public static array $headers = [];
    public static int $sent = 0;
}

function function_exists(string $name): bool
{
    if (in_array($name, ['wp_is_cross_origin_isolated_request', 'wp_send_document_isolation_policy_header'], true)) {
        return IsolationHeadersFixture::$coreApi;
    }
    return \function_exists($name);
}

function headers_list(): array
{
    return IsolationHeadersFixture::$headers;
}

function header(string $value): void
{
    IsolationHeadersFixture::$sent++;
    IsolationHeadersFixture::$headers[] = $value;
}

function wp_is_cross_origin_isolated_request(): bool
{
    return IsolationHeadersFixture::$coreIsolated
        || (bool) preg_grep('/^Document-Isolation-Policy:/i', headers_list());
}

function wp_send_document_isolation_policy_header(): bool
{
    header('Document-Isolation-Policy: isolate-and-credentialless');
    return true;
}

function is_preview(): bool
{
    return IsolationHeadersFixture::$target;
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
$preview = (new ReflectionClass(FrontendPreview::class))->newInstanceWithoutConstructor();
(new ReflectionProperty(FrontendPreview::class, 'file'))->setValue(
    $preview,
    dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php'
);
(new ReflectionProperty(FrontendPreview::class, 'previewPostId'))->setValue($preview, 123);
(new ReflectionProperty(FrontendPreview::class, 'previewSiteId'))->setValue($preview, get_current_blog_id());
$isolation = new ReflectionProperty(FrontendPreview::class, 'isolated');
$policy = 'Document-Isolation-Policy: isolate-and-credentialless';
$cases = [
    ['headers' => [], 'isolated' => false],
    ['headers' => ['Content-Type: text/html'], 'isolated' => false],
    ['headers' => ['Document-Isolation-Policy: isolate-and-require-corp'], 'isolated' => true],
    ['headers' => ['document-isolation-policy: isolate-and-credentialless'], 'isolated' => true],
    ['headers' => [], 'isolated' => false, 'coreIsolated' => true],
];
foreach ([false, true] as $coreApi) {
    IsolationHeadersFixture::$coreApi = $coreApi;
    foreach ([false, true] as $requested) {
        $isolation->setValue($preview, $requested);
        foreach ([false, true] as $target) {
            IsolationHeadersFixture::$target = $target;
            foreach ($cases as $case) {
                IsolationHeadersFixture::$headers = $case['headers'];
                IsolationHeadersFixture::$coreIsolated = $case['coreIsolated'] ?? false;
                IsolationHeadersFixture::$sent = 0;
                $alreadyIsolated = $case['isolated'] || ($coreApi && IsolationHeadersFixture::$coreIsolated);
                $send = $requested && $target && !$alreadyIsolated;
                $preview->checkPreviewTarget();
                $check(
                    IsolationHeadersFixture::$sent === (int) $send,
                    'Only opted-in target previews without existing isolation may send a policy.'
                );
                $expected = $send ? [...$case['headers'], $policy] : $case['headers'];
                $check(
                    IsolationHeadersFixture::$headers === $expected,
                    'Existing frontend policies and unrelated headers must remain unchanged.'
                );
            }
        }
    }
}
WP_CLI::success('Preview isolation preserves site policies with core APIs and the older-core fallback.');
