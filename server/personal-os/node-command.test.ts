import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeviceNode, windowsCommandEnvironment, decodeCommandOutput } from "./node.ts";

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

it("preserves Windows shell initialization paths without passing Core credentials or another PowerShell's module path", () => {
  const system = {
    Path: "C:\\Windows\\System32", SYSTEMROOT: "C:\\Windows", windir: "C:\\Windows",
    SystemDrive: "C:", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: "C:\\fixture\\Temp", TMP: "C:\\fixture\\Temp", USERPROFILE: "C:\\fixture",
    HOMEDRIVE: "C:", HOMEPATH: "\\fixture", APPDATA: "C:\\fixture\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\fixture\\AppData\\Local", ALLUSERSPROFILE: "C:\\ProgramData",
    ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files",
    CommonProgramFiles: "C:\\Program Files\\Common Files",
    "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
    CommonProgramW6432: "C:\\Program Files\\Common Files",
  };
  const parent = {
    ...system, OPENAI_API_KEY: "synthetic-secret", NEX_CORE_TOKEN: "synthetic-token",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
  };
  expect(windowsCommandEnvironment(parent)).toEqual(system);
  expect(parent.PSModulePath).toBe("C:\\Program Files\\PowerShell\\7\\Modules");
  expect(windowsCommandEnvironment({ Path: "synthetic", TEMP: undefined })).toEqual({ Path: "synthetic" });
});

it.each([
  {
    name: "writes marker.txt with a built-in cmdlet",
    windows: "Set-Content -LiteralPath marker.txt -Value synthetic; Get-Content -LiteralPath marker.txt",
    posix: "printf synthetic > marker.txt; cat marker.txt",
    file: "marker.txt", content: "synthetic",
  },
  {
    name: "appends counter.txt exactly once",
    windows: "Add-Content -LiteralPath counter.txt -Value executed; Get-Content -LiteralPath counter.txt",
    posix: "echo executed >> counter.txt; cat counter.txt",
    file: "counter.txt", content: "executed",
  },
])("completes unattended command: $name", async ({ windows, posix, file, content }) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-node-command 'fixture-"));
  roots.push(root);
  const node = { commands: new Set() } as DeviceNode;
  // These are the app.test.ts commands that hung on Windows. Exercise each
  // fresh shell separately, so the EOF check cannot mask a startup failure.
  const result = await DeviceNode.prototype.command.call(node, process.platform === "win32" ? windows : posix, root, 20_000);
  expect(result).toMatchObject({ code: 0, timedOut: false, stdout: expect.stringContaining(content) });
  expect(readFileSync(path.join(root, file), "utf8").trim()).toBe(content);
  expect(node.commands.size).toBe(0);
}, 30_000);

it("resolves the working directory through the shell's filesystem provider", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-node-command 'fixture-"));
  roots.push(root);
  const node = { commands: new Set() } as DeviceNode;
  const result = await DeviceNode.prototype.command.call(node, process.platform === "win32" ? "Convert-Path ." : "pwd", root, 20_000);
  expect(result).toMatchObject({ code: 0, timedOut: false });
  const stdout = (result as { stdout: string }).stdout.trim();
  expect(path.relative(realpathSync.native(root), realpathSync.native(stdout))).toBe("");
  expect(node.commands.size).toBe(0);
}, 30_000);

it("drains both output pipes even after the captured output limit is reached", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-node-output-"));
  roots.push(root);
  const node = { commands: new Set() } as DeviceNode;
  const command = process.platform === "win32"
    ? "[Console]::Out.Write(('o' * 200000)); [Console]::Error.Write(('e' * 200000))"
    : "head -c 200000 /dev/zero | tr '\\000' o; head -c 200000 /dev/zero | tr '\\000' e >&2";
  const result = await DeviceNode.prototype.command.call(node, command, root, 20_000);
  expect(result).toMatchObject({ code: 0, timedOut: false, stdout: "o".repeat(50_000), stderr: "e".repeat(10_000) });
  expect(node.commands.size).toBe(0);
}, 30_000);

it("decodes UTF-8 and Windows code page lines without replacement characters", () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
  const mixed = Buffer.concat([Buffer.from("中文\n", "utf8"), gbk, Buffer.from("tail", "utf8")]);
  expect(decodeCommandOutput(mixed, true)).toBe("中文\n中文\ntail");
  expect(decodeCommandOutput(Buffer.from("中文", "utf8"), false)).toBe("中文");
});

it.runIf(process.platform === "win32")("returns Chinese PowerShell output and errors readably", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-node-utf8-"));
  roots.push(root);
  const node = { commands: new Set() } as DeviceNode;
  const result = await DeviceNode.prototype.command.call(node, "Write-Output '中文输出'; Get-Item '不存在的文件'", root, 20_000) as { stdout: string; stderr: string };
  expect(result.stdout.trim()).toBe("中文输出");
  expect(result.stderr).toContain("不存在的文件");
  expect(result.stderr).not.toContain("\uFFFD");
}, 30_000);
