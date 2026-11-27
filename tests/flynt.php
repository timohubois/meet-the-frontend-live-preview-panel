<?php

/** Run with `wp eval-file tests/flynt.php`; Flynt and ACF are not required for the markup fixture. */

use MeetTheFrontendLivePreviewPanel\Compatibility\Flynt;

if (!defined('WP_CLI') || !WP_CLI || !class_exists(Flynt::class)) {
    throw new RuntimeException('Run with Meet the Frontend – Live Preview Panel active.');
}

$check = static function (bool $valid, string $message): void {
    if (!$valid) {
        throw new RuntimeException(esc_html($message));
    }
};
$adapter = new Flynt();
$html = "<h2><span>Heading</span></h2>\n<p>Copy</p>";
$key = str_repeat('a', 64);
$data = ['__mtflpp_flynt_row' => $key];
$updated = $adapter->markComponent($html, 'Fixture', $data);
$attribute = ' data-mtflpp-evidence-flynt-row="' . $key . ':';
$expected = '<h2' . $attribute . '0"><span>Heading</span></h2>' . "\n" . '<p' . $attribute . '1">Copy</p>';
$check($updated === $expected, 'Mark existing roots only, with no wrapper or descendant changes.');
$check($adapter->markComponent($html, 'Fixture', []) === $html, 'Unrelated components stay unmarked.');
$check($adapter->discardDuplicates($updated) === $expected, 'Split roots from one render belong to the same row.');
$duplicate = $adapter->markComponent($html, 'Fixture', $data);
$unmarked = $adapter->discardDuplicates($updated . $duplicate);
$check(
    str_replace(['<h2 >', '<p >'], ['<h2>', '<p>'], $unmarked) === $html . $html,
    'Never follow either copy of a row rendered more than once.'
);

WP_CLI::success('Flynt row markers preserve component HTML and reject repeated renders.');
