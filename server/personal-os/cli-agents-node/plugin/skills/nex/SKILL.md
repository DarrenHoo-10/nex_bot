---
name: nex
description: Use when the user asks for multi-agent collaboration, delegating work to another agent (e.g., Codex, AGY, or another Claude), parallelizing across agents, or having another agent review code.
---

# NexAgent Multi-Agent Collaboration (`nex`)

When the user asks to collaborate with other agents, delegate implementation/review/testing to another agent, or split work across multiple agents:

1. Run `nex guide` first to read the exact commands, rules, and current collaboration settings for this session.
2. Run `nex agents` if you need to check which agents (`claude`, `codex`, `agy`) are installed and enabled on this computer.
3. Dispatch workers with `nex start <agent> --title "<title>" --file <utf8-spec-file>` (pass long text via `--file` to avoid shell escaping issues; use `--permissions readonly` for code review).
4. After dispatching workers or sending messages, end your turn immediately and wait—do not poll `nex status`. Worker reports will be delivered back to you automatically.
5. Do not dispatch workers unless the user asked for collaboration (unless `nex guide` indicates automatic dispatch is enabled in settings). Never instruct workers to push, deploy, merge to main, or delete branches.
