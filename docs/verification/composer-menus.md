# Composer menus — 2026-10-18

## Current composer simplification

The persistent permission and model buttons have been removed. Both controls
are available only through the plus menu, which shows their current values.
The model dialog is anchored to plus; selection and Escape restore focus there.
The permission menu also anchors to plus. Settings-page model pickers keep
their regular triggers. Build, lint and type checking passed; the isolated
model-picker smoke covers the absent toolbar controls, permission persistence,
model selection, Escape focus and mobile popover bounds.

The records below describe earlier releases.


The user selected existing functionality only. The permission control now uses a
compact icon button and a rounded menu with a checkmark on the selected mode.
It retains **Standard / Full access**, the existing server semantics; no
read-only or workspace-sandbox modes are implied by the reference screenshot.
The plus and permission buttons sit together below the message input.

The plus menu groups **File** under Add, and **Permissions / Model settings /
Export conversation** under Commands. File opens the system picker, Permissions
opens the same mode menu, Model settings opens the existing shared settings page,
and Export downloads Markdown for the selected assistant. Export paginates the
authenticated history instead of exporting only the visible 100 messages and
checks workspace/privacy identity before releasing the download. It does not
export diagnostic logs, credentials or an attachment ZIP. The existing copy
action remains available in the chat header.

Menus use the browser top layer so the scrollable composer cannot clip them.
They support selected-item focus, arrow/Home/End navigation, Escape dismissal
with focus return, outside-pointer dismissal and bounded layouts on small screens.
Reduced-motion preferences disable the opening transition. Product screens have
labels and actual state, without added explanatory paragraphs.

## Verification

```powershell
node scripts/build-personal.mjs --core
node scripts/smoke-personal-workspace.mjs
pnpm exec tsc -b
pnpm exec oxlint --deny-warnings src/personal/components/ComposerControls.tsx src/personal/AgentDesktop.tsx
```

The real hidden Electron renderer and disposable Core passed 36 checks. New
checks cover the actual file-picker event, upload-only send, full/standard mode
persistence, selected-mode focus/checkmark, Escape focus return, model settings
navigation, actual Markdown file download and mobile dark-mode bounds. Fake
identity/model/MCP providers and an owned temporary download directory were used;
the concurrent model-catalog feature is configured not to fetch external data.
Type checking, targeted lint and the build passed.

Screenshots in `doc/ui/`: `composer-add-menu-light.png`,
`composer-permission-menu-light.png`, `composer-add-menu-mobile-dark.png`, and
`composer-permission-menu-mobile-dark.png`. The two existing composer attachment
screenshots were refreshed to the same layout. All identities/content are synthetic.

This menu revision was installed locally and deployed to the hosted UI on
2026-10-18. These menu changes require only updated UI.

## 2026-10-18 combined local client update

Built `release/personal-client-menus-model-local/win-unpacked` with the composer
menus, username-initial account avatar, and model context/output settings.
The exact packaged shell passed 30 isolated login/lifecycle checks; the current
model-limit fixture passed five scenario groups. Packaged UI hashes matched the
built assets. Installation verified 664 files, retained the previous installation
for rollback, and left the saved-login file unchanged. Private installation
evidence is under ignored `release/local-menus-model-update/`.

The combined production rollout below includes matching Core model-limit support.


## Combined production rollout — 2026-10-18

Release `composer-menus-20261018` includes the grouped menus, username-initial
account avatar, uploads/permission behavior, and independent model limits with
256,000 / 32,000 fallback defaults. No model alias matching change was added.

Validation: 64 targeted tests passed (one existing skip), 36 renderer cases,
six model-limit renderer cases, and 17 isolated Linux release cases. The Linux
fixture verifies both provider output caps, independent limits and restart
persistence, uploads, permission modes and PDF loading. Mutations use synthetic
accounts and disposable workspaces only.

Both production workspaces had no active tasks before the service switch. The
previous release and private server backup are retained. Read-only checks after
the switch confirmed database integrity and preserved identities, vault keys,
model overrides, model/memory configuration and record counts. Public HTTPS
health returned 200; HTML and all three referenced assets matched; unauthenticated
APIs returned 401. The service remained active with zero restarts. Private
release evidence is under ignored `release/deployment-composer-menus/`.
