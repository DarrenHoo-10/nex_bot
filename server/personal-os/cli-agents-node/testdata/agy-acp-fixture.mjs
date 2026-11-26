#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.ANTIGRAVITY_CLI_CONFIG_DIR;
if (!dir) throw new Error("The fixture requires an isolated AGY profile");
if (process.argv[2] === "models") {
  console.log("gemini-fixture-low\tGemini Fixture (Low)\ngemini-fixture-high\tGemini Fixture (High)");
  process.exit(0);
}
if (process.argv[2] !== "acp") throw new Error("Expected agy acp");

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id, result = {}) => send({ id, result });
const update = (sessionId, fields) => send({ method: "session/update", params: { sessionId, update: fields } });
const logPath = (sessionId) => path.join(dir, "brain", sessionId, ".system_generated", "logs", "transcript_full.jsonl");
const pending = new Map();
let question = 100;
const timestamp = () => new Date().toISOString();
const configOptions = [
  { id: "mode", category: "mode", currentValue: "default" },
  { id: "model", category: "model", currentValue: "gemini-fixture" },
  { id: "thought_level", currentValue: "high" },
];
const load = (sessionId) => {
  const file = logPath(sessionId);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const append = (sessionId, value) => {
  const file = logPath(sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ step_index: load(sessionId).length, created_at: timestamp(), ...value }) + "\n");
};
function finish(id, sessionId, text, reason = "end_turn") {
  if (text) {
    for (const fragment of [text.slice(0, 4), text.slice(4)]) {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: fragment } });
    }
    append(sessionId, { type: "PLANNER_RESPONSE", status: "DONE", content: text });
  }
  reply(id, { stopReason: reason });
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const { id, method, params, result } = JSON.parse(line);
  if (!method) {
    const turn = pending.get(id);
    if (!turn) return;
    pending.delete(id);
    finish(turn.id, turn.sessionId, result?.outcome?.optionId === "permit" ? "approved fixture" : "denied fixture");
    return;
  }
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
      break;
    case "session/new":
      reply(id, { sessionId: "c75d00aa-0000-4000-8000-000000000002", configOptions });
      break;
    case "session/resume":
      if (!existsSync(logPath(params.sessionId))) send({ id, error: { code: -32002, message: "unknown session" } });
      else reply(id, { configOptions });
      break;
    case "session/set_mode":
      reply(id, { configOptions });
      break;
    case "session/set_config_option": {
      const option = configOptions.find((item) => item.id === params.configId);
      if (option) option.currentValue = params.value;
      // the modes a test asked for, in the isolated profile
      if (params.configId === "mode") appendFileSync(path.join(dir, "modes.log"), params.value + "\n");
      reply(id, { configOptions });
      break;
    }
    case "session/prompt": {
      const sessionId = params.sessionId;
      const text = params.prompt[0].text;
      const previous = load(sessionId).find((step) => step.type === "USER_INPUT")?.content;
      append(sessionId, { type: "USER_INPUT", created_at: new Date(Date.now() - 1000).toISOString(),
        content: `<USER_REQUEST>${text}</USER_REQUEST>\n<ADDITIONAL_METADATA>fixture clock</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>fixture model</USER_SETTINGS_CHANGE>` });
      if (text === "request approval") {
        pending.set(++question, { id, sessionId });
        send({
          id: question, method: "session/request_permission", params: {
            sessionId, toolCall: { toolCallId: "fixture", title: "Read fixture.txt", rawInput: { path: "fixture.txt" } },
            options: [{ optionId: "permit", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }],
          },
        });
      } else finish(id, sessionId, previous ? "context " + previous : "new fixture");
      break;
    }
    case "session/cancel":
      for (const [questionId, turn] of pending) {
        if (turn.sessionId !== params.sessionId) continue;
        pending.delete(questionId);
        finish(turn.id, turn.sessionId, "", "cancelled");
      }
      break;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: "unsupported operation" } });
  }
});
