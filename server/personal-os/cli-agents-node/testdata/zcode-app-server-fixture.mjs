#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

if (process.argv[2] === "skills" && process.argv[3] === "list") {
  process.stdout.write(JSON.stringify({
    skills: [
      { name: "zcode-review", description: "Review code with ZCode" },
      { name: "zcode-fix", description: "Fix failing tests" },
    ],
  }) + "\n");
  process.exit(0);
}

if (process.argv[2] !== "app-server") {
  process.stderr.write("Expected app-server or skills list\n");
  process.exit(1);
}

const dbPath = process.env.ZCODE_SESSION_DB_PATH;
if (!dbPath) throw new Error("The fixture requires ZCODE_SESSION_DB_PATH");
mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
    version TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_deleted INTEGER, task_type TEXT
  );
  CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER
  );
  CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER
  );
  CREATE TABLE IF NOT EXISTS session_runtime_presence (
    session_id TEXT, owner_id TEXT, process_id INTEGER
  );
`);

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result = {}) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
// Match real ZCode `BLi`: `sessionId`, `type`, `payload` are directly on `params`.
const emit = (sessionId, type, payload = {}) => send({ method: "session/event", params: { sessionId, type, payload } });

const AVAILABLE_MODELS = [
  {
    ref: { providerId: "magpie", modelId: "zcode/GLM-5.3-Flash" },
    label: "GLM-5.3-Flash",
    providerLabel: "Magpie",
    contextWindow: 200000,
    reasoning: {
      levels: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }],
      defaultLevel: "medium",
    },
    properties: { inputFormat: { supportsImage: true } },
  },
  {
    ref: { providerId: "bigmodel", modelId: "glm-5" },
    label: "GLM-5",
    providerLabel: "智谱",
    contextWindow: 128000,
    reasoning: { levels: [], defaultLevel: undefined },
    properties: { inputFormat: { supportsImage: false } },
  },
];

const sessions = new Map();
const uploads = new Map();
const pendingServerReqs = new Map();
let nextServerId = 1000;
let seqCounter = 100;

function ensureSessionInDb(sessionId, cwd, title = "") {
  const now = Date.now();
  const exists = db.prepare("SELECT id FROM session WHERE id=?").get(sessionId);
  if (!exists) {
    db.prepare(
      "INSERT INTO session (id, directory, title, version, time_created, time_updated, task_type) VALUES (?,?,?,?,?,?,?)",
    ).run(sessionId, cwd, title, "0.18.0", now, now, "interactive");
  }
  db.prepare("INSERT OR REPLACE INTO session_runtime_presence (session_id, owner_id, process_id) VALUES (?,?,?)")
    .run(sessionId, "fixture", process.pid);
}

function persistMessage(sessionId, role, text) {
  const now = Date.now();
  const id = `msg_${++seqCounter}`;
  db.prepare("INSERT INTO message (id, session_id, time_created, data, sequence) VALUES (?,?,?,?,?)")
    .run(id, sessionId, now, JSON.stringify({ role, time: { created: now }, ...(role === "assistant" ? { providerId: "magpie", modelId: "zcode/GLM-5.3-Flash", tokens: { total: 420 } } : {}) }), seqCounter);
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?,?,?,?,?,?)")
    .run(`${id}_p0`, id, sessionId, now, JSON.stringify({ type: "text", text }), 0);
  db.prepare("UPDATE session SET time_updated=? WHERE id=?").run(now, sessionId);
}

function settingsOf(s) {
  return {
    mode: { current: s.mode },
    model: { current: s.model, available: AVAILABLE_MODELS },
    thoughtLevel: s.thoughtLevel,
  };
}

function finishTurn(session, responseText) {
  session.busy = false;
  if (session.subscribed) {
    emit(session.id, "model.streaming", { kind: "reasoning_delta", delta: "thinking..." });
    emit(session.id, "tool.updated", { kind: "scheduled", toolCallId: "tc-1", toolName: "Read", input: { file_path: "README.md" } });
    emit(session.id, "tool.updated", { kind: "result", toolCallId: "tc-1", toolName: "Read", result: { content: "ok" }, duration: 12 });
    emit(session.id, "model.streaming", { kind: "text_delta", delta: responseText.slice(0, 4) });
    emit(session.id, "model.streaming", { kind: "text_delta", delta: responseText.slice(4) });
  }
  persistMessage(session.id, "assistant", responseText);
  if (session.subscribed) {
    emit(session.id, "turn.completed", { response: responseText, tokenCount: 420, usage: { total: 420 } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if ("jsonrpc" in msg) {
    if (msg.id !== undefined) fail(msg.id, -32600, "Unrecognized key: jsonrpc");
    return;
  }
  if (!msg.method) {
    const waiter = pendingServerReqs.get(msg.id);
    if (!waiter) return;
    pendingServerReqs.delete(msg.id);
    waiter(msg);
    return;
  }
  const { id, method, params = {} } = msg;
  switch (method) {
    case "session/create": {
      const deferred = params.persistence === "deferred";
      const sessionId = deferred ? `sess_probe_${++seqCounter}` : `sess_fixture_${++seqCounter}`;
      const cwd = params.workspace?.workspacePath || process.cwd();
      const model = params.model
        ? { providerId: params.model.providerId, modelId: params.model.modelId }
        : { providerId: "magpie", modelId: "zcode/GLM-5.3-Flash" };
      const s = {
        id: sessionId,
        cwd,
        mode: params.mode || "yolo",
        model,
        thoughtLevel: params.thoughtLevel || params.model?.options?.reasoningLevel || "medium",
        subscribed: false,
        busy: false,
        deferred,
      };
      sessions.set(sessionId, s);
      if (!deferred) ensureSessionInDb(sessionId, cwd, "New ZCode Session");
      const prefId = ++nextServerId;
      pendingServerReqs.set(prefId, () => {
        const langId = ++nextServerId;
        pendingServerReqs.set(langId, () => {
          reply(id, {
            session: { sessionId, mode: s.mode, model: s.model, title: deferred ? "" : "New ZCode Session" },
            settings: settingsOf(s),
            runtime: { stateRevision: 1, eventSeq: 0 },
          });
        });
        send({ id: langId, method: "session/readReplyLanguage", params: { sessionId } });
      });
      send({ id: prefId, method: "session/requestRuntimePreferences", params: { sessionId } });
      break;
    }
    case "session/resume": {
      const sessionId = params.sessionId;
      const row = db.prepare("SELECT id, directory, title FROM session WHERE id=? AND time_deleted IS NULL").get(sessionId);
      if (!row) {
        fail(id, -32004, "Session not found");
        return;
      }
      const cwd = params.workspace?.workspacePath || row.directory;
      const restoreWarning = sessionId === "sess_account_only" ? "Original account model unavailable" : undefined;
      const s = {
        id: sessionId,
        cwd,
        mode: "guarded",
        model: restoreWarning
          ? { providerId: "account:bigmodel-coding-plan", modelId: "glm-5" }
          : { providerId: "magpie", modelId: "zcode/GLM-5.3-Flash" },
        thoughtLevel: params.thoughtLevel || "medium",
        subscribed: false,
        busy: false,
        restoreWarning,
      };
      sessions.set(sessionId, s);
      ensureSessionInDb(sessionId, cwd, row.title || "");
      reply(id, {
        session: { sessionId, mode: s.mode, model: s.model, title: row.title || "" },
        settings: settingsOf(s),
        ...(restoreWarning ? { restoreWarning } : {}),
        runtime: { stateRevision: 1, eventSeq: 0 },
      });
      break;
    }
    case "session/subscribe": {
      const s = sessions.get(params.sessionId);
      if (!s) {
        fail(id, -32004, "Session not found");
        return;
      }
      s.subscribed = true;
      reply(id, { subscribed: true });
      break;
    }
    case "session/setModel": {
      const s = sessions.get(params.sessionId);
      if (!s) {
        fail(id, -32004, "Session not found");
        return;
      }
      s.model = { providerId: params.model.providerId, modelId: params.model.modelId };
      if (params.model.options?.reasoningLevel) s.thoughtLevel = params.model.options.reasoningLevel;
      s.restoreWarning = undefined;
      reply(id, { settings: settingsOf(s) });
      break;
    }
    case "session/setThoughtLevel": {
      const s = sessions.get(params.sessionId);
      if (!s) {
        fail(id, -32004, "Session not found");
        return;
      }
      s.thoughtLevel = params.thoughtLevel;
      reply(id, { settings: settingsOf(s) });
      break;
    }
    case "session/setMode": {
      const s = sessions.get(params.sessionId);
      if (!s) {
        fail(id, -32004, "Session not found");
        return;
      }
      s.mode = params.mode;
      reply(id, { settings: settingsOf(s) });
      break;
    }
    case "session/close": {
      sessions.delete(params.sessionId);
      db.prepare("DELETE FROM session_runtime_presence WHERE session_id=? AND process_id=?").run(params.sessionId, process.pid);
      reply(id, { closed: true });
      break;
    }
    case "v4/attachment/begin": {
      uploads.set(params.uploadId, { meta: params, chunks: [] });
      reply(id, { uploadId: params.uploadId, state: "staging", nextChunkIndex: 0 });
      break;
    }
    case "v4/attachment/chunk": {
      const u = uploads.get(params.uploadId);
      if (!u) {
        fail(id, -32602, "Unknown uploadId");
        return;
      }
      u.chunks[params.chunkIndex] = Buffer.from(params.dataBase64, "base64");
      reply(id, { uploadId: params.uploadId, nextChunkIndex: params.chunkIndex + 1 });
      break;
    }
    case "v4/attachment/commit": {
      const u = uploads.get(params.uploadId);
      if (!u) {
        fail(id, -32602, "Unknown uploadId");
        return;
      }
      const data = Buffer.concat(u.chunks);
      const digest = `sha256:${createHash("sha256").update(data).digest("hex")}`;
      if (digest !== u.meta.checksum) {
        fail(id, -32602, "Checksum mismatch");
        return;
      }
      uploads.delete(params.uploadId);
      reply(id, { ref: `zcode-artifact://${u.meta.sessionId}/${params.uploadId}` });
      break;
    }
    case "v4/attachment/abort": {
      uploads.delete(params.uploadId);
      reply(id, {});
      break;
    }
    case "session/send": {
      const s = sessions.get(params.sessionId);
      if (!s) {
        fail(id, -32004, "Session not found");
        return;
      }
      if (s.busy) {
        fail(id, -32010, "A prompt is already running");
        return;
      }
      if (s.restoreWarning) {
        fail(id, -32020, "Restore warning unresolved");
        return;
      }
      if (s.model.providerId === "magpie" && !params.modelSelection?.options?.reasoningLevel) {
        fail(id, -32020, "Reasoning level is required for magpie/zcode/GLM-5.3-Flash");
        return;
      }
      s.busy = true;
      const content = String(params.content || "");
      persistMessage(s.id, "user", content);
      reply(id, { accepted: true, sessionId: s.id, stateRevision: 2 });

      if (content === "ask permission" || content === "ask reannounce" || content.startsWith("ask long ")) {
        const nativeRequestId = `perm-${++seqCounter}`;
        const input = content.startsWith("ask long ")
          ? { command: content.slice("ask long ".length) + " " + "x".repeat(4500) }
          : { command: "echo hi" };
        let settled = false;
        const onAnswer = (resp) => {
          if (settled) return;
          settled = true;
          finishTurn(s, resp.result?.decision === "allow" ? "permission allowed" : "permission denied");
        };
        const reqId1 = ++nextServerId;
        pendingServerReqs.set(reqId1, onAnswer);
        send({
          id: reqId1,
          method: "interaction/requestPermission",
          params: {
            requestId: nativeRequestId,
            sessionId: s.id,
            toolCallId: "tc-perm",
            toolName: "Bash",
            riskLevel: "high",
            reason: "Run test command",
            input,
            options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
          },
        });
        if (content === "ask reannounce") {
          setTimeout(() => {
            if (settled) return;
            const reqId2 = ++nextServerId;
            pendingServerReqs.set(reqId2, onAnswer);
            send({
              id: reqId2,
              method: "interaction/requestPermission",
              params: {
                requestId: nativeRequestId,
                sessionId: s.id,
                toolCallId: "tc-perm",
                toolName: "Bash",
                riskLevel: "high",
                reason: "Run test command",
                input,
                options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
              },
            });
          }, 15);
        }
      } else if (content === "ask plan approval") {
        const reqId = ++nextServerId;
        pendingServerReqs.set(reqId, (resp) => {
          const val = resp.result?.content?.answer ?? resp.result?.content?.answers?.["Approve plan?"];
          finishTurn(s, val === "approve" ? "plan approved" : `plan feedback: ${String(val)}`);
        });
        send({
          id: reqId,
          method: "interaction/requestUserInput",
          params: {
            requestId: `plan-${reqId}`,
            sessionId: s.id,
            toolName: "ExitPlanMode",
            prompt: "Approve this plan?",
            schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
            questions: [
              {
                question: "Approve plan?",
                header: "Plan",
                options: [{ label: "Approve", value: "approve", description: "Exit plan mode" }],
              },
            ],
          },
        });
      } else if (content === "ask question") {
        const reqId = ++nextServerId;
        pendingServerReqs.set(reqId, (resp) => {
          const answer = resp.result?.content?.answers?.["Pick one?"] ?? "declined";
          finishTurn(s, `answered: ${answer}`);
        });
        send({
          id: reqId,
          method: "interaction/requestUserInput",
          params: {
            requestId: `q-${reqId}`,
            sessionId: s.id,
            toolName: "AskUserQuestion",
            prompt: "Need choice",
            questions: [{ question: "Pick one?", header: "Choice", options: [{ label: "Alpha" }, { label: "Beta" }] }],
          },
        });
      } else if (content === "wait forever") {
        s.pendingWait = true;
      } else {
        setTimeout(() => finishTurn(s, `echo: ${content} [${s.mode}/${s.model.modelId}/${s.thoughtLevel}]`), 15);
      }
      break;
    }
    case "v4/command": {
      const s = sessions.get(params.sessionId);
      if (!s || params.type !== "sendText") {
        fail(id, -32602, "Invalid command");
        return;
      }
      // Enforce jq attachment schema if attachments were sent
      for (const att of params.payload?.attachments ?? []) {
        if (typeof att.ref !== "string" || typeof att.fileName !== "string" || typeof att.mime !== "string" || typeof att.bytes !== "number" || "dataBase64" in att) {
          fail(id, -32602, "Invalid v4 jq attachment");
          return;
        }
      }
      const guideText = String(params.payload?.text || "");
      if (guideText === "reject me") {
        reply(id, { commandId: params.commandId, status: "rejected", reasonCode: "turn_not_steerable", message: "Cannot steer now", revisionAtDecision: 2 });
        return;
      }
      reply(id, {
        commandId: params.commandId,
        status: "accepted",
        revisionAtDecision: 2,
        result: { type: "inputAccepted", delivery: "guide", inputId: `in_${++seqCounter}` },
      });
      if (s.pendingWait) {
        s.pendingWait = false;
        setTimeout(() => finishTurn(s, `steered: ${guideText}`), 15);
      }
      break;
    }
    case "session/stop": {
      const s = sessions.get(params.sessionId);
      if (!s) {
        fail(id, -32004, "Session not found");
        return;
      }
      s.pendingWait = false;
      reply(id, { stopped: true });
      if (s.busy) {
        s.busy = false;
        emit(s.id, "turn.failed", { error: { type: "AbortError", message: "Turn aborted by user" } });
      }
      break;
    }
    default:
      if (id !== undefined) fail(id, -32601, `Unsupported method: ${method}`);
  }
});
