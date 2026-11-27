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

Flynt sites use the built-in adapter directly and do not call this filter. On
other sites, the filter starts at `null` (no custom renderer). Return one theme
or plugin hook name to opt in. Reuse a hook with the signature `($html, $row)` or
add one where you render each row.

### Example: a theme with an ACF sections field

In ACF, add a Flexible Content field with the field name `sections` to Pages.
Give it a layout named `text` with a Text subfield named `heading` and a Text Area
subfield named `body`. Add at least two rows with different headings on a page
to try a reorder in the Classic Editor.

In the theme's `functions.php`, register the hook name (not inside an admin-only hook):

```php
add_filter('Mtflpp/previewRowRenderFilter', static fn (): string => 'ExampleTheme/renderRow');
```

In `page.php`, render each row to a string before passing it through the theme's filter:

```php
<?php
get_header();

while (have_posts()) {
    the_post();
    $rows = function_exists('get_field') ? get_field('sections', get_the_ID()) : [];
    echo '<main>';
    foreach ($rows ?: [] as $row) {
        if (($row['acf_fc_layout'] ?? '') !== 'text') {
            continue;
        }

        $html = sprintf(
            '<h2>%s</h2><p>%s</p>',
            esc_html($row['heading'] ?? ''),
            esc_html($row['body'] ?? '')
        );

        echo apply_filters('ExampleTheme/renderRow', $html, $row);
    }
    echo '</main>';
}

get_footer();
```

- **`$html`** is the finished HTML string for **one row**. It can contain one
  top-level element or several siblings, like the heading and paragraph above.
  It is not the whole page, a template filename, or an already-printed result.
- **`$row`** is the formatted associative array returned by ACF for that same row.
  Here it contains `acf_fc_layout`, `heading`, and `body`. Pass the original array,
  or a copy that keeps **all** its keys. Do not pass the row number, request data,
  or a new array containing just the template fields.

Call the render filter **once per row**. In an eligible live preview, the panel
adds a private marker to the formatted ACF array and uses your render filter to
copy it to the HTML's top-level elements. Your theme does not create the marker.
The panel still verifies the reorder before scrolling; missing or ambiguous
evidence falls back to normal change detection. Ordinary page renders are unchanged.

The other built-in adaptations are wired directly to the preview owners. There
is no public save or preview lifecycle hook. The former `mtflpp_` PHP hooks and
`mtflpp.` browser setup actions are not called.
