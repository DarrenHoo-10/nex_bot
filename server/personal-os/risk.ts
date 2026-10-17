// Capabilities are available by default. Approval belongs to a concrete
// effect, never to enabling the computer as a whole.
const readCommands = new Set([
  "get-location", "get-date", "get-childitem", "get-content", "get-item",
  "get-computerinfo", "get-process", "get-service", "get-volume",
  "test-path", "resolve-path", "convert-path", "select-string", "measure-object",
  "write-output", "echo", "pwd", "ls", "dir", "cat", "whoami",
  "hostname", "uname", "head", "tail", "wc", "stat",
]);

export function commandNeedsApproval(command: string): boolean {
  // Only literal, known observations run automatically. Shell composition,
  // expansion, scripts and unknown executables need their effect confirmed.
  // This is an approval classifier, not a filesystem/security sandbox.
  if (/[\r\n;|&<>$`{}()[\]#\0]/.test(command)) return true;
  const words = command.match(/'[^']*'|"[^"]*"|[^\s'"\\]+(?:\\[^\s'"\\]+)*/g) ?? [];
  if (!words.length || words.join(" ") !== command.trim().replace(/\s+/g, " ")) return true;
  const name = words[0]!.toLowerCase();
  if (!readCommands.has(name)) return true;
  // PowerShell common parameters can write to a file even on read commands.
  if (words.slice(1).some((word) => /^-(?:out|error|warning|information|pipeline|debug|verbose)[a-z]*[:=]?/i.test(word))) return true;
  return false;
}

export function dangerousEffect(args: Record<string, unknown>): boolean {
  // MCP annotations are server claims, not permission to perform external effects.
  if (args.action === "connector.call") return true;
  if (args.risk !== undefined && args.risk !== "standard" && args.risk !== "dangerous") throw new Error("操作风险标记无效");
  if (args.riskReason !== undefined && (typeof args.riskReason !== "string" || args.riskReason.length > 500)) throw new Error("操作风险说明无效");
  if (args.risk === "dangerous" && (args.action === "device.exec" || args.action === "device.computer")) return true;
  if (args.action === "device.exec") return commandNeedsApproval(String(args.command));
  // Creating or rewriting an Agent changes who can act and what they are told, so the user confirms it.
  return args.action === "memory.delete" || args.action === "memory.forget" || args.action === "agent.create" || args.action === "agent.update";
}
