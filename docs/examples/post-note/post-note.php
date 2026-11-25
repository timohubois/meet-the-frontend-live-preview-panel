<?php

/** Plugin Name: Post Note – Live Preview Example */

namespace LivePreviewExample\PostNote;

use WP_Error;

defined('ABSPATH') || exit;

const KEY = 'example_post_note';

final class LiveNote
{
    private ?string $submitted = null;
    private ?int $postId = null;
    private int $siteId;
    private int $sourceId;

    public function registerHooks(): void
    {
        add_action('init', [$this, 'registerField']);
        add_filter('mtflpp_block_editor_preview_script_dependencies', [$this, 'addEditorScript'], 10, 2);

        add_filter('mtflpp_live_preview_form_values', [$this, 'prepare'], 10, 2);
        add_action('mtflpp_live_preview_custom_fields_initialized', [$this, 'write']);
        add_filter('mtflpp_live_preview_preparation_error', [$this, 'verify'], 10, 2);
        add_action('mtflpp_live_preview_preparation_finished', [$this, 'finish']);

        add_action('mtflpp_frontend_live_preview_source_selected', [$this, 'bind']);
        add_action('mtflpp_frontend_saved_preview_source_selected', [$this, 'unbind']);
    }

    public function registerField(): void
    {
        // A Paragraph bound to core/post-meta uses WordPress's normal editor, save and render paths.
        register_post_meta('post', KEY, [
            'label' => 'Post note',
            'type' => 'string',
            'single' => true,
            'show_in_rest' => true,
            'sanitize_callback' => 'sanitize_text_field',
        ]);
    }

    public function addEditorScript(array $handles, array $context): array
    {
        if (get_post_type($context['post']['id']) === 'post') {
            $handle = 'example-post-note-preview';
            wp_register_script($handle, plugins_url('preview.js', __FILE__), ['wp-hooks'], '1.0', true);
            $handles[] = $handle;
        }
        return $handles;
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

    public function write(array $context): void
    {
        if ($this->submitted !== null) {
            // update_post_meta() would redirect this revision ID to its saved parent.
            update_metadata('post', $context['source']['id'], KEY, wp_slash($this->submitted));
        }
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
            $matches = get_metadata_raw('post', $sourceId, KEY) === [$this->submitted];
        }
        if (!$matches) {
            return new WP_Error('example_note_not_saved', 'Could not prepare the post note.', ['status' => 409]);
        }
        return null;
    }

    public function finish(): void
    {
        $this->submitted = null;
    }

    public function bind(array $context): void
    {
        $postId = $context['post']['id'];
        if (get_post_type($postId) !== 'post') {
            $this->unbind();
            return;
        }
        $this->siteId = get_current_blog_id();
        $this->postId = $postId;
        $this->sourceId = $context['source']['id'];
        add_filter('get_post_metadata', [$this, 'read'], 10, 4);
    }

    public function read(mixed $value, int $id, string $key, bool $single): mixed
    {
        if ($value !== null || $key !== KEY || $id !== $this->postId || get_current_blog_id() !== $this->siteId) {
            return $value;
        }
        $rows = get_metadata_raw('post', $this->sourceId, KEY);
        if ($rows) {
            return $rows; // WordPress unwraps the first row on single reads, including a stored empty string.
        }
        if (!isset(get_post_meta($id)[KEY])) {
            return $value; // Neither has a row: let WordPress resolve the original post's default.
        }
        return $single ? '' : []; // A parent note added after capture is not part of the preview.
    }

    public function unbind(): void
    {
        remove_filter('get_post_metadata', [$this, 'read'], 10);
        $this->postId = null;
    }
}

(new LiveNote())->registerHooks();
