=== Meet the Frontend – Live Preview Panel ===
Contributors: timohubois
Tags: preview, live preview, block editor
Requires at least: 6.9
Tested up to: 7.1
Stable tag: 1.4.0
Requires PHP: 8.3
License: GPLv3 or later
License URI: https://www.gnu.org/licenses/gpl-3.0.html

Preview unsaved changes on your site in a floating panel without leaving the block or classic editor.

== Description ==

Meet the Frontend – Live Preview Panel shows unsaved changes in a movable, resizable frontend preview alongside WordPress's post Block Editor or classic editor. The panel also previews category, tag and public custom taxonomy archives from the term editor. Your theme and plugins render the output. You can also preview saved post revisions without restoring them.

**Features**

* Use **View → Show live preview** to open a movable, resizable preview in the Block Editor. In the classic editor, use **Live Preview Changes** in the Publish box. In the term editor, use **Live Preview Changes** above the Name field.
* Inspect Desktop, Tablet and Phone viewports with rotation and zoom.
* Follow detected content changes automatically, or keep your own scroll position.
* See when the preview follows a same-site redirect or the saved public post URL redirects.
* Remember panel preferences across posts and editors. Use fullscreen or **Keep on top** (Picture-in-Picture) where supported.

Save new posts as drafts first. Live post previews work even when WordPress revision history is disabled. Previewing does not save or publish your edits; use WordPress's normal save controls.

== Installation ==

1. Install and activate **Meet the Frontend – Live Preview Panel** through **Plugins > Add New**, or upload an installable plugin ZIP using **Upload Plugin**.
2. Open a post, page or supported custom post type in the Block Editor or classic editor. Save new posts as drafts first. For a category, tag or public custom taxonomy term, open its **Edit** screen.
3. Open the live preview and edit a supported field. The preview refreshes after a short pause.

== Frequently Asked Questions ==

= Which changes can I preview? =

Both post editors preview the title, content, excerpt and supported ACF fields. The Block Editor also previews author, publication date, categories, tags and featured image. Previewing a different date does not schedule or publish the post.

Term previews show unsaved changes to the name, description and supported ACF fields on the term archive. Slug, parent, post assignments and raw term metadata stay saved until you click Update.

The panel does not support the Site Editor, template selections, other custom fields or unsaved shared content such as synced patterns. Related-post lists and archive queries still use saved content.

= Do I need ACF, Timber, Yoast SEO or Flynt? =

No. The plugin works with WordPress on its own.

ACF live previews cover supported post and term fields, including paginated repeaters with ACF Pro. The term archive must render the fields through ACF (directly or through an integration such as Timber).

The Timber integration supports post previews, including changes to taxonomy assignments. On term archives, it also previews the current term’s name and description in Timber’s standard term objects. Custom term classes and raw WordPress lookups can still show saved values.

Yoast SEO support previews changes to post breadcrumbs when you edit primary-term selections in the Block Editor, and changes to the default archive breadcrumb when you edit a term name. It does not preview SEO titles, meta descriptions or analysis scores.

Flynt is optional. In the Classic Editor, the plugin can use matching Flynt components to help follow an ACF Flexible Content row after it is dragged. If the preview cannot verify the match, normal change detection still applies.

= Can I preview older revisions? =

Yes, on the classic Revisions screen. If you’re in Visual Revisions in the Block Editor, choose **Open classic revisions screen** in the Settings sidebar first. Then click **Preview revision** next to **Go to editor**. The floating window follows the right-hand **To** selection without narrowing the diff, restoring the revision or changing your saved post.

Historical content and supported stored fields use your current theme and settings. The post's author, publication date, categories and tags remain current. Not every field has a historical value. Some values remain current, while missing historical values may be empty. This is a content preview, not a snapshot of the whole site.

= Does the preview save my work? =

No. Use WordPress's normal **Save**, **Update** or **Publish** controls. Native autosaves continue independently, and previewing does not replace WordPress's recovery autosave. Closing the panel does not discard your edits, but the preview is not a backup or recovery tool.

