import type { ConnectorTool } from "./connectors.ts";

// Effect classifier, not a shell sandbox: the Agent also assesses user intent,
// important existing files and the effect of scripts/GUI submit buttons.
const ordinaryCommands = new Set([
  "get-location", "get-date", "get-childitem", "get-content", "get-item",
  "get-computerinfo", "get-process", "get-service", "get-volume",
  "test-path", "resolve-path", "convert-path", "select-string", "measure-object",
  "write-output", "echo", "pwd", "ls", "dir", "cat", "whoami",
  "hostname", "uname", "head", "tail", "wc", "stat",
  "select-object", "where-object", "sort-object", "format-list", "format-table",
  "printf", "rg", "grep", "findstr", "set-content", "add-content", "out-file",
  "mkdir", "touch", "start-sleep", "sleep",
]);

const dangerousWords = /(?:^|[^\w-])(?:remove-item|clear-content|clear-item|rm|rmdir|rd|del|erase|unlink|truncate|shred|format-volume|format|diskpart|mkfs|shutdown|restart-computer|stop-computer|send-mailmessage|sendmail|chmod|chown|set-acl|set-executionpolicy|set-mppreference|disable-netfirewallrule|reg\s+(?:add|delete)|git\s+(?:push|clean|reset\s+--hard)|(?:npm|pnpm|yarn|pip|pip3|brew|apt|apt-get|winget|choco)\s+(?:install|add|remove|uninstall)|(?:os|fs|shutil)\.(?:remove|unlink|rmdir|rmtree|rmSync|unlinkSync))(?=$|[^\w-])/i;
const importantPath = /(?:\.env(?:\b|\.)|\.ssh\b|\.aws\b|\.git[\\/]|id_rsa\b|id_ed25519\b|credentials\b|[\\/]etc[\\/]|[\\/]windows[\\/]|\b(?:package(?:-lock)?\.json|pnpm-lock\.yaml|core\.db|backend\.json|authorized_keys|config\.(?:json|ya?ml|toml))\b)/i;

export function commandNeedsApproval(command: string, assessedOrdinary = false): boolean {
  if (!command.trim() || command.includes("\0")) return true;
  const masked = command.replace(/'[^']*'|"[^"$`]*"/g, " VALUE ");
  // Don't confuse quoted document text / search terms with executed commands.
  // Keep embedded interpreter source, substitutions and indirect invocations.
  const source = /[$`&]|\b(?:python\d*|node|powershell|pwsh|cmd|sh|bash|eval|invoke-expression|iex)\b/i.test(masked) ? command : masked;
  if (dangerousWords.test(source)) return true;
  if (/\b(?:curl|wget|invoke-restmethod|invoke-webrequest)\b/i.test(source) && /(?:--data(?:-\w+)?\b|--upload-file\b|\s-d(?:\s|=)|\s-T\s|(?:-X\s*|--request[=\s]+|-method\s+)(?:POST|PUT|PATCH|DELETE)\b)/i.test(command)) return true;
  const writes = /(?:>|\b(?:set-content|add-content|out-file|new-item|tee|cp|copy|copy-item|mv|move-item|writefile|writefilesync|write_text|write_bytes)\b)/i.test(command);
  if (writes && importantPath.test(command)) return true;
  // Complex ordinary scripts can be assessed without asking the user. The
  // standard flag does not override recognized dangerous effects above.
  if (assessedOrdinary) return false;
  if (/["'`$(){}]/.test(masked)) return true;
  return masked.split(/[;|&\r\n]+/).some((part) => {
    const words = part.trim().split(/\s+/), name = words[0]?.toLowerCase();
    if (!name) return false;
    if (name === "git") return !/^(?:status|diff|log|show|ls-files|rev-parse)$/.test(words[1] ?? "");
    if (name === "new-item") return !/-itemtype\s+(?:file|directory)\b/i.test(part) || /\bhklm:|\bhkcu:/i.test(command);
    return !ordinaryCommands.has(name);
  });
}

export function connectorNeedsApproval(args: Record<string, unknown>, tool?: ConnectorTool): boolean {
  const parameters = (args.parameters ?? {}) as Record<string, unknown>;
  const dangerousVerb = /(?:^|[^a-z])(?:delete|remove|drop|truncate|destroy|send|publish|post|pay|payment|purchase|transfer|checkout|charge|refund|install|uninstall)(?:$|[^a-z])/i;
  const name = String(args.tool).replace(/([a-z])([A-Z])/g, "$1 $2");
  const read = /(?:^|[^a-z])(?:get|read|list|search|fetch|query|lookup|count|describe)(?:$|[^a-z])/i.exec(name);
  const danger = dangerousVerb.exec(name);
  // Catalog annotations are hints, not authority; conflicting effects win.
  if (danger && (!read || danger.index < read.index)) return true;
  if ([parameters.action, parameters.operation, parameters.method].some((value) => typeof value === "string" && dangerousVerb.test(value))) return true;
  if ([parameters.sql, parameters.query].some((value) => typeof value === "string" && /(?:^|;)\s*(?:delete\s+from|drop\s+(?:table|database)|truncate\s+table|update\s+\S+\s+set)\b/i.test(value))) return true;
  if (typeof parameters.command === "string" && commandNeedsApproval(parameters.command, args.risk === "standard")) return true;
  if (tool?.annotations?.destructiveHint === true) return true;
  if (tool?.annotations?.readOnlyHint === true) return false;
  return args.risk !== "standard";
}

export function dangerousEffect(args: Record<string, unknown>, connectorTool?: ConnectorTool): boolean {
  if (args.risk !== undefined && args.risk !== "standard" && args.risk !== "dangerous") throw new Error("操作风险标记无效");
  if (args.riskReason !== undefined && (typeof args.riskReason !== "string" || args.riskReason.length > 500)) throw new Error("操作风险说明无效");
  if (args.risk === "dangerous" && ["device.exec", "device.computer", "connector.call"].includes(String(args.action))) return true;
  if (args.action === "connector.call") return connectorNeedsApproval(args, connectorTool);
  if (args.action === "device.exec") return commandNeedsApproval(String(args.command), args.risk === "standard");
  // Creating or rewriting an Agent changes who can act and what they are told, so the user confirms it.
  return args.action === "memory.delete" || args.action === "memory.forget" || args.action === "agent.create" || args.action === "agent.update";
}
