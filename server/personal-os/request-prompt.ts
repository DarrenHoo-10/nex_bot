// Providers cache by exact prefix. The system message carries only the stable prompt;
// the per-request volatile block is added here, after all history, and never persisted.
type Wire = { role: string; content?: unknown };
type Payload = { system?: unknown; messages?: unknown };

// The SDK sends the Anthropic system prompt as text blocks and puts its cache breakpoint (cache_control, with the
// retention's ttl) on the block that carries the prompt. Only that text is replaced; the block, and so its
// cache marker, stays. With the Claude Code identity block first (OAuth keys), the prompt is the last block.
function withSystemText(system: unknown, text: string): unknown {
  if (typeof system === "string") return text;
  if (!Array.isArray(system)) return [{ type: "text", text }];
  const index = system.findLastIndex((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text");
  if (index < 0) return [...system, { type: "text", text }];
  return system.map((block, at) => at === index ? { ...(block as object), text } : block);
}

export function applyRequestPrompt(provider: string, payload: Payload, prompt: { systemPrompt: string; volatilePrompt: string }) {
  if (!Array.isArray(payload.messages)) throw new Error("Invalid model messages");
  const messages = payload.messages as Wire[], volatile = prompt.volatilePrompt;
  if (provider === "anthropic") {
    payload.system = withSystemText(payload.system, prompt.systemPrompt);
    if (!volatile) return;
    const part = { type: "text", text: volatile }, last = messages.at(-1);
    // Appended after the existing parts: tool_result blocks must stay first in their
    // message, and the SDK's cache breakpoint on the last block then precedes this
    // volatile text instead of covering it.
    if (last?.role === "user") last.content = Array.isArray(last.content) ? [...last.content, part] : [{ type: "text", text: String(last.content ?? "") }, part];
    else messages.push({ role: "user", content: [part] });
    return;
  }
  const role = messages.find((m) => m.role === "system" || m.role === "developer")?.role ?? "system";
  const rest = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  // Before the user input the model must answer, or after the tool results of a
  // continuation. Both positions follow every assistant/tool pair, never split one.
  let at = rest.length;
  while (at > 0 && rest[at - 1].role === "user") at--;
  if (volatile) rest.splice(at, 0, { role: "user", content: volatile });
  payload.messages = [{ role, content: prompt.systemPrompt }, ...rest];
}
