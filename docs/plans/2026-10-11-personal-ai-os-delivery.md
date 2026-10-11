# Personal AI OS: Windows 0.2.0 implementation and delivery

This records the initial delivery. The contact-based 0.3.0 product contract is
[Personal Agent product correction](2026-10-11-personal-agent-product-correction.md);
it supersedes the conversation navigation described here.

The later design contract is [Main-device memory and Agent collaboration](2026-10-11-personal-agent-memory-hindsight.md): local Hindsight on the primary device, a public Bot capability directory, automatic internal A2A, and approvals only for risky actions in the executing Agent's inbox. The approval and SQLite-only memory descriptions below record the initial shipped behavior; they are not the target behavior of that upgrade.

The user authorized delivery of a complete Windows EXE with particular attention
to Agent communication and memory. This implements the previously agreed
modular monolith and fixed embedded Pi harness in a dedicated desktop entry.
The deliverable is a self-contained application, not the experimental P0 CLI.

## Production modules

| Module | Implementation | Durable boundary |
|---|---|---|
| Local identity / model configuration | `store.ts`, Electron DPAPI-backed vault | Core schema, encrypted model secret |
| Bot / conversation / task | `store.ts`, `runtime.ts` | scoped bot, conversation input receipts, task and run generation |
| Runtime adapter | `worker.ts`, `projection.ts` | SDK public session entries in `runtime.db`; Core acknowledgement before worker exit |
| Permission Broker | `runtime.ts` | immutable source tuple/envelope, argument-bound approvals, policy snapshots |
| Agent communication | `runtime.ts` and `a2a_messages` | parent, child, root, depth, payload, result, cancellation |
| Memory | `memory.ts` | private/shared documents, content, optimistic versions, commit receipts |
| Device Gateway | `devices.ts` | credentials, local grants, Core grants, device call delivery/results |
| Device Node | `node.ts` | binding/local grant and immutable call/result journal in `node/node.db` |
| Desktop | `electron/nex-main.mjs`, `src/personal` | private server IPC, sandboxed renderer, model/approval/memory/device controls |

Core uses the full previously reviewed 33-table schema, copied to the production
module. The first migration adds `secrets`, `transcript`, `memory_content`,
`a2a_messages` and the FTS virtual index. `runtime.db` contains SDK projections,
not a second copy of task/permission/memory business truth. A Core application
lock belongs to Electron's profile. Every SDK worker has a distinct temporary
Pi resource directory and only the Broker tool is installed.

## Communication decisions

Each delegation creates a fresh child conversation and task in the same Core
transaction as its durable A2A relation. An Agent sees only its own memories
and explicitly shared workspace memories. Delegation passes the approved
payload, not the parent's transcript. A committed child result resolves the
original immutable tool call. Restart reuses the same relation and child IDs.

The limit is three levels, eight child tasks per root, four simultaneous workers
and shared model-call/token accounting across the root's children. Ancestor Bot
cycles are rejected. Parent cancellation recursively stops unfinished children.
Approval or delegation waits release a worker after 60 seconds; a new worker
must wait for the old one's exit before claiming a conversation.

This is a local durable A2A protocol inside the modular monolith. An external
standard-compatible A2A transport is not introduced in 0.2.0.

## Memory decisions

Short-term state is the persisted task, accepted input, run and SDK context.
Long-term documents have Bot-private or workspace-shared scope. They are
included in the owning Agent's next system prompt, and can also be searched or
read through the Broker. Search includes older documents rather than just the
latest prompt slice. The owner can manually create/edit/delete memory; Agent
writes require explicit approval.

Memory content, version, search index and tool commit receipt share a Core
transaction. Updates require the expected version. Retrying the original tool
source returns its receipt rather than overwriting memory again. Context
compaction summarizes the SDK projection and keeps durable input history in
Core. Model invocation purpose distinguishes compaction from an answer; absent
usage is recorded as unknown, not zero usage.

## Device decisions

The same EXE can operate as a Core and/or an outbound Device Node. The Core
owner generates a device token; Node connects over authenticated WebSocket and
reports an explicit local grant. Only a relative path under the selected real
directory can be read/listed; symlinks outside the grant are rejected. PDF.js
extracts PDF text. Terminal authority is a separate, default-off checkbox and
requires a per-command Core approval. Its directory is a working directory,
not a shell security sandbox.

The local policy version is captured when proposing a call and rechecked at
approval and execution. Node hashes the received original envelope without
re-serializing it. Results and acknowledgements are durable. Duplicate delivery
returns the existing result. Interrupted or unconfirmed execution is unknown
and never blindly replayed. Node can provide proof that an unreceived call was
not executed; otherwise the device owner must inspect and confirm a stopped
call before clearing it. This is an explicit reconciliation action in the UI.

Local desktop requests use a random per-launch bearer/cookie token and strict
origin/host checks. LAN mode exposes only the authenticated Device Gateway for
remote nodes; its desktop owner UI remains local. Public deployment requires a
TLS edge. Native Identity v1/OIDC are still future adapters; 0.2.0 uses the
local owner.

## Build and validation

`pnpm package:personal:win` builds dedicated UI/Core/worker bundles, copies
PDF.js and the Windows canvas native binary, and produces NSIS Setup and
self-extracting Portable executables. The pinned desktop runtime is Electron
39.8.10; the harness is Pi SDK 1.0.4. No Node, pnpm, Pi CLI or harness installation
is needed on the target computer. Keys, personal databases and workspaces never
enter the resource tree. No auto-updater or upstream publish target is enabled.

See `docs/verification/personal-os.md` for disposable fixture commands and the
precise scope of evidence. The original legacy build commands and directories
remain separate; this release does not automatically migrate legacy user data.

Final local evidence on 2026-10-11: all four test files passed (31 tests),
including 11 production workflows against the packaged Core/worker files and
20 Pi regressions. Both TypeScript checks, added-code lint and 65 schema checks
passed. The actual `NexBot-0.2.0-x64-Portable.exe` passed renderer boot, API-key
settings, SDK chat, memory display, layout and graceful shutdown. NSIS Setup and
Portable artifacts are in `release/personal-os`, with a user guide, verification
scope and SHA-256 manifest. They are unsigned and were not uploaded or pushed.