Live updates pause during native saving or Preview, then resume. If the panel asks you to reload, copy any unsaved edits first. In the classic editor, also reload after using native Preview if it saved additions, removals or reordering in a paginated ACF repeater; copy any later edits first.

= How do I adjust the preview? =

Drag the floating window's titlebar to move it and its borders or corners to resize it. **Preview options** contains placement, reset and preference controls. Use the move grip or resize control with arrow keys, holding Shift for larger steps.

Choose Desktop, Tablet or Phone and use Zoom to fit the preview or inspect it more closely. Click the selected Tablet or Phone button again to rotate it. These are viewport presets, not device or touch emulation.

**Scroll to my changes** follows detected changes where possible. Turn it off to retain manual positioning; it does not operate custom tabs, sliders or other interactive widgets.

Panel preferences are remembered across posts and editors. In **Preview options**, you can turn off remembering the panel's size and position or, in the post and term editors, its open or closed state. Revisions always starts with the panel closed. Closing the floating panel stops live updates.

Fullscreen and **Keep on top** appear only when supported. Keep on top uses Document Picture-in-Picture; your browser and desktop window manager control its availability and behavior. Neither mode reopens automatically or is required for the in-editor panel.

= What happens if I edit the same post or term in multiple tabs? =

Choose **Use preview here** to move live preview to that tab. Each tab keeps its own edits; changes are not copied or merged. This works within the same browser, not across browsers or devices.

= Why is the preview unavailable, blank or not updating? =

For posts, save the post first and check that you can edit it and its post type has a frontend preview. Live post previews store a separate internal snapshot even when WordPress revision history is disabled. For terms, open the full **Edit** screen (not Quick Edit) and check that the term has a public archive.

Live updates need HTTPS (or a trusted local development address), a browser with ES module and Web Locks support, and access to WordPress's REST API while signed in. The editor and frontend must use the same protocol, domain and port.

Site security settings may prevent embedding. Do not weaken them to enable the panel; use WordPress's normal **Preview** button instead. If a loaded preview shows a login or error page, resolve that first: **Preview updated** means a page loaded, not that its contents were verified.

= Is the preview sandboxed? =

No. Theme and plugin scripts run normally and can access the editor because both share the same origin. Only use trusted theme and plugin code.

= What happens when I deactivate or delete the plugin? =

Deactivation keeps preview data and preferences. Deleting the plugin through WordPress removes its temporary preview revisions and server-stored preferences, including across Multisite. Your saved content, normal revisions and recovery autosaves are preserved. Temporary term previews expire automatically. Browser-local preference backups may remain.

== Support and contributions ==

