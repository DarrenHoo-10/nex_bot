// Reasoning effort ("思考强度"). A model offers the levels its provider settings tick; "off" is always available.
// The values are the agent SDK's thinking levels, which it turns into OpenAI reasoning_effort or Anthropic thinking.
export const reasoningLevels = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = typeof reasoningLevels[number];
export type ReasoningChoice = ReasoningLevel | "off";

/** Normalizes a stored or submitted list of levels: known values only, in order, no duplicates. */
export function parseReasoningLevels(value: unknown): ReasoningLevel[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((level) => typeof level !== "string")) throw new Error("推理档位无效");
  if (value.some((level) => !(reasoningLevels as readonly string[]).includes(level))) throw new Error("推理档位无效");
  return reasoningLevels.filter((level) => value.includes(level));
}

/** Reads a submitted reasoning choice; undefined keeps the stored one. */
export function parseReasoningChoice(value: unknown): ReasoningChoice | undefined {
  if (value === undefined) return undefined;
  if (value === "off" || (reasoningLevels as readonly unknown[]).includes(value)) return value as ReasoningChoice;
  throw new Error("思考强度无效");
}

/**
 * The level a request uses: the assistant's choice when the model offers it, otherwise the nearest level the model
 * offers (the lower one on a tie). With no choice yet the middle one is aimed for. A model offering no levels is off.
 */
export function resolveReasoning(choice: string | null | undefined, offered: readonly ReasoningLevel[]): ReasoningChoice {
  if (!offered.length || choice === "off") return "off";
  const wanted = (reasoningLevels as readonly string[]).includes(String(choice)) ? String(choice) as ReasoningLevel : "medium";
  if (offered.includes(wanted)) return wanted;
  const at = reasoningLevels.indexOf(wanted);
  return [...offered].sort((a, b) => Math.abs(reasoningLevels.indexOf(a) - at) - Math.abs(reasoningLevels.indexOf(b) - at) || reasoningLevels.indexOf(a) - reasoningLevels.indexOf(b))[0];
}
