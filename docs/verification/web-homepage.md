# Web homepage and live client downloads — 2026-10-18

Signed-out browsers that open `https://bot.nexorai.com.cn` see a product
homepage with the existing login card in the hero. Desktop and Android shells
keep the bare login screen. Download cards read the public
`GET /api/client/downloads`, which Core answers from the GitHub release list:
the newest installable asset per platform, repository-hosted URLs only, one
cached lookup (10 minutes, last good answer kept through GitHub failures). The
page CSP stays `connect-src 'self'`. Without an answer the cards open the
GitHub release list.

## Verification

- 4 `client-downloads` cases: per-platform selection, draft/unsigned/foreign
  asset rejection, shared cache and failure fallback, public route without a
  session. Identity, app and conversation-search suites passed; lint,
  typecheck and locale checks passed.
- A disposable local Core (temporary data, synthetic identity, built UI, real
  GitHub lookup) served the homepage under the production CSP with no console
  errors. Cards linked Windows 0.9.4 and Android 0.2.4; both assets downloaded
  with GitHub's recorded sizes. Header login focused the email field and the
  synthetic login reached the workspace. 1440 px and 390 px layouts had no
  horizontal overflow.
- On the production host, the candidate passed 5 isolated checks: upgrade from
  `conversation-search-20261018` preserving history at schema 17, live public
  downloads, authentication on business APIs, retained conversation search and
  homepage assets.

## Production

Core runs `homepage-20261018` (branch merge of main `66e334c4`). No work was
active before the switch. The data/configuration backup and previous release are
retained. Four workspaces, vaults, identities, model and memory settings and
record counts were preserved; integrity checks passed. Public HTML and three
assets matched the build; `/api/client/downloads` returned 0.9.4 / 0.2.4;
unauthenticated business APIs returned 401. Production checks were read-only.
Operational evidence remains in ignored `release/deployment-homepage`.
