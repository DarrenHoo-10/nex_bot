// nex_bot's Claude Code hook (plain Node, no dependencies; it runs inside the
// plugin directory, so it cannot import anything from the repository).
//
//   hook.mjs permission   PermissionRequest: ask nex_bot, wait for the answer
//   hook.mjs post         PostToolUse: the tool ran, so the prompt was answered
//   hook.mjs stop         Stop: a turn ended
//
// Claude Code writes the event as JSON to stdin. The hook forwards it to the
// Agent bridge of the nex_bot client over a local named pipe / unix socket
// (NEXBOT_HOOK_PIPE, authenticated by NEXBOT_HOOK_TOKEN, both set in the
// terminal nex_bot starts) and, for a permission request, prints the decision.
//
// Every failure path prints nothing and exits 0, which makes Claude Code show
// its own prompt in the terminal: a missing variable, a bridge that is not
// listening, a wrong token, a timeout, a stdin that is not JSON.
//
// Wire format, one JSON line each way (the bridge side is hooks.ts):
//   hook -> bridge  {"v":1,"token":"…","event":"permission|post|stop","input":{…}}
//   bridge -> hook  {"v":1,"decision":"allow|deny|pass","message"?:"…","answers"?:{…},"always"?:true}
//
// `always` allows the call and applies the rules Claude Code itself suggested
// for this prompt (permission_suggestions) for the rest of the session only.
import net from "node:net";

const MODES = new Set(["permission", "post", "stop"]);
const STDIN_LIMIT = 8 * 1024 * 1024;
const REPLY_LIMIT = 256 * 1024;
const DELIVER_WAIT_MS = 3000;
const DEFAULT_WAIT_MS = 1_795_000;
const CONNECT_MS = 3000;
// Both the permission and the post hook slim the input the same way, so the
// bridge can pair a PostToolUse with the request it closes.
const MAX_STRING = 2000;
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;

function slim(value, depth = 0) {
  if (typeof value === "string") return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((entry) => slim(entry, depth + 1));
  const out = {};
  for (const key of Object.keys(value).slice(0, MAX_ITEMS)) out[key] = slim(value[key], depth + 1);
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > STDIN_LIMIT) {
        chunks.length = 0;
        resolve("");
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

/** Claude Code's own suggestions for this prompt, kept to the current session. */
function sessionRules(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)).map((entry) => ({ ...entry, destination: "session" }));
}

/** What Claude Code expects on stdout for a decision. */
function permissionOutput(input, reply) {
  if (reply.decision === "allow") {
    const decision = { behavior: "allow" };
    if (reply.always === true && input.tool_name !== "AskUserQuestion") {
      const rules = sessionRules(input.permission_suggestions);
      if (rules.length) decision.updatedPermissions = rules;
    }
    if (input.tool_name === "AskUserQuestion") {
      // To verify with a real Claude Code: the answers go in updatedInput next to the original questions.
      if (!reply.answers || typeof reply.answers !== "object") return null;
      decision.updatedInput = { ...input.tool_input, answers: reply.answers };
    }
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
  }
  if (reply.decision === "deny") {
    const message = typeof reply.message === "string" && reply.message ? reply.message : "Denied from nex_bot.";
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } };
  }
  return null;
}

/** Sends one line and waits for one line back. Resolves null on any failure. */
function exchange(pipe, line, waitMs, parentWatch) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let watch = null;
    let timer = null;
    const socket = net.connect(pipe);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (watch) clearInterval(watch);
      socket.destroy();
      resolve(value);
    };
    const connectTimer = setTimeout(() => finish(null), CONNECT_MS);
    socket.setEncoding("utf8");
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () => {
      clearTimeout(connectTimer);
      timer = setTimeout(() => finish(null), waitMs);
      // When Claude Code ends this hook because the prompt was answered in the
      // terminal, it may kill only the shell around us. Leave when it is gone,
      // which closes the connection and tells the bridge the prompt is closed.
      if (parentWatch) {
        const parent = process.ppid;
        watch = setInterval(() => {
          try {
            process.kill(parent, 0);
          } catch {
            finish(null);
          }
        }, 1000);
      }
      socket.write(line + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > REPLY_LIMIT) return finish(null);
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, end)));
      } catch {
        finish(null);
      }
    });
  });
}

async function main() {
  const mode = process.argv[2];
  const pipe = process.env.NEXBOT_HOOK_PIPE;
  const token = process.env.NEXBOT_HOOK_TOKEN;
  if (!MODES.has(mode) || !pipe || !token) return null;
  const text = await readStdin();
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return null;
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const sent = {
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    cwd: input.cwd,
    tool_name: input.tool_name,
    tool_use_id: input.tool_use_id,
    tool_input: slim(input.tool_input),
    ...(Array.isArray(input.permission_suggestions) ? { permission_suggestions: slim(input.permission_suggestions) } : {}),
  };
  const line = JSON.stringify({ v: 1, token, event: mode, input: sent });
  const waitMs = mode === "permission" ? Number(process.env.NEXBOT_HOOK_TIMEOUT_MS) || DEFAULT_WAIT_MS : DELIVER_WAIT_MS;
  const reply = await exchange(pipe, line, waitMs, mode === "permission");
  if (mode !== "permission" || !reply || reply.v !== 1) return null;
  return permissionOutput({ tool_name: input.tool_name, tool_input: input.tool_input, permission_suggestions: input.permission_suggestions }, reply);
}

let output = null;
try {
  output = await main();
} catch {
  output = null;
}
if (output) process.stdout.write(JSON.stringify(output), () => process.exit(0));
else process.exit(0);
