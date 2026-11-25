# Integration hooks

Use the `mtflpp_` PHP hooks and `mtflpp.` browser setup actions documented here.
Integrations using the previous names must update their registrations; no hook
aliases are provided.

## Editor integration hooks

Plugins and themes may ship their own adapters. There is no discovery mechanism,
manifest or integration registry: load PHP normally and register browser setup through
WordPress hooks. Built-in ACF and Yoast integrations use this same contract. Core
editors do not import, construct or inspect optional plugin integrations.

### Try it: a post note without ACF

The [Post Note example](examples/post-note/post-note.php) registers one public, plain-text post meta field.
WordPress's built-in `core/post-meta` block binding supplies the editor control, the native Save and the
frontend output. Gutenberg includes unchanged fields when any post meta is edited, so the
[editor adapter](examples/post-note/preview.js) compares just the note with its saved value.

1. On a test site with the panel active, copy [`docs/examples/post-note/`](examples/post-note/)
   into `wp-content/plugins/post-note/` and activate **Post Note – Live Preview Example**. The example
   is not included in release packages. Alternatively, copy `post-note/` into your theme, require its PHP
   file from `functions.php`, and replace `plugins_url('preview.js', __FILE__)` with
   `get_theme_file_uri('post-note/preview.js')`.
2. In the **Block Editor** for a regular post, paste this bound Paragraph into the code editor, switch back
   to the visual editor, type a note in the paragraph and save the post. Leave the legacy **Custom Fields**
   panel disabled so the binding is editable.

   ```html
   <!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"example_post_note"}}}}} -->
   <p></p>
   <!-- /wp:paragraph -->
   ```

3. Open the live preview. Replace or clear the note: the paragraph shows the edit, while the saved post
   keeps its old note until you use WordPress's normal Save. A template using
   `echo esc_html(get_post_meta(get_the_ID(), 'example_post_note', true));` gets the same scoped read.

For a submitted note, the PHP adapter checks the post, field permission and input type, then applies the
post field's registered sanitizer. It uses `update_metadata('post', $sourceId, ...)` on the owned revision:
**do not use `update_post_meta()` here**, as it redirects revisions to their parent. Before returning a
preview URL, the adapter verifies the edited value (an empty string when cleared). If the note was
omitted, it checks that the saved rows were copied. When neither the post nor the revision has a note,
WordPress supplies the post field's default. The live read is limited to the selected site, post and key;
term and historical previews are unchanged.

### PHP hook context

PHP filters receive the extendable value first and context second:
`$value, array $context`. PHP actions receive only `array $context`. Register two
accepted arguments for filters when your callback needs context.

Post preview contexts start with these core-owned identities, in this documented order:

```php
[
    'post' => ['id' => 42],
    'source' => null, // Or ['id' => 901] when this operation has established a source.
]
```

`post` identifies the original post. `source` identifies the prepared or selected
preview source; it is not a mutable selection instruction. Form-value filters add
`input` after these identities; script-dependency filters add `config`. Other hooks
receive identities only. There is no screen/mode discriminator: subscribe to the
appropriate feature hook. Key order aids readability; callbacks should access keys
by name, not position.

Context is separate from the filter's returned value. Mutating a callback's context
does not replace core's post or source identity. Integrations still run as trusted PHP
code, not inside a security sandbox. Original editor input remains untrusted.
This context does not restructure native form fields or browser configuration.
The request's `base` key is an opaque fingerprint of the saved editor state, not a
context envelope or a hash of every value stored on the post.

### PHP configuration and assets

Only the selected screen's hooks run:

| Configuration filter | Arguments and contract |
| --- | --- |
| `mtflpp_classic_editor_preview_config` | `array $config, array $context`. Extend Classic Editor live-preview configuration before JSON encoding. |
| `mtflpp_block_editor_preview_config` | `array $config, array $context`. Extend Block Editor live-preview configuration before JSON encoding. |
| `mtflpp_revision_browser_preview_config` | `array $config, array $context`. Extend read-only revision-browser configuration; this screen does not capture edits or prepare live previews. |

Configuration context contains `post` and a null `source`. Preserve the configuration's core
identity, endpoint, nonce, baseline and availability values where present, existing
integration keys and labels. Shared panel labels are merged afterward.

| Script-dependency filter | Arguments and contract |
| --- | --- |
| `mtflpp_classic_editor_preview_script_dependencies` | `string[] $dependencies, array $context`. Add scripts for Classic Editor preview. |
| `mtflpp_block_editor_preview_script_dependencies` | `string[] $dependencies, array $context`. Add scripts for Block Editor preview. |
| `mtflpp_revision_browser_preview_script_dependencies` | `string[] $dependencies, array $context`. Add scripts for the read-only revision browser. |

