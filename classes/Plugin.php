<?php

namespace AFloatingLivePreviewPanel;

use AFloatingLivePreviewPanel\Compatibility\Acf;
use AFloatingLivePreviewPanel\Compatibility\CoreBlocks;
use AFloatingLivePreviewPanel\Compatibility\Timber;
use AFloatingLivePreviewPanel\Compatibility\Yoast;

/** Connect the feature owners without registering their hooks or implementing their behavior. */
final class Plugin
{
    public function __construct(string $file)
    {
        new Acf();
        new CoreBlocks();
        new Timber();
        new Yoast();
        new PublicRedirect();
        $livePreview = new LivePreview();
        $frontendPreview = new FrontendPreview($file, $livePreview);
        $panel = new Panel($file);
        new ClassicEditor($livePreview, $panel);
        new BlockEditor($livePreview, $panel);
        new TermEditor(new TermPreview($file), $panel);
        new RevisionBrowser($frontendPreview, $panel);
    }
}
