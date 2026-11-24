# Usage

In the Block Editor, choose **View → Show live preview**. The floating panel
stays open while you switch between **Post** and **Block** settings. WordPress's
**Preview in new tab** action remains separate. **×** stops live updates and
returns focus to **View**, or to the editing area in **Distraction free** mode.
On narrow screens, use the floating **Live preview** button instead. Closing
returns focus to that button.

In the classic editor, choose **Live Preview Changes** below WordPress's Preview
button in the Publish box. WordPress's own Preview control still opens its
normal new-tab preview. **×** closes the floating panel, stops live updates,
and returns focus to **Live Preview Changes** without discarding your edits.

Move the floating window by its titlebar and resize it from usable borders and
corners. Edges pinned to a dock stay anchored. The move grip and keyboard resize
control respond to arrow keys, with Shift for larger steps. Opening with the
keyboard moves focus to **Preview options** without trapping it.
In the post editors, WordPress's native **Preview** button keeps the panel and its last frame visible,
waits for outstanding live writes, and normally resumes live updates afterward.
It retains WordPress's normal behavior, including saving changes to your own drafts.
**Save**, **Update** and **Publish** also keep an open panel and its last frame visible
while live writes drain and WordPress validates and submits the form. Live updates
pause during this action and resume if browser, WordPress or ACF validation rejects
it. Classic saves use WordPress's normal editor reload. Block Editor saves and
autosaves keep the editor open, wait for any legacy meta-box saves, then resume
previewing against the acknowledged saved state. An explicitly closed panel stays
closed. If the saved state cannot be confirmed, preserve your edits and reload;
the panel never guesses a new baseline or prevents WordPress from saving.

