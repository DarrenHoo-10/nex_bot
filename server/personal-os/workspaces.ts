import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { createPersonalApp, type AppOptions } from "./index.ts";
import { hash } from "./store.ts";
import { IdentityError, type UpstreamSession } from "./identity-provider.ts";
import { requestBody } from "./http-body.ts";
import { GOOGLE_CALLBACK } from "./gmail-provider.ts";

type App = Awaited<ReturnType<typeof createPersonalApp>>;

/** One endpoint, separate Core databases. The original database stays in place. */
export async function createWorkspaceService(options: AppOptions) {
  if (options.identity === false) throw new Error("账号工作区必须启用 NexorAI 登录");
  const primary = await createPersonalApp({ ...options, hostDevice: false, accountWorkspaces: true });
  const workspaces = new Map<string, App>(), pending = new Map<string, Promise<App>>();
  const directory = path.join(options.dir, "account-workspaces");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const publicCoreId = String(primary.store.get("SELECT core_id FROM workspaces")!.core_id);
  const issuer = String(primary.identity!.configuration()!.base_url);
  const workspaceKey = (subject: string) => hash(JSON.stringify([issuer, subject]));
  let closing = false;
  const apps = () => [primary, ...workspaces.values()];
  function existingSubject(app: App) {
    return app.store.get("SELECT e.subject FROM external_identities e JOIN identity_provider p ON p.external_identity_id=e.id WHERE e.issuer=? AND e.status='active'", issuer)?.subject;
  }
  async function load(key: string) {
    if (closing) throw new IdentityError(503, "服务正在重启，请稍后重试");
    const existing = workspaces.get(key); if (existing) return existing;
    const inFlight = pending.get(key); if (inFlight) return inFlight;
    if (workspaces.size + pending.size >= 100) throw new IdentityError(503, "工作区容量已满，请联系服务管理员");
    const promise = (async () => {
      const dir = path.join(directory, key);
      // Subject-derived directory names are server-owned; never accept a path from HTTP.
      const keyMaterial = createHmac("sha256", options.key).update("nexbot-workspace-v1:" + key).digest();
      const app = await createPersonalApp({ ...options, dir, key: keyMaterial, token: randomBytes(32).toString("base64url"),
        listen: false, serviceOrigin: primary.origin, publicCoreId, hostDevice: false });
      const subject = existingSubject(app);
      if (subject && workspaceKey(String(subject)) !== key) { await app.close(); throw new Error("工作区身份索引不一致"); }
      workspaces.set(key, app); return app;
    })();
    pending.set(key, promise);
    try { return await promise; } finally { pending.delete(key); }
  }
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory() || lstatSync(path.join(directory, entry.name)).isSymbolicLink()) throw new Error("工作区目录无效");
      await load(entry.name);
    }
    primary.identity!.routeVerified = async (upstream: UpstreamSession, name: string) => {
      if (closing) throw new IdentityError(503, "服务正在重启，请稍后重试");
      const target = existingSubject(primary) === upstream.subject ? primary : await load(workspaceKey(upstream.subject));
      if (closing) throw new IdentityError(503, "服务正在重启，请稍后重试");
      const login = target.identity!.acceptVerified(upstream, name);
      target.runtime.startRecovered(); target.changed(); return login;
    };
    primary.setRequestRouter(async (request, response) => {
      if (closing) throw new IdentityError(503, "服务正在重启，请稍后重试");
      const route = new URL(request.url ?? "/", primary.origin).pathname;
      if (route === GOOGLE_CALLBACK && request.method === "GET") {
        const state = new URL(request.url!, primary.origin).searchParams.get("state") ?? "";
        const target = apps().find((app) => app.connectors.oauth.ownsState(state));
        if (!target || target === primary) return false;
        await target.handleRequest(request, response); return true;
      }
      // All password challenges belong to the endpoint, regardless of old cookies.
      if (["/api/auth/start", "/api/auth/respond"].includes(route) || !route.startsWith("/api/")) return false;
      let token = request.headers.authorization?.replace(/^Bearer /, "") ?? request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("nex="))?.slice(4) ?? "";
      if (route === "/api/session" && request.method === "POST") token = String((await requestBody(request)).token ?? "");
      if (!token || token.length > 200) return false;
      const digest = hash(token);
      const target = apps().find((app) => app.store.get("SELECT id FROM user_sessions WHERE token_hash=?", digest));
      if (!target || target === primary) return false;
      // The chosen Core still checks expiry, revocation, membership and upstream status.
      await target.handleRequest(request, response); return true;
    });
    primary.server.removeListener("upgrade", primary.gateway.handleUpgrade);
    primary.server.on("upgrade", (request, socket, head) => {
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (closing || !token || token.length > 200) { socket.destroy(); return; }
      const digest = hash(token);
      const target = apps().find((app) => app.store.get("SELECT id FROM device_credentials WHERE access_hash=? AND status='active' AND access_expires_at>?", digest, Date.now()));
      if (!target) { socket.destroy(); return; }
      target.gateway.handleUpgrade(request, socket, head);
    });
    return { ...primary, workspaces, async close() {
      closing = true;
      await Promise.allSettled(pending.values());
      await Promise.all([...workspaces.values()].map((app) => app.close()));
      await primary.close();
    } };
  } catch (error) {
    closing = true;
    await Promise.allSettled([...workspaces.values()].map((app) => app.close()));
    await primary.close(); throw error;
  }
}
