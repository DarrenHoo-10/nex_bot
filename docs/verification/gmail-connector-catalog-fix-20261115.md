# Gmail connector catalog fix — 2026-11-15

Production deployed Core/UI release `main-4ee3bbec-20261115`, commit
[`4ee3bbec`](https://github.com/DarrenHoo-10/nex_bot/commit/4ee3bbec808eb8696336238be821e811a21a05dd)
(merged fast-forward to `main` from `fix/gmail-connector-catalog` after
re-checking `origin/main` was still at `dde43fb7`).

## Defect

`ddd967af` (2026-10-25, Feishu catalog integration) excluded Gmail rows from
the shared `connections` list in `ConnectorsPage.tsx` but still derived the
Gmail account list from it, so `accounts` was always empty. The catalog
therefore offered 连接 forever and never 已添加, and the Gmail detail page
rendered no existing mailbox — its 重新授权 control was unreachable.
Reconnecting an existing mailbox became impossible: the flow started without
a target and Core correctly rejected the duplicate account, which the browser
callback page reports only as 连接未完成. The operator hit exactly this loop
on production (relay log 2026-11-14 23:59:04 EST begin without target →
23:59:22 callback, 3.35 s ≈ two completed Google round trips →
duplicate-account rejection; a 00:04 reload replayed the consumed state).

## Fix and local verification

`accounts` now derives from `state.connectors` directly; the MCP list keeps
its own exclusion. `pnpm typecheck` passed. The renderer smoke
(`scripts/smoke-gmail-connectors.mjs`) passed all eleven scenario groups,
including connected-account display, multi-mailbox grouping, reauthorization
with preserved grants and targeted disconnect. Negative control: with the fix
stashed and the bundle rebuilt, the same smoke fails at "connected mailbox" —
the existing suite covers the regression; it had simply not been run since
the filter changed. Screenshots under `release/gmail-verification/`.

## Deployment evidence

- Staged `/Users/darrenhoo/nexbot/releases/main-4ee3bbec-20261115` as a copy
  of the running release with `core/`, `ui/`, `package.json` and
  `SOURCE_COMMIT` replaced (not overlaid — a first overlay attempt left two
  stale hashed assets from the previous build and was redone). The SHA-256
  manifest of every file in `core/` and `ui/` matches the local build of the
  pushed commit byte for byte. `node_modules` is the previous release's
  (Darwin ARM64 natives; the commit changes no dependencies).
- A throwaway Core from the staged release on a fresh data directory answered
  `/health` 200 and served the UI before the switch.
- Active-task check: 0 open tasks, 0 open runs. Backup
  `/Users/darrenhoo/nexbot/backups/main-4ee3bbec-20261115-pre/` holds
  `core.db`/`runtime.db` via the sqlite3 backup API, `vault-key.bin`,
  `core.env`, `core.plist`, `runtime-env.json` and the previous
  `run-core.py`. Baseline table counts (users/bots/connectors/conversations/
  agent_messages/todos = 1/7/3/54/247/3) are unchanged after the restart.
- Switched `run-core.py` to the new release and restarted
  `cn.nexorai.nexbot-core` (launchctl kickstart). Same `coreId` as before the
  restart; the Gmail connector row survives with no error; the process
  carries all three `NEX_GOOGLE_*` variables.
- Public verification over `https://bot.nexorai.com.cn`: `/health` 200,
  unauthenticated `POST /api/...` 401, OAuth callback probe 400; the served
  HTML and both referenced assets (`personal-Bs94QgQ_.css`,
  `personal-peR56hHb.js`) match the local build byte for byte.

## Limits

- Windows and Web receive the fixed UI immediately from Core; Android keeps
  the bundled copy until its next APK release, and no client installers were
  republished, so no client version bump or release page was part of this
  deploy. The Apple catalogs were reviewed and need no change: the native
  SwiftUI account list filters the API connectors list directly and never had
  the broken intermediate filter.
- The stored Gmail refresh token died around 2026-10-31 (Testing consent
  screen yields seven-day tokens). The fix restores the reconnect path; the
  operator still must reauthorize darrenhoomessi@gmail.com and grant Gmail
  tools to an Agent (no grants exist yet). The durable remedy for the weekly
  expiry is publishing the Google OAuth application, which is outside this
  repository.