- **Preview options** uses native WordPress controls, with **Preview window** for display actions and **Settings** for remembering and scrolling options. **Move preview to** saves a preferred bottom-left, bottom-center or bottom-right preset, even when layout remembering is off. Dragging freely clears the active dock selection without erasing the preferred preset. Resizing keeps the selected dock. **Reset preview window** restores the default 480 × 393 px panel, compact, bottom-right and saves that preset without changing whether layouts are remembered. **Use full screen** and **Keep on top** (Picture-in-Picture) appear where available. The remembering, scrolling and reset actions include short, visible explanations. There is no separate new-tab action; WordPress’s normal Preview button is unchanged.
- **Keep on top** appears only in browsers that support Document Picture-in-Picture, not just video PiP. Its tooltip explains: “Open the preview in a separate Picture-in-Picture window.” Its icon-only shortcut sits inside the preview's bottom-right corner, fading in only when the pointer is near the button, or appearing immediately on keyboard focus. It stays visible on devices without hover, and reduced-motion settings disable the fade. The pop-out uses the browser's native **Back to tab** and close controls to return inline. **Update preview** stays visible in the pop-out header, including its loading indicator. Its **⋮** menu can close the live preview entirely. A normal WordPress page reload closes PiP; use the same **Keep on top** action to open it again. There is no PiP persistence or reload-specific behavior.
- **Desktop**, **Tablet** and **Phone** use a native WordPress toolbar with pressed states and arrow-key navigation. Their representative viewports are 1280 × 800, 768 × 1024 and 390 × 844 CSS pixels. Clicking a different device selects it; clicking the already selected Tablet or Phone button rotates it between portrait and landscape. Desktop stays in landscape. The selected Tablet or Phone icon turns with the orientation and its tooltip names the next action. Tablet and Phone each remember their own orientation; there is no separate rotate button. Switching devices or rotating never resizes the panel. This sizes the viewport, not the device, user agent or touch capabilities. If **Scroll to my changes** brought an element into view and switching or rotating moves it off-screen, the preview brings that same element back into view in any zoom mode. In **Fill width** and **Choose zoom**, it can also pan the canvas when the element is clipped by the panel. It makes no follow adjustment if the element stays visible, you already scrolled or panned away, or the new layout hides or replaces it. When following an edit across a switch, the preview skips the zoom animation and lets the new layout render before deciding whether to adjust the scroll position. Manual scrolling or panning still takes priority. Visibility is best-effort: the preview accounts for scroll containers and top-edge fixed or sticky headers, but does not try to work around arbitrary theme overlays.
- **Zoom** combines fitting and magnification in one native WordPress popover. **Auto** (the default) fits the whole viewport for every device and orientation, capped at screen-pixel 1:1 (100%), so only the webpage needs scrolling. Auto stays selected while adapting to the device, orientation, available space and displaying-window DPR. **Fit to panel** fills the available area while keeping the whole viewport visible; **Fill width** fills its width without shortening or stretching the iframe height. Both can enlarge beyond 100%. A **Zoom mode** radio group makes the active choice explicit, with a short, plain-English explanation for each mode. **Choose zoom** reveals a native **Zoom (%)** slider and number field accepting whole percentages from 10 to 400, including 80% and screen-pixel 1:1 at 100%; a fixed percentage stays fixed when the panel is resized. Selecting a mode applies it without closing the popover; the percentage field stays hidden for fitting modes. The native number field clamps out-of-range numbers to 10–400; empty and fractional values are not saved. Enter closes a valid custom value; Escape closes the popover and returns focus to Zoom. The closed control shows only the selected mode name. The adjacent readout shows the device, viewport dimensions in CSS pixels and current zoom, such as **Desktop (1280 × 800) · 75%**. The last custom percentage is retained when switching back to fitting; the earlier capped whole-screen preference is restored as Auto.
- All zoom modes keep the selected CSS viewport dimensions fixed: panel resizing and zoom never change media queries, text wrapping, `vh` units or viewport proportions. At an exact 100%, each viewport CSS pixel occupies one physical screen pixel, using a CSS transform of `1 / devicePixelRatio`. Computed fitting percentages are rounded for display; the **100% = pixel for pixel.** note defines the 100% reference rather than describing every current zoom. DPR is detected automatically from the displaying window, including PiP's own window, and shown as two always-visible, read-only lines at the bottom of the Zoom popover, without a heading or collapsible section. Monitor changes and browser zoom update it automatically; a device preset never selects a device DPR. This is screen-pixel 1:1 sizing, not calibrated handset dimensions in centimetres or device-DPR emulation. If the viewport extends beyond the canvas in Fill width or Choose zoom, use the outer canvas's scrollbars, or Tab to the canvas and use the arrow keys. Choose zoom can need navigation on both axes; Fill width needs only vertical navigation. The webpage keeps its own scroll position inside the iframe. Verified HTML previews use native scroll containment, so reaching a webpage boundary does not move the canvas; unverified and browser-native output is left untouched. Empty canvas around the preview is expected. These controls work in the floating panel, expanded view, fullscreen and PiP; narrow footers wrap rather than clip.
- Loading and no-frame recovery use a centered native Placeholder. Problems with a retained frame appear in a native Notice below the header, without covering the preview. Unresolved problems remain visible; incidental window-operation notices can be dismissed.
- In the Block Editor, classic editor and term editor, **Remember open or closed** is on by default. Turning it off starts the preview open on each new screen load. Revisions always starts closed. Viewport, zoom mode, custom percentage, device orientations, **Scroll to my changes** and floating layout preferences are stored per user across screens. Preferences remain after deactivation; uninstalling through WordPress removes the plugin's server-stored preferences.
- **Remember size and position** is on by default. It restores compact dimensions, custom placement or responsive docking, the shared panel/launcher anchor and expanded/compact mode. The initial layout is 480 × 393 px, compact, bottom-right. Turning remembering off leaves the current layout untouched and discards its saved geometry; subsequent screen loads start with the default compact size at the preferred **Move preview to** preset. Moving, resizing or expanding then lasts only for the current page; closing and reopening without reloading keeps that layout. Re-enabling saves the current layout rather than reviving an older one. Restored layouts fit inside the current window without overwriting preferred bounds; fullscreen and PiP are never reopened automatically.
- **Scroll to my changes** is on by default. It combines submitted editor-value changes, HTML captured before frontend scripts and the loaded DOM to identify changed content, structure and attributes without theme-specific mapping. Matching old → new values strengthen candidates, including script-rendered content; missing literal matches do not reject conditional or transformed output. Whitespace-only edits can be followed when they change the rendered text, such as a missing word separator or an extra space in preformatted text. A normal trailing space that the browser collapses does not trigger a scroll. Content/structure normally takes priority over presentation unless stronger input evidence supports an attribute edit. Non-content regions, including Xdebug diagnostic tables, are excluded by default without hiding their output. The PHP [comparison exclusion filter](integrations.md#comparison-exclusions) can extend or replace that complete policy. After identifying a change, following opens enclosing native `<details>` bodies and reveals `hidden="until-found"` containers through their `beforematch` notification contract. Visible disclosure headings and wrappers do not open their own bodies. Native exclusive groups may close another item, and frontend handlers still run. After one bounded rendering opportunity and an immediate owner-state flush, the plugin scrolls once; this is not a readiness guarantee for late initialization, transitions or lazy content. Ordinary hidden or unrelated display-none containers block native activation along that path; following instead uses the nearest visible ancestor, which may be a broader container. Custom accordions/tabs are not activated through guessed controls, ARIA attributes, clicks, focus or URL fragments. If a replacement or reorder is clearly confined to one surviving container, such as a form with new fields or a reordered gallery, the preview can follow that container without guessing which child changed. If a target is clipped or scrolling to it could move a widget’s internal viewport, the preview can follow the container instead. Equally corroborated locations retain position rather than letting visibility decide which one was edited. An edit already visible in the panel keeps the restored position. If a zoom mode clips an edit that is otherwise in view, only the canvas pans. If the edit is partly clipped inside the page or covered by a top-edge header, the page scrolls only enough to reveal it. For off-screen edits, shorter changes still land around the upper third of the preview when there is room, and changes too tall to fit are shown from their beginning. Following scrolls smoothly regardless of theme scroll settings, or instantly when reduced motion is preferred. Restoring the previous position is always instant. Theme-owned opening animations remain the theme's responsibility. Detection and header handling remain best-effort; disable following to retain manual positioning and skip comparison snapshots. Turning following on refreshes the preview once to establish a baseline while retaining position. Once the preview is ready, further edits can be followed.

### Taxonomy terms

Open the full **Edit** screen for an existing category, tag or public custom
taxonomy term, then click **Live Preview Changes** above **Name**. Edit **Name**,
**Description** or a supported **ACF field** to see the change on the term archive
as your theme renders it. **×** closes the panel and returns focus to the button.
The public archive stays unchanged until you click WordPress's **Update** button.

The panel is not available in Quick Edit or when adding a new term. It uses the
saved archive URL, slug, parent and post assignments. Native archive headings,
Term Name and Term Description blocks, and standard Timber term objects show the
matching term edits. Yoast’s default archive breadcrumb shows the updated name;
custom breadcrumb titles stay saved. ACF fields preview through ACF’s normal reads
(such as `get_field()` or Timber’s `term.meta()`). Raw `get_term_meta()` reads,
third-party ACF field types and behavior that runs on save aren’t previewed. Term
previews don’t require post revisions and their temporary data expires after 15 minutes.

### Posts page

If you assign a page as the **Posts page** in **Settings → Reading**, the panel
shows the normal posts index in both live and revision previews. The posts list
stays unchanged, while page fields used by the theme, such as the archive
heading, can show the preview values. The panel does not add the page body or
other fields that the theme does not display. WordPress’s own Preview button is
unchanged.

### Revision browser

The panel supports the classic Revisions screen (`wp-admin/revision.php`), not
Visual Revisions inside the Block Editor. If you’re in Visual Revisions, open its
**Settings** sidebar and choose **Open classic revisions screen** for the selected
revision. Then click **Preview revision** next to **Go to editor** to open the
floating window. While you browse Visual Revisions, the live panel is hidden and
its updates are paused. Returning to editing restores the panel if it was open.
A popped-out panel returns to the editor window.

**×** closes it. The comparison keeps its full width whether the preview is open
or closed. The panel follows the selected right-hand **To** revision when using
the slider or Previous/Next buttons. Comparing two
revisions still shows one frontend preview: the To version, not a visual diff.
The caption identifies the displayed revision by date and author; it retains the
previous identity until a replacement loads.

Browsing previews does not restore revisions, update saved content, create internal
preview revisions or replace recovery autosaves. WordPress's comparison and Restore
controls remain unchanged. Revision previews do not acquire the editor's live-write
lock, so they can run alongside an editor preview.

Historical title, content, excerpt, revision-enabled post metadata and stored ACF
values come from the selected source. The current-post entry uses saved parent data,
not the latest autosave. Themes, styles, global settings, related content and
unrevisioned metadata remain current: this is old content rendered by today's site,
not a historical site snapshot. Fields absent from a revision cannot be reconstructed.
If a source is deleted, permission changes or its URL expires, reload the revision
browser. Embedding and theme-specific output limitations below also apply.

## Data and limitations

Live post updates write a separate internal preview revision per user and post, not the
saved parent post or WordPress's recovery autosave, and do not publish changes.
Live previews can write these snapshots even when normal revision history is disabled.
Preview revisions stay out of the normal revision history and do not trigger the
newer-autosave notice. They are reused on refresh and deleted when the parent post
is updated or permanently deleted. Existing recovery autosaves are left untouched.

Both post editors preview title, content, excerpt and supported post-local ACF fields.
The Block Editor supplies serialized blocks in either visual or code mode and also
previews author, publication date/time and taxonomy assignment changes, plus
featured-image selection, replacement and removal. Publication dates update the
preview, not the post's scheduling or publication state. Taxonomy support covers
native term lists, Post Terms blocks and standard Timber `post.category`,
`post.categories()` and `post.terms()` reads. Direct relationship queries remain
saved. ACF meta-box values use the same field-save
integration as classic editing; ACF blocks keep their native content-save hooks,
including blocks configured to store values in post metadata.
With Yoast SEO, the Block Editor also previews native primary-term selections and
the configured taxonomy breadcrumb trail without persisting unsaved SEO data.
Other arbitrary non-ACF metadata, template selections and unsaved separate
entities are not live inputs. Native ACF/legacy meta-box saving remains intact;
saved values become the new baseline.
When the editor switches to an unsupported entity, the panel visibly pauses without
a loading spinner and retains its last frame. Returning to the original post resumes
live updates.
WordPress's normal server autosave continues independently, including its usual
updates to your own drafts. Native REST saves carry request-specific fingerprint
receipts. A rejected REST save permits continued previewing only when a matching
receipt confirms that the saved fingerprint stayed unchanged: even a 4xx can follow
a partial post update. Failed saves never advance the baseline. Classic Preview
and block-editor legacy meta-box saves use a short-lived
acknowledgement cookie containing fingerprints, not editor content; it is cleared
on completion and expires after one minute.

- **Block Editor ACF fields:** native form serialization preserves ACF's field keys, empty values, signed field lists and paginated row changes. The optional ACF PRO datastore is respected when already enabled; the plugin never enables it or changes Gutenberg's edited metadata to prepare a preview. After a native meta-box save, previewing pauses with its last frame until ACF replaces its paginated rows. If ACF's reload fails, the panel remains paused and asks you to reload; it never resets row markers or guesses that a delay was sufficient. Live preview storage is not recovery storage: legacy meta boxes are not sent by Gutenberg's native autosave, and ACF datastore recovery behavior remains ACF's responsibility.
- **Classic live ACF fields:** support depends on compatible field and revision APIs; not every field type has been verified. Paginated repeaters use ACF's native row merging to preserve unloaded saved rows and edits retained across pages. If native Preview saves draft repeater additions, deletions or reordering, the panel retains its last frame but requires an editor reload: ACF's remaining row changes still refer to the old saved order. Copy any later edits before reloading, and reload before saving again.
- **Excerpt rendering:** core's native Post Excerpt block uses the authorized preview excerpt, or generates one from preview content when it is cleared. The same adaptation supports selected saved revisions while preserving other-post contexts, native filters, excerpt length and read-more links. It is scoped to core's native registered renderer: custom renderers and other theme/plugin reads that reload saved posts by ID are not adapted automatically. Native WordPress Preview outside the panel remains unchanged, including its stale published-post excerpt behavior reproduced on WordPress 6.7 and 7.1.4.
- **Frontend output:** your theme and plugins determine the result, including redirects and browser-native output such as PDFs. When the panel can confirm a redirect to another HTML page on the same site, it shows that page with a note above it. For published posts, pages, and other viewable post types, the first recognized preview also starts a separate check of the saved public URL without editor cookies. It shows the first HTTP redirect, if confirmed and if the preview itself did not redirect. This check runs once per editor load and never visits the redirect destination. Reload the editor to check again after changing the public link or routing. Drafts and browser-script redirects are not checked. Scroll restoration and change-following only apply to recognized HTML previews. Changes made only through stylesheets or frontend state may be missed; dynamic output at load can introduce unrelated differences. PDF page, zoom and scroll state may reset on refresh.
- **Isolated editors:** authorized HTML previews opt into an isolated Block Editor's `Document-Isolation-Policy` when the frontend is not already isolated, preserving document access for scrolling without disabling core's client-side media processing. Existing frontend isolation policies are retained. Cross-origin subresources follow the resulting policy. Non-isolated screens do not request it.
- **Password-protected posts:** the panel shows the unlocked content to editors in live and revision previews without entering the post password. The public page still requires its password. To test the password form itself, use the normal frontend page in a separate tab; the panel blocks form submissions.
- **Trusted code only:** the preview is not sandboxed. Same-origin frontend scripts can access the editor. Use trusted theme and plugin code.
- **Embedding:** the preview URL must use the same scheme, hostname and port as the editor. If WordPress provides a preview URL at a different address, the panel explains why it can’t load it. This does not change the public link. Site and browser restrictions still apply. Do not weaken them to force embedding; use WordPress’s normal **Preview** button when needed. **Preview updated** reports a document load, not verified content or publication.
- **Multiple tabs:** **Use preview here** switches preview ownership between editor tabs after pending writes finish. Fields are not copied or merged. Coordination is limited to the same browser, not other browsers or devices; this is not a collaborative editing tool.

## Uninstall

Deactivation keeps preview data and preferences. Uninstalling through WordPress
removes the plugin's internal preview revisions and their metadata, plus only its
namespace in persisted user preferences. On multisite, cleanup covers all sites.
Saved posts, normal revisions, recovery autosaves and unrelated preferences are
preserved. WordPress's browser-local preference backups cannot be directly erased
by the PHP uninstaller; cleaned server preferences receive a fresh timestamp.


[Back to README](../README.md).
