<?php

namespace MeetTheFrontendLivePreviewPanel;

/** Connect a built-in renderer’s native filter to the preview’s row marker. */
interface RowMarkerAdapter
{
    public function isAvailable(): bool;

    /** @param callable(mixed, mixed): mixed $mark Receives the rendered HTML and formatted row. */
    public function bindRowMarker(callable $mark): void;
}
