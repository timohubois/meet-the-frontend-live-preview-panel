<?php

namespace MeetTheFrontendLivePreviewPanel;

use MeetTheFrontendLivePreviewPanel\Compatibility\Acf;
use MeetTheFrontendLivePreviewPanel\Compatibility\AcfTerm;
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
        $acf = new Acf();
        $acfTerm = new AcfTerm();
        $coreBlocks = new CoreBlocks();
        $flynt = new Flynt();
        $timber = new Timber();
        $yoast = new Yoast();

        new PublicRedirect();
        $livePreview = new LivePreview($acf, $flynt, $yoast);
        $frontendPreview = new FrontendPreview($file, $livePreview, $acf, $coreBlocks, $flynt, $timber, $yoast);
        $panel = new Panel($file, $acf, $acfTerm, $flynt, $yoast);
        new ClassicEditor($livePreview, $panel);
        new BlockEditor($livePreview, $panel);
        new TermEditor(new TermPreview($file, $acfTerm, $coreBlocks, $timber, $yoast), $panel);
        new RevisionBrowser($frontendPreview, $panel);
    }
}
