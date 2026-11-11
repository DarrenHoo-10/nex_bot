import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkspaceService } from "./workspaces.ts";
import { startFakeIdentity } from "./testing/fake-identity.ts";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function fixture() {
  const provider = await startFakeIdentity();
  closes.push(() => provider.close());
  const serviceKey = randomBytes(32).toString("hex");
  const scope = {issuer: provider.origin, subject: "synthetic-other-uid", coreId: "fixture-core", instanceId: "fixture-stock", delegationId: "fixture-binding"};
  const state = { token: "first-lease", revoked: false, loggedIn: true, renewals: 0, publicEnd: 7, privateEnd: 11, wrongPublicView: false, tools:["call_api"] };
  const operations: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://localhost");
      const send = (code: number, data: unknown) => {
        response.writeHead(code, {"Content-Type": "application/json"}); response.end(JSON.stringify(data));
      };
      let raw = ""; for await (const chunk of request) raw += chunk;
      const data = raw ? JSON.parse(raw) : {};
      const grant = () => ({...scope, delegationToken: state.token, refreshToken: "fixture-renewal", expiresAt: Date.now() + 900_000});
      const route = url.pathname.replace("/api/v1/finance/", "");
      if (request.headers.authorization !== "Bearer " + serviceKey || state.revoked) return send(401, {});
      if (route === "session-exchanges/redeem") return send(data.code === "verified" ? 200 : 401, grant());
      if (route === "delegations/renew") {
        if (!state.loggedIn || data.refreshToken !== "fixture-renewal" || data.delegationId !== scope.delegationId) return send(401, {});
        state.renewals++; state.token = "renewal-" + state.renewals; return send(200, grant());
      }
      const isPublic = route === "reports/public-events";
      if (isPublic ? request.headers["x-finance-subscription"] !== "fixture-renewal" :
        !state.loggedIn || request.headers["x-finance-delegation"] !== state.token) return send(401, {});
      if (route === "tools") return send(200, {tools: state.tools.map(name => ({name, description:"fixture", inputSchema:{type:"object"}}))});
      if (route === "tools/call") { operations.push({...data, audience: request.headers["x-finance-audience"]}); return send(200, {ok:true, evidence:{marketTimestamp:null}}); }
      if (route === "delegations/verify") return send(200, grant());
      if (route === "history") return send(200, {messages: [], nextCursor: 0, hasMore: false});
      if (isPublic || route === "reports/events") {
        const end = isPublic ? state.publicEnd : state.privateEnd;
        const audience = isPublic && !state.wrongPublicView ? "public" : "private";
        const event = {cursor: end, instanceId: scope.instanceId, reportId: (isPublic ? "public-" : "private-") + end,
          version: "v1", kind: "market_review", tradingDay: isPublic ? "2026-11-09" : null,
          views: [{audience, content: "fixture", verified:true}]};
        const empty = url.searchParams.has("head") || Number(url.searchParams.get("after")) >= end;
        return send(200, {events: empty ? [] : [event], nextCursor:end});
      }
      send(404, {});
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const remote = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  closes.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const dir = mkdtempSync(path.join(tmpdir(), "nex-finance-gateway-"));
  closes.push(async () => { rmSync(dir, {recursive:true,force:true}); });
  const options = {dir, key:randomBytes(32), token:"synthetic-bootstrap", identity:{fixtureOrigin:provider.origin}, memoryRuntime:false as const,
    stock:{url:remote,token:serviceKey,coreId:scope.coreId,instanceId:scope.instanceId}};
  const service = await createWorkspaceService(options);
  closes.push(() => service.close());
  const api = async (route:string, credential:string, data?:Record<string,unknown>) => {
    const res = await fetch(service.origin + "/api/" + route, {method:data ? "POST":"GET",
      headers:{Authorization:"Bearer " + credential, "Content-Type":"application/json", ...(credential === options.token ? {Cookie:"nex-bootstrap="+options.token} : {})}, ...(data ? {body:JSON.stringify(data)}:{})});
    return {status:res.status, data:await res.json() as Record<string,unknown>};
  };
  const exchange = () => api("finance/exchange", serviceKey, {instanceId:scope.instanceId, code:"verified"});
  const owner = await api("auth/start", options.token, {account:"owner@example.test",name:"Owner"});
  expect(owner.status).toBe(200);
  expect((await api("auth/respond", options.token, {...owner.data,password:" synthetic password "})).status).toBe(200);
  return { service, api, state, exchange, operations, scope };
}

it("routes a verified Stock subject to the same native workspace, and confines its browser credential to finance", async () => {
  const f = await fixture();
  const first = await f.exchange(); expect(first.status).toBe(200);
  const newLogin = await f.api("auth/start","",{account:"other@example.test",name:"Test"});
  const native = await f.api("auth/respond","",{...newLogin.data,password:" synthetic password "});
  expect(native.status).toBe(200);
  const grant = first.data, stock = String(grant.token);
  expect((await f.api("agents/finance",String(native.data.token))).data.botId).toBe(grant.botId);
  expect((await f.exchange()).data.botId).toBe(grant.botId);
  expect(f.service.workspaces.size).toBe(1);
  expect((await f.api("state",stock)).status).toBe(403);
  expect((await f.api("agents/topics?bot=some-other-agent",stock)).status).toBe(403);
  expect((await f.api("events",stock)).status).toBe(403);
  expect((await f.api("finance/aliases", stock)).status).toBe(200);
  expect((await f.api("finance/alias?sessionId=unknown", stock)).status).toBe(404);
  expect((await f.api("finance/exchange",stock,{code:"verified",instanceId:f.scope.instanceId})).status).toBe(401);
  f.state.revoked = true;
  expect((await f.api("agents/finance",stock)).status).toBe(401);
  expect((await f.api("agents/finance",String(native.data.token))).status).toBe(200);
});

