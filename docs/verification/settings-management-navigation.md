# Connector and device settings navigation — 2026-10-17

The account menu now contains settings, theme switching, and logout. Connector
and device management live inside the shared settings navigation alongside
account, model, memory service, and system information. Composer and inspector
management shortcuts open the matching category; model shortcuts open model
settings. Other settings drafts remain mounted when switching categories.

Verification used the isolated Core/renderer fixture with synthetic identity,
model, and MCP services. `pnpm exec tsc -b`, changed-file oxlint, and the Core/UI
build passed. `scripts/smoke-personal-workspace.mjs` passed all 24 checks,
including management shortcut routing, connector creation/discovery/grants,
actual approved MCP calls, preserved model drafts, and desktop/mobile layouts.
The button helper now excludes hidden panels so memory and connector controls
with the same label are distinguished like visible user controls.

The updated account menu, connector, device, and settings screenshots and
navigation descriptions are in `doc/ui/`. This follow-up is installed locally
as recorded in [local-settings-navigation.md](local-settings-navigation.md);
the previous `07b02171` production deployment is documented separately in
`settings-deployment.md` and does not include this navigation change.

Later updates removed system information and inspector management shortcuts;
see [current inspector behavior](inspector-cleanup.md) and `doc/ui/README.md`
for the latest five-category navigation and reference screenshots.
