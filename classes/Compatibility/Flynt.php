<?php

namespace MeetTheFrontendLivePreviewPanel\Compatibility;

/** Adapt Flynt's native (HTML, component name, row data) filter to the panel's row callback. */
final class Flynt
{
    public const RENDER_FILTER = 'Flynt/renderComponent';

    public static function defaultRowRenderFilter(): ?string
    {
        return class_exists('Flynt\\Api') ? self::RENDER_FILTER : null;
    }

    public static function addRenderedRowFilter(callable $mark): void
    {
        add_filter(
            self::RENDER_FILTER,
            static fn ($html, $componentName = null, $row = null) => $mark($html, $row),
            PHP_INT_MAX,
            3
        );
    }
}
