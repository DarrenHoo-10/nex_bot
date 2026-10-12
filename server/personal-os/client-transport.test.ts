import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it, expect } from "vitest";
import { createPersonalApp } from "./index.ts";

const start: typeof createPersonalApp = process.env.NEX_TEST_BUNDLE ? (await import(pathToFileURL(path.resolve(process.env.NEX_TEST_BUNDLE)).href)).createPersonalApp : createPersonalApp;
function http(origin: string, host: string, route: string, token: string, data?: unknown, browserOrigin?: string) {
  return new Promise<{ status?: number; cookie?: string[] }>((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = request(origin + route, { method: data ? "POST" : "GET", headers: { Host: host, Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}), ...(browserOrigin ? { Origin: browserOrigin } : {}) } }, (response) => { response.resume(); response.once("end", () => resolve({ status: response.statusCode, cookie: response.headers["set-cookie"] })); });
    req.once("error", reject); req.end(data ? body : undefined);
  });
}
async function fixture(options: { host?: string; publicOrigin?: string }, work: (app: Awaited<ReturnType<typeof createPersonalApp>>) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-client-transport-"));
  if (path.dirname(root).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(root).startsWith("nex-client-transport-")) throw new Error("Unsafe transport fixture directory");
  const app = await start({ ...options, identity: false, dir: root, key: randomBytes(32), token: "synthetic-transport-owner", memoryRuntime: false });
  try { await work(app); } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}
it("accepts this machine's literal LAN Host and matching browser Origin, and prevents remote client grants to Core's local Node", async () => {
  await fixture({ host: "0.0.0.0" }, async (app) => {
    const entry = Object.values(os.networkInterfaces()).flat().find((item) => item?.family === "IPv4" && !item.internal);
    const host = `${entry?.address ?? "127.0.0.1"}:${new URL(app.origin).port}`;
    expect((await http(app.origin, host, "/api/clients/invite", "synthetic-transport-owner", { name: "合成 LAN 客户端" }, `http://${host}`)).status).toBe(200);
    expect((await http(app.origin, host, "/api/clients/invite", "synthetic-transport-owner", { name: "bad" }, "https://foreign.example")).status).toBe(403);
    const inviteResponse = await fetch(app.origin + "/api/clients/invite", { method: "POST", headers: { Authorization: "Bearer synthetic-transport-owner", "Content-Type": "application/json" }, body: '{"name":"合成客户端"}' });
    const invite = await inviteResponse.json() as { code: string };
    const loginResponse = await fetch(app.origin + "/api/client/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: invite.code, name: "合成客户端" }) });
    const login = await loginResponse.json() as { token: string };
    expect((await http(app.origin, host, "/api/node", login.token, { origin: app.origin, root: app.store.dir, exec: true, token: "bad" }, `http://${host}`)).status).toBe(403);
    app.store.run("UPDATE user_sessions SET expires_at=? WHERE token_hash=?", Date.now() + 60_000, (await import("./store.ts")).hash(login.token));
    const exchange = await http(app.origin, host, "/api/session", login.token, { token: login.token }, `http://${host}`);
    expect(Number(/Max-Age=(\d+)/.exec(exchange.cookie?.[0] ?? "")?.[1])).toBeLessThanOrEqual(60);
  });
});
it("supports an explicitly pinned HTTPS reverse proxy origin and sets Secure client cookies", async () => {
  await fixture({ publicOrigin: "https://synthetic-core.example" }, async (app) => {
    const response = await http(app.origin, "synthetic-core.example", "/api/session", "synthetic-transport-owner", { token: "synthetic-transport-owner" }, "https://synthetic-core.example");
    expect(response.status).toBe(200); expect(response.cookie?.[0]).toContain("; Secure");
    expect(Number(/Max-Age=(\d+)/.exec(response.cookie?.[0] ?? "")?.[1])).toBeGreaterThan(360 * 86400);
    expect((await http(app.origin, "unlisted.example", "/api/state", "synthetic-transport-owner")).status).toBe(403);
  });
});
