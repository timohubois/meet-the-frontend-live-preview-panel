# Preview comparison exclusions

Use `Mtflpp/previewComparisonExclusions` to tell the panel which parts of a page
are runtime output rather than edits. Matching elements and their descendants
are ignored for change detection; the preview still renders them normally.

```php
add_filter('Mtflpp/previewComparisonExclusions', static function (array $selectors): array {
    $selectors[] = '[data-vendor-runtime]';
    return $selectors;
});
```

The filter runs once when a panel screen is configured. It receives the complete
list of CSS selectors and, as its optional second argument, the screen name:
`classic-editor`, `block-editor`, `revision-browser` or `term-editor`. To scope an
exclusion to one screen, register the callback with two accepted arguments.

The default list is `script`, `style`, `noscript`, `template`, `link`, `meta`,
`nav`, `[role="navigation"]`, `[aria-live]`, `input[type="hidden"]` and
`table.xdebug-error`. Append to the incoming list to preserve earlier contributions.
You can remove selectors, replace the list entirely, or return `[]` to remove all
exclusions. Invalid return values retain the defaults; invalid CSS selectors are
ignored individually in the browser.

Prefer selectors present in the server-rendered markup: when the panel captures
source HTML, it compares that markup rather than relying on classes added later by
JavaScript. Exclude only known runtime output. Changes inside an excluded region
won’t be followed.

Built-in ACF, Yoast, Timber and Flynt behavior is connected directly to the preview
owners, not exposed as integration lifecycle hooks. The former `mtflpp_` PHP hooks
and `mtflpp.` browser setup actions are not called.
