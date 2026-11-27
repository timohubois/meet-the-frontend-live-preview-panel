# Development

The supported baseline is WordPress 6.9. Historical verification notes below include
older core versions; they are not a statement of current support. Source capture
uses only core's native template-enhancement buffer.

Use PHP 8.3+ and Composer for the development checks:

```sh
composer install
composer check-platform-reqs
composer php:lint
```

All authored JavaScript and panel CSS live in `src/`. WordPress's standard tooling builds five entries: `src/classic-editor.js`, `src/block-editor.js`, `src/term-editor.js`, `src/revision-browser.js` and `src/preview-navigation.js`. The admin entries import public APIs from `@wordpress/components`, `@wordpress/element`, `@wordpress/data`, `@wordpress/preferences`, `@wordpress/api-fetch` and `@wordpress/hooks`; selected official icons live in `src/panel/icons.js`. WordPress supplies the installed runtime instead of bundling another copy of React or its components:

```sh
npm ci
npm run build
```

Prefer guard clauses and early returns, simple two-way ternaries rather than nested decisions, and named options when a call needs several boolean flags. Keep multi-step branches and error handling on separate lines. Extract meaningful operations rather than splitting functions solely for their length; preserve native save/cleanup boundaries.

Prefer logical CSS properties for dimensions, spacing, borders and UI positioning. Keep physical coordinates only where they describe the preview canvas, native window scrolling or compass-based window geometry; protect those rules from automatic RTL mirroring. The cssnano configuration in `package.json` preserves important `/*! rtl:… */` directives until WordPress's RTL build processes them.

Run `npm run lint` to check the focused JavaScript readability rules, logical CSS properties and declaration style. Use `npm run format:css` to format authored panel CSS with four-space indentation. These commands use the existing WordPress development tooling; generated assets are excluded.

Rebuild after changing anything in `src/`; `npm start` watches those inputs during development. All plugin browser code is bundled, including editor/revision coordination, scrolling and the ACF adapter. ACF is initialized only when available. There are no runtime imports from `src/` or PHP-configured module URLs.

`build/` contains only generated assets and is ignored by Git. Build it locally before using a checkout or running the JavaScript tests, and rebuild after pulling source changes. Never edit generated files by hand. The complete directory, including CSS and generated `.asset.php` dependency/version metadata, must still ship in installable packages. The admin bundles intentionally contain the same shared panel source; they load on different screens and need no separate shared runtime. Distribution excludes `src/` and development dependencies; `.distignore` deliberately does not exclude `build/`.

Native component CSS is still enqueued separately and copied into PiP, including WordPress's combined admin stylesheets and runtime-generated component styles. CSSOM-only rules are copied as CSS text so native spinners retain their strokes and animation. Package imports do not replace this stylesheet handling.

The public panel APIs and built asset loading are checked against WordPress 6.7 and 7.1.4 core assets, including in-page, fullscreen and native PiP controls. This is not a full authenticated editor-to-frontend compatibility guarantee.

## Migrations

Use a migration when an upgrade must move or remove persisted plugin data. A
rename that doesn't affect persisted data doesn't need a migration.

- Name files `<unix-timestamp>.php` in `classes/Migrations/` and classes
  `Migration<unix-timestamp>`. Take the timestamp from `git log -1 --format=%ct`
  when creating the migration and keep existing IDs unchanged. Describe what
  each migration does in its class docblock.
- The runner in `classes/Migrations.php` discovers timestamped files in order.
  Add only the migration file; don't list individual migrations in the plugin
  bootstrap or in `uninstall.php`.
- Implement static `runForSite(): void` for the upgrade work. Keep progress per
  site, bound work per request, and mark completion only after the work succeeds.
  Make repeat runs safe and touch only legacy data the plugin owns.
- Implement static `uninstallForSite(): array` to remove any legacy data and
  progress markers even if the upgrade never ran. Return any retired panel
  preference scopes (or an empty array). The uninstaller removes all returned
  scopes and the current one in the same user scan.

The [identifier rename migration](../classes/Migrations/1795452494.php) only
discards old temporary preview revisions. It starts on the first non-AJAX
admin request with the new code and a user who can manage the site. Don't rely
on `upgrader_process_complete`: WordPress can fire it with the old code still
loaded, and replacing plugin files directly doesn't fire it at all. On
Multisite, each site's dashboard visit starts that site's migration; upgrading
the network does not sweep every site in one request.

