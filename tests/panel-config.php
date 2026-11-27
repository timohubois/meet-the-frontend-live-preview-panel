<?php

/** Run with `wp eval-file tests/panel-config.php`; no database fixtures are created. */

use MeetTheFrontendLivePreviewPanel\Panel;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(Panel::class)) {
    throw new RuntimeException('Run through WP-CLI with Meet the Frontend – Live Preview Panel active.');
}

$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException(esc_html($message));
    }
};
$panel = new Panel(dirname(__DIR__) . '/meet-the-frontend-live-preview-panel.php');
$handle = 'meet-the-frontend-live-preview-panel';
$screens = ['classic-editor', 'block-editor', 'revision-browser', 'term-editor'];
$defaults = ['script', 'style', 'noscript', 'template', 'link', 'meta', 'nav',
    '[role="navigation"]', '[aria-live]', 'input[type="hidden"]', 'table.xdebug-error'];
$read = static function (string $screen) use ($handle, $panel): array {
    wp_deregister_script($handle);
    $config = $screen === 'term-editor' ? ['termId' => 123, 'taxonomy' => 'category'] : ['postId' => 123];
    $panel->enqueue($screen, $config, ['jquery']);
    $script = wp_scripts()->registered[$handle];
    $inline = implode("\n", $script->extra['before']);
    return [json_decode(substr($inline, strpos($inline, ' = ') + 3, -1), true, 512, JSON_THROW_ON_ERROR),
        $script->deps, $inline];
};
$policy = 'Mtflpp/previewComparisonExclusions';
$previousScripts = $GLOBALS['wp_scripts'] ?? null;
$previousPolicy = $GLOBALS['wp_filter'][$policy] ?? null;
unset($GLOBALS['wp_filter'][$policy]);
$GLOBALS['wp_scripts'] = clone wp_scripts();
wp_deregister_script('acf-input');
try {
    foreach ($screens as $screen) {
        [$config, $dependencies] = $read($screen);
        $check($config['comparisonExcludedSelectors'] === $defaults, 'Every screen must receive the default policy.');
        $check(in_array('jquery', $dependencies, true), 'Preserve the native screen dependencies.');
        $check(!in_array('acf-input', $dependencies, true), 'Do not add an unregistered optional script dependency.');
    }
    wp_register_script('acf-input', '/acf-test.js', [], '1', true);
    foreach ($screens as $screen) {
        [$config, $dependencies] = $read($screen);
        $postEditor = in_array($screen, ['classic-editor', 'block-editor'], true);
        $postAcf = $postEditor && function_exists('acf');
        $termAcf = $screen === 'term-editor' && function_exists('acf_get_field_type');
        $check(
            isset($config['acfEnabled']) === $postAcf && isset($config['acfTermEnabled']) === $termAcf,
            'Enable ACF only on the matching live editor.'
        );
        $check(
            in_array('acf-input', $dependencies, true) === ($postAcf || $termAcf),
            'ACF scripts must precede the matching editor entry.'
        );
        $flynt = $screen === 'classic-editor' && class_exists('Flynt\\Api') && function_exists('acf_get_field_type')
            && acf_get_field_type('flexible_content');
        $check(isset($config['previewRowEvidence']) === $flynt, 'Flynt row evidence is a Classic Editor capability.');
        $check(
            $screen === 'block-editor' || !isset($config['yoastPrimaryTaxonomies']),
            'Only Block Editor config carries Yoast controls.'
        );
    }
    $seen = [];
    add_filter($policy, static function (array $selectors, string $screen) use (&$seen): array {
        $seen[] = $screen;
        $selectors[] = '[data-widget="</script>"]';
        if ($screen === 'term-editor') {
            $selectors[] = '.term-widget';
        }
        return $selectors;
    }, 10, 2);
    add_filter($policy, static fn (array $selectors): array => array_filter(
        $selectors,
        static fn (string $selector): bool => $selector !== 'nav'
    ), 20);
    foreach ($screens as $screen) {
        [$config, , $inline] = $read($screen);
        $selectors = $config['comparisonExcludedSelectors'];
        $check(array_is_list($selectors) && !in_array('nav', $selectors, true), 'Sparse results must become a list.');
        $check(
            in_array('[data-widget="</script>"]', $selectors, true) && !str_contains($inline, '</script>'),
            'Escape filtered selectors in inline JSON.'
        );
        $check(
            in_array('.term-widget', $selectors, true) === ($screen === 'term-editor'),
            'One filter can scope exclusions to a screen.'
        );
    }
    $check($seen === $screens, 'Run the policy filter once for each enqueued preview screen.');
    remove_all_filters($policy);
    foreach ([[], ['.only-this'], null, 'nav', [123], ['', '.valid']] as $value) {
        $replace = static fn () => $value;
        add_filter($policy, $replace);
        [$config] = $read('classic-editor');
        $expected = in_array($value, [[], ['.only-this']], true) ? $value : $defaults;
        $check($config['comparisonExcludedSelectors'] === $expected, 'Accept replacements; reject invalid types.');
        remove_filter($policy, $replace);
    }
    WP_CLI::success('Screen adapters, required assets and shared comparison exclusions passed.');
} finally {
    $GLOBALS['wp_scripts'] = $previousScripts;
    unset($GLOBALS['wp_filter'][$policy]);
    if ($previousPolicy) {
        $GLOBALS['wp_filter'][$policy] = $previousPolicy;
    }
}
