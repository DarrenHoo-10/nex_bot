# Conversation history search

Verified 2026-10-18 in disposable Core data and an isolated, hidden Electron
profile. All identities and messages were synthetic; no live account data was
read or changed.

The sidebar now searches message content across the account's active assistants.
Results show the assistant, timestamp and excerpt. Search is a literal substring
match, including `%`, `_` and backslashes, with 50 results per page. Clearing the
query restores the conversation list. Archived assistants and forgotten records
are excluded. Search is not limited to the most recent 100 messages.

Selecting a result loads up to 40 preceding messages and 60 messages from the
match onward, then scrolls to and outlines the match. Returning to latest or
sending a message leaves this history view. A result forgotten before or during
viewing falls back to the latest messages.

Commands:

```sh
pnpm exec vitest run server/personal-os/conversation-search.test.ts
pnpm build:core
node --experimental-strip-types scripts/smoke-conversation-search.mjs
pnpm typecheck
pnpm lint
git diff --check
```

Results: 2 backend tests and 7 UI cases passed. Backend checks cover old records,
cross-assistant results, literal matching, pagination, authentication, invalid
queries/cursors, assistant scope, archived assistants and forgotten records.
UI checks cover cross-assistant search, locating an old message, returning to
latest, pagination, empty results, clearing, mobile layout and disappearing
targets. Build, type checking and lint passed.

Ignored evidence is under `release/conversation-search-verification/`: report
JSON and desktop, located-message and mobile screenshots. The fixture closes
only its owned processes and removes only its temporary directory.

This verifies the shared web renderer at desktop and mobile sizes, not a new
native client package or production deployment. Large-history search throughput
was not benchmarked.

## Local deployment

2026-10-18: the existing loopback Core at `127.0.0.1:8799` was upgraded after
confirming there were no active tasks. The staged server's 608 files matched the
tested build. The previous data directory and client UI were backed up locally;
the installed client's UI override and local launcher were updated.

Read-only post-deployment checks confirmed the same Core identity, matching HTML
and all three referenced assets, SQLite quick-check success, and unchanged bot,
message and task counts. No live chat or settings mutations were used for tests.
The public service and downloadable packages were not updated during that local
deployment.

## Published preview

The subsequent `nexbot-v0.9.4-preview.1` release includes Windows 0.9.4 and
Android 0.2.4 (version code 204). The shared search UI is bundled in both clients.

- The exact Windows portable executable passed 24 isolated login, lifecycle and
  account-workspace checks.
- Android Core and App JVM suites passed (47 and 26 tests). The exact APK passed
  20 workspace checks plus 3 search/navigation checks on an owned read-only
  emulator instance. APK v2 signature verification passed.
- The Linux candidate passed 9 isolated checks, including upgrading synthetic
  history from the preceding release, older-message navigation, pagination,
  literal search, authentication and forgotten/archived record exclusion.
- Production cutover preserved four account workspaces, vaults, identities,
  model and memory settings, and existing records. Database integrity checks
  passed; schema remains 17. Public HTML and all three referenced assets matched
  the candidate, health returned 200 and unauthenticated search returned 401.

Production data/configuration backups and the previous executable are retained
privately. Only the EXE, APK and checksum file are public download assets.
Windows remains unsigned; Android uses the existing debug signing identity.
Operational evidence remains in ignored `release/deployment-conversation-search`.

Android search verification command (after starting the owned workspace fixture
and forwarding its WebView):

```sh
node scripts/smoke-android-conversation-search.mjs /path/to/fixture.json 9227
```