The migration finishes scanning before retrying vetoed deletions and waits an
hour between passes. Panel preferences reset to defaults because the panel
reads only the new preference scope. This also ignores old values in WordPress's
browser backup without changing what WordPress stores for other features.
Uninstall removes the old and current panel scopes from the database; there is
no user scan on upgrade.

Test upgraded and already-migrated data, resumption between requests, and
preservation of unrelated data. The [identifier rename fixture](../tests/identifier-rename.php)
uses the same disposable-site guard and opt-in as the uninstall fixture below.
CI runs both on single-site and network-activated Multisite installations.

## Tests

Node.js 24.5+ is needed only for development, not on the WordPress site. The ownership tests use native Web Locks and BroadcastChannel. After installing the development dependencies and building the assets, run the JavaScript regression tests with `npm test`.

`npm run test:unit` runs without Chromium. `npm run test:browser` runs only the
Chromium tests, one test file at a time (`CHROMIUM_BIN` can override the browser
path). Register tests that launch Chromium with `testInChromium` so both commands
select the right tests. To use real WordPress jQuery, Quicktags and component CSS,
point `WORDPRESS_ROOT` at an unpacked WordPress core directory:

```sh
WORDPRESS_ROOT=/path/to/wordpress npm run test:browser
```

The PHP integration check requires PHP's DOM extension and a disposable single-site
WordPress installation with this plugin active; it refuses multisite before creating
fixtures. It checks the rendered panel's accessibility, creates and removes its own
users, posts and revisions, verifies source permissions, custom
post statuses and nonce separation, and checks that preview reads leave saved posts,
recovery autosaves and metadata unchanged. With ACF active, it also checks historical
fields and rejects attempted ACF updates/deletions of the saved source without
blocking live-editor or unrelated writes:

```sh
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/revisions.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/classic-editor.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/block-editor.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/author.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/date-terms.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/posts-page.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/term-preview.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/term-acf.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/acf-choices.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/preview-fields.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/core-blocks.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/compatibility.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/compatibility-dependencies.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/panel-config.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/row-evidence.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/timber-terms.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/yoast.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/preview-isolation.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/preview-source.php
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/public-redirect.php
```

CI also runs the Post Note fixture on the opted-in `mtflpp_test_` multisite installation. It creates
and removes a subsite with a matching post ID. It checks the custom note, native post fields,
featured image, Post Excerpt block and password handling across the site switch.

The Posts page fixture checks live and saved revision sources on plain and pretty
permalinks, including the native posts loop, queried page, title helpers, and
rejection of invalid tokens or unrelated routes.

The term-preview fixture checks category, tag and public custom taxonomy archives,
including contextual Term Name and Term Description blocks. With Timber it also
checks standard term imports, including Flynt-style filter labels. With Yoast it
checks the default breadcrumb, custom title preservation and the editor’s richer
Description HTML policy. The separate ACF fixture checks native formatting, new
and cleared values, nested fields, paginated row deltas, archive isolation, and that
previews leave saved metadata, relationships, assignments and save hooks untouched.
The ACF choice fixture verifies that Select, Checkbox and Radio can show new choices
without writing shared field definitions in either preview, and that native saves
still persist those options when configured to do so.

The block-editor fixture checks native REST save receipts, source conflicts,
authorization, first-save eligibility, draft/published autosaves, unchanged validation
rejections, metadata errors after partial writes, and isolated serialized-block previews.
It verifies that Classic's native Custom Fields box and REST-only registrations do
not change the editor baseline, and that metadata outside the check can seed the
next snapshot without expiring the current frame or bypassing snapshot integrity
checks.
Client adapter tests cover pre-save draining, request correlation,
legacy meta-box acknowledgement and failure handling, including malformed fingerprints
and read-only errors in strict mode. The HTTP-free preview-isolation fixture checks that
existing site policies are preserved with both core APIs and the older-core fallback.
The HTTP-free preview-source fixture checks the HTML API wire format, Unicode/entity
escaping, element identities, native buffer capture, cleaning and streaming opt-out,
large responses and unchanged non-HTML, error and partial response fallbacks. It also
checks that the plugin leaves template-loading and shutdown hooks unchanged and does
not start a custom output buffer.
Frame/scroll tests cover isolation and capture opt-in, nested insertion/deletion,
repeated content, ambiguity, initialization noise, source-to-live element mapping,
generic visible-container fallbacks with directly visible changes taking precedence,
unchanged custom-widget state, and non-executing source parsing. Native reveal tests
cover details/until-found nesting, named exclusivity, visible summary/wrapper edits,
notification order and immediate owner updates, target removal/reparenting, cancellation,
initial rendering, focus/history preservation and reduced-motion scrolling. Frame tests
also invalidate deferred following after selection changes, closing, navigation or
following being disabled. These do not replace authenticated browser testing of native
editor controls.