Report issues or contribute on [GitHub](https://github.com/timohubois/meet-the-frontend-live-preview-panel/). Include the relevant versions and steps to reproduce, without credentials or private site data.

== Screenshots ==

1. Open Show live preview from the Block Editor’s View menu to check how an unsaved headline wraps over the featured image.
2. Use Live Preview Changes in the classic editor’s Publish box to see unsaved edits.
3. Use Live Preview Changes above the Name field to preview unsaved category edits on the archive.
4. Open Preview revision beside Go to editor to see a saved version without restoring it.
5. Preview unsaved edits to ACF PRO Flexible Content fields in the classic editor.
6. Check responsive layouts with device viewport presets.
7. Resize the floating preview for a closer look while keeping the editor in view.
8. Keep the preview in a separate Picture-in-Picture window where supported.

== Changelog ==

= 1.4.0 =

* Follow verified ACF Flexible Content row moves more reliably in the Classic Editor, including moves across disabled rows and Flynt components that render as multiple elements.
* Follow uniquely identifiable ACF plain-text edits in the Classic Editor.
* Preserve frontend click handlers in the preview, including links used by interactive components.
* Avoid duplicate Classic Editor preview refreshes and reduce the work needed to capture large preview pages.
* Breaking change for custom integrations: the previous `mtflpp_` PHP hooks and `mtflpp.` JavaScript setup actions are no longer called, and no aliases are provided. See the [integration guide](https://github.com/timohubois/meet-the-frontend-live-preview-panel/blob/1.4.0/docs/integrations.md) for the two supported filters. Built-in integrations need no changes.

= 1.3.4 =

* Improve scroll targeting by prioritizing matching editor changes and keeping position when multiple targets are equally supported.
* Follow verified ACF Flexible Content row moves when a generated page index reorders to match.

= 1.3.3 =
* Fix a Classic Editor crash when a theme replaces the current post with a wrapper such as a Timber post.

= 1.3.2 =
* Follow moved ACF Flexible Content rows more reliably, including on the first drag. Keep the preview in place when it can't verify where the row moved.
* Keep preview values on the correct site in WordPress Multisite, even when posts on two sites share an ID.
* Preserve values sent by other block editor integrations when ACF has no fields to include in the preview.
* Clarify what happens when you switch between live previews.

= 1.3.1 =
* Keep WordPress's native Preview in a separate tab in both the Classic and Block Editors.
* Follow more changes in the live preview, including ACF Flexible Content row moves and gallery edits.
* Preview the page assigned to display your latest posts, including from its revision history.
* Fix Classic revision preview startup and pause live updates while browsing Visual Revisions.
* Avoid false preview conflicts after comment moderation, embed cache updates, or unrelated metadata changes.
* Improve Timber 1 and 2 compatibility for post and term previews.

= 1.3.0 =
* Open the floating live preview from the Block Editor's View menu. On narrow screens, use the floating launcher.
* Open live previews from the Classic Editor's Publish box and from term edit screens, without replacing WordPress's native controls.
* Use Preview revision next to Go to editor to see the selected revision without restoring it. The revision panel starts closed and leaves the comparison at full width.

= 1.2.3 =
* Keep the part you edited in view when switching or rotating preview devices, and follow more visible changes, including whitespace edits.
* Refresh live previews sooner and avoid rewriting unchanged preview metadata.
* Clarify the viewport size and zoom readout, and make preview notices easier to scan, including when WordPress returns a URL on a different site address.

= 1.2.2 =
* Show password-protected content in authorized live and revision previews without unlocking the public page.

= 1.2.1 =
* Scroll smoothly to changes and position shorter changes higher in the preview so more of the content below stays visible. Respect reduced-motion preferences.
* Fix duplicate initialization of custom fields when preparing a post preview.

= 1.2.0 =
* Align plugin identifiers with the Meet the Frontend name and remove obsolete temporary preview snapshots after upgrading.
* Panel preferences reset to defaults once. Reload any editor tabs left open during the update. Saved posts, revision history, and recovery autosaves are unchanged.
* Breaking change for custom integrations: use the `mtflpp_` PHP hooks and `mtflpp.` JavaScript hooks. The old hooks are no longer called. See the [integration guide](https://github.com/timohubois/meet-the-frontend-live-preview-panel/blob/1.2.0/docs/integrations.md).

= 1.1.1 =
* Allow live post previews when WordPress revision history is disabled.
* Explain why the preview cannot load when WordPress returns a URL on a different website address than the editor.
* Update the plugin listing screenshots.

= 1.1.0 =
* Preview unsaved names and descriptions on existing category, tag, and public custom taxonomy archives.
* Preview supported ACF fields on term archives without saving the edits, including paginated repeaters with ACF Pro.
* Show confirmed same-site preview redirects and redirects from saved public post URLs.
* Prevent previews from saving new ACF choices to shared field definitions.

= 1.0.1 =
* Clarify the Picture-in-Picture tooltip and documentation for Keep on top.

= 1.0.0 =
* Initial commit

== Credits ==

Icons from [WordPress Gutenberg](https://github.com/WordPress/gutenberg), by the WordPress Contributors, licensed GPL-2.0-or-later.
