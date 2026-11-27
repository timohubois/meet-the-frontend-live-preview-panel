<?php

namespace MeetTheFrontendLivePreviewPanel\Compatibility;

/** Connect Flynt's existing component-render filter to the preview panel's row evidence. */
final class Flynt
{
    public function __construct()
    {
        add_filter('Mtflpp/previewRowRenderFilter', [$this, 'previewRowRenderFilter']);
    }

    public function previewRowRenderFilter(mixed $filter): mixed
    {
        return $filter ?? (class_exists('Flynt\\Api') ? ['name' => 'Flynt/renderComponent', 'rowArgument' => 3] : null);
    }
}
