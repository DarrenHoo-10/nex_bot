# Unified memory and simplified composer release

2026-10-18: `nexbot-v0.9.3-preview.1`, Windows 0.9.3 and Android 0.2.3
(version code 203).

The memory page exposes one account-wide switch, one memory model and lifetime
memory token usage. The model choice applies to existing and future assistants;
an empty choice follows the account default model, independently of each chat's
selection. Each assistant's stored memory remains separate. Detailed statistics,
per-assistant controls and external-memory configuration are hidden.

Permission and model controls appear only in the composer's plus menu. The
menus retain current values, keyboard navigation, focus return and mobile bounds.

## Verification

Behavioral checks used owned temporary data and synthetic identity/model services.
No test messages or settings changes were sent to live accounts.

| Check | Result |
| --- | --- |
| Continuity, memory, composer and model catalog regression | 22 passed |
| Type checking and lint | Passed |
| Shared memory renderer | 7 passed |
| Model picker and plus-only permissions renderer | 9 passed |
| Exact Windows portable executable | 30 login/settings/lifecycle checks passed |
| Android JVM suites | 47 core tests (cached), 26 app tests passed |
| Exact Android APK on an owned emulator | 20 workspace checks passed |
| Android signature | APK v2 verified |
| Exact Linux candidate with upgrade from previous release | 12 checks passed |

The Linux fixture covers schema 15 to 17, mixed legacy switches, memory and
budget preservation, shared-model routing across different chat models, new
assistants, usage totals, stale and old-client writes, cursor preservation,
disable/restart behavior and fallback to the account default model.

Schema 16 converts mixed legacy switches to off instead of silently opting
previously disabled assistants in. Schema 17 retains a single common nonempty
legacy memory model; differing selections fall back to the account default.
New clients are required to change the unified settings; old per-assistant
writes return an update-required error.

## Deployment

The Linux candidate passed its isolated fixture before the service switch.
A restricted data/configuration backup and previous executable were retained.
All four existing account workspaces passed schema 17, integrity and foreign-key
checks after cutover. Account bindings, credential stores, model connections,
model visibility, old histories and memory/usage record counts were preserved;
the new switch/model values matched the verified migration rules.

The service was active. Public HTML and three referenced assets matched the
candidate byte-for-byte; health returned 200 and unauthenticated APIs returned
401. Operational reports and fixture state remain in ignored release output.
Only the EXE, APK and checksum file are published as download assets.

Windows remains an unsigned portable preview; Android uses the existing debug
signing identity. These functional checks do not benchmark real-model memory
quality. Native memory recall remains lexical rather than vector-based.
