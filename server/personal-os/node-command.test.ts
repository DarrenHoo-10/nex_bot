import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeviceNode } from "./node.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("closes unattended terminal input before executing a command in a quoted working directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-node-command 'fixture-"));
  roots.push(root);
  // No server, database or real home: exercise the production spawn path.
  const node = { commands: new Set() } as DeviceNode;
  // Reading stdin must see EOF, not wait for the device execution deadline.
  const command = process.platform === "win32"
    ? "[Console]::In.ReadToEnd() | Out-Null; Set-Content -LiteralPath marker.txt -Value synthetic; Get-Content -LiteralPath marker.txt"
    : "cat >/dev/null; printf synthetic > marker.txt; cat marker.txt";
  const result = await DeviceNode.prototype.command.call(node, command, root, process.platform === "win32" ? 20_000 : 2_000);
  expect(result).toMatchObject({ code: 0, timedOut: false });
  expect(readFileSync(path.join(root, "marker.txt"), "utf8").trim()).toBe("synthetic");
  expect(node.commands.size).toBe(0);
}, 30_000);