Dependency context contains `post`, a null `source` and `config`: that screen's
already-filtered configuration. Register scripts with `wp_register_script()` and append
their handles, preserving previous dependencies. Generated WordPress runtime
dependencies are merged afterward. Register a common callback on multiple screen
hooks if you support more than one screen; no entry argument or screen check is needed.

Register an external script as an entry dependency so its setup listener exists before
synchronous editor initialization. The external script must declare `wp-hooks` and any
other WordPress packages it uses. It must register setup without reading the panel's
configuration global: dependencies execute before the entry's inline configuration.
The setup callback receives the complete configuration later. Register it at script
execution, not in a DOM-ready callback, asynchronous import or timer.

```php
add_filter('mtflpp_classic_editor_preview_script_dependencies', function (
    array $dependencies,
    array $context
): array {
    wp_register_script(
        'vendor-preview',
        plugins_url('preview.js', __FILE__),
        ['wp-hooks'],
        '1.0.0',
        true
    );
    $dependencies[] = 'vendor-preview';
    return $dependencies;
}, 10, 2);
```

A theme can use `get_theme_file_uri()` instead of `plugins_url()`. Enqueue integration
styles through normal WordPress APIs. Do not declare an unavailable optional script
as a dependency: WordPress will also withhold the dependent entry.

### Comparison exclusions

`mtflpp_preview_comparison_excluded_selectors` filters the complete `string[]` exclusion
policy for Classic, Block Editor and read-only revision previews. The term editor
uses the separate opt-in `mtflpp_term_preview_comparison_excluded_selectors` filter.
Each runs once for its selected screen. On post screens it runs after the
configuration filter and before the script-dependency filter. Both receive
`array $selectors, array $context`. The post filter receives `post.id` and
the term filter receives `term.id` and `term.taxonomy`. Both have a null `source`.

Defaults are `script`, `style`, `noscript`, `template`, `link`, `meta`, `nav`,
`[role="navigation"]`, `[aria-live]`, `input[type="hidden"]` and `table.xdebug-error`.
Matching elements and their descendants do not participate in comparison; their actual
rendered output is never hidden or changed. Attribute normalization, content-root
selection and ambiguous-match handling remain comparison logic, not this policy.
Attribute normalization ignores event handlers, nonce/token attributes and the internal
source-mapping attribute. Ordinary ARIA labels and states remain comparable. Identity
and reference-only changes, such as IDs and `aria-labelledby`, require corroborating
authored-value changes rather than triggering following on their own.

A site-specific plugin, MU plugin or theme can extend the policy without browser code:

```php
add_filter('mtflpp_preview_comparison_excluded_selectors', static function (
    array $selectors,
    array $context
): array {
    $selectors[] = '[data-vendor-runtime]';
    return $selectors;
}, 10, 2);
```

Preserve previous contributors when appending. Callbacks may also remove selectors or
return a replacement list; return `[]` to remove every configured exclusion. The final
list is delivered as `comparisonExcludedSelectors`; JavaScript does not merge another
default list back in. Prefer component/integration selectors across the site rather
than post-ID lists. Context is available only if a real conditional exception is needed.
With source capture, selectors match pre-JavaScript HTML; otherwise they match the loaded
document, so choose stable markup selectors rather than script-only state.

Invalid PHP return shapes (not an array of nonempty strings) retain the shipped
defaults; sparse keys are reindexed before JSON encoding. Syntactically invalid CSS
selectors are ignored individually in the browser without disabling valid exclusions
or scrolling. Keep exclusions limited to known non-author output: editing an excluded
region will not trigger change-following.

### Browser setup and lifecycle

Register synchronously with the action for the editor you support:

- `wp.hooks.addAction('mtflpp.classicEditor.previewSetup', 'vendor/integration', callback)`
- `wp.hooks.addAction('mtflpp.blockEditor.previewSetup', 'vendor/integration', callback)`

Only that editor's setup action runs, once per live editor session. The term editor
and the read-only revision browser have no browser setup action. An adapter supporting
both post editors registers both actions; it does not need to inspect a `screen` discriminator.

Both setup contexts contain:

- `config`: the final configuration for that editor.
- `hooks`: a native `wp.hooks.createHooks()` instance private to this editor session.
- `changed()`: notify the core preview that integration inputs or readiness changed;
  never refresh, save or acquire preview ownership independently.
- `onDestroy(callback)`: register cleanup immediately after installing listeners or
  subscriptions. Cleanup runs once, in reverse registration order, on teardown or
  setup failure; one failed cleanup does not prevent the others.