it("renews an accepted task separately from the browser lease, and stops at verified upstream revocation", async () => {
  const f = await fixture(); const {data:grant} = await f.exchange();
  const app = [...f.service.workspaces.values()][0];
  const session = await app.finance.authenticate(String(grant.token)); expect(session).toBeTruthy();
  const sid = String(session!.id);
  app.store.run("UPDATE stock_finance_bindings SET expires_at=0");
  app.store.run("UPDATE user_sessions SET created_at=1,expires_at=2 WHERE id=?",sid);
  expect(app.finance.locallyAllowed(String(grant.token))).toBeUndefined();
  expect(await Promise.all([app.finance.authorizeTask(sid),app.finance.authorizeTask(sid)])).toEqual([true,true]);
  expect(f.state.renewals).toBe(1);
  expect(await app.finance.authorizeBoundOwner()).toBe(true);
  f.state.loggedIn = false;
  await expect(app.finance.authorizeTask(sid)).rejects.toMatchObject({status:401});
  await expect(app.finance.authorizeBoundOwner()).rejects.toMatchObject({status:401});
});

it("starts at the archive head, retains each undelivered cursor, and processes public subscriptions after private logout", async () => {
  const f = await fixture(); await f.exchange(); const app = [...f.service.workspaces.values()][0];
  const received:string[] = [];
  const deliver = (report:{reportId:string}) => { received.push(report.reportId); return {durable:true}; };
  await app.finance.pollReports(deliver);
  expect(received).toEqual([]);
  f.state.loggedIn = false; f.state.publicEnd++;
  await expect(app.finance.pollReports(() => ({durable:false}))).rejects.toThrow();
  await expect(app.finance.pollReports(deliver)).rejects.toMatchObject({status:401});
  expect(received).toEqual(["public-8"]);
  f.state.wrongPublicView = true; f.state.publicEnd++;
  await expect(app.finance.pollReports(deliver)).rejects.toMatchObject({status:502});
  expect(received).toEqual(["public-8"]);
  f.state.loggedIn = true; f.state.wrongPublicView = false; f.state.privateEnd++;
  await app.finance.pollReports(deliver);
  expect(received.sort()).toEqual(["private-12","public-8","public-9"]);
  await app.finance.pollReports(deliver); expect(received).toHaveLength(3);
});

it("discovers newly added financial tools for the default assistant while preserving each explicit grant", async () => {
  const f = await fixture(); const {data:grant} = await f.exchange();
  const app = [...f.service.workspaces.values()][0];
  const connector = () => app.store.get("SELECT id,version FROM personal_connectors WHERE kind='stock-finance'")!;
  const granted = (botId: string) => JSON.parse(String(app.store.get("SELECT tools_json FROM personal_connector_grants WHERE connector_id=? AND bot_id=?", connector().id, botId)?.tools_json));
  const secondary = app.store.createBot("Other");
  app.connectors.grant({...connector(), botId:secondary, tools:["call_api"]});
  f.state.tools.push("strategy_inputs");
  await app.finance.testConnector(String(connector().id), connector().version, async () => {});
  expect(granted(String(grant.botId))).toEqual(["call_api","strategy_inputs"]);
  expect(granted(secondary)).toEqual(["call_api"]);
  app.connectors.grant({...connector(), botId:grant.botId, tools:[]});
  f.state.tools.push("read_api_doc");
  await app.finance.testConnector(String(connector().id), connector().version, async () => {});
  expect(granted(String(grant.botId))).toEqual([]);
});

it("renews native history access after the Stock browser lease expires and fails closed when the owner logs out upstream", async () => {
  const f=await fixture();const exchange=await f.exchange();const grant=exchange.data;
  const started=await f.api('auth/start','',{account:'other@example.test',name:'Native history fixture'});
  const native=await f.api('auth/respond','',{...started.data,password:' synthetic password '});
  expect(native.status).toBe(200);
  const app=[...f.service.workspaces.values()][0],stock=await app.finance.authenticate(String(grant.token));
  expect(stock).toBeTruthy();
  app.store.run('UPDATE stock_finance_bindings SET expires_at=0');
  app.store.run('UPDATE user_sessions SET created_at=1,expires_at=2 WHERE id=?',stock!.id);
  expect((await f.api('finance/aliases',String(native.data.token))).status).toBe(200);
  expect(f.state.renewals).toBe(1);
  f.state.loggedIn=false;
  expect((await f.api('finance/aliases',String(native.data.token))).status).toBe(401);
});
