# Image models selected from the existing catalog

Settings → 模型 → 生图模型 lists the existing connection's model catalog. Users
search and select one or more models, then save the selection. There is no
independent model name, endpoint, model ID or API-key form. Image generation
reuses the current connection and its encrypted key. Selections are scoped to
provider/endpoint and protected by version checks. Switching connections hides
selections from the previous connection; switching back restores them.

Schema 20 adds `image_model_selections`. Schema 19's legacy `image_models` table
is retained for rollback but is no longer read or written by generation/settings.
Old CRUD routes return 410 so stale clients refresh instead of saving obsolete
configuration. The current transport supports OpenAI Images-compatible endpoints.
All active Agents have `image.models` and `image.generate` as universal
capabilities. Other customized policy restrictions remain in force.

The assistant calls `image.models` to choose a selected model ID and
`image.generate(prompt, modelId?, size?)` when the user asks for an image or their
task requires one. Generation uses `/images/generations`, one image per call,
and a 180-second cancellable request. Compatible services must return
`data[0].b64_json`. GPT Image model IDs omit `response_format`; other model IDs
request `b64_json`. URL-only responses are rejected without fetching their URLs.
PNG, JPEG and WebP output is limited to 5 MB and uses the existing encrypted,
200 MB attachment store. No real provider compatibility is claimed by fixtures.

Images are published in their own durable assistant message with a download
link, even if a subsequent model reply fails. Preview and download require a
valid session and the original message reference. Redacting that message removes
access. Stop aborts generation and fences late results. Revoked permissions or
changed connections or model selections cannot publish an in-flight result. Interrupted
generation is not automatically replayed on Core restart.

Run only isolated fixtures:

```powershell
pnpm typecheck
pnpm exec vitest run server/personal-os/image-models.test.ts server/personal-os/chat-composer.test.ts server/personal-os/model-catalog.test.ts server/personal-os/agent-model.test.ts server/generated-image.test.ts shared/image-generation.test.ts
pnpm build:core
node scripts/smoke-image-models.mjs
```

The HTTP/worker suite uses disposable databases and loopback synthetic image and
chat services. It covers key privacy and persistence, multiple model selection,
version conflicts, connection scoping, missing selections, corrupt/oversized and
URL-only output, safe upstream errors, cancellation, late authorization changes,
default-policy migration and authenticated image access.

The UI fixture signs into a synthetic identity provider and opens a hidden
Electron window in an owned temporary profile. It selects and deselects existing catalog models
through the settings list, verifies no independent configuration fields appear,
and verifies existing credentials are reused. It sends an image
request through the composer, decodes a deterministic 640×400 raster, and checks
authenticated download bytes and desktop/mobile geometry. Screenshots and report
are written to ignored `release/image-models-verification/`. This verifies the
responsive web renderer, not a packaged native Android release or real paid API.

Selection correction verified 2026-10-19: 15 image, sending-device and public
client-download regression cases passed, along with four real-renderer scenarios,
TypeScript checks and the Core production build. Fixtures use synthetic services;
real provider compatibility is not implied. Two profiles from an earlier version
remain after automatic cleanup approval was rejected; neither contains live data.

The deployment build preserves the public homepage, client downloads and
sending-device context already in production. The Linux candidate upgrades a
synthetic schema 19 workspace to 20 and checks old conversation preservation,
restricted permissions, existing-connection image generation, `currentClient`,
image access, restart persistence and redaction.

Deployment receipts and backups are private. Production checks are read-only:
SQLite integrity, preserved identity/model/memory settings, encrypted credentials,
vault keys, device links, record counts, authentication, health and exact public
UI bytes. The memory plugin's derived origin ciphertext is excluded from byte
comparison because startup intentionally re-encrypts it; all other credential
rows and memory settings are compared. No production conversation or paid image
request is created for verification.

The corrected `image-selection-20261019` release is active as of 2026-10-19.
All four production workspaces upgraded to schema 20 with preservation checks
passing. Eight isolated Linux checks and 32 cases across the six documented
suites passed. Public HTTPS health returned 200; HTML and its three assets matched
the candidate exactly, and protected APIs returned 401 without authentication.
Receipts are in ignored `release/deployment-image-selection/` and server staging;
private data/configuration backups remain on the server.

Model-picker UI correction, 2026-10-19: both image-model and visible-model
sections now open the searchable multi-select list only from their selection
button, and display selected model names as tags when collapsed. The former
show-all / clear / selected-only / refresh toolbar is removed. Done, Escape and
outside clicks dismiss the picker; explicit save persists changes. Visibility
custom IDs remain available through the search input while selecting.

Verified with five image-selection/preview renderer scenarios, nine existing
model-picker scenarios (including the 1,505-model catalog, keyboard navigation,
custom IDs, persistence and mobile bounds), TypeScript checks and production
build. The UI-only rollout keeps the backend running and retains previous hashed
assets plus an index backup. Private receipts are under ignored
`release/deployment-model-picker/`.

