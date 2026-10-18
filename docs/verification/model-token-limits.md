# Per-model context and output limits

The current Personal UI exposes **Settings → Model → Model parameters** for
context window and maximum output tokens. Overrides are scoped to the normalized
endpoint, API protocol and exact model ID in each account's Core database. Blank
fields mean automatic. Changing models restores that model's saved overrides;
old clients that omit the fields preserve existing overrides.

Opening a model reads its saved settings and local catalog first, then refreshes
the public models.dev directory when either field is automatic. The directory
cache lasts 24 hours; **Online lookup** forces a refresh. Fetching uses the existing
bounded, redirect-refusing catalog client. No model ID, endpoint, credential or
conversation is transmitted to the public directory. Manual overrides always win.
Unavailable or ambiguous IDs use explicitly labelled defaults (64,000 context and
8,192 output); missing output metadata also falls back independently. Conflicting
third-party entries do not cause a guessed match. The bundled older snapshot can
contain context without output metadata; a successful refresh retains both.

The selected limits reach the Personal worker's Pi model registration. Output is
a ceiling; the SDK additionally clamps requests to the remaining window. Catalog
entries with output equal to context are valid. Before continuing a task, Core's
worker compares its reported/estimated context to the smaller of 80% of the window
and the window minus bounded output reserve and safety buffer. It retains the
existing Core-owned compaction call and durable input/receipt handling. This change
does not add compaction between tool calls within a running task.

This is the Personal Core path (`server/personal-os/worker.ts`), not the legacy
multi-engine server's `server/context-budget.ts`. Before this change the Personal
path registered every model as 64,000 / 8,192 and triggered compaction at 160,000
serialized characters. The legacy 80%-window implementation was not its runtime.

## Reproduce

```powershell
pnpm exec vitest run server/personal-os/model-limits.test.ts server/personal-os/model-catalog.test.ts server/personal-os/app.test.ts server/model-catalog/trim.test.ts server/model-catalog/catalog.test.ts
pnpm exec tsc -b
pnpm exec tsc -p tsconfig.server.json
pnpm build:core
node scripts/smoke-model-limits.mjs
```

The smoke test launches its own temporary Core, synthetic identity/model/catalog
services and hidden Electron profile. It verifies automatic discovery, per-model
save/restore, slow-response isolation, manual edits during lookup, clearing to auto,
offline cache, unknown IDs, validation and reload persistence. Desktop and mobile
screenshots plus `report.json` are written under ignored
`release/model-limits-verification/` and visually checked. Runtime tests verify the
actual OpenAI and Anthropic outgoing output caps and compaction with a smaller
configured context. No live app or account is mutated.

A separate temporary-directory public catalog lookup verified real models.dev
fetching and exact-model matches. No production service or installed desktop app
was deployed or replaced by this work.
