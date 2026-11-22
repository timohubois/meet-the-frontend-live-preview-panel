=== Meet the Frontend – Live Preview Panel ===
Contributors: timohubois
Tags: preview, editor
Requires at least: 6.9
Tested up to: 7.1
Stable tag: 1.0.1
Requires PHP: 8.3
License: GPLv3 or later
License URI: https://www.gnu.org/licenses/gpl-3.0.html

Preview unsaved changes on your actual frontend in a floating panel while editing posts, pages and supported custom post types.

== Description ==

Meet the Frontend – Live Preview Panel shows unsaved changes in a movable, resizable frontend preview alongside WordPress's post Block Editor or classic editor. Your theme and plugins render the output through WordPress's normal preview routing. You can also preview saved revisions without restoring them.

**Features**

* Move, resize or dock the panel without leaving the editor, using a mouse or keyboard.
* Inspect Computer, Tablet and Phone viewports with rotation and zoom.
* Follow detected content changes automatically, or keep your own scroll position.
* Remember panel preferences across posts and editors. Use fullscreen or **Keep on top** (Picture-in-Picture) where supported.

Save new posts as drafts first. Live updates require revisions to be enabled. Previewing does not save or publish your edits; use WordPress's normal save controls.

== Installation ==

1. Install and activate **Meet the Frontend – Live Preview Panel** through **Plugins > Add New**, or upload an installable plugin ZIP using **Upload Plugin**.
2. Open a post, page or supported custom post type in the Block Editor or classic editor. Save new posts as drafts first.
3. Open **Live preview**, edit a supported field and the preview refreshes after a short pause.

== Frequently Asked Questions ==

= Which changes can I preview? =

Both editors preview the title, content, excerpt and supported ACF fields. The Block Editor also previews author, publication date, categories, tags and featured image. Previewing a different date does not schedule or publish the post.

The panel does not support the Site Editor, template selections, other custom fields or unsaved shared content such as synced patterns. Related-post lists and archive queries still use saved content.

= Do I need ACF, Timber, Yoast SEO or Flynt? =

No. The plugin works with WordPress on its own.

ACF support includes live updates to supported fields and paginated repeaters. Timber support lets standard post and term reads use preview values; custom theme queries may still show saved values. In the Block Editor, Yoast SEO support previews unsaved primary-term selections and their effect on breadcrumbs where your theme displays them, not SEO titles, meta descriptions or analysis scores.

Flynt is not required and has no separate integration.

= Can I preview older revisions? =

Yes. Open WordPress's revision history and use **Revision preview**. The panel follows the right-hand **To** selection without restoring it or changing your saved post.

Historical content and supported stored fields use your current theme and settings. The post's author, publication date, categories and tags remain current. Not every field has a historical value. Some values remain current, while missing historical values may be empty. This is a content preview, not a snapshot of the whole site.

= Does the preview save my work? =

No. Use WordPress's normal **Save**, **Update** or **Publish** controls. Native autosaves continue independently, and previewing does not replace WordPress's recovery autosave. Closing the panel does not discard your edits, but the preview is not a backup or recovery tool.

Live updates pause during native saving or Preview, then resume. If the panel asks you to reload, copy any unsaved edits first. In the classic editor, also reload after using native Preview if it saved additions, removals or reordering in a paginated ACF repeater; copy any later edits first.

= How do I adjust the preview? =

Drag the titlebar to move the panel and its borders or corners to resize it. **Preview options** contains docking, reset and preference controls. Use the move grip or resize control with arrow keys, holding Shift for larger steps.

Choose Computer, Tablet or Phone and use Zoom to fit the preview or inspect it more closely. Click the selected Tablet or Phone button again to rotate it. These are viewport presets, not device or touch emulation.

**Scroll to my changes** follows detected changes where possible. Turn it off to retain manual positioning; it does not operate custom tabs, sliders or other interactive widgets.

Panel preferences are remembered across posts and editors. You can turn remembering of the open/closed state and window size and position on or off in **Preview options**.

Fullscreen and **Keep on top** appear only when supported. Keep on top uses Document Picture-in-Picture; your browser and desktop window manager control its availability and behavior. Neither mode reopens automatically or is required for the in-editor panel.

= What happens if I edit the same post in multiple tabs? =

Choose **Use preview here** to move live preview to that tab. Each tab keeps its own edits; changes are not copied or merged. This works within the same browser, not across browsers or devices.

= Why is the preview unavailable, blank or not updating? =

Save the post first and check that you can edit it, its post type has a frontend preview, and revisions are enabled.

Live updates need HTTPS (or a trusted local development address), a browser with ES module and Web Locks support, and access to WordPress's REST API while signed in. The editor and frontend must use the same protocol, domain and port.

Site security settings may prevent embedding. Do not weaken them to enable the panel; use WordPress's normal **Preview** button instead. If a loaded preview shows a login or error page, resolve that first: **Preview updated** means a page loaded, not that its contents were verified.

= Is the preview sandboxed? =

No. Theme and plugin scripts run normally and can access the editor because both share the same origin. Only use trusted theme and plugin code.

= What happens when I deactivate or delete the plugin? =

Deactivation keeps preview data and preferences. Deleting the plugin through WordPress removes its temporary preview revisions and server-stored preferences, including across Multisite. Your posts, normal revisions and recovery autosaves are preserved. Browser-local preference backups may remain.

== Support and contributions ==

Report issues or contribute on [GitHub](https://github.com/timohubois/meet-the-frontend-live-preview-panel/). Include the relevant versions and steps to reproduce, without credentials or private site data.

== Screenshots ==

1. Preview unsaved changes alongside the Block Editor.
2. Preview unsaved changes alongside the classic editor.
3. Preview saved revisions without restoring them.
4. Preview changes to supported ACF PRO Flexible Content fields.
5. Check responsive layouts with device viewport presets.
6. Enlarge the preview while keeping the editor in view.
7. Keep the preview in a separate Picture-in-Picture window where supported.

== Changelog ==

= 1.0.1 =
* Clarify the Picture-in-Picture tooltip and documentation for Keep on top.

= 1.0.0 =
* Initial commit

== Credits ==

Icons from [WordPress Gutenberg](https://github.com/WordPress/gutenberg), by the WordPress Contributors, licensed GPL-2.0-or-later.
