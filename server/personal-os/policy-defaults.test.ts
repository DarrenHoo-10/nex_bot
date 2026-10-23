import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CoreStore } from "./store.ts";
import { actions, evaluateTool, policyTools } from "./policy.ts";

const legacy = ["memory.search", "memory.read", "memory.write", "agent.delegate", "device.read", "device.list", "device.exec", "routine.list", "routine.save", "routine.toggle", "routine.run", "memory.reflect", "memory.delete", "memory.forget", "agent.directory", "device.inventory", "device.info", "device.computer", "skill.list", "skill.read"];
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-policy-defaults-")), key = randomBytes(32);
  let store = new CoreStore(dir, key, "synthetic");
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, restart() { store.close(); store = new CoreStore(dir, key, "synthetic"); } };
}

it("upgrades the stranded default policy and keeps the repair stable across restarts", () => {
  const f = fixture(), bot = f.store.createBot("Legacy default");
  f.store.run("UPDATE bot_policies SET policy_json=?,version=3 WHERE bot_id=?", JSON.stringify({ tools: legacy }), bot);
  expect(() => evaluateTool(f.store, bot, { action: "attachment.read", attachmentId: "fixture" })).toThrow("无权");
  f.store.run("DELETE FROM schema_migrations WHERE version=22");
  f.restart();
  const policy = () => f.store.get("SELECT * FROM bot_policies WHERE bot_id=?", bot)!;
  expect(policy().version).toBe(4);
  expect(policyTools(policy())).toEqual([...actions]);
  expect(JSON.parse(String(policy().policy_json)).inheritDefaults).toBe(true);
  for (const action of ["attachment.read", "connector.list", "agent.directory", "device.inventory"])
    expect(evaluateTool(f.store, bot, { action, attachmentId: "fixture" }).approvalRequired).toBe(false);
  expect(evaluateTool(f.store, bot, { action: "agent.create", name: "Peer" }).approvalRequired).toBe(true);
  f.store.run("INSERT INTO agent_approval_settings VALUES(?,?,?)", bot, "full", 1);
  expect(evaluateTool(f.store, bot, { action: "agent.create", name: "Peer" }).approvalRequired).toBe(false);
  f.restart();
  expect(policy().version).toBe(4);
  expect(policyTools(policy())).toEqual([...actions]);
});

it("preserves edited policies, unknown restricted sets and creator-limited peers", () => {
  const f = fixture();
  const edited = f.store.createBot("Edited"), restricted = f.store.createBot("Restricted"), peer = f.store.createBot("Peer");
  for (const bot of [edited, peer]) f.store.run("UPDATE bot_policies SET policy_json=? WHERE bot_id=?", JSON.stringify({ tools: legacy }), bot);
  f.store.run("UPDATE bot_policies SET policy_json=? WHERE bot_id=?", JSON.stringify({ tools: ["memory.search"] }), restricted);
  f.store.audit("agent.policy.update", "bot", edited, { tools: legacy });
  f.store.audit("steward.agent.create", "tool_call", "synthetic-call", { botId: peer });
  const before = f.store.all("SELECT * FROM bot_policies ORDER BY bot_id");
  f.store.run("DELETE FROM schema_migrations WHERE version=22");
  f.restart();
  expect(f.store.all("SELECT * FROM bot_policies ORDER BY bot_id")).toEqual(before);
  for (const bot of [edited, restricted, peer])
    expect(() => evaluateTool(f.store, bot, { action: "attachment.read", attachmentId: "fixture" })).toThrow("无权");
});

it("uses current defaults instead of stale snapshots while keeping scope checks", () => {
  const f = fixture(), bot = f.store.createBot("Default");
  const policy = f.store.get("SELECT * FROM bot_policies WHERE bot_id=?", bot)!;
  expect(JSON.parse(String(policy.policy_json)).inheritDefaults).toBe(true);
  expect(policyTools({ ...policy, policy_json: JSON.stringify({ tools: legacy, inheritDefaults: true }) })).toEqual([...actions]);
  expect(() => evaluateTool(f.store, bot, { action: "device.read", deviceId: "unbound", path: "." })).toThrow("本地授权");
  f.store.run("UPDATE bots SET status='archived' WHERE id=?", bot);
  expect(() => evaluateTool(f.store, bot, { action: "attachment.read", attachmentId: "fixture" })).toThrow("无权");
});
