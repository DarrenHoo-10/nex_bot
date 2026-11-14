# Agent mode phase 0 spike: herdr-core on Windows (2026-11-15)

Scope: plan section 11 items 1-4 and 10. Real herdr-core 0.1.21 driven by the
new `HerdrCore` client (`server/personal-os/cli-agents-node/hc.ts`) and a fake
terminal program (`scripts/testing/fake-tui.mjs`). No real `claude` or `codex`
process was started and no file under `~/.claude` or `~/.codex` was read or
written.

## Environment

- Windows 11 Pro 10.0.26200, Node v24.18.0, x64.
- herdr-core staged by `node scripts/prepare-herdr-core.mjs --current` into
  `dist-native/herdr-core/win32-x64/`. `herdr-core.exe --version` prints
  `hc 0.1.21`; `herdr-core.exe --licenses` is 946631 bytes with SHA-256
  `0574542ad0acc8de676ec9b50083b2a527634314172f541e9454bf4b1157163b`, identical
  to the notices file pinned from the release archive.
- Pinned SHA-256: archive `herdr-core-windows-x86_64.zip`
  `a8984634c35b58ba82d0aec078d5a5e6004da01d5a25b3daf822ab5e31c7312b`,
  `herdr-core.exe` `5304b33036e6f83d752751e8e4ca78ea484acf6b9247e72f2d3aecc02f696a6d`,
  `conpty.dll` `39fba2713e2495117b1591ae8c32a3b904bea7aa66069cf7815e2844c76d75d8`,
  `OpenConsole.exe` `b7fd936c2668b87b9ecf7b3366dc6568afc1c6f981874cba3e955a1c35cf8160`.
- Isolation: `HC_SESSION=nexbot-spike-<random>` and
  `HC_SOCKET=\\.\pipe\<that session>`. The user's classic `herdr.exe` (pid 50028,
  Persona) was running throughout and was never touched. The spike core was
  stopped with a raw `server.stop` on its own pipe; its state directory
  `%LOCALAPPDATA%\herdr-core\<session>` and the temp files were deleted.

## Method

The driver (kept outside the repository) imported `hc.ts` directly (Node 24
strips types) and ran two processes:

1. `node spike.mjs main <session>`: start the core, exercise every item below,
   leave a `spike-survive` terminal running and idle.
2. `taskkill /F /T /PID <main>` (kills the driver and its whole process tree),
   then `node spike.mjs reconnect <session>` from a new process.

## Results

