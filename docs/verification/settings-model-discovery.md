# Settings cleanup and model discovery — 2026-10-17

Local desktop changes:

- Removed the personal-workspace subtitle and account workspace fact.
- Removed system information and model request technical details.
- Device settings retain device management and unresolved execution approvals,
  but remove connection explanations and backend configuration cards.
- The shell login screen no longer displays the backend URL or advanced
  connection fields. Its hidden origin still honors the existing saved
  connection and explicit launch overrides.
- Model settings can fetch a provider catalog, select a returned model, or
  retain manual ID entry. Listing does not save or overwrite configuration.

The desktop bridge queries the explicitly entered endpoint/key directly from
the main process, avoiding browser CORS restrictions. Its existing sender and
logged-in-session checks apply. Only HTTPS or loopback HTTP is accepted; URL
credentials, query strings and fragments are rejected. Redirects are disabled,
responses are bounded, and upstream error bodies are not exposed.

The new authenticated Core endpoint `/api/models/list` is also implemented and
tested. It reuses a stored key only when provider and normalized endpoint match,
never returns the key, and rechecks authentication after fetching. This backend
change has **not** been deployed. The installed local client therefore asks for
API Key input when querying a catalog; saved server keys stay on the server.
Normal chat and saved configuration continue using the production backend.
Providers without catalogs retain manual input. Partial catalogs are labelled.

Validation passed:

- 3 shared catalog tests covering credential scope, protocols, redirect policy,
  malformed/oversized responses, and sanitized failures.
- 1 isolated Core integration test covering authentication, saved-key scope,
  unchanged configuration and private credentials.
- 24 isolated renderer cases, including model discovery, dropdown selection
  and saving the selected model through Core.
- 17 checks against the actual local package, including native model discovery,
  simplified login markup, login restoration/logout and account isolation.
- Frontend and server TypeScript, changed-file lint, and UI/Core build.

The tested local package replaced the installation with a backup. All 78
runtime files matched; encrypted saved login remained unchanged, and the app
was reopened. Evidence lives in ignored `release/local-settings-cleanup/`.
Public HTTPS assets still match the previous production release `07b02171`.
No live account was used for verification mutations, and no production service
or real model credentials were queried or changed by the tests.

The updated 23 reference screenshots and index are in `doc/ui/`; the obsolete
system-information screenshot was removed. The screenshot index describes the current reference set.

## Follow-up: visible key and discovery after save

The previous model form cleared its password field after saving. On the
production Core (which has no model-list endpoint yet), a subsequent catalog
request therefore fell back to an unsupported route and displayed a misleading
request to enter a key. This was a client/server version gap, not evidence of
the provider rejecting the user's credential.

The field now has an accessible show/hide button. Saving retains this page's
entered key in memory, remasks it, and allows native discovery immediately
afterward. Changing settings categories remasks it; changing the provider or
endpoint clears it to prevent sending it to a different service. No key is
written to browser storage or returned from the server. Closing settings or
restarting still discards the entered value; previously stored server keys
cannot be revealed by this button. The unsupported-route message now explains
that a key must be entered again for this older service version.

Validation: frontend TypeScript, changed-file lint, UI/Core build, 24 renderer
checks and 21 packaged-shell checks passed. The packaged test explicitly
simulates a 404 model-list route and proves enter, reveal, hide, save, then
native discovery, plus remasking and endpoint-change clearing. Synthetic-only
model and mobile reference screenshots were refreshed. Candidate and install
evidence are in ignored `release/local-key-reveal/`; production was not changed.


## Searchable model picker and visible-model preferences — 2026-10-18

The shared picker serves default, per-assistant chat and memory models. It renders
only the visible rows (44 px each plus overscan), supports search, arrows, Ctrl+Home /
Ctrl+End, Enter and Escape with focus return, and positions in the browser top layer.
A mounted picker retains its fetched catalog between openings. Changing connection
or entered credentials resets that catalog. Manual IDs remain available by typing.

Settings → Model → Visible models stores an optional shortlist by protocol and
normalized endpoint in migration 15. Null means all models, an empty array means
no suggestions; the current model and follow-default option remain selectable.
The choice survives restart and is shared by chat, default and memory selectors.
Changes require workspace ownership, the current connection and an optimistic
version. Hiding models never changes a running assistant's model. The editor can
search the full directory, show only selected entries and add private IDs.

Catalog retrieval no longer cuts results to 1,000. It follows explicit `last_id`
(`after_id`) or `next_cursor` (`cursor`) pagination on the original URL, never
provider-supplied URLs. Repeated/missing cursors and bounded pagination report
`hasMore`; the UI offers manual IDs. Bounds are 100 pages, 30 seconds, 2 MiB per
page and 8 MiB total; pagination stops after at least 10,000 unique IDs. Providers
with other pagination conventions may still require manual IDs. Credentials are
sent only to the validated endpoint; redirects and upstream error bodies stay blocked.

Verification (all synthetic, isolated Core and hidden Electron):

```powershell
node --test shared/model-catalog.node-test.mjs
pnpm exec vitest run server/personal-os/model-catalog.test.ts server/personal-os/agent-model.test.ts
pnpm typecheck
pnpm build:core
node --experimental-strip-types scripts/smoke-model-picker.mjs
node --experimental-strip-types scripts/smoke-model-limits.mjs
node --experimental-strip-types scripts/smoke-continuous-memory.mjs
```

Five catalog unit tests and three backend tests pass. Nine picker UI scenarios
cover 1,505 models over two pages, bounded DOM rows, last-item scroll/search and
keyboard navigation, reopening without another fetch, shortlist persistence,
custom IDs, current-model retention, memory/chat sharing, switching and mobile
bounds. Six model-limit and eight continuous-memory UI scenarios also pass after
adapting their model input helpers to the real picker. Screenshots and JSON reports
are under ignored `release/model-picker-verification`. This verifies bounded
rendering and interaction; it is not a frame-rate benchmark or a live-provider audit.
