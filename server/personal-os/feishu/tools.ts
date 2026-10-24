/** 内置飞书工具目录：通用只读/写接口，写入一律审批（destructiveHint）。 */
export const feishuTools = [
  {
    name: "feishu_read",
    description: "调用飞书开放平台只读接口（GET）。path 形如 /open-apis/docx/v1/documents/{document_id}/raw_content；params 为查询参数；as=user 表示以主人身份调用（需要主人已完成授权）。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, params: { type: "object", additionalProperties: true }, as: { type: "string", enum: ["bot", "user"] } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "feishu_write",
    description: "调用飞书开放平台写入接口（POST/PUT），需要用户逐次批准。path 形如 /open-apis/...；body 为请求体；as=user 表示以主人身份调用。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, body: { type: "object", additionalProperties: true }, as: { type: "string", enum: ["bot", "user"] } },
      required: ["path"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
] as const;

export const feishuToolNames = feishuTools.map((tool) => tool.name);

const pathPattern = /^\/open-apis\/[\w./{}:-]+$/;
const toolMethods = { feishu_read: ["GET"], feishu_write: ["POST", "PUT"] } as const;

/** 校验工具调用参数，返回规范化后的请求。 */
export function parseToolCall(tool: string, parameters: Record<string, unknown>): { method: "GET" | "POST" | "PUT"; path: string; body?: unknown; query: Record<string, unknown>; as: "bot" | "user" } {
  const methods = toolMethods[tool as keyof typeof toolMethods];
  if (!methods) throw new Error("未知工具");
  const rawPath = typeof parameters.path === "string" ? parameters.path.trim() : "";
  if (!rawPath || !pathPattern.test(rawPath)) throw new Error("path 必须以 /open-apis/ 开头，只能包含字母数字与 ./{}:-");
  if (rawPath.includes("?") || rawPath.includes("#")) throw new Error("查询参数请放在 params 里");
  const body = parameters.body;
  if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body))) throw new Error("body 必须是对象");
  if (body !== undefined && JSON.stringify(body).length > 64_000) throw new Error("body 过大（上限 64KB）");
  const query = parameters.params && typeof parameters.params === "object" && !Array.isArray(parameters.params) ? parameters.params as Record<string, unknown> : {};
  const as = parameters.as === "user" ? "user" : "bot";
  const method = methods[0] as "GET" | "POST" | "PUT";
  return { method, path: rawPath, ...(method === "GET" ? {} : { body: body ?? {} }), query, as };
}

export function queryString(query: Record<string, unknown>): string {
  const parts = Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
