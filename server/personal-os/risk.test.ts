import { describe, expect, it } from "vitest";
import { commandNeedsApproval, dangerousEffect } from "./risk.ts";

describe("default device capability effect approvals", () => {
  it("executes literal device observations without a blanket terminal approval", () => {
    for (const command of ["Get-Location", "Get-ChildItem -LiteralPath 'C:\\My Files'", "Get-Content -LiteralPath paper.txt", "whoami", "ls -la", "echo synthetic"]) expect(commandNeedsApproval(command), command).toBe(false);
  });
  it("does not let command wording or a standard flag hide shell composition and side effects", () => {
    for (const command of ["Get-Location; Remove-Item important.txt", "echo $(Remove-Item important.txt)", "echo `touch marker`", "echo ok > marker.txt", "cat paper.txt | sh", "Get-Content paper.txt\nRemove-Item important.txt", "Remove-Item important.txt", "Set-Content important.txt replaced", "node -e 'process.exit()'", "Get-Content paper.txt -OutVariable result", "Get-Content 'unterminated", "& Get-Location"]) expect(dangerousEffect({ action: "device.exec", command, risk: "standard" }), command).toBe(true);
  });
  it("approves a dangerous GUI effect and keeps normal window actions and A2A automatic", () => {
    expect(dangerousEffect({ action: "device.computer", operation: "click" })).toBe(false);
    expect(dangerousEffect({ action: "device.computer", operation: "click", risk: "dangerous", riskReason: "确认付款" })).toBe(true);
    expect(dangerousEffect({ action: "agent.delegate", risk: "dangerous" })).toBe(false);
    expect(() => dangerousEffect({ action: "device.computer", risk: "auto-approve" })).toThrow();
  });
});
