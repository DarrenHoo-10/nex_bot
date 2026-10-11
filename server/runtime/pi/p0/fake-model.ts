import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type FakeScript = (
  | { kind: "openai-text"; text: string }
  | { kind: "openai-tool"; calls: Array<{ id: string; name: string; args: string }> }
  | { kind: "openai-error"; status: number; message: string }
  | { kind: "anthropic-text"; text: string }
  | { kind: "anthropic-tool"; id: string; name: string; args: string }
  | { kind: "anthropic-error"; status: number; message: string }
  | { kind: "hang" }) & { waitFor?: Promise<void> };

export interface FakeRequest {
  url: string;
  body: string;
}

export interface FakeModel {
  origin: string;
  port: number;
  scripts: FakeScript[];
  requests: FakeRequest[];
  close(): Promise<void>;
}

function sse(chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

function openaiText(text: string): string {
  return sse([
    {
      id: "chatcmpl-p0",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-p0",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-p0",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  ]);
}

function openaiTool(calls: Array<{ id: string; name: string; args: string }>): string {
  return sse([
    {
      id: "chatcmpl-p0-tool",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: "" },
          })),
        },
        finish_reason: null,
      }],
    },
    ...calls.map((call, index) => ({
      id: "chatcmpl-p0-tool",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index, function: { arguments: call.args } }] },
        finish_reason: null,
      }],
    })),
    {
      id: "chatcmpl-p0-tool",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

function anthropicFrame(events: unknown[]): string {
  return events.map((event) => {
    const record = event as { type: string };
    return `event: ${record.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join("");
}

function anthropicText(text: string, model: string): string {
  return anthropicFrame([
    {
      type: "message_start",
      message: {
        id: "msg_p0",
        type: "message",
        role: "assistant",
        model,
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

function anthropicTool(id: string, name: string, args: string, model: string): string {
  return anthropicFrame([
    {
      type: "message_start",
      message: {
        id: "msg_p0_tool",
        type: "message",
        role: "assistant",
        model,
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

function errorBody(message: string): string {
  return JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message },
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function write(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

export function startFakeModel(): Promise<FakeModel> {
  const scripts: FakeScript[] = [];
  const requests: FakeRequest[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? "";
    requests.push({ url, body });
    const script = scripts.shift();
    if (!script) {
      write(res, 500, "application/json", errorBody(`no script for ${url}`));
      return;
    }
    if (script.waitFor) await script.waitFor;
    if (script.kind === "hang") {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        req.on("aborted", done);
        req.on("close", done);
        res.on("close", done);
      });
      if (!res.writableEnded) res.end();
      return;
    }
    if (script.kind === "openai-error" || script.kind === "anthropic-error") {
      write(res, script.status, "application/json", errorBody(script.message));
      return;
    }
    if (script.kind === "openai-text") {
      write(res, 200, "text/event-stream", openaiText(script.text));
      return;
    }
    if (script.kind === "openai-tool") {
      write(res, 200, "text/event-stream", openaiTool(script.calls));
      return;
    }
    if (script.kind === "anthropic-text") {
      write(res, 200, "text/event-stream", anthropicText(script.text, "p0-anthropic"));
      return;
    }
    write(res, 200, "text/event-stream", anthropicTool(script.id, script.name, script.args, "p0-anthropic"));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        port,
        scripts,
        requests,
        close: () => new Promise((done, fail) => {
          server.close((error) => error ? fail(error) : done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
