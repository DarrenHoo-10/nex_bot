# Categorized Personal OS settings — 2026-10-17

Settings now have four categories: account and login devices, model, memory
service, and system information. Each category has a single content pane;
switching categories retains unsaved form values. Advanced request details and
memory diagnostics are collapsed initially. The blue controls support light,
dark, and narrow layouts. Account logout remains in the account category;
in the desktop shell it also clears the saved connection and returns to login.

Verification used disposable Core services, synthetic identity/model/MCP
providers, and isolated Electron profiles. No live account or production data
was changed.

- `pnpm exec tsc -b`: passed.
- Changed-file `oxlint --deny-warnings`: passed.
- `node scripts/build-personal.mjs --core`: passed.
- `node scripts/smoke-personal-workspace.mjs`: 23 checks passed, including
  category navigation, retaining drafts, saving model configuration to Core,
  folded advanced details, and light/dark/390px layouts. The first run hit a
  fixture serialization error (returning a DOM element instead of a boolean);
  the fixture was corrected and the full run passed.
- `node scripts/smoke-shell-login.mjs --account-workspaces
  --exe=release/personal-client/NexBot-0.9.1-x64-Client-Portable.exe`: 15 checks
  passed with the updated UI served by the isolated Core, including visible
  memory settings, account logout, restart, and account isolation.
- Settings screenshots were visually inspected at desktop and mobile widths.

Screenshots are in the ignored `release/workspace-verification-avatars/`:
`settings-account-light.png`, `settings-model-light.png`,
`settings-memory-dark.png`, and `settings-mobile-dark.png`.

This is a local UI preview. It has not been packaged into a new release or
deployed. The shell verification uses the existing 0.9.1 executable against
the new local UI; it does not establish a new packaged release. Memory service
connectivity was not exercised against a live Hindsight instance.
