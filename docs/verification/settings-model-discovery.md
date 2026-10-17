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
