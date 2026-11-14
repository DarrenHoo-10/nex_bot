# Agent mode MVP: browser smoke and test suites (2026-11-15)

Scope: plan section 8.2. The Agent sessions page in a real browser against a
fixture Core, a real device process running the CLI agent bridge, and the real
herdr-core on Windows. No real `claude` or `codex` was started and no file under
the user's `~/.claude` or `~/.codex` was read or written. The device saw only
temporary directories and a restricted PATH.

Tested tree: committed `df64d83c` ("Show CLI agent requests, supervision and
forking in the web client"), checked out in a throw-away worktree. The first runs
were on `2554e270` with the same smoke result; the final run and the suite table
below are `df64d83c`. Uncommitted work in the main checkout (hooks, triage,
plugin) is not covered.

Result: 18 of 19 smoke steps pass. One step fails on a real bug (see Bugs). The
smoke keeps the correct assertion, so it stays red until the bug is fixed.

## Environment

- Windows 11 Pro 10.0.26200, Node v24.18.0, x64.
- Browser: Microsoft Edge 157.0.4341.46, headless, driven over the DevTools
  protocol with `ws` (`CHROME_BIN` selects another Chrome or Edge).
- herdr-core: `hc 0.1.21`, staged in `dist-native/herdr-core/win32-x64/` by
  `corepack pnpm build:herdr-core`. Each run uses its own session
  `nexbot-<8 hex>` and pipe `\\.\pipe\nexbot-hc-<8 hex>`.
- The user's classic `herdr.exe` (pid 50028) ran throughout; its pid was
  unchanged before and after every run.

## Commands

```
node scripts/build-personal.mjs --core
corepack pnpm build:herdr-core
node scripts/smoke-cli-agents.mjs [--skip-build]
corepack pnpm exec vitest run shared server/personal-os/cli-agents-node server/personal-os/cli-agents src/personal/cli-agents
```

`scripts/smoke-cli-agents.mjs` builds Core and stages herdr-core only when
`dist-personal/server/core/index.js` or the herdr-core binary is missing, so
delete `dist-personal` after changing code. It exits 1 when any step fails.

## What the smoke builds

- A fixture Core on a random loopback port in a temporary directory, with the
  fake identity from `server/personal-os/testing/fake-identity.ts` and a fake
  model. The page logs in through the real login form.
- A device process (esbuild bundle of the real `DeviceNode` and bridge) paired
  to that Core, with temporary `USERPROFILE`, `HOME`, `APPDATA`,
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and a PATH of only a shim directory, the
  Node directory and System32. A `where.exe` pre-flight proves `claude` resolves
  only to the stand-in `claude.cmd` and that no `codex` exists.
- The stand-in `claude.cmd` runs a wrapper that writes
  `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` (idle, or busy after a line that
  starts with "work"), appends Claude-format transcript lines under `projects/`,
  and then runs `scripts/testing/fake-tui.mjs`.
- Synthetic history: Claude folder `alpha` ("重构解析器", "Fix the flaky test"),
  Codex folder `beta` ("整理发布说明").

## Results

| # | Step | Result |
|---|------|--------|
| 1 | Prerequisites | PASS. Node, Edge and `hc 0.1.21` found. |
| 2 | Isolation pre-flight | PASS. `claude` resolves only to the stand-in, no `codex`. |
| 3 | Fixture Core, sign in, pair the device | PASS. The sessions API answers 401 without a session. |
| 4 | Device process with real herdr-core | PASS. Engines `["claude"]`, 3 synthetic sessions visible to Core. |
| 5 | Browser start and open Core | PASS. |
| 6 | Log in through the form | PASS. |
| 7 | Agent 会话 entry and grouped list | PASS. Device 演示电脑 > alpha (2 Claude rows) and beta (1 Codex row), all 已停止. |
| 8 | Start a new Claude session | PASS. Row under folder `gamma`, chip 空闲, shown after the first transcript line. |
| 9 | Terminal observe | PASS. Status 只看, the screen shows `fake>`. |
| 10 | 操作, type a line | PASS. Typing `hello agent` shows `you said: hello agent`. |
| 11 | Screenshot, terminal at 1440 | PASS. |
| 12 | Transcript view | PASS. Both the first line and the line typed in the terminal appear as user messages. |
| 13 | Composer send | PASS. The reply appears, the composer clears, no error. |
| 14 | Interrupt | PASS. 运行中, then 中断, then 空闲; the program printed `[interrupted]`. |
| 15 | Draft refusal | FAIL. See Bugs. Nothing reached the terminal and the draft was left alone (both asserted). |
| 16 | Continue a stopped session | PASS. 继续 resumes "Fix the flaky test" in a nex_bot terminal. |
| 17 | Screenshots at 1440 and 390 | PASS. No horizontal overflow; the terminal fits 390 px. |
| 18 | No uncaught page errors | PASS. No exceptions and no `console.error`. |
| 19 | Cleanup | Verified in the log and by hand, see below. |

Screenshots (git-ignored, written by the smoke; each checked for at least 12
sampled colours and a dominant colour below 98.5 percent):

- `release/agent-mode-smoke/desktop-1440-terminal.png` (1440x900)
- `release/agent-mode-smoke/desktop-1440-list-transcript.png` (1440x900)
- `release/agent-mode-smoke/mobile-390-list.png` (390x844)
- `release/agent-mode-smoke/mobile-390-terminal.png` (390x844)

Observation: after 继续 the pane opened on the 对话 tab, because the page keeps
the tab chosen for the previous session. The smoke selects 终端 explicitly.

## Bugs found (not fixed here)

1. A refused send while someone is typing shows the wrong text.
   - Files: `server/personal-os/cli-agents/routes.ts` lines 42-43 and 88
     (`cliErrorResult(error.code)` rebuilds the body from the code and drops
     `CliOpError.message`), and `src/personal/cli-agents/api.ts` line 31
     (`cliErrorText` prefers the code text over the server message). The code
     text for `busy` is "上一个操作还没完成" (`shared/cli-agents.ts` line 323).
   - Symptom: the device correctly answers `busy` with "电脑上有人正在输入"
     (`server/personal-os/cli-agents-node/bridge.ts` line 1217, covered by
     `server/personal-os/cli-agents-node/bridge.test.ts`), but the composer
     shows "上一个操作还没完成", which tells the person nothing about the draft.
   - Reproduction: run the smoke, step 15. In the terminal (操作) type `draftx`
     without Enter, then send "must be refused" from the composer; after about
     6 seconds the composer shows the generic text.
   - The refusal itself works: the message never reached the program and the
     draft survived.
2. `scripts/testing/verification-docs.test.ts` ("cite test files that exist")
   fails on the committed `docs/verification/agent-mode-spike-20261115.md`,
   which names the herdr-core client's unit test file without its directory. It is a documentation
   problem, not a code problem; this record uses full paths.

## Unit and integration suites

Command: `corepack pnpm exec vitest run shared server/personal-os/cli-agents-node server/personal-os/cli-agents src/personal/cli-agents`
on `df64d83c`: 53 files, 849 tests, 847 passed, 2 skipped, 0 failed. The skips
are the opt-in real-herdr-core test (`NEX_HC_REAL`) in
`server/personal-os/cli-agents-node/integration.test.ts` and a POSIX-only
executable-bit test in `server/personal-os/cli-agents-node/launch.test.ts`. A
separate run of `scripts/testing/verification-docs.test.ts` is listed under Bugs.

| File | Passed | Skipped |
|------|--------|---------|
| `server/personal-os/cli-agents-node/bridge.test.ts` | 40 | 0 |
| `server/personal-os/cli-agents-node/claude.test.ts` | 27 | 0 |
| `server/personal-os/cli-agents-node/codex.test.ts` | 20 | 0 |
| `server/personal-os/cli-agents-node/discovery.test.ts` | 15 | 0 |
| `server/personal-os/cli-agents-node/hc-frames.test.ts` | 10 | 0 |
| `server/personal-os/cli-agents-node/hc.test.ts` | 29 | 0 |
| `server/personal-os/cli-agents-node/integration.test.ts` | 1 | 1 |
| `server/personal-os/cli-agents-node/items.test.ts` | 36 | 0 |
| `server/personal-os/cli-agents-node/launch.test.ts` | 29 | 1 |
| `server/personal-os/cli-agents-node/liveness.test.ts` | 13 | 0 |
| `server/personal-os/cli-agents-node/local-store.test.ts` | 8 | 0 |
| `server/personal-os/cli-agents-node/open-local.test.ts` | 7 | 0 |
| `server/personal-os/cli-agents-node/reader.test.ts` | 17 | 0 |
| `server/personal-os/cli-agents-node/streams.test.ts` | 10 | 0 |
| `server/personal-os/cli-agents/fork.test.ts` | 7 | 0 |
| `server/personal-os/cli-agents/hub.test.ts` | 24 | 0 |
| `server/personal-os/cli-agents/requests.test.ts` | 11 | 0 |
| `server/personal-os/cli-agents/stream.test.ts` | 15 | 0 |
| `server/personal-os/cli-agents/supervisor.test.ts` | 29 | 0 |
| `server/personal-os/cli-agents/tools.test.ts` | 15 | 0 |
| `server/shared-computers.e2e.test.ts` | 9 | 0 |
| `server/shared-computers.gate.test.ts` | 4 | 0 |
| `server/shared-computers.test.ts` | 14 | 0 |
| `server/shared-user-profile.e2e.test.ts` | 1 | 0 |
| `shared/ask-question.test.ts` | 39 | 0 |
| `shared/call-consent.test.ts` | 7 | 0 |
| `shared/chat-charts.test.ts` | 8 | 0 |
| `shared/cli-agent-frames.test.ts` | 11 | 0 |
| `shared/cli-agents.test.ts` | 60 | 0 |
| `shared/connector-scopes.test.ts` | 11 | 0 |
| `shared/failed-turn.test.ts` | 5 | 0 |
| `shared/html-preview.test.ts` | 5 | 0 |
| `shared/image-generation.test.ts` | 14 | 0 |
| `shared/line-diff.test.ts` | 4 | 0 |
| `shared/live-approval.test.ts` | 13 | 0 |
| `shared/live-call.test.ts` | 13 | 0 |
| `shared/markdown-windows-paths.test.ts` | 3 | 0 |
| `shared/options-card.test.ts` | 5 | 0 |
| `shared/outbound.test.ts` | 9 | 0 |
| `shared/package-format.test.ts` | 35 | 0 |
| `shared/pairing-link.test.ts` | 12 | 0 |
| `shared/place-view.test.ts` | 14 | 0 |
| `shared/provider-icon.test.ts` | 2 | 0 |
| `shared/routine-schedule.test.ts` | 30 | 0 |
| `shared/tool-scope.test.ts` | 34 | 0 |
| `src/personal/cli-agents/CliAgentsWorkspace.test.ts` | 16 | 0 |
| `src/personal/cli-agents/CliRequests.test.ts` | 17 | 0 |
| `src/personal/cli-agents/SupervisionPanel.test.ts` | 7 | 0 |
| `src/personal/cli-agents/requests.test.ts` | 17 | 0 |
| `src/personal/cli-agents/session-model.test.ts` | 14 | 0 |
| `src/personal/cli-agents/stream.test.ts` | 20 | 0 |
| `src/personal/cli-agents/terminal-session.test.ts` | 17 | 0 |
| `src/personal/cli-agents/transcript.test.ts` | 14 | 0 |

The real-herdr-core integration test is
`server/personal-os/cli-agents-node/integration.test.ts`; the browser smoke
above exercises the same bridge against the real core end to end.

## Cleanup

The smoke stops everything in reverse order even when a step fails: the DevTools
socket, the browser (by profile directory), the device process, the fixture Core
and fake identity, then the herdr-core session (a raw `server.stop` over its own
pipe, then a kill of any process of that binary or pipe that is left, then
removal of `%LOCALAPPDATA%\herdr-core\<session>`), then the temporary directory.
Final run: no core or holder process left, the pipe gone, the state directory
removed, the temp directory removed, classic `herdr.exe` pids unchanged.

## Not tested

- A real `claude` or `codex`: their TUI, hooks, status reporting and session
  files. Real-CLI acceptance still has to be done in an isolated Windows user
  account or a VM.
- The packaged client EXE (the device ran from an esbuild bundle of the same
  sources) and the installer.
- Android and Apple clients.
- Real Core deployment, remote devices over the internet, and more than one
  device or browser at once.
- Approval requests, supervision and fork flows in the browser (unit tests only).
- Keyboard layouts and IME input in the terminal; typing used raw key events.
