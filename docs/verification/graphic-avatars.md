# Graphic role gallery and motion — 2026-10-24

The Personal UI adds twelve optional graphic appearances: feminine 03, 04, 05,
06, 07 and 12, plus masculine M01–M06. These are the retained original boards,
not the later A/B/C or exaggerated character studies.

The existing twenty companion combinations, classic portrait assets, stable
defaults and persisted selections remain intact. The classic gallery is no longer
offered in the picker; already-saved classic portraits still display. No migration,
automatic live-account avatar assignment or production deployment is included.

All twelve graphic avatars now appear under **角色**, without gender headings,
numbers or names. The original companions are in the same selection panel. A
selection remains a draft until explicitly applied. The existing authenticated,
version-checked appearance API accepts only the twelve new graphic IDs.

Graphic motion uses the approved original artwork: idle breathing, thinking
tilts, working nods and a single completion acknowledgment. Each character has a
different tempo, tilt and lift. These are whole-character transforms, not new
facial-expression frames. Approval, failure, offline and paused poses stay still.
The existing badge and original companions' animations remain unchanged. Idle
contacts and picker thumbnails stay quiet; active contacts, header, inspector
and the preview respond to task state. System reduced motion, the app preference
and visibility signals stop graphic motion.

## Verification

All mutations used owned temporary profiles and local fake identity/model/MCP
providers. No real account or installed client profile was used.

- TypeScript frontend and backend checks passed.
- Changed TypeScript/TSX/test/smoke files passed lint; whitespace checks passed.
- The unchanged appearance integration fixture previously passed: all twelve IDs saved and synced
  between sessions; arbitrary IDs and stale versions rejected; graphic selections
  survived a service restart; another bot's classic portrait remained unchanged;
  switching back to a companion still worked.
- The real hidden Electron workspace fixture passed all 45 grouped cases,
  including twelve graphic thumbnails loading, draft cancellation, female/male
  selection, refresh persistence, correct contact/header/inspector display,
  390px picker layout, another bot's unchanged appearance, saved classic portrait
  rendering without a gallery, and switching back to companion avatars. All
  twelve graphic choices have idle/thinking/working/done animations; frame
  transforms change, completion finishes once and quiet states remain still.
  Actual model/tool execution drives graphic motion in the contact/header/inspector.
  Reduced motion, persisted app motion preference, a simulated document visibility
  signal, unlabelled role choices and desktop/mobile non-overlapping apply controls
  were checked. Existing motion, chat and connector cases also passed.
- The local Core/UI development build passed. The existing JS chunk-size advisory
  remains; the new art is bundled as three shared local PNG sheets.

Commands:

```sh
node node_modules/typescript/bin/tsc -b
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node node_modules/vitest/vitest.mjs run server/personal-os/appearance.test.ts
node scripts/build-personal.mjs --core
node scripts/smoke-personal-workspace.mjs
```

Screenshots: [desktop picker](../../doc/ui/graphic-avatar-picker.png) and
[mobile picker](../../doc/ui/graphic-avatar-picker-mobile.png).
The ignored full report is `release/workspace-verification-avatars/result.json`.

This verifies the shared web renderer used by browser, Windows and Android
WebView. It is not a physical Android device run. The Apple native avatar
component was not extended in this change. No release package was published.

An earlier workspace smoke closed its owned services but left the temporary profile
`nex-workspace-fixture-9o9KEz` after a file-lock cleanup failure; the later
recursive cleanup was rejected by automatic approval policy, so it was retained.
The final 45-case run cleaned up its own fixture successfully. The separate
interactive design preview uses its own fixture and stays open until the user
closes its window. `node scripts/preview-personal-design.mjs --avatars` selects a
graphic avatar for the first synthetic bot; it never changes a real account.
