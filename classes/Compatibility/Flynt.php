<?php

namespace MeetTheFrontendLivePreviewPanel\Compatibility;

use MeetTheFrontendLivePreviewPanel\RowMarkerAdapter;

/** Adapt Flynt's native (HTML, component name, row data) filter to the panel's row callback. */
final class Flynt implements RowMarkerAdapter
{
    public function isAvailable(): bool
    {
        return class_exists('Flynt\\Api');
    }

    public function bindRowMarker(callable $mark): void
    {
        if (!$this->isAvailable()) {
            return;
        }
        add_filter(
            'Flynt/renderComponent',
            static fn (mixed $html, mixed $componentName = null, mixed $row = null): mixed => $mark($html, $row),
            PHP_INT_MAX,
            3
        );
    }
}
