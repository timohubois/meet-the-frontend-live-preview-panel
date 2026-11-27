# Architecture and compatibility

## Architectural principles

Keep the plugin a thin, native-first shell around normal WordPress frontend
rendering, with a narrow isolation layer for unsaved editor state. Native Preview
is the reference for frontend behavior on supported inputs, not a command the panel
repeatedly executes: panel refreshes must not update the saved parent post, create
or overwrite recovery autosaves, or cause a newer-autosave notice. WordPress's own
saving, autosave, validation and genuine recovery notices remain untouched. A known
native preview-read defect may have an explicit, source-scoped compatibility
adaptation while leaving native rendering and ordinary requests intact; the Post
Excerpt case below is one such bounded adaptation, not a global preview rewrite.

The live path is editor capture, an isolated preview source, authorized frontend
reads, then normal theme rendering. Saved-revision browsing reuses the authorized
read and presentation paths without capturing editor values or writing previews.

- Apply YAGNI: build for concrete supported workflows, not hypothetical editors, entities or integrations. DRY means sharing actual common behavior, not forcing distinct editor/revision lifecycles into configurable controllers. Do not add provider frameworks, integration registries, speculative interfaces or classes merely for symmetry.
- Prefer existing public WordPress and integration contracts over custom field formats, renderers or copies of native save workflows. Small explicit mappings are appropriate where native editor attributes and storage differ; do not build a universal field framework merely to hide those differences.
- Keep temporary-source storage, authorization and cleanup together. The plugin owns that isolation boundary and preview presentation/refresh coordination; WordPress and the active theme own normal frontend rendering. Optional integrations own their narrowly scoped adaptations.
- Keep editor and compatibility adapters thin. Every custom adaptation should have a concrete reason it cannot be delegated through a suitable native contract, plus focused regression coverage. Calling a native API inside a large custom workflow does not by itself meet this principle.
- Surface missing native contracts and maintenance costs before adding another workaround. Agree an explicit support limit where appropriate rather than silently accumulating special cases or dropping existing support. A missing native contract requires an explicit support-limit or bounded-exception decision; it is not permission to add private dependencies. The accepted ACF exceptions below do not authorize new ones.
- Treat these as constraints for new work and simplification reviews, not a claim that every current implementation detail is already minimal. Keep verified behavior and documented limitations distinct from architectural intent.

## Structure and ownership

