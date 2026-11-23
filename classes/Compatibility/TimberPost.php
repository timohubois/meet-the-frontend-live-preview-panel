<?php

namespace MeetTheFrontendLivePreviewPanel\Compatibility;

use Closure;

/** Loaded only for an authorized live preview using Timber's standard Post class. */
final class TimberPost extends \Timber\Post
{
    private ?Closure $previewTerms = null;

    public function setPreviewTerms(Closure $callback): void
    {
        $this->previewTerms = $callback;
    }

    public function terms($query_args = [], $options = [])
    {
        $native = fn () => parent::terms($query_args, $options);
        return $this->previewTerms ? ($this->previewTerms)($this, $native) : $native();
    }
}
