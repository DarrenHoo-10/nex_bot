---
name: nex
description: NexAgent 协作模式（多 Agent 协作，nex CLI）：将实现、审查或并行任务委派给其他 Agent（Claude/Codex/AGY）。当用户提及协作模式或要求跨 Agent 协作时先运行 nex guide。
---

# NexAgent Multi-Agent Collaboration (`nex`)

When the user asks to collaborate with other agents, delegate implementation/review/testing to another agent, or split work across multiple agents:

1. **Role boundary (strict)**: Once collaboration mode is triggered or active, **you are strictly the planner and decision-maker — NEVER write/edit project deliverables, source code, or fix review bugs yourself.** Delegate all implementation and bug fixes to workers (during an active run, direct edits to project files are also blocked by runtime guards).
2. Run `nex guide` first to read the exact commands, rules, and current collaboration settings for this session, and `nex agents` (or `nex models <agent>`) to check installed agents (`claude`, `codex`, `agy`) and their exact available model IDs before passing `--model`.
3. Put temporary `--file` specs, fix requests, and summaries under `.nex-team/` inside the workspace (e.g., `.nex-team/plan.md`, `.nex-team/fixes.md`, `.nex-team/summary.md`), then dispatch with `nex start <agent> --title "<title>" --file .nex-team/plan.md` (all workers launch automatically in full-access mode so users are not interrupted by approval prompts—for code reviews, instruct the worker in the task prompt to inspect only without modifying files).
4. **Review-fix loop**: When a reviewer reports issues that need fixing, **NEVER fix them yourself.** Send the fix instructions back to the implementer with `nex send <implementer> --file .nex-team/fixes.md`, end your turn, wait for the implementer's report, then send back to the reviewer with `nex send <reviewer> --file .nex-team/recheck.md` for re-review. Repeat until clean or you decide to deliver/ask the user.
5. After dispatching workers or sending messages, end your turn immediately and wait—do not poll `nex status`. Worker reports will be delivered back to you automatically.
6. Do not dispatch workers unless the user asked for collaboration (unless `nex guide` indicates automatic dispatch is enabled in settings). Never instruct workers to push, deploy, merge to main, or delete branches.
