# Assistant inspector cleanup

Date: 2026-10-17. Scope: Personal UI and local Windows client.

## Behavior

The inspector now has Work and Settings tabs. The temporary removal of the
Memory tab does not delete stored memories or disable backend memory tools.
File/tool previews open in Work. Connector and device administration remain
under global Settings. The idle card, redundant shortcuts, directory display,
and motion preference control are removed.

The avatar itself opens the appearance picker. Settings > About >
`bot身份信息` opens the identity editor. Routine rows show title, schedule/prompt
summary and a separate accessible switch. Row clicks edit, the heading plus
creates, and manual execution is available inside the editor. Empty lists
keep only the heading and plus action.

The removed motion control was stored globally on this client, despite its
old per-assistant label. Existing disabled-motion preference and system
reduced-motion support remain respected.

## Isolated verification

Commands:

```sh
pnpm exec tsc -b
pnpm exec oxlint src/personal/AgentDesktop.tsx scripts/smoke-personal-workspace.mjs
node scripts/build-personal.mjs --core
node scripts/smoke-personal-workspace.mjs
node release/local-inspector-cleanup/package.mjs
node scripts/smoke-shell-login.mjs --account-workspaces --expect-local-ui "--exe=D:/ProgrammingProjects/nex_bot/release/local-inspector-cleanup/candidate/NexBot Client.exe"
```

Renderer fixture: 30 checks pass, using a disposable Core, synthetic identity,
fake model and fake MCP. It verifies avatar persistence, identity edits,
routine creation/pause/resume/edit/reload, manual execution of a paused routine
without enabling its schedule, tool previews, OS reduced motion, task-state
animations, settings, logout, light/dark and narrow layouts. Routine timers
use 1440-minute intervals to prevent incidental execution in this fixture.
Switch knob containment and text/switch overlap are explicitly checked.

Evidence: `release/workspace-verification-avatars/result.json` and PNGs.
Current shareable references and interaction notes: `doc/ui/README.md`.
No real account, chat, API key, device or routine is mutated by these tests.

This is a frontend-only local package; no production Core API or database
migration is needed for this inspector change. macOS native behavior is not
verified by the Windows fixture.

## Local package result

Packaged-client fixture: 25 checks pass, including local UI with remote API,
login/restart/logout, model discovery, and independent account workspaces.
Installed on this Windows machine and reopened. The replacement verified
all 78 package files and preserved encrypted saved-login bytes. Previous app
files were backed up under the local Programs directory; the private
installation report is in `release/local-inspector-cleanup/local-installation.json`.
This record describes the verification and installation before source synchronization.

## Contact animation follow-up

The sidebar previously passed task state but omitted `animate`, whose default
is false. It now enables animation for contacts with a nonterminal task.
Thinking moves the eyes; tool execution gently moves the body. Idle,
approval, pause and disconnected states remain quiet. Existing global and
system motion preferences still apply. Portrait gallery images remain static.

The isolated renderer fixture now passes 31 checks. It additionally samples
thinking-eye transforms across frames, checks tool-execution animation in the
sidebar, tests reduced motion during an active task, and asserts animation
stops once the task is finished. No live chat was sent for verification.
The local package is staged under `release/local-contact-motion/`.