The core-blocks fixture renders the actual native Post Excerpt block with explicit,
cleared, whitespace-only and empty excerpts. It checks preview-content generation,
native filter order, formatting, length/more behavior against a saved control post,
unrelated post contexts and Query Loops, original permalinks, cache/global isolation,
permissions and renderer lifecycle. The revisions fixture also checks explicit and
generated historical block excerpts and rebinding to current saved data without writes.

The optional custom-field fixture checks shared live-field saves, paginated repeater
merging, native post-meta block saving/rendering and source isolation. It runs with
ACF Pro or Secure Custom Fields (SCF), and skips when compatible repeater support
is absent:

```sh
wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/acf.php
```

Uninstall checks are destructive and require both an explicit opt-in and the dedicated
`mtflpp_test_` table prefix on a disposable installation. They check revision/user batches,
preserved content, recovery autosaves and unrelated preferences, including multisite.
CI runs them on single-site WordPress, then converts that disposable site to multisite
and runs them again. Never point them at a project database:

```sh
MTFLPP_TEST_UNINSTALL=1 wp eval-file /path/to/meet-the-frontend-live-preview-panel/tests/uninstall.php
```

### Native reveal browser verification

The built checkout was checked on the local WordPress 7.2-beta5 / Flynt development
site using actual core Details, Accordion and Tabs blocks, including their shipped
frontend modules and inline block styles. A disposable administrator edited saved
fixture content through Gutenberg's code-editor textarea; the normal live-preview
request and iframe replacement then revealed and scrolled to the unsaved text.
The checks passed at 1280 × 800 and 390 × 844 preview viewports, preserving textarea
focus, the editor URL and browser history length. Disabled following and the
re-enable baseline refresh opened nothing. Separate actual-output checks confirmed
that core's beforematch handlers synchronize expanded/selected state.

These are Chromium-only checks of this configuration, not a guarantee across all
core versions, themes or engines. Initialization after the bounded rendering
opportunity, asynchronous transitions/lazy content and custom-widget activation
remain outside the reveal contract. The disposable author and content were removed.

### Installed-ZIP verification

The built distribution, not a checkout or symlink, was installed on disposable
single-site WordPress 6.7 and 7.1.4 installations with PHP 8.3.36, Chromium and each
version's bundled Twenty Twenty-Five theme. ACF, Timber and Flynt were absent. A QA
helper selected the classic editor through core's native filter and exposed
read-only saved-parent/recovery hashes; no Classic Editor plugin was required.

Both installations passed authenticated checks for:

- Gutenberg title/content rendering and excerpt capture, with native save/reopen.
- Native featured-image picker selection and edited-attribute replacement/removal,
  isolated from saved metadata until Save.
- Gutenberg and administrator classic native autosaves, including own-draft parent
  updates, published-post recovery preservation and the genuine recovery notice.
- Continued live editing after native saves/autosaves, with saved-parent and recovery
  hashes distinguishing native writes from panel writes.
- Historical/current revision selection with zero live-preview POST writes and the
  packaged revision-browser entry loaded.

The 364-test JavaScript suite and five core PHP fixtures passed against both core
versions; the optional ACF fixture skipped as expected. Core checksums passed, and
browser runs recorded no PHP errors. A separate native-preview comparison reproduced
core's stale Post Excerpt reads on both versions; the focused follow-up below adapts
panel sources without changing ordinary native Preview.

The same ZIP also passed the Gutenberg and classic browser suites on WordPress
7.1.4 with ACF PRO 6.8.11, using separate fixtures with the datastore disabled and
enabled. These checks covered native field capture, datastore API edits without
changing Gutenberg transport metadata, paginated row edits/additions, real native
autosaves, save/reopen, featured images, and delayed/failed native row reloads.
The datastore-only API case skipped when disabled. All six PHP fixtures passed
with ACF active, including native post-meta block saving/rendering and source
isolation. The ACF fixture now gives unsigned inputs a matching Page field-group
location, as ACF 6.8.11 requires; that fixture also passed with ACF 6.8.10.

