# Integrations

Most themes and plugins render in the panel without any integration. Unsaved
changes appear when they use an input the panel [already supports](usage.md#data-and-limitations).

## Preview comparison exclusions

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

## Rendered rows

A theme or plugin that renders ACF Flexible Content rows can use
`Mtflpp/previewRowRenderFilter` to help the panel follow a drag when ordinary
change detection cannot identify the moved row. This only adds evidence for
Classic Editor reorders; it does not add support for new kinds of unsaved data.

After rendering a row, pass its HTML and the formatted ACF row array to a filter
before outputting the HTML. Reuse a filter that already receives `($html, $row)`,
or add one where the theme renders each row:

```php
$html = apply_filters('ExampleTheme/renderRow', $html, $row);
```

In your normal theme or plugin setup (not in an admin-only hook), tell the panel
the name of that filter:

```php
add_filter('Mtflpp/previewRowRenderFilter', static fn (): string => 'ExampleTheme/renderRow');
```

The panel attaches its own callback to that filter during eligible live previews.
It reads a private marker it previously added to the formatted ACF row and puts
that marker on the HTML's top-level elements. Pass the row through the filter
**once**, using the original formatted array (or a copy that keeps all its keys).
Passing only the fields used by the template drops the marker. A row can render
several sibling elements; no wrapper is needed.

Only one renderer filter is selected. Flynt is supported automatically; its
different callback signature is handled by the built-in adapter. Return the
incoming selection to keep it, or return `null` to disable renderer evidence.

The panel still verifies the reorder, HTML mapping and on-screen placement before
scrolling. Missing or ambiguous evidence falls back to normal change detection.
Ordinary page renders are unchanged.

The other built-in adaptations are wired directly to the preview owners. There
is no public save or preview lifecycle hook. The former `mtflpp_` PHP hooks and
`mtflpp.` browser setup actions are not called.
