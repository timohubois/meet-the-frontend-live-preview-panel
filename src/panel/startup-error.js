// Initialization failures remove only this plugin's UI; native editing and revision controls remain usable.
export function showStartupError(message, error) {
    document.getElementById('mtflpp-panel')?.remove();
    document.getElementById('mtflpp-toggle')?.remove();
    document.getElementById('mtflpp-publish-preview')?.remove();
    document.getElementById('mtflpp-term-preview')?.remove();
    const notice = document.createElement('div');
    notice.className = 'notice notice-error';
    notice.setAttribute('role', 'alert');
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    notice.append(paragraph);
    (document.getElementById('wpbody-content') || document.body).prepend(notice);
    console.error('Meet the Frontend – Live Preview Panel could not start.', error);
}
