import { createServer, type ServerResponse } from "node:http";

/** Loopback only, synthetic MCP server shared by isolated API and renderer checks. */
export async function startFakeMcp() {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const credentials: string[] = [];
  const streams = new Set<ServerResponse>();
  let held = false;
  const server = createServer(async (request, response) => {
    credentials.push(request.headers.authorization ?? "");
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/mcp" }); response.end(); return; }
    if (request.method === "GET" && request.url === "/sse") {
      response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write("event: endpoint\ndata: /messages\n\n");
      streams.add(response); response.on("close", () => streams.delete(response)); return;
    }
    if (request.method !== "POST") { response.writeHead(204); response.end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Isolated fixture", version: "1" } };
    else if (rpc.method === "tools/list") result = { tools: [{ name: "echo", description: "回显测试文字", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }, { name: "read_query", description: "只读测试查询", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object" } }, { name: "send_message", description: "模拟发送", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }, { name: "private_tool", description: "未授权工具", inputSchema: { type: "object" } }] };
    else if (rpc.method === "tools/call") {
      calls.push(rpc.params);
      if (held) return;
      result = { content: [{ type: "text", text: `MCP 回显：${rpc.params.arguments.text ?? ""}` }], structuredContent: { echo: rpc.params.arguments.text } };
    } else result = {};
    const json = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
    if (request.url === "/messages") { for (const stream of streams) stream.write(`event: message\ndata: ${json}\n\n`); response.writeHead(202); response.end(); }
    else { response.writeHead(200, { "Content-Type": "application/json" }); response.end(json); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, calls, credentials, hold(value: boolean) { held = value; }, async close() { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