Automatic selection saving, 2026-10-19: selecting or deselecting image and visible
models now writes immediately, without either save button. A shared hook serializes
requests using returned versions and keeps the latest draft during rapid clicks.
Failure restores the last confirmed selection and displays an error; a subsequent
selection retries normally. Pending writes continue when navigating within the app.
Eight isolated image UI scenarios pass, including delayed rapid selection,
synthetic save failure/recovery, both selections surviving reload and chat image
output. The nine model-picker scenarios, typecheck and production build also pass.
The `model-autosave-20261019` UI rollout preserves the running backend; public
HTML/assets match the build, health returns 200 and protected APIs require auth.
Private deployment receipts are in `release/deployment-model-autosave/`.

The `model-quiet-20261019` UI update removes the persistent saved badge from both
model selections. Automatic persistence, in-flight status and errors remain.
The eight isolated image UI scenarios and production build passed; the fixture
also asserts that neither selection section renders the saved text. Public HTML
and assets match the deployed build. Receipts: `release/deployment-model-quiet/`.

Universal image access, 2026-10-19: `policyTools` always includes the two image
capabilities. This fixes older Agents whose customized policies were intentionally
excluded by the original default-policy migration. Effective capabilities are
used by the broker, directory, model prompt and state response. Permission edits
retain the image actions, and their UI checkboxes are checked and disabled.
Existing policy rows are not rewritten on startup; schema remains 20. Missing,
archived and out-of-workspace Agents still fail authorization. Stop, identity,
model-selection and in-flight policy-version checks remain enforced.

Verification: image/chat/app suites initially had 51 passes, one deliberate skip,
one old expected-policy assertion and one random browser-blocked fixture port.
The assertion was updated for the new universal grants; both affected app cases
passed on rerun, and all eight image cases passed. Nine isolated real-renderer
scenarios include an Agent with an empty stored tool list, locked-on image
checkboxes and a completed image request. Eight Linux candidate scenarios passed,
including a real worker with a restrictive legacy policy. Typecheck and build passed.

`image-access-20261019` is deployed. Four workspaces retained their policies,
image selections, credentials, settings, identity and records with passing database
integrity checks. Public HTML/assets match the candidate, health is 200 and protected
APIs return 401 unauthenticated. Private receipts: `release/deployment-image-access/`.

## Client image UX (2026-10-23)

The Personal workspace (Windows desktop, browser and Android WebView) and the
native Mac/iOS clients now share the same interaction rules:

- Composer pictures are bare thumbnails. Before upload confirms, the slot is a
  pulsing gray placeholder; after success it shows the real thumbnail. No file
  name, upload label, progress bar or persistent remove badge is shown.
- Tapping or clicking a chat picture opens an in-place lightbox with only a
  top-right X. The X deletes that picture; the backdrop or Escape closes without
  deleting. Deleting one picture keeps the message text and other attachments;
  deleting the only content removes the message.
- Right-click on desktop and long-press on touch open a download-only menu. The
  message row keeps its own 引用 / 复制 actions.
- Pasting an image bitmap into the composer uses the same upload path. The Mac
  editor handles ⌘V; iOS has 粘贴图片 in the composer menu; the web composer
  handles the paste event.

The Core route is `POST /api/agents/messages/image/delete` with `botId`,
`messageId` and `attachmentId`. It checks that the attachment is an image of the
message and refuses while the message's task is still active. Attachments and
their encrypted object-store entries are removed together.

Focused verification on this checkout: `pnpm typecheck` and `pnpm lint` pass;
the focused composer/attachment parser suites pass; `node
scripts/smoke-image-models.mjs` passes 12 isolated hidden-renderer cases,
including the generated-image thumbnail, X deletion preserving text, and the
download-only lightbox control set. `./gradlew :app:assembleDebug` builds the
Android WebView bundle.

The Mac/iOS native changes were reviewed statically on this Windows host; an
Xcode/macOS toolchain is required to compile and run those targets. They reuse
the same Core route and replace the old Quick Look/Preview behavior with the
in-place X-delete viewer.

## Production deployment — 2026-10-23

The Core/UI release `main-d3bfb7e7-20261023` was built from pushed main commit
`d3bfb7e7`. The service was active with no unfinished tasks across all five
workspaces. The previous executable, data directory, environment files and
systemd drop-ins were backed up under
`main-d3bfb7e7-20261023-pre`; the previous release remains available for
rollback.

The isolated candidate check passed image deletion with preserved text,
image-only message removal, UI asset equality and unauthenticated API refusal.
After the switch, database quick/foreign-key checks passed, schema 21 and all
vault/identity/model/secret hashes were preserved, and the five workspaces
retained their record counts. Public HTTPS health returned 200; the HTML and
all three hashed assets matched the candidate exactly; `/api/state` and the new
image-delete route returned 401 without authentication. The new UI bundle
contains the in-place lightbox and compact composer thumbnail markers.

This deployment covers Core and the served Personal UI. Native Mac/iOS clients
were not packaged on this Windows host; Android used the previously built debug
APK. Private receipts are in ignored `release/deployment-image-ux-20261023/`.
