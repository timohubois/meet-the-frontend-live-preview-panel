<?php

/** Run with `wp eval-file tests/compatibility-dependencies.php`; no database fixtures are created. */

namespace MeetTheFrontendLivePreviewPanel\Compatibility;

use RuntimeException;
use WP_CLI;

if (!defined('WP_CLI') || !WP_CLI || !\class_exists(Acf::class) || !\class_exists(Timber::class)) {
    throw new RuntimeException('Run through WP-CLI with Meet the Frontend – Live Preview Panel active.');
}

// Hide optional APIs without deactivating real site plugins or changing their configuration.
final class CompatibilityDependenciesFixture
{
    public static array $missingFunctions = [];
    public static bool $missingTimber = false;
}

function function_exists(string $name): bool
{
    return !in_array($name, CompatibilityDependenciesFixture::$missingFunctions, true) && \function_exists($name);
}

function class_exists(string $name): bool
{
    return !($name === 'Timber\\Timber' && CompatibilityDependenciesFixture::$missingTimber)
        && \class_exists($name);
}

$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$acf = new Acf();
$timber = new Timber();
$yoast = new Yoast();
try {
    CompatibilityDependenciesFixture::$missingFunctions = [
        'acf', 'acf_save_post', 'acf_get_store', 'acf_decode_post_id', 'acf_get_metadata', 'YoastSEO',
    ];
    CompatibilityDependenciesFixture::$missingTimber = true;
    $acf->bindPreview(123, 456, true);
    $timber->bindPreview(123, 456);
    $yoast->bindPreview(123, 456);
    $check(!$yoast->isAvailable() && $yoast->primaryTaxonomies(123) === [], 'Absent Yoast exposes no controls.');
    $check(!$acf->isAvailable() && $acf->editorDependencies() === [], 'Absent ACF must not enqueue its assets.');
    $config = ['postId' => 123, 'strings' => [], 'vendor' => 'keep'];
    $context = ['post' => ['id' => 123], 'source' => null];
    foreach (['classic-editor', 'block-editor', 'revision-browser'] as $entry) {
        $hook = match ($entry) {
            'classic-editor' => 'mtflpp_classic_editor_preview_config',
            'block-editor' => 'mtflpp_block_editor_preview_config',
            'revision-browser' => 'mtflpp_revision_browser_preview_config',
        };
        $dependencyHook = str_replace('_config', '_script_dependencies', $hook);
        $check(
            apply_filters($hook, $config, $context) === $config
            && apply_filters($dependencyHook, ['wp-hooks'], $context) === ['wp-hooks'],
            'Missing integrations must leave screen configuration and asset dependencies unchanged.'
        );
    }
    $check(
        !has_filter('acf/validate_post_id', [$acf, 'readPostId'])
        && !has_filter('acf/pre_load_metadata', [$acf, 'readMetadata'])
        && !has_filter('acf/pre_update_metadata', [$acf, 'preventSourceWrite'])
        && !has_filter('acf/pre_delete_metadata', [$acf, 'preventSourceWrite'])
        && !has_filter('timber/post/import_data', [$timber, 'readPost'])
        && !has_filter('timber_post_get_meta_pre', [$timber, 'readLegacyPostMeta'])
        && !has_filter('timber/post/class', [$timber, 'postClass'])
        && !has_action('shutdown', [$acf, 'unbindPreview'])
        && !has_action('shutdown', [$timber, 'unbindPreview'])
        && !has_filter('get_post_metadata', [$yoast, 'readPrimaryMeta'])
        && !has_filter('wpseo_breadcrumb_links', [$yoast, 'readBreadcrumbs'])
        && !has_filter('wpseo_should_save_indexable', [$yoast, 'allowIndexableSave'])
        && !has_action('shutdown', [$yoast, 'unbindPreview']),
        'Unavailable integrations must not install third-party read/write hooks or shutdown cleanup.'
    );
    $check(
        $acf->readPostId(123, 123) === 123 && $acf->readMetadata(null, 123, 'field', false) === null
        && $acf->preventSourceWrite(null, 123) === null
        && $timber->readPost(['post_title' => 'Saved'], (object) ['ID' => 123]) === ['post_title' => 'Saved']
        && $timber->readLegacyPostMeta([], 123) === []
        && $timber->readTerms((object) ['ID' => 123], static fn (): array => ['Saved']) === ['Saved']
        && $yoast->readPrimaryMeta(null, 123, '_yoast_wpseo_primary_category', true) === null
        && $yoast->readBreadcrumbs([['id' => 123]]) === [['id' => 123]]
        && $yoast->allowIndexableSave(true, (object) []) && !$yoast->allowIndexableSave(false, (object) []),
        'Unbound callbacks must be safe no-ops without calling optional dependency APIs.'
    );
    $acf->clearRevisionCache(456);
    $payload = ['post_title' => 'Core content'];
    $check(
        $acf->preparePayload($payload, $context + ['input' => []]) === $payload,
        'Missing ACF must not affect core-only writes.'
    );
    $error = $acf->preparePayload($payload, $context + ['input' => ['acf' => []]]);
    $check(
        is_wp_error($error) && $error->get_error_code() === 'mtflpp_acf_unavailable'
        && $acf->verifySave($error, $context) === $error && !has_action('acf/save_post', [$acf, 'recordSave']),
        'Submitted ACF data without ACF must fail clearly, not disappear silently or leave a save monitor.'
    );

    $check(
        $yoast->preparePayload($payload, $context + ['input' => []]) === $payload,
        'Missing Yoast must not affect core writes.'
    );
    $error = $yoast->preparePayload($payload, $context + ['input' => ['yoast_primary_terms' => '{"category":1}']]);
    $check(
        is_wp_error($error) && $error->get_error_code() === 'mtflpp_invalid_yoast_primary_terms'
        && $yoast->verifySave($error, $context) === $error,
        'Submitted primary terms without Yoast must fail clearly and release pending state.'
    );

    // An ACF installation missing a required read API must also remain inert.
    CompatibilityDependenciesFixture::$missingFunctions = ['acf_decode_post_id'];
    $acf->bindPreview(123, 456, true);
    $check(
        !has_filter('acf/validate_post_id', [$acf, 'readPostId'])
        && !has_filter('acf/pre_load_metadata', [$acf, 'readMetadata']),
        'Partial optional APIs must not install callbacks that would call missing functions.'
    );
    $acf->unbindPreview();
    $timber->unbindPreview();
    WP_CLI::success('Missing ACF, Timber and Yoast, partial APIs and inert callback contracts passed.');
} finally {
    $acf->unbindPreview();
    $timber->unbindPreview();
    $yoast->unbindPreview();
    CompatibilityDependenciesFixture::$missingFunctions = [];
    CompatibilityDependenciesFixture::$missingTimber = false;
}
