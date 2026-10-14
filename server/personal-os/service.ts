import { randomBytes } from "node:crypto";
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, unlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { createPersonalApp } from "./index.ts";

export interface ServiceOptions { command: "start" | "init"; dir: string; host: string; port: number; publicOrigin?: string; jsonInput: boolean; fixtureOrigin?: string }
export function serviceOptions(args: string[], env: NodeJS.ProcessEnv = process.env): ServiceOptions {
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "start";
  if (command !== "start" && command !== "init") throw new Error("用法：service.js start|init [--data-dir=目录] [--host=127.0.0.1] [--port=8799]");
  const value = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const dir = path.resolve(value("data-dir") ?? env.NEX_CORE_DATA_DIR ?? path.join(os.homedir(), ".nexbot", "core"));
  const host = value("host") ?? env.NEX_CORE_HOST ?? "127.0.0.1";
  const port = Number(value("port") ?? env.NEX_CORE_PORT ?? 8799);
  if (!["127.0.0.1", "0.0.0.0", "::1"].includes(host) || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("后端监听地址或端口无效");
  const fixtureOrigin = args.includes("--fixture") ? env.NEX_IDENTITY_FIXTURE_URL : undefined;
  if (args.includes("--fixture")) {
    if (realpathSync(path.dirname(dir)) !== realpathSync(os.tmpdir()) || !path.basename(dir).startsWith("nex-service-fixture-") || !fixtureOrigin) throw new Error("测试身份只能用于明确创建的临时服务目录");
  } else if (env.NEX_IDENTITY_FIXTURE_URL) throw new Error("生产后端不能覆盖内置用户中心");
  return { command, dir, host, port, publicOrigin: value("public-origin") ?? env.NEX_CORE_PUBLIC_ORIGIN, jsonInput: args.includes("--input-json"), ...(fixtureOrigin ? { fixtureOrigin } : {}) };
}
export function serviceVault(dir: string, supplied = process.env.NEX_CORE_VAULT_KEY): Buffer {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (supplied) {
    const key = Buffer.from(supplied, "base64");
    if (key.length !== 32 || key.toString("base64") !== supplied) throw new Error("NEX_CORE_VAULT_KEY 必须为 32 字节的 Base64 密钥");
    return key;
  }
  const file = path.join(dir, "vault-key.bin");
  if (!existsSync(file)) {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, randomBytes(32)); } finally { closeSync(fd); }
  }
  const info = lstatSync(file);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077))) throw new Error("后端保险库密钥须为当前服务账号的私有文件");
  const key = readFileSync(file); if (key.length !== 32) throw new Error("后端保险库密钥格式错误");
  return key;
}
export function serviceLock(dir: string) {
  const file = path.join(dir, "service.lock"), nonce = randomBytes(24).toString("hex");
  if (existsSync(file)) {
    if (!lstatSync(file).isFile()) throw new Error("后端锁文件无效");
    const old = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
    if (!Number.isSafeInteger(old.pid) || old.pid! < 1) throw new Error("后端锁文件无效");
    let alive = true;
    try { process.kill(old.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) throw new Error("此数据目录已有后端服务运行；请先停止该服务");
    unlinkSync(file);
  }
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); } finally { closeSync(fd); }
  return () => { if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).nonce === nonce) unlinkSync(file); };
}
async function initialCredentials(jsonInput: boolean) {
  if (jsonInput) {
    let input = "";
    for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 8192) throw new Error("初始化输入过大"); }
    let data: { account: string; password: string };
    try { data = JSON.parse(input) as typeof data; }
    catch { throw new Error("初始化输入须为有效的 JSON 对象"); }
    if (!data || typeof data.account !== "string" || typeof data.password !== "string") throw new Error("初始化输入须包含 account 和 password");
    return data;
  }
  if (!process.stdin.isTTY) throw new Error("请在终端运行 init，或通过 --input-json 从标准输入提供凭据");
  const prompts = await import("@clack/prompts");
  const account = await prompts.text({ message: "关联后端的 NexorAI 账号邮箱", validate: (value) => !value?.includes("@") ? "请输入邮箱" : undefined });
  if (prompts.isCancel(account)) throw new Error("初始化已取消");
  const password = await prompts.password({ message: "账号密码（不会保存）", validate: (value) => !value ? "请输入密码" : undefined });
  if (prompts.isCancel(password)) throw new Error("初始化已取消");
  return { account: String(account), password: String(password) };
}
export async function runService(options: ServiceOptions) {
  const key = serviceVault(options.dir), release = serviceLock(options.dir);
  let app: Awaited<ReturnType<typeof createPersonalApp>> | undefined;
  let stopping = false;
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  const stop = () => { stopping = true; finish(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    // Dynamic relative import keeps the CLI and Core in separate build files.
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const { createPersonalApp: start } = await import(new URL("./index" + extension, import.meta.url).href) as { createPersonalApp: typeof createPersonalApp };
    const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    app = await start({ dir: options.dir, key, token: randomBytes(32).toString("base64url"), strictPort: true, host: options.command === "init" ? "127.0.0.1" : options.host, port: options.command === "init" ? 0 : options.port,
      publicOrigin: options.command === "init" ? undefined : options.publicOrigin, uiDir: path.join(resources, "ui"), ...(options.fixtureOrigin ? { identity: { fixtureOrigin: options.fixtureOrigin } } : {}) });
    if (stopping) return;
    if (options.command === "init") {
      if (!app.identity || app.identity.connected()) throw new Error("此后端已关联账号，客户端可直接登录");
      const credentials = await initialCredentials(options.jsonInput);
      const operator = app.store.get("SELECT * FROM user_sessions WHERE id=?", app.store.session)!;
      const transaction = app.identity.start({ account: credentials.account, name: "后端初始化" }, operator);
      const login = await app.identity.respond({ ...transaction, password: credentials.password }, operator);
      credentials.password = "";
      await app.identity.logout(login.token);
      process.stdout.write(JSON.stringify({ type: "initialized", coreId: login.coreId }) + "\n");
      return;
    }
    const runtimeFile = path.join(options.dir, "service.json");
    const status = { type: "ready", pid: process.pid, origin: app.origin, initialized: app.identity?.connected() ?? false, coreId: app.store.get("SELECT core_id FROM workspaces")!.core_id };
    writeFileSync(runtimeFile, JSON.stringify(status), { mode: 0o600 });
    process.stdout.write(JSON.stringify(status) + "\n");
    await stopped;
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    try { if (app) await app.close(); }
    finally {
      const file = path.join(options.dir, "service.json");
      if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).pid === process.pid) writeFileSync(file, JSON.stringify({ type: "stopped", pid: process.pid }), { mode: 0o600 });
      release();
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runService(serviceOptions(process.argv.slice(2))); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : "后端服务启动失败") + "\n"); process.exitCode = 1; }
}
