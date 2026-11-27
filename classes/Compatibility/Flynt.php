<?php

namespace MeetTheFrontendLivePreviewPanel\Compatibility;

/** Adapt Flynt's native (HTML, component name, row data) filter to the panel's row callback. */
final class Flynt
{
    public static function isAvailable(): bool
    {
        return class_exists('Flynt\\Api');
    }

    public static function addRenderedRowFilter(callable $mark): void
    {
        add_filter(
            'Flynt/renderComponent',
            static fn (mixed $html, mixed $componentName = null, mixed $row = null): mixed => $mark($html, $row),
            PHP_INT_MAX,
            3
        );
    }
}
