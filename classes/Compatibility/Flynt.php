<?php

namespace MeetTheFrontendLivePreviewPanel\Compatibility;

use Closure;

/** Adapt Flynt's native (HTML, component name, row data) filter to the panel's row callback. */
final class Flynt
{
    public static function rowMarkerRegistration(): ?Closure
    {
        return class_exists('Flynt\\Api') ? self::addRenderedRowFilter(...) : null;
    }

    private static function addRenderedRowFilter(callable $mark): void
    {
        add_filter(
            'Flynt/renderComponent',
            static fn (mixed $html, mixed $componentName = null, mixed $row = null): mixed => $mark($html, $row),
            PHP_INT_MAX,
            3
        );
    }
}
