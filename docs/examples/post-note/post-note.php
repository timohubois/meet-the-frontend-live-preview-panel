<?php

/** Plugin Name: Post Note – Live Preview Example */

namespace LivePreviewExample\PostNote;

use WP_Error;

defined('ABSPATH') || exit;

const KEY = 'example_post_note';

// A Paragraph bound to core/post-meta edits this field. WordPress already knows how to save and render it.
function register_field(): void
{
    register_post_meta('post', KEY, [
        'label' => 'Post note', 'type' => 'string', 'single' => true, 'show_in_rest' => true,
        'sanitize_callback' => 'sanitize_text_field',
    ]);
}
add_action('init', __NAMESPACE__ . '\\register_field');

add_filter('mtflpp_block_editor_preview_script_dependencies', static function (array $handles, array $context): array {
    if (get_post_type($context['post']['id']) === 'post') {
        wp_register_script('example-post-note-preview', plugins_url('preview.js', __FILE__), ['wp-hooks'], '1.0', true);
        $handles[] = 'example-post-note-preview';
    }
    return $handles;
}, 10, 2);

final class LiveNote
{
    private ?string $submitted = null;
    private array $selected = [];

    public function __construct()
    {
        add_filter('mtflpp_live_preview_form_values', [$this, 'prepare'], 10, 2);
        add_action('mtflpp_live_preview_custom_fields_initialized', function (array $context): void {
            if ($this->submitted !== null) {
                // update_post_meta() would redirect this revision ID to its saved parent.
                update_metadata('post', $context['source']['id'], KEY, wp_slash($this->submitted));
            }
        });
        add_filter('mtflpp_live_preview_preparation_error', [$this, 'verify'], 10, 2);
        add_action('mtflpp_live_preview_preparation_finished', function (): void {
            $this->submitted = null;
        });
        add_action('mtflpp_frontend_live_preview_source_selected', function (array $context): void {
            if (get_post_type($context['post']['id']) !== 'post') {
                $this->unbind();
                return;
            }
            $this->selected = $context;
            add_filter('get_post_metadata', [$this, 'read'], 10, 4);
        });
        add_action('mtflpp_frontend_saved_preview_source_selected', [$this, 'unbind']);
    }

    public function prepare(array|WP_Error $form, array $context): array|WP_Error
    {
        if (is_wp_error($form) || !array_key_exists(KEY, $context['input'])) {
            return $form; // Omitted: leave the source seeded from the saved post.
        }
        $id = $context['post']['id'];
        if (get_post_type($id) !== 'post' || !current_user_can('edit_post_meta', $id, KEY)) {
            return new WP_Error('example_note_forbidden', 'Cannot edit this post note.', ['status' => 403]);
        }
        $note = $context['input'][KEY];
        // Use the post field's sanitizer even though the write target is a revision.
        $note = is_string($note) ? sanitize_meta(KEY, $note, 'post', 'post') : null;
        if (!is_string($note)) {
            return new WP_Error('example_note_invalid', 'The post note must be text.', ['status' => 400]);
        }
        $this->submitted = $note;
        return $form;
    }

    public function verify(?WP_Error $error, array $context): ?WP_Error
    {
        $postId = $context['post']['id'];
        $sourceId = $context['source']['id'] ?? null;
        if ($error || !$sourceId || get_post_type($postId) !== 'post') {
            return $error;
        }
        if ($this->submitted === null) {
            // Compare stored rows: a key-specific parent read may still be bound to a live preview.
            $matches = (get_post_meta($sourceId)[KEY] ?? []) === (get_post_meta($postId)[KEY] ?? []);
        } else {
            $matches = get_post_meta($sourceId, KEY, false) === [$this->submitted];
        }
        return $matches ? null
            : new WP_Error('example_note_not_saved', 'Could not prepare the post note.', ['status' => 409]);
    }

    public function read(mixed $value, int $id, string $key, bool $single): mixed
    {
        if ($value !== null || $key !== KEY || $id !== ($this->selected['post']['id'] ?? null)) {
            return $value;
        }
        $rows = get_post_meta($this->selected['source']['id'], KEY, false);
        // WordPress unwraps the first row on single reads. Preserve the absence of metadata, too.
        return $single && !$rows ? '' : $rows;
    }

    public function unbind(): void
    {
        remove_filter('get_post_metadata', [$this, 'read'], 10);
        $this->selected = [];
    }
}

new LiveNote();
