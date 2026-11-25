wp.hooks.addAction('mtflpp.blockEditor.previewSetup', 'example/post-note', ({ hooks }) => {
    const key = 'example_post_note';
    hooks.addFilter('additionalPreviewValues', 'example/post-note', (values, editor) => {
        const edits = editor.getPostEdits().meta;
        // Gutenberg includes saved siblings in a meta edit. Send only a change to this note, including a clear.
        if (!edits || !Object.hasOwn(edits, key) || edits[key] === editor.getCurrentPost()?.meta?.[key]) return values;
        if (typeof edits[key] !== 'string') throw new TypeError('Expected a text post note.');
        return { ...values, [key]: edits[key] };
    });
});
