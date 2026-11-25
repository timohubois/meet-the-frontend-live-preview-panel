wp.hooks.addAction('mtflpp.blockEditor.previewSetup', 'example/post-note', ({ hooks }) => {
    const key = 'example_post_note';
    hooks.addFilter('additionalPreviewValues', 'example/post-note', (values, editor) => {
        const edits = editor.getPostEdits().meta;
        if (!edits || !Object.hasOwn(edits, key)) return values;

        // Gutenberg includes unchanged fields when a sibling is edited.
        const note = edits[key];
        if (note === editor.getCurrentPost()?.meta?.[key]) return values;
        if (typeof note !== 'string') throw new TypeError('Expected a text post note.');
        return { ...values, [key]: note };
    });
});