- `meet-the-frontend-live-preview-panel.php` explicitly loads the feature classes and migration runner; `classes/Plugin.php` connects the owners. PHP owners live directly in `classes/`, with compatibility adaptations and migrations grouped in their own subdirectories. No Composer autoloader is required at runtime.
- Runtime identifiers follow the public name: `MeetTheFrontendLivePreviewPanel` in PHP, `meet-the-frontend-live-preview-panel` for the translation domain, REST namespace base, assets and preferences, and `mtflpp` for short prefixes. The one-time identifier migration in `classes/Migrations/` starts on the first site administrator visit with the new code and processes at most 100 old temporary preview snapshots per request. On Multisite, each site migrates independently when an administrator visits its dashboard. Panel preferences from the old scope are ignored, so the first editor session after the rename uses defaults. Uninstall removes both scopes from the database. Old hooks have no aliases. Reload any editor tabs left open during an upgrade to start a new preview session.
- See [Migrations](development.md#migrations) for naming, implementation and verification guidance.
- `classes/ClassicEditor.php`, `BlockEditor.php`, `TermEditor.php` and `RevisionBrowser.php` connect their respective native screens. `classes/Panel.php` owns shared assets, labels, the configurable comparison-exclusion defaults and the PHP view in `views/panel.php`; the view remains a plain markup template, not a separate rendering layer.
- `classes/LivePreview.php` owns internal preview revision writes, fingerprints, native-save coordination and cleanup. `classes/FrontendPreview.php` authorizes reads and overlays only the selected source on the authorized site's post. Live post-source ownership and token verification stay together in `LivePreview`. `classes/TermPreview.php` owns temporary term sources and archive reads. Both frontend owners use `classes/PreviewDocument.php` for the cache policy, marker, navigation containment and optional source capture.
- `classes/Compatibility/` contains the built-in adaptations: ACF and Yoast prepare and verify their inputs around a native preview write; ACF, Core Blocks, Timber and Yoast bind source-local reads. The preview owners call those adapters directly at the point where the work happens. `Plugin.php` connects the instances; the adapters still own their subscriptions to the native APIs they adapt.
- `src/screens/` connects native editor behavior. Classic captures the form, uses the ACF adapter for custom fields and requests optional rendered-row evidence. Block reads public editor selectors, uses ACF’s native meta-box fields and reads Yoast’s primary terms. `preview-inputs.js` reads comparison hints from the exact submitted values and keeps input failures from rejecting native saves. Both editors use `src/preview/live-preview.js` for shared live writes, frames and Web Locks.
- `src/screens/term-editor.js` reads the native Name and Description fields and uses the same live coordinator without intercepting the term form’s native submit. When a plugin supplies WordPress's `wp_editor()` for Description, the term screen observes the standard TinyMCE init event and reads the active Visual editor without saving it. It has no Yoast- or ACF-specific dependency.
- `src/screens/revision-browser.js` owns read-only revision selection. It never acquires editor locks or writes previews. It follows core's `wp.revisions.view.frame.model`; guard and verify that integration when changing supported WordPress versions.
- The classic editor adds a button through `post_submitbox_minor_actions` without changing WordPress's Preview or save controls. The Block Editor uses the public `PluginPreviewMenuItem` slot to open its floating panel without touching the native preview or sidebar. The term editor adds a button above the fields through `{$taxonomy}_term_edit_form_top`, leaving the form actions untouched. Revisions insert a text action next to the return link without modifying the native diff.
- `src/panel/window.js` owns the floating window, focus, preferences, fullscreen and PiP. `panel/geometry.js` owns preferred bounds, anchored placement, resizing and temporary viewport fitting; pointer/keyboard event binding stays with the window. `controls.js` renders public WordPress components and `viewport.js` sizes the preview viewport.
- `src/preview/frame.js` owns iframe replacement, cancellation and the comparison instance. While following is enabled, it captures each accepted, token-verified document before comparison or scrolling, while the previous frame remains mounted for deletion analysis. Disabled following skips snapshots as well as comparison, but keeps scroll containment and position restoration. Enabling following requests one non-following baseline refresh through the existing refresh callback when refreshing is available; an in-flight update can establish the baseline on completion. Native save and recovery gates remain in force. After uncaptured output, the next accepted following document becomes the new baseline without retroactively snapshotting the old page. `comparison.js` exposes only `capture(document, submittedValues)` and `findChange(previousDocument, nextDocument)`: snapshots and candidates stay private, and identification returns one live element or `null`. Visibility can corroborate weak output and deletion anchors, but comparison never scrolls or reveals an ancestor. `scroll.js` owns only remembered position and restoration/reveal. For that one identified element, it allows one completed rendering opportunity (two animation frames, bounded at 100 ms for background documents), then opens enclosing native details bodies and notifies/removes explicitly discoverable `hidden="until-found"` ancestors. The ancestor path is checked for ordinary hidden or unrelated display-none blockers before activation, so an unreachable disclosure does not close a visible exclusive peer. One task flushes immediate owner updates before visible-target resolution. Following keeps a visible edit in place, pans only the canvas if it clips an otherwise visible edit, uses nearest-edge alignment for an edit clipped inside the page or covered by a header, and retains the header-aware upper-third bias for off-screen targets that fit. It never infers custom widget activation from ARIA, CSS classes or controls, changes focus/history, or waits indefinitely for lazy initialization or transitions. Following requests native smooth scrolling unless reduced motion is preferred or the rendering wait timed out without two animation frames. Position restoration is always instant. Visible descendants or the nearest visible ancestor remain the fallback; visibility checks include native skipped-content visibility where supported. Frame-owned eligibility checks the iframe's actual current HTML document as well as the accepted frame/document identities; together with a restoration version, this prevents stale or disabled deferred following. No editor values, snapshots or candidate kinds enter scroll presentation. These are shared by the separate editor and revision lifecycles. Following iframe loads opt into `mtflpp_source=1`; ordinary/new-tab previews do not. `PreviewDocument` uses WordPress's native template-enhancement buffer (WordPress 6.9 minimum) to attach inert JSON source data to the existing authorization marker. Response-local `data-mtflpp-node` attributes map that source to live elements without theme-specific classes. Invalid/partial/non-HTML responses, explicit response contracts and native buffering opt-outs retain DOM-based comparison. While following is enabled, both captured HTML and the live DOM are frozen for each accepted document. Capture availability transitions never compare unlike representations: independently corroborated DOM/input transitions can still follow, otherwise position is retained. A missing source identity is not a guessed path; independent input/DOM evidence may identify a replacement, while repeated live matches remain ambiguous. Source capture adds response payload, buffering, snapshot and comparison work within the existing iframe request, without persistent storage.
- Comparison hints come from the exact submitted core values and contributed native text/choice controls, not controls reread after a request. Hidden helpers and attachment IDs are not literal search terms. Repeated hidden values can corroborate a DOM-only reorder when their membership stays the same and only their submitted order changes.
- `src/preview/snapshot.js` builds the comparable trees and maps captured entries to live elements. `row-move.js` verifies submitted moves; sibling alignment in `comparison.js` can still report an ordinary reorder without identifying a row.
- For a Classic ACF Flexible Content drag, the submitted order of enabled layouts and the rendered siblings must agree on a single move. An unchanged field from the dropped row can identify it in both previews. For rich text, reserializing inline styles or indenting block markup does not by itself invalidate the field’s label; this comparison does not change the submitted values or general edit detection. A text label must remain in its mapped element, using the same HTML word boundaries and configured exclusions. Ordinarily hidden text isn’t evidence; content in native disclosures can still be identified without opening them during comparison. An image control can contribute the unchanged attachment’s nonempty alt, unique among submitted siblings and on one mapped image in each captured response. A rich-text field consisting of a single link can contribute its label and literal destination together. The pair must be unique to the row in both submissions and previews; markup in an ordinary textarea can rule out uniqueness but cannot supply positive link evidence. A lost mapped link or image is not grounds to guess from neighbors. An independent intact field can still confirm the row; contradictory matches cannot.
- Rich-text blocks can corroborate each other without a shared wrapper, including a linked card’s heading and body. Standalone action captions aren’t sufficient. When following is enabled, the Classic preview write can request WordPress’s `wptexturize()` and `wpautop()` output for rich-text row fields in that request. Only changed variants are returned as optional evidence for matching and uniqueness. Raw values still drive edit detection; this runs neither `the_content`, shortcodes nor embeds and stores no formatted variants.
- Without a direct match, a captured collection can identify a distinct, nonempty row by elimination. Its eligible children must correspond one-for-one to the submitted slots, with no change except the rotation. At least one crossed neighbor must be identified by unique submitted text in both previews, with no conflicting or stale matches. The live sibling order and the inferred row’s own comparable content and presentation must still match their respective captures. This fallback preserves position if a renderer rewrites the row; a slot alone never justifies a scroll. If the old and new row boxes occupy the same document position, the comparison returns no target, regardless of DOM order. For an empty spacer, matching text from **every** crossed row can instead identify the destination boundary if the range’s boxes remain adjacent and vertically ordered in both previews. Identical spacers outside that range don’t invalidate it.
- Classic ACF gallery hints use the full submitted field name and attachment sequence, including empty galleries. A single change of membership or order can identify a local rendered gallery when the lists show the same change and their surviving items can be matched. Image sources distinguish items within a rendered list, not attachments across the editor and frontend. Several lists can identify one shared local container, but intervening content or other media in that container makes the destination ambiguous. Captured HTML establishes the authored change when available, and the loaded lists must still reflect it; inaccessible duplicates only count as clones if another occurrence represents the image. The comparison uses rendered snapshots when neither response has a capture. It needs no heading or renderer integration and follows a local gallery scrollport rather than panning its track. The coordinator passes hints only with an accepted preview generation; native iframe navigation drops them. The revision browser supplies only its selected revision identity, without capturing editor fields or adding a request. HTML text, markup-only attributes/media and formatting transitions can corroborate output. Unmatched transformations remain usable rendered evidence, not automatic rejections. Identity/reference-only changes need corroborating authored values; ordinary ARIA labels and states remain comparable without such hints. All comparison state stays in owner-local memory.

Keep PHP class names and filenames in PascalCase (except timestamped migration files) and browser filenames in kebab-case. Group browser modules by responsibility: `screens/` connects native screens, `preview/` manages preview updates and documents, `panel/` presents the preview, and `compatibility/` contains optional integrations. Shared behavior stays with its owner rather than in generic helpers, utilities or separate JavaScript/CSS buckets. Preserve runtime identifiers such as preference keys, REST paths and the `mtflpp-` CSS namespace when reorganizing internals. Extract concrete shared behavior, not generic controller or module frameworks.

The five JavaScript files directly in `src/` are the build entries: `classic-editor`,
`block-editor`, `term-editor`, `revision-browser` and `preview-navigation`. The admin entries initialize
screen integrations, import panel styles and handle startup failures; the navigation
entry runs inside the frontend preview. Screen behavior lives in `screens/`, separate
from startup. Only the shared live coordinator is named `preview/live-preview.js`;
`screens/revision-browser.js` is read-only, not another live editor. Compatibility
filenames put the integration first: `compatibility/acf-fields.js` and
`compatibility/acf-block-editor.js`. Tests follow the corresponding feature/integration
names where they target an owner.

`src/` contains authored assets; `build/` contains generated assets with the same
entry basenames. WordPress tooling intentionally adds `.asset.php` dependency files
and `-rtl.css` stylesheets; do not rename those suffixes or hand-edit generated files.
The native WordPress script handle `revisions` remains a dependency of our
`revision-browser` entry; it is not an obsolete plugin asset. The build test rejects
old or unexpected output filenames so a rename cannot leave stale release assets.

## Compatibility ownership and supported scope

The plugin owns an isolated preview data source feeding normal WordPress rendering.
It does not repeatedly invoke native Preview or replace the theme's renderer. Saved
posts and recovery autosaves remain WordPress-owned; the preview owners authorize,
select, write and clean up only their own temporary sources.

Compatibility is explicit, not hidden inside the preview engine:

| Integration owner | Supported adaptation | Boundary |
| --- | --- | --- |
| `Compatibility/CoreBlocks.php` | Delegates core's native Post Excerpt callback with a private block/post copy carrying the authorized source's title/content/excerpt and the original parent's identity. Cleared excerpts use native generation from preview content. Live author selections use the same private-copy approach for native Post Author, Post Author Name, Post Author Biography and Avatar callbacks. Publication dates use the public post-data binding on newer core, or a private Post Date callback copy on older core. | Only the matched original post and native registered callbacks; other post contexts, explicit avatar users, actual block contexts, globals, caches and custom renderers stay untouched. No renderer copy, global ID substitution or persistence. |
| `Compatibility/Acf.php` and `src/compatibility/acf*.js` | Post-local form values, native ACF save verification, revision value-cache invalidation, selected-source field reads and saved-history write guards; browser events and legacy meta-box coordination. | ACF is optional. Support depends on ACF's field/revision APIs; this is not support for every field type, options pages, related entities or a complete historical site snapshot. |
| `Compatibility/Timber.php` and `TimberPost.php` | Overlays title/content/excerpt, live author and publication dates through `timber/post/import_data`. Uses the public post-class hook to delegate native `terms()` with the authorized post's selections, covering `post.category`, categories, tags and custom taxonomies. Preserves parent identity, other import data and unrelated posts. | The term bridge replaces only the standard `Timber\Post` class for the selected live post; theme-specific subclasses stay untouched. It adapts only the term query inside that call, never shared relationship caches or other posts. Native relationship-dependent query modes remain saved. No Twig renderer or theme changes. Normal metadata and ACF reads retain their respective owners. |
| `Compatibility/Yoast.php` and `src/compatibility/yoast.js` | Validates native primary-term selections, stores them only on the owned live revision, and adapts the selected post's primary metadata and breadcrumb links. Uses Yoast's native renderer and parent breadcrumb surface. | Optional; existing Gutenberg controls only. Changes the configured main-taxonomy trail, preserves custom titles and parent hierarchy, and blocks lazy saves of this post's indexable/primary models. Bulk metadata, indexed repositories, other posts and saved-history taxonomy behavior stay native. No analysis-score, SEO title or meta-description capture. |
| `Compatibility/Flynt.php` | Owns Flynt detection and adapts its native component-render filter. `Plugin.php` passes it to `PreviewRowEvidence` as an optional `RowMarkerAdapter`. The row-evidence owner checks availability at use time and binds the adapter only for an eligible preview, without using the public renderer filter. | Editor-to-preview following for verified Flexible Content reorders only. No public markup changes, wrappers, subfield matching or editor navigation. Unmarked or ambiguous output retains ordinary following. |

A compatibility class identifies a deliberate integration, not a guarantee across all
versions of that dependency. Add a concrete owner and regression tests when adding
third-party behavior; do not put its hooks in the shared preview owners or introduce a generic
integration registry. The shared comparison-exclusion defaults are configuration policy, not an
adaptation of dependency rendering/read/write APIs: they may identify recognizable non-author
output such as Xdebug diagnostics, while the matcher itself stays dependency-neutral.
`Panel.php` configures assets and capabilities together for each screen. Post and term
previews call their own adapters directly; there is no integration registry or hook bus.
Classic requests optional row evidence after the required form body. `PreviewRowEvidence.php`
matches accepted ACF row values to opaque markers on existing roots via the selected
[renderer filter](integrations.md#rendered-rows). The shared browser reader
uses those markers only with the accepted comparison snapshot. Core still verifies the
submitted reorder, mapping, visibility and position before following; it treats evidence
attributes as non-presentational. The other public filter, [comparison exclusions](integrations.md#preview-comparison-exclusions),
is site policy, not an internal lifecycle event.

## WordPress Posts page

Live and saved-revision previews for the page assigned under **Settings → Reading**
use its public permalink with the usual signed source arguments, but not core’s
`preview=true` flag. After WordPress matches the posts index to that page, the
plugin overlays a detached queried-page object and binds the normal read adapters.
Native title displays can use the preview title; raw `get_post($id)` reads and the
posts loop stay saved. Canonical routing and template selection remain with WordPress.

## Taxonomy term archives

WordPress does not provide term revisions or native term previews. The term editor
reads the existing Name and Description controls; the optional ACF adapter captures
its own form values. The REST endpoint requires
the standard `wp_rest` nonce and actual HTTP POST for browser requests. It checks the
term's edit capability and publicly queryable taxonomy, applies core's term-field
sanitization and stores one 15-minute transient per user and term. A new refresh
replaces the previous token. The archive request checks the current capability,
session nonce and stored token before applying any preview data. There are no writes
to terms, term meta or relationships.

After WordPress resolves the matching archive, the preview overlays a copy of its
queried term and the two term-field display filters. Native archive titles and
descriptions retain their formatting; the slug, parent, archive query and raw term
reads remain saved. No preview values are written to the term cache. Creation,
Quick Edit, arbitrary term metadata and term history are out of scope.

Once the archive matches, core gives the built-in read adapters detached copies of
the saved term and the preview term. `CoreBlocks` supplies a private term to the
native Term Name and Term Description renderers when their explicit context matches
the archive, and keeps linked Term Name blocks on the saved URL, including when they
use the current archive as a fallback. `Timber` adapts only matching standard term
imports through Timber's class filter. Its link filters see the saved name and
formatted description, and custom term classes are untouched. `Yoast` updates the native current archive
breadcrumb when it uses the default name;
custom breadcrumb labels and indexables stay untouched.

`AcfTerm` validates the native taxonomy form nonce and field scope, then uses ACF's
built-in field handlers against a synthetic in-memory source. This keeps nested
field names, cleared values and paginated repeater deltas consistent with ACF
without firing the native save hooks, making assignments, writing bidirectional
relationships or persisting choices. The transient carries only the resulting
metadata overlay and the draft Save Terms selections, not a copy of unrelated term
metadata. After the archive matches, ACF reads for that site and term use the overlay
and keep their native formatting. ACF's Load Terms uses the combined draft selection,
without changing the saved assignments or the archive query. Other ACF sources and
raw WordPress metadata reads stay saved. Third-party field types and custom save
callbacks are not simulated.

## Core Post Excerpt read adaptation

Core's explicit context-ID lookup can bypass the main preview object. Upstream
[#37648](https://github.com/WordPress/gutenberg/pull/37648) used the global preview
object to fix excerpts; [#49495](https://github.com/WordPress/gutenberg/pull/49495)
restored the explicit ID for legitimate other-post contexts. Reverting to the global
post would repeat that regression.

`CoreBlocks` binds only after `FrontendPreview` authorizes and selects a source.
It temporarily wraps only the registered `render_block_core_post_excerpt` callback,
then delegates to that unchanged native function. For the exact original-post ID,
only the callback's private block copy receives a cloned parent post carrying the
selected text fields. Native `get_the_excerpt()` and `get_the_permalink()` accept that
`WP_Post`; it retains the parent's ID, post type, slug, saved author and saved dates.
Unsaved author/date choices therefore cannot change date- or author-based excerpt URLs.
The actual block context remains an integer ID. Native excerpt generation, filters,
formatting, length and read-more processing run once through core's own pipeline.

This relies on that renderer forwarding its post context to object-aware native
functions, as checked on WordPress 6.7 and 7.1.4. It is not a general object-valued
block-context contract. Keep the assumption and its tests in this owner, revisit
it when core changes, and remove it when native preview reads preserve both source
and explicit post context. Rebinding and shutdown release the owned callback;
cleanup must not overwrite a later theme/plugin renderer. Ordinary/rejected requests
remain inactive, and other-post contexts are never replaced by the global post or
a revision ID. This exception does not authorize cached-post mutation or a copied
block renderer.

## Live author selections

Gutenberg's public `author` attribute is captured and observed alongside the other
live fields. The preview endpoint validates user IDs and the post type's native
`edit_others_posts` capability before writing. The effective post author is stored
in `_mtflpp_post_author` metadata on the isolated source; its `post_author` continues
to identify the editor who owns that source. Reused sources reseed the saved author
when the input is omitted, and author changes invalidate the previous source token.

Frontend post objects and Timber imports overlay that selection only for live
previews. Core's native author and avatar blocks reload the saved post by ID, so
`CoreBlocks` delegates their unchanged callbacks with a private parent-post copy,
using a separate display copy so excerpt routing keeps the saved author/date. This relies on
those callbacks passing `postId` to `get_post_field()`; it is not a general
object-valued block-context contract. Custom callbacks are not wrapped. Explicit
avatar users, comment authors, author archives and unrelated posts remain native.
Rebinding and shutdown release only owned callbacks.

Saved-history previews retain the current saved post author: a native revision's
author identifies its editor, not a historical post-author selection. The focused
regression covers live author rendering, links, permissions, revision ownership,
isolation, fallback, save/reopen and history on the local WordPress 7.2-beta5 / PHP
8.3 site, alongside client capture tests. The previous 6.7/7.1.4 browser matrix was
not repeated for this addition.

## Live publication dates and taxonomy assignments

Gutenberg's public `date` attribute uses WordPress's REST local/UTC conversion,
including explicit timezone offsets. A null date (or empty ACF form value) means
publish immediately and displays the current time. Omitted input reseeds the saved
date. `_mtflpp_post_date` stores both display fields on the isolated revision;
revision creation/modification timestamps, saved post status, scheduling events and
recovery autosaves are not changed. Last-modified fields remain those of the saved
post. Frontend post objects and Timber imports receive the selected publication
date, not the internal revision's creation time. Native Post Date blocks use the
public `block_bindings_source_value` filter for `core/post-data` on newer core;
older native callbacks receive a private post/block copy. Their linked dates retain
the saved-parent URL through object-identity-scoped permalink filters, released in
`finally` even after errors. Explicit block dates and other-post contexts are
preserved. Arbitrary saved-post-by-ID reads and general permalink routing are not simulated.

The Block Editor configuration maps each assignable REST-enabled taxonomy to its
native editor attribute, including custom `rest_base` values. A small JSON `terms`
map preserves empty lists through both JSON and ACF's native form transport.
The endpoint validates registered taxonomies, existing term IDs and taxonomy/per-term
assignment capabilities before writing. It stores the effective lists in
`_mtflpp_terms` metadata, never real term relationships; it does not create terms.
Omitted taxonomies reseed saved assignments on every refresh.

`FrontendPreview` overlays `get_the_terms` after WordPress has populated its native
relationship cache. Unchanged assignments retain the native result, including its
ordering and earlier list filters; changed lists retain registered taxonomy
ordering. This supports standard term-list functions and Post Terms blocks without
putting unsaved relationships in shared caches or changing term counts. The optional Timber adapter also supports `post.category`,
`post.categories()` and `post.terms()` for categories, tags and custom taxonomies.
It selects a small standard-Post subclass through `timber/post/class` and delegates
Timber's native `terms()` implementation. Temporary `pre_get_terms` and
`terms_pre_query` hooks adapt only its direct matching queries (one per taxonomy
when grouping), not nested WordPress reads. They are removed in `finally`,
including after errors. Native aliases, term objects, links, grouping, include/exclude
filters, ordering and limits stay native. Empty selections short-circuit that query;
`include => [0]` is not a safe empty-result sentinel on older WordPress.

**Scope limits:** theme-specific Timber Post subclasses are not replaced.
Relationship-dependent term query modes (`all_with_object_id`, `term_order` and
`exclude_tree`) retain saved reads. Direct relationship queries (`wp_get_object_terms`,
`has_term`, including Timber's `has_term()`, and archive/related-post queries) are not
intercepted. A theme can naturally use the previewed lists as inputs to its own related
query; the queried posts' relationships still come from saved data. No shared
relationship cache is substituted. New terms created through Gutenberg itself remain
native editor writes.

Saved-history previews retain current saved publication dates and taxonomy
assignments; native revisions do not record historical selections of these fields.
Fingerprints include stored term assignments, so external term-only changes expire
old live sources and require a fresh baseline. They use stored post properties,
not `WP_Post::to_array()`'s filtered term-list convenience fields.

`tests/date-terms.php` covers date conversions, immediate/reset/omitted values,
draft/published/scheduled posts, native blocks, term replacement/removal, custom
taxonomies, permissions, cache/source isolation, counts, scheduling, history,
conflicts and native save/reopen. It also checks registered non-default taxonomy
ordering, date/author-based pretty permalinks, nested date reads and exception cleanup.
`tests/preview-fields.php` rejects failed author/date/term writes on fresh and reused
sources, accepts unchanged-value updates, rejects post-save corruption and verifies
retry/recovery isolation. The endpoint reads snapshots back before returning a URL.
PHP integration checks passed on disposable
core-only WordPress 6.7 and 7.1.4 sites and the local WordPress 7.2-beta5 ACF/Timber
site with PHP 8.3. Client regressions cover capture, observation and ACF transport.
Those PHP/client checks do not by themselves verify authenticated editor behavior;
the focused local browser coverage is described below.

`tests/timber-terms.php` uses real Timber imports and Twig rendering to check the
category byline, links, tag loops, custom taxonomies, clearing/rebinding, saved
fallback, query filtering/grouping, unrelated posts, custom-class preservation,
nested native reads, term counts, recovery data and hook cleanup after exceptions.
It skips explicitly without Timber. The focused fixture passed with Timber 2.5.1
on disposable WordPress 6.7 and 7.1.4 sites, and with Timber 2.4.1 on the local
WordPress 7.2-beta5 Flynt site. The latter also rendered its actual
`BlockPostHeader/index.twig` and verified the selected category replaced the saved
one. This fixture is PHP/Twig coverage; separate authenticated editor checks are
described below.

## Yoast primary terms and breadcrumbs

`src/compatibility/yoast.js` reads `getPrimaryTaxonomyId()` from Yoast's own
`yoast-seo/editor` store. It observes primary-only changes and uses the same JSON
or ACF multipart preview transport. Missing stores, another post context and
uninitialized controls omit the field and retain saved values. Native unset and
unassigned selections become `0`; no second primary-category control is added.

`Compatibility/Yoast.php` validates the `yoast_primary_terms` JSON object against
native, REST-enabled, assignable primary taxonomies, existing terms, the submitted
or saved assignments, and per-term permissions. It writes directly to the owned
preview revision and verifies the result. Omitted values are reseeded from saved
bulk metadata, so rebinding cannot copy a previous live override back into the
baseline. Selected-post `WPSEO_Primary_Term` / `yoast_get_primary_term_id()` reads
use the preview selection; bulk metadata and indexed repositories stay native.

The `wpseo_breadcrumb_links` adapter replaces only the configured main-taxonomy
trail, including term ancestors and native custom breadcrumb titles. A read-only
`wpseo_breadcrumb_indexables` observer identifies the original ancestry, so custom
links to other terms in that same taxonomy are not mistaken for the native trail. When no
primary is selected, it follows Yoast's deepest-term/root-order fallback. It
updates default post breadcrumb text from the preview title, but preserves explicit
Yoast breadcrumb titles, other posts, custom crumbs, disabled main taxonomies,
unchanged baselines and saved-history taxonomy behavior. Parent-post hierarchy
keeps precedence. Yoast still owns settings, rendering, wrappers and later filters;
plugin-generated term text follows its HTML-text contract with safe allowed markup.

A scoped `wpseo_should_save_indexable` guard prevents the selected post's native
lazy builds/upgrades from saving preview-derived fields, permalinks or hierarchy.
Its primary models are also denied saves. Native primary builders still see saved
bulk metadata, not preview clears. Missing post models get a read-only taxonomy
trail or reuse the native parent's breadcrumb surface. Other models retain their
native save decision. Rebinding and shutdown release the read and write hooks.

**Scope limits:** the theme must already output Yoast breadcrumbs; the adapter
does not add a breadcrumb UI or enable it. Ordinary Timber `post.category` remains
a category-list read, not an implicit primary-category lookup. Direct indexed
reads remain saved. SEO title/meta-description capture and analysis scores are not
part of this adapter; analysis stays Yoast-owned. No Flynt changes are needed.

`tests/yoast.php` checks real primary getters, breadcrumb generation and native
`yoast_breadcrumb()` HTML, primary-only edits, assignment replacement/removal,
custom taxonomies and REST bases, ancestors, fallback, custom titles, earlier
same-taxonomy custom link filters, parent hierarchy, permissions, failed writes,
rebinding, history and saved/recovery-data
isolation. It snapshots Yoast's indexable, primary-term and hierarchy tables and
exercises stale and missing post models without persisting preview data. The
fixture passes with Yoast 28.8 on disposable WordPress 7.1.4 (indexing enabled) and
the local WordPress 7.2-beta5 development installation (indexing disabled), PHP 8.3.
Yoast 28.8 requires WordPress 7.0+, so WordPress 6.7 only verifies the inert optional
dependency path. Focused authenticated Gutenberg checks also passed on Flynt's
local WordPress 7.2-beta5 / Timber 2.4.1 / Yoast 28.8 devstack: native category and
primary controls, clearing, Save/reopen and later unsaved changes; store-driven
author/date edits checked actual native blocks and Flynt's author byline. A real
blocked metadata write produced a retryable error, retained the last good frame
and recovered through Try again. Saved parent and recovery receipts remained
unchanged during unsaved previews. The
browser fixture temporarily output Yoast's native breadcrumbs without changing
Flynt; it does not claim the theme already outputs them. These checks are not an
installed-package test or a guarantee across all Yoast versions.

## Native-first bridge review

The focused review checked WordPress 7.2-beta5 and ACF PRO 6.8.10 source. Relevant
entry points are core's `wp-admin/edit-form-blocks.php` and `core/edit-post` store;
ACF's repeater `listenForSavedMetaBoxes()` / `ajaxLoadPage()` methods in
`assets/build/js/pro/acf-pro-input.min.js`; and `acf_flush_value_cache()` in
`includes/acf-value-functions.php`. This is not a new version-range or authenticated
browser compatibility guarantee.

| Bridge | Native contract considered | Result and remaining boundary |
| --- | --- | --- |
| Recognizing native legacy meta-box requests | Core builds its endpoint with `admin_url('post.php')`. | `classes/BlockEditor.php` supplies that URL. Request matching no longer reads the private `_wpMetaBoxUrl` global or copies its nonce logic. Core still sends the request; the plugin only scopes its acknowledgement to the same-origin endpoint, loader request, post ID and `editpost` action. |
| Native meta-box capture and acknowledgement | `core/edit-post` selectors `getActiveMetaBoxLocations()` and `isSavingMetaBoxes()`. | WordPress now chooses the active locations to capture, including an empty list. The existing location fallback is retained only when the selector is absent. These APIs do not supply signed form values or a request-correlated saved-data fingerprint, so native `FormData` capture and the acknowledgement receipt remain necessary. We do not call `requestMetaBoxUpdates()` to prepare previews: that would perform a real native save. The native form markup and loader request shape remain version-sensitive seams. |
| ACF paginated row reload after a native save | Native save state and ACF lifecycle actions. | ACF starts a separate AJAX row reload after `isSavingMetaBoxes()` becomes false. In the inspected implementation, `remount` occurs per returned row and does not cover an empty result; no whole-refresh completion action was found. Keep the existing scoped row-replacement observer, including zero-row results, rather than guessing from elapsed time or calling ACF's private refresh methods. Row markup remains an implementation dependency, not a stable public contract. |
| ACF pending structural pagination edits | Field value reads and normal ACF change actions. | These do not supply the pending add/delete/reorder deltas across loaded and unloaded rows. Keep the existing native row-marker check that protects Classic Preview handover; do not build another row-state model or reset ACF's deltas. The marker classes remain a version-sensitive assumption. |
| Request-local ACF source cache invalidation | `acf_flush_value_cache($postId, $fieldName)` and the values-store `reset()`. | The flush helper clears one named field, not all cached values for a post/revision, including absent/default fields. Resetting the whole store would affect unrelated objects. Keep the existing source-prefix invalidation; the cache-key prefix remains an explicit internal assumption, not a newly guaranteed API. |

### Accepted ACF compatibility exceptions

**Decision: preserve the current ACF features and accept only the three bounded
adaptations above.** Native-first does not mean public-contract-only at the expense
of supported behavior. These are deliberate compatibility obligations, not unresolved
items that must be removed regardless of feature cost, and not stable public APIs:

- `src/compatibility/acf-block-editor.js` may observe paginated row replacement to
  resume after ACF's own reload, including empty results. It must not trigger or
  reimplement that reload.
- `src/compatibility/acf-fields.js` may inspect pending structural row markers so the
  Classic Preview handover requires a reload only when necessary. It must not
  reconstruct ACF's row state or reset its deltas.
- `classes/Compatibility/Acf.php` may recognize value-cache key prefixes to invalidate
  only the preview's parent/source values. It must not reset unrelated objects' caches.

Conditions of this decision:

- Keep these assumptions inside their ACF compatibility owners. WordPress and ACF
  retain normal saving, autosave, validation and field-value interpretation; WordPress
  and the active theme retain rendering. The exceptions do not broaden permissions
  or allow panel refreshes to change saved posts or recovery autosaves.
- Maintain focused regressions when changing a bridge: empty, deleted and reordered
  paginated rows; reused preview sources; fresh raw/formatted/default field values;
  and isolation from unrelated posts. Tests establish behavior in the checked
  environments, not stability across all ACF versions or coverage of every field type.
- If native save or row-reload acknowledgement cannot be confirmed, retain the last
  frame, explain the problem and require an editor reload instead of guessing a new
  baseline or using a timer as proof. Reload is a synchronization fallback, not a
  general substitute for correct server-side cache invalidation; known cache-contract
  incompatibilities need an explicit support decision rather than stale output.
- Do not impose blanket reloads on working flows merely to remove these dependencies.
  New private assumptions, broader support or reductions in existing behavior require
  a separate review and explicit decision. Do not add a custom field/repeater engine,
  vendor fork or generic integration framework.
- Replace each exception when a suitable public ACF contract covers its actual needs:
  whole-refresh completion including empty results, pending structural deltas, or
  source-scoped cache invalidation. Verify equivalent behavior and autosave isolation
  before retiring that bridge; an API with a similar name is not enough.

The safe simplifications delegate request identification and active form locations
to WordPress. They do not change native save URLs/nonces, create another save workflow
or alter preview isolation.

[Comparison exclusions](integrations.md) · [Back to README](../README.md).