Classic setup additionally supplies `form`, `watchEditor(tinyMceEditor)` and
`cancelNativeSave()`. These connect native field editors and validation without
replacing WordPress saves. Block setup does not supply these form helpers; its local
observation and value filters receive public editor selectors instead.

Use the context's **local** `hooks`, not global `wp.hooks`, for the hooks below.
Callbacks are synchronous and use normal WordPress namespaces/priorities. Multiple
integrations may contribute; preserve earlier results and use distinct payload keys.

##### Classic Editor local hooks

| Local hook | Arguments and contract |
| --- | --- |
| `previewFormBody` (filter) | `URLSearchParams body, FormData nativeValues`. Append owned fields to the existing core form body. Preserve repeated keys, empty values and earlier contributors; return the body, never `null`. Core sets the baseline afterward. Do not override core fields. |
| `previewPauseReason` (filter) | `string reason`. Preserve an existing nonempty reason or return your own waiting message; return an empty string when ready. Call `changed()` when readiness changes. |
| `nativePreviewHandoffError` (filter) | `Error\|undefined error, boolean saved`. Preserve prior errors. Return an error when an acknowledged native Preview changed the saved baseline in a way that makes retained integration inputs unsafe. Core owns baseline verification. |
| `nativeSaveValidationPending` (filter) | `boolean validating`. Preserve a previous `true`, or return whether your native validator is still running. This only informs cancellation detection; it must not implement validation or saving. |

##### Block Editor local hooks

| Local hook | Arguments and contract |
| --- | --- |
| `additionalPreviewValues` (filter) | `object values, editorSelectors`. Contribute a plain object of strings, finite numbers, booleans or null; omit unavailable keys. See the transport rules below when PHP needs a specific type. Called during observation and capture; return stable, cheap values without serializing core content, dispatching store changes or mutating selectors. Adding, changing or removing a key schedules an update. |
| `previewFormBody` (filter) | `URLSearchParams\|null body, null nativeValues`. Starts with `null` and no native form values. Return the incoming body unchanged when contributing nothing; create a `URLSearchParams` only if you need form fields and no body exists yet. Preserve previous contributions, repeated keys and empty values. Core values, including `additionalPreviewValues`, and the baseline are set afterward. Do not override core fields. |
| `previewPauseReason` (filter) | `string reason, editorSelectors`. Preserve an existing nonempty reason or return your own waiting message; return an empty string when ready. Call `changed()` when readiness changes. |
| `observePreviewInputs` (action) | `editorSelectors`. Runs when the selected post is ready, before integration readiness and cheap values are read. Observe public state; do not save or dispatch editor changes. |
| `nativeMetaboxSaveAcknowledged` (action) | No arguments. Runs only after the native legacy meta-box save has a valid fingerprint acknowledgement. An integration may wait for its own asynchronous refresh before becoming ready again; this action does not prove that refresh finished. |

**Types on the wire.** With no form contributor, Gutenberg sends JSON and PHP receives booleans,
finite numbers, strings and `null` as such. ACF or *any* contributor returning a form body switches
custom values to strings: `false` becomes `"false"`, `0` becomes `"0"`, and `null` becomes `""`.
An omitted key stays absent. If the distinction matters, `JSON.stringify` **only your own value**
(including string scalars) before returning it in `additionalPreviewValues`. In PHP, use
`array_key_exists()` to distinguish omission, require a string, decode it once with `JSON_THROW_ON_ERROR`,
and reject malformed JSON or a value outside your field's schema with `WP_Error`. Don't coerce other
adapters' fields. A text-only field such as the post note needs no extra encoding.

**Preserving form entries.** Append to the incoming `URLSearchParams`, or copy an existing body with
`new URLSearchParams(body)`. Don't copy through `Object.fromEntries(body)`: only the last entry with
each name survives. Use a name such as `vendor_choices[]` for a PHP list, append each value in order,
and keep intentionally empty entries. A no-op returns its input, **not** a fresh body or an unconditional
`null`.

If an existing Classic Editor meta box already saves `example_post_note`, it can reuse the example's PHP
preview adapter. Register its script as a Classic entry dependency. Read the native form data so a
disabled input is omitted and an intentionally empty value is still submitted:

```js
wp.hooks.addAction('mtflpp.classicEditor.previewSetup', 'example/post-note', ({ form, hooks, changed, onDestroy }) => {
    const input = form.querySelector('[name="example_post_note"]');
    if (!input) return;
    input.addEventListener('input', changed);
    onDestroy(() => input.removeEventListener('input', changed));
    hooks.addFilter('previewFormBody', 'example/post-note', (body, nativeValues) => {
        const note = nativeValues.get('example_post_note');
        if (typeof note === 'string') body.append('example_post_note', note);
        return body;
    });
});
```

