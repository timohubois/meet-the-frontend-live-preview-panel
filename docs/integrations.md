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

Suppose your renderer already calls
`apply_filters('ExampleTheme/renderRow', $html, $row)`. Point the panel at that
filter:

```php
add_filter('Mtflpp/previewRowRenderFilter', static function ($filter) {
    return $filter ?? ['name' => 'ExampleTheme/renderRow', 'rowArgument' => 2];
});
```

The panel selects one renderer filter. Return a hook name and the one-based
position of the row in its arguments (HTML is argument 1), or leave the incoming
selection unchanged. Return `null` at a later priority to disable the selection.
Register on editor, REST and frontend requests alike; the same rendering hook
must apply on the site being previewed. Flynt uses this same contract with
`Flynt/renderComponent` and argument 3.

Pass each row's HTML through the renderer filter **once**, with the original
formatted row array (or a copy preserving all its keys). Multiple sibling roots
in that HTML are fine. Do not construct a row from its index or recreate the
panel's evidence. The panel marks eligible roots only in authorized live previews
that request row evidence. It still verifies the reorder, HTML mapping and
on-screen placement before scrolling. Missing or ambiguous evidence falls back
to normal change detection. Ordinary page renders are unchanged.

The other built-in adaptations are wired directly to the preview owners. There
is no public save or preview lifecycle hook. The former `mtflpp_` PHP hooks and
`mtflpp.` browser setup actions are not called.
