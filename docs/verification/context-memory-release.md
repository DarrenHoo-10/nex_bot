# Continuous context, memory and model picker release

Release verification, 2026-10-18. Published as `nexbot-v0.9.2-preview.1`:
Windows client 0.9.2 and Android 0.2.2 (version code 202).

## Delivered behavior

The [continuous context and memory record](continuous-context-memory.md)
describes the implemented defaults and limitations. Conversations remain
continuous across execution tasks; older turns are compressed at the configured
budget threshold with original sources retained. Long-term memory remains off
until enabled for an assistant. Its model, daily budget and usage are configurable.

The shared model picker supports search, keyboard selection, virtualized large
catalogs and paginated discovery. Settings can restrict the visible models per
provider and endpoint; default, chat and memory pickers share those choices.
The current selected model remains accessible. The release also includes the
upstream device lease clock-skew fix and Android viewport/error-panel changes.

## Verification

All behavioral mutations used disposable accounts, databases and synthetic
model providers. Production checks were read-only after the upgrade.

| Surface | Result |
| --- | --- |
| Feature backend regression | 93 passed, 3 skipped before upstream merge |
| Post-merge device lease regression | 5 passed |
| Android viewport and error panel regression | 11 passed |
| Model catalog Node tests | 5 passed |
| Type checking, Core build, Windows packaging | Passed |
| Integrated model picker UI | 9 passed, including a 1,505-model catalog |
| Integrated continuous memory UI | 8 passed |
| Exact Linux release candidate | 25 passed; migration, auth, uploads, limits, continuity, memory and persistence |
| Exact Windows portable executable | 30 passed; isolated login, settings, restart, logout and account isolation |
| Android unit tests | 47 core and 26 app tests passed |
| Exact Android APK on an owned emulator | 20 workspace UI checks passed |
| APK signature | v2 verification passed |

The Windows fixture uses `scripts/smoke-shell-login.mjs` with `--exe`,
`--expect-local-ui` and `--account-workspaces`. Android uses
`scripts/fixture-android-workspace.mjs` and `scripts/smoke-android-workspace.mjs`;
the latter accepts an explicit fixture JSON path and forwarded debugger port.

## Production rollout

The candidate was built on the merged main branch, staged separately and tested
on Linux before switching the service. A restricted backup and the prior release
were retained for rollback. No active tasks were present at cutover.

All four account workspaces passed schema 15, database integrity and foreign-key
checks. Account bindings, encrypted credential stores, model settings, external
memory settings and existing record counts were preserved. Native long-term
memory remained disabled. The service was active; public HTML and all referenced
assets matched the candidate, health returned 200 and unauthenticated APIs 401.

Operational reports and synthetic fixture state remain under ignored `release/`
directories. Only the explicitly selected EXE, APK and SHA-256 checksum file are
public release assets; no account database, credentials or fixture profile is
included.

Windows is an unsigned portable preview and Android uses the existing debug
signing identity. Synthetic checks establish functional behavior, not real-model
memory quality. Recall currently uses lexical indexing, not vector retrieval.
