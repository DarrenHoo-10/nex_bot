import { describe, expect, it } from "vitest";
import { commandNeedsApproval, dangerousEffect } from "./risk.ts";

describe("default device capability effect approvals", () => {
  it("executes literal device observations without a blanket terminal approval", () => {
    for (const command of ["Get-Location", "Get-ChildItem -LiteralPath 'C:\\My Files'", "Get-Content -LiteralPath paper.txt", "whoami", "ls -la", "echo synthetic"]) expect(commandNeedsApproval(command), command).toBe(false);
  });
  it("runs ordinary saves, read pipelines and assessed scripts without approval", () => {
    for (const command of ["Set-Content report.md updated", "echo ok > marker.txt", "Add-Content notes.md more; Get-Content notes.md", "Get-Content paper.txt | Select-Object -First 10", "git status --short", "rg -n hello src", "rg 'Remove-Item' src", "Set-Content report.md 'How to remove old files'", "New-Item -ItemType Directory drafts", "Get-Content paper.txt -OutVariable result"])
      expect(commandNeedsApproval(command), command).toBe(false);
    expect(dangerousEffect({ action: "device.exec", command: "python make_report.py", risk: "standard" })).toBe(false);
    expect(commandNeedsApproval("python unknown.py")).toBe(true);
    expect(commandNeedsApproval("Get-Content 'unterminated")).toBe(true);
  });
  it("keeps destructive commands and important file writes behind approval even with standard", () => {
    for (const command of ["Get-Location; Remove-Item important.txt", "echo $(Remove-Item important.txt)", "cat paper.txt | rm -rf backups", "Get-Content paper.txt\nRemove-Item important.txt", "Set-Content .env replaced", "echo replaced > config.json", "git push origin main", "Send-MailMessage -To test@example.test", "curl -X POST https://example.test/messages -d message", "python -c 'import os; os.remove(123)'" ])
      expect(dangerousEffect({ action: "device.exec", command, risk: "standard" }), command).toBe(true);
    expect(dangerousEffect({ action: "device.exec", command: "Set-Content unique-original.md replaced", risk: "dangerous" })).toBe(true);
  });
  it("uses catalog read hints without letting them override dangerous effects", () => {
    const tool = { name: "search", description: "", inputSchema: {}, annotations: { readOnlyHint: true } };
    expect(dangerousEffect({ action: "connector.call", tool: "search" }, tool)).toBe(false);
    expect(dangerousEffect({ action: "connector.call", tool: "search", parameters: { query: "how to delete a file" } }, tool)).toBe(false);
    expect(dangerousEffect({ action: "connector.call", tool: "get_payment" }, tool)).toBe(false);
    expect(dangerousEffect({ action: "connector.call", tool: "execute_query", parameters: { sql: "SELECT * FROM notes" } }, tool)).toBe(false);
    expect(dangerousEffect({ action: "connector.call", tool: "execute_query", parameters: { sql: "DELETE FROM notes" }, risk: "standard" }, tool)).toBe(true);
    expect(dangerousEffect({ action: "connector.call", tool: "shell", parameters: { command: "rm document.md" }, risk: "standard" }, tool)).toBe(true);
    expect(dangerousEffect({ action: "connector.call", tool: "search", risk: "dangerous" }, tool)).toBe(true);
    for (const name of ["delete_file", "send_message", "sendEmail", "make_payment", "publish_post"])
      expect(dangerousEffect({ action: "connector.call", tool: name, risk: "standard" }, { ...tool, name })).toBe(true);
    expect(dangerousEffect({ action: "connector.call", tool: "search", parameters: { operation: "delete" } }, tool)).toBe(true);
    expect(dangerousEffect({ action: "connector.call", tool: "search" }, { ...tool, annotations: { readOnlyHint: true, destructiveHint: true } })).toBe(true);
    expect(dangerousEffect({ action: "connector.call", tool: "unknown", annotations: { readOnlyHint: true } })).toBe(true);
    expect(dangerousEffect({ action: "connector.call", tool: "search", risk: "standard" })).toBe(false);
    expect(dangerousEffect({ action: "connector.call", tool: "save_document", risk: "standard" })).toBe(false);
    expect(() => dangerousEffect({ action: "connector.call", risk: "invalid" })).toThrow();
  });
  it("approves a dangerous GUI effect and keeps normal window actions and A2A automatic", () => {
    expect(dangerousEffect({ action: "device.computer", operation: "click" })).toBe(false);
    expect(dangerousEffect({ action: "device.computer", operation: "click", risk: "dangerous", riskReason: "确认付款" })).toBe(true);
    expect(dangerousEffect({ action: "agent.delegate", risk: "dangerous" })).toBe(false);
    expect(() => dangerousEffect({ action: "device.computer", risk: "auto-approve" })).toThrow();
  });
});
