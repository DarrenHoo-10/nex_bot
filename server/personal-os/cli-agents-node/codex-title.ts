import { privateCliImageLinks } from "../../../shared/cli-images.ts";

const LEGACY_NAME = "NexAgent 新会话";
const INJECTED = /^\s*(<environment_context>|<user_instructions>|<user_shell_command>|<turn_aborted>|<permissions instructions>|# AGENTS\.md|<INSTRUCTIONS>)/;

export function emptyCodexTitle(id: string): string {
  return `${LEGACY_NAME} · ${id.slice(-8)}`;
}

export function isNexAgentCodexTitle(id: string, name: unknown): boolean {
  return name === LEGACY_NAME || name === emptyCodexTitle(id);
}

export function codexPromptTitle(raw?: string): string | undefined {
  if (!raw || INJECTED.test(raw)) return undefined;
  const text = privateCliImageLinks(raw).replace(/!\[([^\]\n]*)\]\(\/api\/cli-agents\/images\/[\w-]+\)/g, (_, filename: string) => filename || "图片");
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 60).join("") || undefined;
}
