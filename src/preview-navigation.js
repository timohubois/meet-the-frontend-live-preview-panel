(() => {
    'use strict';

    function staysInPreview(link, event) {
        if (event.type !== 'click' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
            || link.hasAttribute('download')) return false;
        // SVG links can use animated targets or XLink to open another context.
        if (link.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
        const context = link.getAttribute('target') || document.querySelector('base[target]')?.getAttribute('target');
        if (context && context.toLowerCase() !== '_self') return false;
        let target;
        try {
            target = new URL(link.href, link.baseURI);
        } catch {
            return false;
        }
        if (!target.hash) return false;
        const current = new URL(window.location.href);
        target.hash = '';
        current.hash = '';
        return target.href === current.href;
    }

    function guardLink(event) {
        const link = event.composedPath().find((node) => node.matches?.('a[*|href], area[href]'));
        // Cancel native navigation in capture, without suppressing frontend click handlers.
        if (link && !staysInPreview(link, event)) event.preventDefault();
    }

    document.addEventListener('click', guardLink, true);
    document.addEventListener('auxclick', (event) => {
        if (event.button === 1) guardLink(event);
    }, true);
    document.addEventListener('submit', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
})();
