# Connectors default-open: per-bot grants retired — 2026-11-15

Production deployed Core/UI release `main-1604d56d-20261115`, commit
`1604d56dab2dfcbf6cde875b6e8dc38bd09eee16` (branch
`feat/connector-default-open`, merged into `main` after re-checking that
`origin/main` had moved to `7097cace`; the deploy commit is a superset of that
release). The owner asked to stop maintaining per-bot connector
authorization: every enabled connector now serves every bot, with no grant
rows or management UI.

## What changed

- `connectorAccess` no longer joins `personal_connector_grants`; a connector
  is looked up by id, workspace and enabled state. Unknown tools still fail
  ("连接器没有这个工具"), gmail without credentials still asks for
  reauthorization, and stale `connectorVersion` is still rejected.
- `grant()` and its handler are gone; `POST /api/connectors/grant` now
  acknowledges legacy bundled clients without side effects.
  `ConnectorView.grants` remains in the state payload as an always-empty
  compatibility field because Android bundles this UI until its next release.
- Remembered `connector.call` approval rules stay valid while the connector
  is enabled, unchanged and still lists the tool; stock-finance discovery
  refreshes only the catalog; feishu no longer auto-grants; assistant
  lifecycle no longer migrates grant rows; migration 52 drops the table.
- The dangerous-call approval layer, each bot's capability policy
  (restricted bots keep their restrictions) and the public-topic
  finance-only boundary are unchanged.
- Web, macOS and iOS drop the grant editors (管理授权/为 XX 选择工具/
  助手授权 sections); wording updated (可用连接器).

## Local verification

- `pnpm typecheck`; renderer smoke `scripts/smoke-gmail-connectors.mjs`
  passed all eleven groups on the merged tree; grant-driven groups were
  rewritten (worker mail search now runs with no grant step).
- Suites touched by the change all pass standalone: connectors,
  gmail-connectors, approval-rules, stock-finance, topic-privacy, feishu,
  workspaces, policy-defaults, tool-catalog (37 + 20 + rest).
- NexClientKit: 245 tests, 0 failures (Mac, fresh temp copy, CRLF→LF).
  `NexBotMac` Debug `BUILD SUCCEEDED`; `NexBotiOS` Debug build against a
  dedicated simulator (created and deleted) `BUILD SUCCEEDED`.
  `scripts/check-ios.sh` fails on main with `no such module 'NexMarkdown'`
  (pre-existing: the script's module path was never extended for the
  NexMarkdown package); the full xcodebuild covers that target.
- Known pre-existing on `origin/main`, reproduced there without my changes:
  `workspaces.test.ts` (404 vs 400 on foreign agents/input),
  `image-models.test.ts` and `sender-device.test.ts`, and the
  `smoke-personal-workspace.mjs` renderer smoke times out at the composer
  wait after the composer-menu group (reproduced on a pristine rebuild of
  main). `feishu` and `stock-finance` flake only under full-suite parallel
  load and pass standalone. None of these relate to this change.

## Deployment evidence

- Staged `/Users/darrenhoo/nexbot/releases/main-1604d56d-20261115` as a copy
  of the running release with `core/` and `ui/` replaced, `package.json` and
  `SOURCE_COMMIT` overwritten. SHA-256 manifests of every file under `core/`
  and `ui/` match the local build byte for byte. `node_modules` reused from
  the previous release (no dependency changes). Throwaway boot answered
  `/health` correctly before the switch.
- Active tasks: 0. Backup
  `/Users/darrenhoo/nexbot/backups/main-1604d56d-20261115-pre/` (sqlite3
  backup API copies of core.db/runtime.db, vault key, config, previous
  run-core.py).
- **Concurrent deploy collision**: between the backup and the switch, another
  session deployed `main-7097cace-20261115` and repointed `run-core.py`;
  my first switch matched the old path and silently kept their release
  running. Detected immediately (the launcher printed 7097cace), re-pointed
  to `main-1604d56d-20261115` (a superset of 7097cace) and restarted again.
  Anyone reading the launcher afterwards sees this release.
- After the switch: same `coreId`; migration 52 applied and
  `personal_connector_grants` is gone (it held 2 rows, preserved in the
  backup); user/bot/connector/conversation/message/todo counts unchanged;
  the process carries all three `NEX_GOOGLE_*` variables.
- Public verification over `https://bot.nexorai.com.cn`: `/health` 200,
  unauthenticated POST 401, OAuth callback probe 400; the served HTML and
  both referenced assets (`personal-BdomTBrF.js`, `personal-ChQOs9kS.css`)
  match the local build byte for byte (one transient empty asset response
  immediately after the restart resolved on retry).

## Limits

- Windows/Web receive the new UI immediately from Core. Android installers
  keep the bundled old UI (grant rows show 0 tools and a no-op 保存授权)
  until the next Android release; Apple apps keep the native grant sheet
  until their next release — the server no-op keeps both functional. No
  client installers were republished and no client versions were bumped.
- `stock_finance_bindings.auto_grant` is now vestigial (kept in schema).
- Previously stored Gmail authorization had already expired (~10-31); the
  operator should reconnect darrenhoomessi@gmail.com — no grant step is
  needed anymore — and the Google OAuth application is still in Testing
  status (seven-day tokens).
