# Chat send stability — 2026-10-25

Sending a message could repeatedly parse unchanged rich history, replace the
optimistic message node after acknowledgement, and move the viewport as the
processing caption and composer status appeared separately. Completing a task
could also remove its processing row before the reply feed arrived.

The shared web UI now memoizes unchanged rich text, keeps a stable message key
across acknowledgement, reserves the sending caption/status immediately, and
commits state with the corresponding feed. Bottom-follow observes viewport size
as well as transcript size, while preserving detached scrollback.

Mac and iOS use the same immediate processing indication; NexClientKit commits
task state with the feed. Mac's scroll-tail key includes the processing row;
iOS follows its appearance/removal only while pinned and unfocused.

## Evidence

- 41 tests passed across AgentDesktop.input, transcript-session, static-html,
  message-media and bottom-follow. Coverage includes stable optimistic DOM,
  unchanged rich-text parsing, delayed completion feed and viewport observation.
- Frontend TypeScript, changed-file lint and Core build passed.
- A disposable Windows Core with fake identity/model and 120 synthetic history
  messages was driven through native desktop input. One sampled send-to-second-
  animation-frame interval changed from 142.6 ms to 63.5 ms. This is a single
  comparative sample including automation overhead, not a latency percentile
  or a measurement of model response speed.
- The source was copied into a fresh temporary directory on `mac-air`, with
  CRLF normalized. 129 NexClientKit tests passed, including a delayed-feed
  task-completion regression. macOS Debug and generic iOS Simulator Debug
  builds passed with signing disabled. No user's checkout or simulator was used.
- Local evidence is under ignored `release/send-latency/`; the visible fixture
  can be launched with `node scripts/preview-send-latency.mjs --label=after`.

## Local handoff scope

The Windows test client uses a separately built local UI and a separate login
profile, connecting to the existing Core after user login. It includes the
Windows integrated title bar. It does not deploy Core-side context-folding
changes. Test accounts and synthetic fixture data are not copied into it.

The unpacked Windows application is at
`release/local-preview-20261025/win-unpacked/NexBot Client.exe`, with local
metadata version `0.9.14-local.20261025`. The existing shell-login smoke suite
passed all 26 checks against this exact executable with `--expect-local-ui`,
including bundled local UI with remote API, device connection, encrypted login,
restart, logout and revoked-session handling. Its bundled JavaScript SHA-256
matches the source build. The desktop shortcut `NexBot 本地测试版` supplies a
separate profile under `%LOCALAPPDATA%/NexBotLocalPreview/profile-20261025`.

The follow-up UI change replaces the text pill with a circular downward arrow
(40px web/Mac, 44px iOS). The accessible name remains `回到底部`; no label is
visually rendered. The existing 18 input/bottom-follow tests and frontend
TypeScript check passed. The local client's UI assets were refreshed; an already
running client must be reopened because it caches bundled assets at startup.
Both Apple Debug targets compiled again in a fresh temporary Mac directory;
logs are saved as `release/send-latency/arrow-{mac,ios}-build.log`.

Native Apple runtime interaction and other display scales still need manual
acceptance. No production deployment, GitHub release or OSS publication is part
of this local handoff.
