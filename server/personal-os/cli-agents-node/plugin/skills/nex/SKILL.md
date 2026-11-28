---
name: nex
description: NexAgent 协作模式（多 Agent 协作，nex CLI）：将实现、审查或并行任务委派给其他 Agent（Claude/Codex/AGY）。当用户提及协作模式或要求跨 Agent 协作时先运行 nex guide。
---

# NexAgent Multi-Agent Collaboration (`nex`)

When the user asks to collaborate with other agents, delegate implementation/review/testing to another agent, or split work across multiple agents:

1. Run `nex guide` first to read the exact commands, rules, and current collaboration settings for this session.
2. Run `nex agents` (or `nex models <agent>`) to check installed agents (`claude`, `codex`, `agy`) and their exact available model IDs before passing `--model`.
3. Dispatch workers with `nex start <agent> --title "<title>" --file <utf8-spec-file>` (pass long text via `--file` to avoid shell escaping issues; all workers launch automatically in full-access mode so users are not interrupted by approval prompts—for code reviews, instruct the worker in the task prompt to inspect only without modifying files).
4. After dispatching workers or sending messages, end your turn immediately and wait—do not poll `nex status`. Worker reports will be delivered back to you automatically.
5. Do not dispatch workers unless the user asked for collaboration (unless `nex guide` indicates automatic dispatch is enabled in settings). Never instruct workers to push, deploy, merge to main, or delete branches.