The remaining administrator classic integration check passed on the existing
Flynt / WordPress 7.2-beta5 / ACF PRO 6.8.10 site with Ask the Origin 1.1.2 and this
plugin active together. A fresh administrator's real heartbeat sent the post form's
nonce, with one core `_wpnonce` and a separate toolbar `ask_the_origin_nonce`.
Native draft autosave, save/reopen, continued ACF editing and published-post recovery
preservation/notices passed. Ask the Origin's saved settings stayed unchanged.

A rebuilt ZIP with the focused core Post Excerpt adapter passed two authenticated
browser workflows per core-only version (6.7 and 7.1.4), plus sign-in setup: published
Gutenberg explicit/cleared/empty excerpts through real autosave and save/reopen;
and historical explicit/generated/current saved excerpts with zero live-preview
POST writes. Parent/recovery hashes distinguished isolated updates from native
writes, and native Preview still reproduced core's unadapted saved excerpt. All
six core PHP fixtures and 364 JavaScript tests passed per version; optional ACF
coverage skipped on these core-only installations. Focused core-blocks, revisions
and ACF PHP fixtures also passed on the existing Flynt / WordPress 7.2-beta5 /
ACF PRO 6.8.10 development site. This follow-up did not repeat the earlier ACF
browser matrix.

These results do not establish a general theme/browser/ACF range or verify other
PHP versions, multisite editor workflows or production deployment. Disposable browser
servers used PHP 8.3.36; the PHP integration fixtures used WP-CLI's PHP 8.3.33. Older
Flynt/ACF browser evidence remains separate and configuration-specific.

### GitHub Actions and releases

For initial WordPress.org submission, set the plugin version, stable tag and changelog,
push only `main`, and build the submission ZIP locally. Do not push a release tag before
approval, SVN access and deployment credentials are in place. Version metadata alone
does not trigger deployment; pushing a release tag does.

The workflows use the same 10up WordPress.org deployment and GitHub release actions
as the other plugins, with an explicit asset build before packaging. Commit Checks
uses floating major action tags for minor and patch updates. The workflows that
publish releases or listing updates pin their actions to exact commits.

- **Commit Checks** runs on pull requests and pushes to `main` and is reused for
  release tags. New PR updates cancel superseded checks on that PR. PHP lint runs
  separately. The JavaScript job lints, builds and runs unit tests once on Node.js 24.
  The browser, PHP integration and WordPress Plugin Check jobs use that same build.
  Chrome runs against the unpacked assets from WordPress 6.9 and latest, without
  installing WordPress or Timber. The PHP 8.3 fixtures run on disposable WordPress
  6.9 and latest installations, both without Timber and with Timber 2.x, plus
  WordPress 6.9 with Timber 1.x. Timber jobs verify the dependency is loaded so
  integration assertions cannot silently skip. An additional job activates Secure
  Custom Fields on the latest WordPress without Timber, verifies the field APIs
  and Repeater support, and runs the post, choice and term fixtures. This covers
  SCF, not ACF Pro; ACF Pro still requires a separate test site.
- **Deploy and Release Plugin** runs on numeric tags such as `1.0.0`, without a `v`
  prefix. The tag, plugin header version and `readme.txt` stable tag must match.
  It waits for the checks, builds again in the deploy job, deploys via
  `10up/action-wordpress-plugin-deploy`, and attaches that action's ZIP to the GitHub
  release. Jobs do not share local generated files. Packaging uses `.distignore`,
  so the ignored local `build/` directory is included, while development files are
  excluded. The archive is checked for matching versions and built assets.
- **Publish listing assets and readme** is a manual workflow restricted to `main`;
  it updates the live WordPress.org listing without a plugin release. Use it only
  after the matching code version has been released.

Configure the repository secrets `SVN_USERNAME` and `SVN_PASSWORD` before publishing
and ensure the WordPress.org slug is available to that account. GitHub's normal
workflow token is used for GitHub releases. Install the attached release ZIP or the
WordPress.org package, not GitHub's automatic source ZIP. These workflows do not
replace authenticated editor-to-frontend browser testing or verify the general
[documented compatibility boundaries](architecture.md).

[Back to README](../README.md).
