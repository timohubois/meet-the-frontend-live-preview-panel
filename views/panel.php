<?php

/**
 * Shared admin floating shell. Public WordPress components render its controls and feedback.
 */

defined('ABSPATH') || exit;
?>
<div id="mtflpp-toggle" class="mtflpp-launcher" hidden
    data-title="<?php echo esc_attr($title); ?>"
    data-move-help="<?php esc_attr_e(
        'Drag to move the preview, or use the arrow keys. Hold Shift to move farther.',
        'meet-the-frontend-live-preview-panel'
    ); ?>"></div>
<section id="mtflpp-panel" class="mtflpp-panel" data-state="loading" data-has-preview="false" data-has-feedback="false"
    aria-labelledby="mtflpp-title" hidden>
    <header class="mtflpp-header">
        <div class="mtflpp-move-control"></div>
        <div class="mtflpp-refresh-control"></div>
        <div class="mtflpp-titlebar">
            <h2 id="mtflpp-title" class="mtflpp-caption"><?php echo esc_html($title); ?></h2>
        </div>
        <div class="mtflpp-controls"></div>
    </header>
    <div class="mtflpp-feedback" hidden></div>
    <div class="mtflpp-viewport">
        <div class="mtflpp-canvas" role="region" tabindex="-1"
            aria-label="<?php esc_attr_e('Preview canvas', 'meet-the-frontend-live-preview-panel'); ?>"
            aria-describedby="mtflpp-canvas-help">
            <div class="mtflpp-canvas-space"><div class="mtflpp-stage"></div></div>
        </div>
        <span id="mtflpp-canvas-help" class="mtflpp-sr-only">
            <?php esc_html_e(
                'Use this area’s scrollbars, or focus it and use the arrow keys, to move around the preview screen. The page scrolls separately inside the preview.', // phpcs:ignore Generic.Files.LineLength.TooLong -- Keep the translatable message intact.
                'meet-the-frontend-live-preview-panel'
            ); ?>
        </span>
        <div class="mtflpp-empty"></div>
        <div class="mtflpp-pip-control"></div>
    </div>
    <footer class="mtflpp-devicebar" hidden>
        <div class="mtflpp-device-controls"></div>
        <div class="mtflpp-viewport-controls">
            <span class="mtflpp-dimensions"
                title="<?php esc_attr_e(
                    'Viewport size in CSS pixels and current zoom.',
                    'meet-the-frontend-live-preview-panel'
                ); ?>">
            </span>
            <div class="mtflpp-fit-control"></div>
        </div>
    </footer>
    <?php foreach (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as $mtflppEdge) : ?>
        <span class="mtflpp-edge mtflpp-edge-<?php echo esc_attr($mtflppEdge); ?>"
            data-resize-edge="<?php echo esc_attr($mtflppEdge); ?>" aria-hidden="true"></span>
    <?php endforeach; ?>
    <div class="mtflpp-resize-control">
        <button type="button" class="mtflpp-resize"
            aria-label="<?php esc_attr_e('Resize preview', 'meet-the-frontend-live-preview-panel'); ?>"
            aria-describedby="mtflpp-resize-help"></button>
        <span id="mtflpp-resize-help" class="mtflpp-resize-help" role="tooltip">
            <?php esc_html_e(
                'Use the arrow keys to change the preview’s size. Hold Shift for bigger steps.',
                'meet-the-frontend-live-preview-panel'
            ); ?>
        </span>
    </div>
    <span class="mtflpp-sr-only" role="status"></span>
</section>
