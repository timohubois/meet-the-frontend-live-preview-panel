// Initialization failures remove only this plugin's UI; native editing and revision controls remain usable.
export function showStartupError(message, error, after) {
    document.getElementById('mtflpp-panel')?.remove();
    document.getElementById('mtflpp-toggle')?.remove();
    document.getElementById('mtflpp-publish-preview')?.remove();
    document.getElementById('mtflpp-term-preview')?.remove();
    const notice = document.createElement('div');
    notice.className = 'notice notice-error inline';
    notice.setAttribute('role', 'alert');
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    notice.append(paragraph);
    const anchor = after || document.querySelector('#wpbody-content .wp-header-end')
        || document.querySelector('#wpbody-content .wrap h1, #wpbody-content .wrap h2');
    if (anchor) anchor.after(notice);
    else (document.getElementById('wpbody-content') || document.body).prepend(notice);
    console.error('Meet the Frontend – Live Preview Panel could not start.', error);
}
