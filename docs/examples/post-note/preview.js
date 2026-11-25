wp.hooks.addAction('mtflpp.blockEditor.previewSetup', 'example/post-note', ({ hooks }) => {
    hooks.addFilter('additionalPreviewValues', 'example/post-note', (values, editor) => {
        const edits = editor.getPostEdits().meta;
        // Send only this field. An empty note is an edit; an absent key is not.
        if (!edits || !Object.hasOwn(edits, 'example_post_note')) return values;
        if (typeof edits.example_post_note !== 'string') throw new TypeError('Expected a text post note.');
        return { ...values, example_post_note: edits.example_post_note };
    });
});
