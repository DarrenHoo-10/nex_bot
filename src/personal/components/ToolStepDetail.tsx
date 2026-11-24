import { type PreviewItem } from "../api";

export interface ToolStepBlock { label: string; text: string; mono?: boolean }

const parseArguments = (item: PreviewItem): unknown => {
  try { return JSON.parse(String(item.arguments ?? "")) as unknown; } catch { return undefined; }
};

const textOf = (value: unknown): string => typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();

const RESULT_FIELDS = ["content", "text", "output", "stdout", "value", "message", "result", "error"];
/** Results read as their text payload when there is one; otherwise the JSON itself. */
const resultOf = (item: PreviewItem): { text: string; mono: boolean } => {
  const raw = String(item.content ?? "").trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") return { text: parsed, mono: false };
    if (parsed && typeof parsed === "object") for (const field of RESULT_FIELDS) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim()) return { text: value, mono: false };
    }
  } catch { /* result is plain text */ }
  return { text: raw, mono: true };
};

/** memory.core.update patches read as plain edit lines instead of nested JSON. */
function corePatchLines(patch: unknown): string {
  const source = patch && typeof patch === "object" ? patch as Record<string, unknown> : {};
  const entries = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const row = (entry: unknown) => entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
  const lines: string[] = [];
  const about = (source.about ?? {}) as Record<string, unknown>, topics = (source.topics ?? {}) as Record<string, unknown>;
  for (const line of entries(about.add)) lines.push(`新增：${textOf(line)}`);
  for (const entry of entries(about.update)) lines.push(`更新第 ${textOf(row(entry).index) || "…"} 条：${textOf(row(entry).text)}`);
  for (const index of entries(about.remove)) lines.push(`移除第 ${textOf(index)} 条`);
  for (const entry of entries(topics.add)) lines.push(`新增主题「${textOf(row(entry).title)}」：${textOf(row(entry).line)}`);
  for (const entry of entries(topics.update)) lines.push(`更新主题「${textOf(row(entry).title) || textOf(row(entry).ref) || textOf(row(entry).index)}」：${textOf(row(entry).line) || textOf(row(entry).newRef)}`);
  for (const entry of entries(topics.remove)) lines.push(`移除主题「${textOf(row(entry).title) || textOf(row(entry).ref) || textOf(row(entry).index) || textOf(typeof entry === "object" ? "" : entry)}」`);
  return lines.filter(Boolean).join("\n");
}

// Saved-acknowledgement results ({saved:true,version:N}) say nothing the status dot does not, so succeeded memory writes hide them.
const quietResults = new Set(["memory.write", "memory.core.update"]);
const resultLabels: Record<string, string> = { "device.exec": "执行输出", "device.read": "文件内容", "memory.search": "检索结果", "memory.read": "记忆内容", "memory.reflect": "综合结果", "attachment.read": "附件内容", "skill.read": "技能说明", "connector.call": "连接器返回" };

/** A tool call reads best in the language of what it did, not its raw JSON. */
export function toolStepBlocks(tool: string, item: PreviewItem): ToolStepBlock[] {
  const args = parseArguments(item), fields = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const blocks: ToolStepBlock[] = [];
  const push = (label: string, text: string, mono = false) => { if (text.trim()) blocks.push({ label, text: text.trim(), mono }); };
  const value = (key: string) => textOf(fields[key]);
  if (tool === "memory.write") { push("记忆标题", value("title")); push("写入内容", value("content")); }
  else if (tool === "memory.core.update") { push("记忆变更", corePatchLines(fields.patch)); push("用户原话", value("quote")); }
  else if (tool === "memory.search") push("检索内容", value("query") || value("text"));
  else if (tool === "device.exec") push("执行命令", value("command"), true);
  else if (tool === "device.read") push("读取路径", value("path"), true);
  else if (tool === "image.generate") push("生图提示词", value("prompt"));
  if (!blocks.length) {
    const pretty = typeof args === "string" ? args.trim() : args !== undefined && args !== null ? JSON.stringify(args, null, 2) : "";
    if (pretty && pretty !== "{}" && pretty !== "[]") push("调用参数", pretty, true);
    else if (String(item.arguments ?? "").trim() && args === undefined) push("调用参数", String(item.arguments), true);
  }
  if (String(item.content ?? "").trim()) {
    const result = resultOf(item);
    if (!(result.mono && item.status !== "failed" && quietResults.has(tool))) push(resultLabels[tool] ?? "执行结果", result.text, result.mono || tool === "device.exec");
  }
  return blocks;
}

export function ToolStepDetail({ tool, item, loading, error, fallback }: { tool: string; item?: PreviewItem; loading?: boolean; error?: string; fallback?: string }) {
  if (loading) return <p className="step-detail-empty" role="status">正在加载…</p>;
  const blocks = item ? toolStepBlocks(tool, item) : [];
  if (!blocks.length) return <div className="step-detail-empty">{error ? <p role="alert">{error}</p> : null}<p>{fallback?.trim() || "暂无输出内容"}</p></div>;
  return <div className="step-blocks">
    {error ? <p role="alert">{error}</p> : null}
    {blocks.map((block, index) => <div className="step-block" key={index}><span className="step-block-label">{block.label}</span>{block.mono ? <pre>{block.text}</pre> : <p>{block.text}</p>}</div>)}
  </div>;
}
