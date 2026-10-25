import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CoreStore } from "./store.ts";
import { evaluateTool } from "./policy.ts";
import { approvalRules, rememberApproval, revokeApprovalRule } from "./approval-rules.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-always-allow-")), key = randomBytes(32);
  let store = new CoreStore(dir, key, "synthetic");
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bot = store.createBot("Fixture"), peer = store.createBot("Peer");
  for (const device of ["device-a", "device-b"]) {
    store.insert("devices", { id: device, ...store.scope(), name: device, platform: "windows", protocol_version: "1", status: "bound", capabilities_json: "{}", created_at: Date.now() });
    store.insert("device_local_grants", { device_id: device, local_grant_id: "shared", ...store.scope(), policy_version: 1, scope_json: JSON.stringify({ exec: true, read: true, computer: true }), status: "active", reported_at: Date.now() });
  }
  const remember = (args: Record<string, unknown>) => {
    const evaluated = evaluateTool(store, bot, args);
    rememberApproval(store, bot, args, Number(evaluated.policy.version), evaluated.resourceVersion);
  };
  return { get store() { return store; }, bot, peer, remember, restart() { store.close(); store = new CoreStore(dir, key, "synthetic"); } };
}

it("remembers a device operation class across arguments and restarts, without granting other devices or agents", () => {
  const f = fixture(), args = { action: "device.exec", deviceId: "device-a", command: "rm first.txt", risk: "dangerous" };
  expect(evaluateTool(f.store, f.bot, args).approvalRequired).toBe(true);
  f.remember(args); f.restart();
  expect(evaluateTool(f.store, f.bot, { ...args, command: "rm second.txt" }).approvalRequired).toBe(false);
  expect(evaluateTool(f.store, f.peer, args).approvalRequired).toBe(true);
  expect(evaluateTool(f.store, f.bot, { ...args, deviceId: "device-b" }).approvalRequired).toBe(true);
  expect(evaluateTool(f.store, f.bot, { action: "device.computer", deviceId: "device-a", operation: "click", risk: "dangerous" }).approvalRequired).toBe(true);
  const rule = approvalRules(f.store)[0];
  expect(rule.label).toContain("device-a");
  expect(() => revokeApprovalRule(f.store, String(rule.id), f.peer)).toThrow("不存在");
  revokeApprovalRule(f.store, String(rule.id), f.bot);
  expect(evaluateTool(f.store, f.bot, args).approvalRequired).toBe(true);
});

it("invalidates remembered effects when device grants or Agent policy change", () => {
  const f = fixture(), args = { action: "device.exec", deviceId: "device-a", command: "rm fixture.txt" };
  f.remember(args);
  f.store.run("UPDATE device_local_grants SET policy_version=2 WHERE device_id='device-a'");
  expect(evaluateTool(f.store, f.bot, args).approvalRequired).toBe(true);
  expect(approvalRules(f.store)[0].active).toBe(false);
  f.remember(args);
  f.store.run("UPDATE bot_policies SET version=version+1 WHERE bot_id=?", f.bot);
  expect(evaluateTool(f.store, f.bot, args).approvalRequired).toBe(true);
  f.remember(args);
  f.store.run("UPDATE device_local_grants SET status='revoked' WHERE device_id='device-a'");
  expect(() => evaluateTool(f.store, f.bot, args)).toThrow("本地授权");
});

it("scopes connector authorization to the connector, tool and current grants", () => {
  const f = fixture();
  const catalog = ["send_mail", "delete_mail"].map((name) => ({ name, description: "synthetic", inputSchema: {} }));
  for (const connector of ["connector-a", "connector-b"]) {
    f.store.insert("personal_connectors", { id: connector, ...f.store.scope(), name: connector, url: "http://127.0.0.1/mcp", transport: "http", tools_json: JSON.stringify(catalog), created_at: Date.now() });
    f.store.run("INSERT INTO personal_connector_grants VALUES(?,?,?)", connector, f.bot, JSON.stringify(catalog.map((tool) => tool.name)));
  }
  const args = { action: "connector.call", connectorId: "connector-a", connectorVersion: 1, tool: "send_mail", parameters: { to: "synthetic@example.test" } };
  f.remember(args);
  expect(evaluateTool(f.store, f.bot, { ...args, parameters: { to: "other@example.test" } }).approvalRequired).toBe(false);
  expect(evaluateTool(f.store, f.bot, { ...args, tool: "delete_mail" }).approvalRequired).toBe(true);
  expect(evaluateTool(f.store, f.bot, { ...args, connectorId: "connector-b" }).approvalRequired).toBe(true);
  f.store.run("UPDATE personal_connectors SET version=2 WHERE id='connector-a'");
  expect(evaluateTool(f.store, f.bot, { ...args, connectorVersion: 2 }).approvalRequired).toBe(true);
  f.store.run("DELETE FROM personal_connector_grants WHERE connector_id='connector-a'");
  expect(() => evaluateTool(f.store, f.bot, { ...args, connectorVersion: 2 })).toThrow("未授权");
});