Capture alone does not make a field previewable: its PHP adapter must validate and
store the input on the owned preview source through the preview hooks below, then
adapt only the authorized frontend reads. Never write the saved parent or recovery
autosave. Check optional capabilities when used; an absent integration should not
subscribe or contribute assets. If PHP detects an integration but its browser API is
missing, fail visibly rather than silently dropping its fields.

Thrown setup/lifecycle errors stop preview writes with `mtflpp_integration_failed` and
retain the last frame where available. Invalid capture results, including removed or
overwritten Classic core fields, fail the same way. Native WordPress saving remains
independent; in particular, a failed post-save observer must not reject the native
save response.
Capture checks the **final** result, not each contributor's intermediate body. A valid final body
(or a final `null` in Gutenberg) can silently lose an earlier adapter's fields. A ready preview is
not proof that every contribution arrived. If a field is required, its PHP adapter should verify it
against an expectation independent of that field's presence. A known integration failure may throw
an `Error` with code `mtflpp_integration_failed` and a
translated user-facing message; unexpected exceptions receive the shared explanation.
Reloading creates a fresh session. Local hook instances are not reused after teardown.

`tests/editor-extensions.php` checks screen-specific configuration/assets, structured
context and context-mutation isolation, multiple contributors, ordering, JSON escaping
and revision isolation. `tests/editor-extensions.mjs` checks
external browser contributions alongside ACF, readiness, repeated/empty form values,
absent dependencies, failure isolation and per-session cleanup. Screen regressions
also verify native save responses and contributed-value removal.

The initial extension API was checked with the full JavaScript suite and core PHP
fixtures on disposable WordPress 6.7 and 7.1.4 installations, PHP 8.3. Additional PHP
checks passed with ACF PRO 6.8.10 and Yoast 28.8 on 7.1.4, and with Timber 2 on 6.7.
Native-event and save-cancellation Chromium fixtures also passed using each core
version's bundled jQuery/Quicktags. These are focused regression checks, not a new
installed-package or authenticated end-to-end browser compatibility claim.

## Preview integration hooks

These feature hooks share the PHP context convention above. Their names describe the
extension opportunity, not the temporary storage mechanism.

### Preparing a live preview from unsaved edits

Classic and Block Editor requests use the same preparation workflow after core has
authorized the post and checked its saved-state fingerprint. Revision browsing never
enters this workflow.

| Hook | Arguments and contract |
| --- | --- |
| `mtflpp_live_preview_form_values` (filter) | `array\|WP_Error $formValues, array $context`. Context contains `post`, null `source` and `input` (the original unslashed editor request). Extend unslashed native form values before slashing/writing, or reject with `WP_Error`; preserve an earlier error. Validate your own input. This is form-save data, not a universal metadata map. |
| `mtflpp_live_preview_custom_fields_initialized` (action) | `array $context`, containing `post` and initialized `source` identities. Runs once per preview preparation, including when reusing a preview revision. Saved custom-field values are available as the starting point. Invalidate integration caches or apply previously validated values. Submitted changes and native save hooks still follow; this does not mean the preview is ready. |
| `mtflpp_live_preview_preparation_error` (filter) | `?WP_Error $error, array $context`, containing `post` and the established `source` identity, or null if no source identity was established. Verify contributions and preserve earlier errors. Runs after success, rejection or exceptions. Rejected form values pass their `WP_Error`. Core write errors still take precedence. |
| `mtflpp_live_preview_preparation_finished` (action) | `array $context`, with the same identities as the verification filter. Release temporary state here, even if verification threw and later verifiers did not run. Cleanup should be idempotent and must not throw. |

At `mtflpp_live_preview_custom_fields_initialized`, the plugin's internal preview
keys for author, date, and taxonomy selections may already contain unchanged
values. Do not depend on those keys being absent or on their metadata delete/add
hooks firing on every refresh.

For example, preparation context is:

```php
[
    'post' => ['id' => 42],
    'source' => null,
    'input' => [
        'post_title' => 'Unsaved title',
        'vendor_note' => 'Unsaved note',
        // Other original editor input; adapters validate their own fields.
    ],
]
```

Core chooses the write target independently of context or the form's `post_ID`.
A preview write dispatched during another preview write returns `mtflpp_preview_busy`
without starting preparation. The preview does not expose caller uploads to native
save hooks. Native WordPress saving remains independent of this lifecycle.

#### ACF field isolation

