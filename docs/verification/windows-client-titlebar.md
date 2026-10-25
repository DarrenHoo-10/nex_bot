# Windows client title bar — 2026-10-25

The Windows thin client hides the separate OS title bar and retains native
caption controls as a transparent 64px overlay. The sidebar brand, conversation
header and inspector heading share that row. Shell-owned CSS reserves the actual
caption width through the window-controls-overlay environment variables. Buttons
and the clickable agent heading remain outside draggable regions. Caption icon
colors follow the workspace theme; login has its own draggable top edge.

The inspector heading label and its close button are hidden in the Windows shell.
Its empty row remains the native caption/drag area. The conversation header's
info button continues to toggle the inspector.

Only the Windows shell changes. The stylesheet is injected on every document load,
so remote Core UI and the local login page both work without a Core deployment.
It is included by the existing `electron/client/**` packaging rule. Web, Android
and native Apple UI are unaffected.

## Verification

- `node scripts/build-personal.mjs --core` passed.
- Main/preload syntax checks, changed-file lint and `git diff --check` passed.
- The actual development Electron shell ran against a disposable Core and fake
  identity provider with a separate temporary profile. No live account or data
  was used. Fixture services and windows were stopped and temporary data removed.
- Native overlay was visible on login and after logout.
- At 1440px and 760px window widths, with the inspector both open and closed,
  the brand and main header started at y=0, with no horizontal page overflow.
  Header controls ended 12px before the native caption area and were non-draggable.
- Light/dark full-window captures include the native caption buttons; their colors
  and alignment were visually checked. Maximize and restore passed through the
  fixture's Electron window API.

Local evidence: `release/titlebar-verification/result.json`, `verify.mjs`,
`entry.mjs`, and `*-window.png` (ignored, synthetic data only).

## Limits

This is a local source change, not an installed-client update. No installer was
built or published; GitHub and OSS publication were skipped. Physical mouse
dragging/double-click and Windows Snap Layout hover were not automated; native
controls and CSS drag/no-drag regions are retained. Other display scale factors
and native Apple builds were not tested for this Windows-only change.