| # | Item | Result |
|---|------|--------|
| 1 | Start the core | PASS. `HerdrCore.ensureStarted()` spawns `herdr-core.exe server start` with `detached: true`, `stdio: "ignore"`, `windowsHide: true`, `.unref()` and `HC_SESSION`/`HC_SOCKET` in env; connected and hello'd in 226 ms cold, 0.7 ms for a second client. The core is `herdr-core.exe serve` plus a child `herdr-core.exe hold --socket \\.\pipe\<session>.holder.<id>.sock` (owns the PTYs). The `server start` launcher exits; the daemon's parent pid was already gone. |
| 2 | Run a program | PASS. `terminal.run` of `node fake-tui.mjs`: 202 ms, state `live`, pid, requested size 90x28 honoured. |
| 2a | `.cmd` handling | PASS, direct. A `.cmd` shim given as argv[0] runs without `cmd.exe`, with and without arguments, and from a path containing a space (`...\with space\fakecli.cmd --resume abc-123`). Wrapped as `cmd.exe /d /s /c <shim> [args]` it works only when the shim path has no space (exit 1 for the spaced path: cmd splits the unquoted path). Passing the whole command as one quoted string is rejected (`invalid_params`: that run only failed on the terminal name I chose, see below, so it remains untested). Decision: `buildArgv` passes shims directly; `wrapCmd: true` stays as a fallback. |
| 3 | Attach framed, type, echo | PASS. Attach 87 ms to first paint (332 bytes, includes `ESC[?1049h` alternate screen and `ESC[?9001h` win32-input-mode). Typed line echoed in 15 ms. Per-key echo median 15.2 ms, p95 15.9 ms, max 16.1 ms (ConPTY frame pacing). The first paint shares a socket chunk with the attach reply, so the client buffers `data` until the first listener exists. `automatic_input` was both in hello features and in the attach result. Permission prompt (`wait`, then `y`) round-trips. |
| 3a | `terminal.send` without a draft | `terminal.send` returned after 1018 ms (about 1 s of built-in settle), text submitted and echoed. |
| 3b | `terminal.send` while a viewer holds a draft | The draft `draft-text` (no Enter) sat idle: the RPC blocked 60.03 s (the documented maximum), then submitted draft and message concatenated (`draft-textSENT`). With a viewer typing one key every 500 ms for 6 s, the RPC returned after 65.99 s (about 60 s wait), again concatenated. Client RPC timeout therefore has to exceed 60 s; `HerdrCore.send` uses 75 s plus the optional wait. Agent mode must either refuse to send while a local draft exists or accept this delay. |
| 3c | `terminal.keys` | `ctrl+c` with a draft present returned after 2.93 s, so it is not instantaneous either. |
| 3d | `terminal.interrupt` | `interrupt(timeout 3)` returned `{key: "ctrl+c", outcome: "unknown"}` after 3.03 s and the program printed `[interrupted]`. `unknown` is expected because fake-tui reports no status. |
| 3e | Observe attach | PASS. A second attach with `observe: true` saw all output (including input typed by the first viewer) and reported the terminal's own size (90x28). Writing through the observer is rejected client-side (`hc_observe_only`). Server-side rejection of raw observer input was not exercised. |
| 3f | Resize | PASS. `RESIZE` frame to 100x30: program saw `[resized 100x30]`, `terminal.get` reported `100x30`. A second non-observing attach at 70x20 set the terminal to 70x20 (last attach wins). When the only viewer disconnected the terminal grew to 200x120 and shrank to the new viewer's size on re-attach, so the TUI redraws on every attach. `resize_notifications` is honoured for observers only; the core replied `false` for a normal attach. |
| 4 | Survive process exit | PASS. After `taskkill /F /T` of the driver, `serve` (pid 51912) and `hold` (pid 7504) kept running. A new process connected in 3 ms, `terminal.list` showed `spike-survive` live with the same pid (57776), re-attach with `history: 200` replayed the earlier output (`you said: before-kill`), a typed line was echoed in 14 ms, `terminal.read` returned the screen, and fake-tui's transcript file (`FAKE_TUI_TRANSCRIPT`) held the lines from both processes. `exit` finished the terminal with exit code 0; finished terminals disappear from the default list and appear with `all: true`. |
| 10 | Latency and throughput | RPC round trip (`terminal.get`, 200 sequential calls over the named pipe): median under 0.05 ms, p95 0.1 ms, max 0.3 ms. A 20000-line burst (1,448,957 bytes of output) arrived in 31 ms (about 46 MB/s) with credit returned as consumed. |
| - | Events | `events.subscribe` with a label filter delivered `created`, `title`, `foreground`, `size` and `finished` events. The client accepts both one JSON message per frame and newline-delimited messages split across frames (both covered by unit tests); which one the real core uses was not distinguished. |

Other observations:

- hello returned 32 methods and features
  `framed, attach, events, status, shell, resize_notifications, automatic_input,
  restart_environment`.
- Terminal `state` is `live`/`finished`. Terminal names must be 1-32 characters
  of `a-z 0-9 - _ .`, start with a letter or digit and must not look like an id
  (`t7`); `nexbot-<engine>-<8 chars>` complies.
- `terminal.attach` accepts a `display` object (viewer colors and cell size,
  used to answer terminal queries); the client does not send it yet.

## Unit tests

`corepack pnpm exec vitest run server/personal-os/cli-agents-node/hc.test.ts
server/personal-os/cli-agents-node/hc-frames.test.ts
server/personal-os/cli-agents-node/launch.test.ts scripts/prepare-herdr-core.test.mjs`:
81 passed, 1 skipped (a POSIX-only executable-bit test), 0 failed. `hc.test.ts`
uses a fake JSON-RPC herdr-core on a temporary named pipe (hello, run, attach
with first paint, send, keys, interrupt, errors, timeouts, disconnect and
reconnect with backoff, re-subscribe, spawn of the start command).
`oxlint --deny-warnings` on every file in this change is clean, and
`tsc -p tsconfig.server.json` reports nothing in `hc*.ts` or `launch*.ts`.

## Not tested

- A real `claude` or `codex` inside herdr-core (their TUI, status reporting,
  hooks, transcript discovery, `codex.cmd` / `claude.exe` startup time).
- xterm.js key encoding through Core into the attach stream (win32-input-mode
  is announced in the first paint; the core never encodes keys).
- Hook-driven `status`/`turn` events, `terminal.send` with `if: idle|working`.
- Core crash recovery (killing `serve` while `hold` keeps the PTYs), a core
  restart after a Windows reboot, and a version mismatch against a real older
  core.
- macOS archives (hashes verified, binaries not run here).
- Server-side rejection of input on an observe stream, `missed` notifications
  and the 15 s heartbeat from the real core.
- Behaviour with `HC_SOCKET` unset (default endpoint) and with the user's own
  `%APPDATA%\herdr-core\config.toml` (`draft_wait`, `shell`).
