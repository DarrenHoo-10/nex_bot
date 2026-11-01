# Todo default date and composer focus — local verification (2026-11-01)

The user replaced the old undated/“未安排” default: when no date is specified,
the Todo belongs to today and must appear in the corresponding week column.
The chat composer's inner thick focus outline should also disappear.

Core now saves today's date for omitted or empty dates, using Asia/Shanghai
rather than the deployment machine's timezone. Explicit dates are preserved.
Legacy rows with an empty stored date are returned as today without changing
their version or writing user data during a read. Until such a legacy row is
saved with a date, this fallback continues to follow today. Newly created items
have a persisted date and do not move to tomorrow automatically.

Web Todo date pickers no longer offer clearing a date; the native editor has an
always-visible date picker and new native DTOs default to today. The server
response drives day/week/month grouping for every client. No database migration
is needed. Model tool help now documents the date default.

The chat textarea overrides the generic workspace focus outline; other controls
retain their focus indicators. Native macOS explicitly disables focus rings on
the composer text editor and scroll view; iOS has no corresponding AppKit ring.

## Evidence

- 24 tests passed across Todo Core, tool discovery and Web calendar suites.
  A temporary Core with synthetic identity/model data verifies both omitted and
  empty dates, stored defaults, explicit-date preservation, legacy HTTP reads,
  unchanged legacy versions, restart behavior and China-time midnight boundaries.
- `scripts/testing/composer-renderer-smoke.mjs` passed in an isolated Chrome
  profile with synthetic API responses and production styles. All three Todo
  cards appear in today's column in week view; next week has zero cards and a
  zero count; Today restores the three cards. Clicking the chat textarea leaves
  its computed outline style `none`. Existing copy/quote/selection checks pass.
  Screenshots were visually inspected in ignored `release/todo-date-evidence/`.
- Frontend/server TypeScript, changed-file oxlint and whitespace checks passed.
- Apple Todo package tests: 3 passed in a fresh temporary source directory on
  `mac-air`; macOS Debug and iOS Simulator Debug compilation passed. Sources
  were converted to LF. The iOS build used a generic destination and did not
  boot or modify any simulator. The temporary source directory was removed.

## Limits

All mutations used disposable data. No production data, release version, update
manifest, installer, deployment or publication was changed. Native interactive
Todo acceptance was not exercised. The build copy omits the device executor;
its warning is unrelated to the date and focus changes.
