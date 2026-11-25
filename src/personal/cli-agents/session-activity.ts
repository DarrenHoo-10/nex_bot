import { normalizeCliTaskItem, type CliItem, type CliSessionState } from "../../../shared/cli-agents";

export interface ActivityEntry { title: string; state: string }
type Fields = Record<string, unknown>;

function fields(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
}

function parse(text: string): Fields {
  try { return fields(JSON.parse(text)); } catch { return {}; }
}

const finished = /^(completed|failed|errored|cancelled|canceled|stopped|shutdown|not_found)$/i;

const directoryChange = /^(?:cd|chdir|pushd|set-location)\s+(?:\/d\s+)?(?:"[^"]*"|'[^']*'|[^;&\r\n]+?)\s*(?:&&|;|\r?\n)\s*/i;
const packageManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
const packageRunners = new Set(["npx", "bunx"]);

function shortTitle(title: string): string {
  const chars = Array.from(title.trim().replace(/\s+/g, " "));
  return chars.length > 36 ? chars.slice(0, 35).join("") + "…" : chars.join("");
}

function executableName(token: string | undefined): string {
  return (token?.split(/[\\/]/).at(-1) ?? "").replace(/\.(?:cmd|bat|exe)$/i, "");
}

function backgroundTitle(data: Fields, input: string): string {
  const description = typeof data.description === "string" ? shortTitle(data.description) : "";
  if (description) return description;
  const command = data.command ?? data.cmd ?? input;
  if (typeof command !== "string") return "后台任务";
  // Directory changes, arguments, and leading environment assignments are not task names.
  const invocation = command.trimStart().replace(directoryChange, "").replace(/^(?:[\w]+=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, "");
  const tokens = Array.from(invocation.matchAll(/"([^"]*)"|'([^']*)'|([^\s;&|]+)/g), match => match[1] ?? match[2] ?? match[3]);
  if (executableName(tokens[0]).toLowerCase() === "corepack") tokens.shift();
  const program = executableName(tokens.shift());
  const lower = program.toLowerCase();
  const packageManager = packageManagers.has(lower);
  const runsTool = packageRunners.has(lower) || packageManager && /^(?:exec|x)$/.test(tokens[0] ?? "");
  if (packageManager && /^(?:exec|run|x)$/.test(tokens[0] ?? "")) tokens.shift();
  const next = tokens[0]?.startsWith("-") ? undefined : tokens[0];
  const task = runsTool ? executableName(next) : program;
  if (task.toLowerCase() === "vite") {
    const subcommand = runsTool ? tokens[1] : next;
    if (subcommand === "build") return "Vite 构建";
    return subcommand === "preview" ? "Vite 预览服务器" : "Vite 开发服务器";
  }
  if (runsTool && task) return /^[\w@.+-]+$/.test(task) ? shortTitle(task) : "后台任务";
  if (!/^[\w.+-]+$/.test(program)) return "后台任务";
  if (packageManager && next && /^[\w:@.+-]+$/.test(next)) return shortTitle(`${program} ${next}`);
  if (/^(?:node|python3?|deno|ruby)$/.test(lower) && next && /\.[a-z0-9]+$/i.test(next)) return shortTitle(executableName(next));
  return shortTitle(program);
}

export function sessionActivity(items: readonly CliItem[], state: CliSessionState, online: boolean) {
  const empty = { todos: [], agents: [], jobs: [] };
  if (!online || state === "stopped") return empty;
  let plan: ActivityEntry[] = [];
  const tasks = new Map<string, ActivityEntry>();
  const foreground = new Map<string, ActivityEntry>();
  const agents = new Map<string, ActivityEntry>();
  const jobs = new Map<string, ActivityEntry>();
  const failedJobs = new Map<string, ActivityEntry>();
  const failedAgents = new Map<string, ActivityEntry>();
  const inTurn = state === "running" || state === "waiting";

  for (const raw of items) {
    const item = normalizeCliTaskItem(raw);
    if (item.kind === "turn") {
      // Foreground calls and plans belong to their turn. Detached processes can outlive it.
      foreground.clear();
      plan = [];
      failedJobs.clear();
      failedAgents.clear();
      continue;
    }
    if (item.kind === "notice" && item.taskEnd) {
      const { id, state: result } = item.taskEnd;
      const job = jobs.get(id), agent = agents.get(id);
      if (inTurn && result === "failed") {
        if (job) failedJobs.set(id, { ...job, state: "失败" });
        if (agent) failedAgents.set(id, { ...agent, state: "失败" });
      } else {
        failedJobs.delete(id);
        failedAgents.delete(id);
      }
      jobs.delete(id);
      agents.delete(id);
      continue;
    }
    if (item.kind === "user" || item.kind === "notice") {
      if (item.text.trimStart().startsWith("<subagent_notification>")) {
        const json = parse(item.text.replace(/<\/?subagent_notification>/g, "").trim());
        if (typeof json.agent_path === "string" && Object.keys(fields(json.status)).some(k => finished.test(k))) agents.delete(json.agent_path);
      } else if (item.kind === "user" && !item.queued) {
        foreground.clear();
        plan = [];
        failedJobs.clear();
        failedAgents.clear();
      }
      continue;
    }
    if (item.kind !== "tool") continue;
    const name = item.name.toLowerCase().split(".").at(-1);
    const data = parse(item.input);
    const output = item.output ?? "";
    const result = parse(output);
    if (name === "write_stdin" && /process exited with code/i.test(output)) { jobs.delete(String(data.session_id)); continue; }
    if (item.status === "error") continue;
    if (name === "todowrite" || name === "update_plan") {
      const rows = data.todos ?? data.plan;
      if (!Array.isArray(rows)) continue;
      plan = rows.flatMap(value => {
        const row = fields(value), title = row.content ?? row.step;
        if (typeof title !== "string" || !title.trim()) return [];
        return [{ title, state: row.status === "completed" ? "已完成" : row.status === "in_progress" ? "进行中" : "待处理" }];
      });
    } else if (name === "taskcreate") {
      const id = output.match(/Task\s+#(\d+)/i)?.[1] ?? fields(result.task).id;
      if (id && typeof data.subject === "string") tasks.set(String(id), { title: data.subject, state: "待处理" });
    } else if (name === "taskupdate") {
      const id = String(data.taskId);
      if (data.status === "deleted") tasks.delete(id);
      else if (tasks.has(id)) {
        const task = tasks.get(id)!;
        if (typeof data.subject === "string") task.title = data.subject;
        if (data.status) task.state = data.status === "completed" ? "已完成" : data.status === "in_progress" ? "进行中" : "待处理";
      }
    } else if (["agent", "task", "spawn_agent"].includes(name ?? "")) {
      const entry = { title: String(data.description || data.message || data.prompt || item.input || "子代理"), state: "执行中" };
      if (item.status === "running") foreground.set(item.id, entry);
      else {
        const id = result.agent_id ?? (name === "spawn_agent" || /async|background/i.test(output)
          ? output.match(/(?:agent\s*id|agent_id|task_id)\s*[:=]\s*["']?([\w./-]+)/i)?.[1] : undefined);
        if (id) agents.set(String(id), entry);
      }
    } else if (name === "wait_agent" || name === "wait") {
      for (const [id, value] of Object.entries(fields(result.status))) {
        if (finished.test(String(value)) || Object.keys(fields(value)).some(k => finished.test(k))) agents.delete(id);
      }
    } else if (name === "close_agent" && data.id && item.status === "ok") {
      agents.delete(String(data.id));
    } else if (["bash", "shell", "exec_command", "shell_command"].includes(name ?? "")) {
      const id = output.match(/(?:running in (?:the )?background with (?:task )?id|process running with session id)\s*:?\s*([\w-]+)/i)?.[1];
      if (id || data.run_in_background === true && item.status === "running" && inTurn) {
        jobs.set(id || item.id, { title: backgroundTitle(data, item.input), state: "运行中" });
      }

    } else if (name === "taskstop" || name === "taskoutput") {
      const id = String(data.task_id ?? data.shell_id);
      if (item.status === "ok" && (name === "taskstop" || /<status>(completed|failed|stopped)<\/status>/i.test(output))) {
        agents.delete(id); jobs.delete(id);
      }
    }
  }
  const todos = [...plan, ...tasks.values()];
  return {
    todos: inTurn && todos.some(entry => entry.state !== "已完成") ? todos : [],
    agents: [...(inTurn ? foreground.values() : []), ...agents.values(), ...failedAgents.values()],
    jobs: [...jobs.values(), ...failedJobs.values()],
  };
}