ACF uses its native form and post-meta block save handlers on the owned preview
revision. Bidirectional updates and attachment parenting are suppressed only for
writes originating on that revision. Taxonomy fields with Save Terms retain their
values without changing real term relationships. A preview dispatched from a native
ACF save neither drains nor clears the caller's queued assignments, so explicit Save
still applies them. Native ACF's callback order at each priority is preserved.
Where ACF lacks an origin-aware bidirectional veto, the adapter guards its native
field handlers. Custom field handlers must provide their own revision-write guards.
The adapter restores only callback slots that still contain its wrapper.

For live ACF reads, Load Terms uses the preview's Save Terms selections (combined
per taxonomy within a native ACF save). If none were submitted for that taxonomy,
it uses the core preview term selection or the saved assignments. The overlay applies
only to ACF post reads for the bound post and source; user and term reads with matching
numeric IDs still follow ACF's normal behavior. The core term display overlay is separate.

### Selecting a source for frontend rendering

Both actions run only after core authorizes and selects the source and installs its
native read overlays. They receive `array $context` with `post` and `source`
identities only. There is no read-only boolean: the action identifies the mode.

| Action | Contract |
| --- | --- |
| `mtflpp_frontend_live_preview_source_selected` | Bind reads for the original post to the authorized source containing unsaved edits. |
| `mtflpp_frontend_saved_preview_source_selected` | Bind read-only reads for the original post to the selected saved version or current saved post. |

For example, `['post' => ['id' => 42], 'source' => ['id' => 901]]` identifies the
post and its selected source. These are identities, not a mutable preview object or
authorization token. Supporting both modes means subscribing to both actions;
adapters may share their internal read-binding implementation.

These are trusted PHP integration points, not authorization APIs. Adapters must not
select another source, modify the saved parent/recovery autosave, broaden permissions
or affect unrelated objects. Historical preview storage uses WordPress revisions;
metadata writes must not use helpers that redirect revision IDs to the saved parent.

Hook lifetime is part of each compatibility owner's contract:

- Lifecycle subscriptions (`mtflpp_live_preview_*` and `mtflpp_frontend_*_preview_source_selected`)
  remain registered for the PHP request so the owner can handle later operations.
  Registering these does not call optional APIs.
- ACF's save monitor and side-effect guards exist only for an initialized owned
  write. Cleanup runs after success, rejection or exceptions, including exceptions in
  payload preparation or verification.
- Keep frontend read filters active through rendering. If another source is selected in the same
  request, replace or release the old binding. The Post Note example reuses the same filter for a new
  live post and removes it for a saved source or an unsupported post type. It needs no `shutdown`
  callback: WordPress filters and the selected IDs are local to that PHP request.
- Built-in adapters with more state have explicit teardown. For example, ACF's `unbindPreview()`
  also clears value caches, restores wrapped callbacks and removes write guards before rebinding
  and at late shutdown.
- Availability checks happen inside the adapter at use time, not once in the bootstrap:
  other plugins and a theme's Timber autoloader may load later. Missing dependencies or
  required read APIs install no third-party read/write filters. Unbound callbacks are
  safe no-ops. Core-only writes work without ACF; submitted ACF values without its save
  APIs return a controlled error rather than being silently discarded.

The revision fixture exercises the real compatibility subscriptions: denied requests
never announce a source; live, historical and current sources rebind correctly; Timber
imports preserve unrelated data; ACF history remains read-only. With Timber 1 it checks
that directly constructed posts import metadata from the authorized live source. With
Timber 2 it checks the native post import for live and saved sources. The compatibility
fixture verifies that only the installed Timber version's hooks are registered. The
taxonomy fixture covers post term lists on both versions without changing raw
relationship reads. Term archives on Timber 1 use WordPress's native preview term and
display filters: a Twig `term.name` from a fresh lookup by ID may still show the saved name.

The compatibility fixture checks core-only writes, lifecycle/error propagation,
exception cleanup and read-filter rebinding/release without requiring ACF or Timber. The
dependency fixture simulates unavailable ACF/Timber and partial ACF APIs without
changing site configuration. Run `wp eval-file tests/acf.php` on a disposable site
with ACF Pro active to exercise the actual ACF handlers. The fixture covers fresh
and reused sources, unchanged parent and recovery data, nested preview dispatch,
explicit Save with a pending term queue, hook order, colliding ACF IDs, warmed field
caches, guard cleanup, repeater merging, post-meta blocks, and signed field lists on
ACF versions that use them.

Verify both screen-to-preview workflows on a disposable WordPress site with the
theme and optional integrations you intend to use.


[Back to README](../README.md).
