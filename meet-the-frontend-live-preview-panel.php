<?php

/**
 * Plugin Name:       Meet the Frontend – Live Preview Panel
 * Plugin URI:        https://github.com/timohubois/meet-the-frontend-live-preview-panel/
 * Description:       See your changes in a floating preview while you edit posts, pages and taxonomy terms.
 * Version:           1.2.2
 * Requires at least: 6.9
 * Requires PHP:      8.3
 * Author:            Timo Hubois
 * Author URI:        https://pixelsaft.wtf
 * Text Domain:       meet-the-frontend-live-preview-panel
 * License:           GPLv3 or later
 * License URI:       https://www.gnu.org/licenses/gpl-3.0.html
 */

namespace MeetTheFrontendLivePreviewPanel;

defined('ABSPATH') || exit;

require_once __DIR__ . '/classes/Compatibility/Acf.php';
require_once __DIR__ . '/classes/Compatibility/AcfTerm.php';
require_once __DIR__ . '/classes/Compatibility/CoreBlocks.php';
require_once __DIR__ . '/classes/Compatibility/Timber.php';
require_once __DIR__ . '/classes/Compatibility/Yoast.php';
require_once __DIR__ . '/classes/LivePreview.php';
require_once __DIR__ . '/classes/PreviewDocument.php';
require_once __DIR__ . '/classes/FrontendPreview.php';
require_once __DIR__ . '/classes/PublicRedirect.php';
require_once __DIR__ . '/classes/Panel.php';
require_once __DIR__ . '/classes/ClassicEditor.php';
require_once __DIR__ . '/classes/BlockEditor.php';
require_once __DIR__ . '/classes/TermPreview.php';
require_once __DIR__ . '/classes/TermEditor.php';
require_once __DIR__ . '/classes/RevisionBrowser.php';
require_once __DIR__ . '/classes/Migrations.php';
require_once __DIR__ . '/classes/Plugin.php';

new Plugin(__FILE__);
