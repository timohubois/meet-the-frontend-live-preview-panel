<?php

namespace MeetTheFrontendLivePreviewPanel;

use MeetTheFrontendLivePreviewPanel\Compatibility\Acf;
use MeetTheFrontendLivePreviewPanel\Compatibility\CoreBlocks;
use MeetTheFrontendLivePreviewPanel\Compatibility\Flynt;
use MeetTheFrontendLivePreviewPanel\Compatibility\Timber;
use MeetTheFrontendLivePreviewPanel\Compatibility\Yoast;

/** Connect the feature owners without registering their hooks or implementing their behavior. */
final class Plugin
{
    public function __construct(string $file)
    {
        new Migrations();
        new Acf();
        new CoreBlocks();
        new Flynt();
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
