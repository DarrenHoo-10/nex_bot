import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A bounded adapter to the existing open-source CUA SDK. No external daemon,
// user-installed helper or Codex/ChatGPT plugin is used by the shipped app.
export const computerReads = ["tools", "list_apps", "list_windows", "get_window_state"];
export const computerOperations = [...computerReads, "bring_to_front", "click", "type_text", "press_key", "scroll", "drag"];
interface NativeResult { text: string; images: { mimeType: string; dataBase64: string }[]; structuredJson?: string; isError: boolean; errorCode?: string; rawJson: string; action?: { completion: number } }
interface Driver { callTool(name: string, args: string, options: { signal: AbortSignal }): Promise<NativeResult>; listToolsJson(): Promise<string>; shutdown(): Promise<void>; uniffiDestroy?(): void }
export class ComputerExecutor {
  private driver?: Driver;
  private loading?: Promise<Driver>;
  private readonly observed = new Map<string, number>();
  private readonly listedWindows = new Map<string, number>();
  private readonly foregroundAllowed = new Set<string>();
  readonly resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "computer-runtime");
  available() { return process.platform === "win32" && ["sdk.mjs", "native/cua_driver_sdk.dll", "native/cua_driver_node_runtime.node"].every((file) => existsSync(path.join(this.resources, file))); }
  async load() {
    if (!this.available()) throw new Error("本机未安装支持的 Windows computer use 运行时");
    return this.loading ??= (async () => {
      process.env.OPENMAUSBOT_CUA_SDK_LIBRARY = path.join(this.resources, "native", "cua_driver_sdk.dll");
      process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "0";
      const sdk = await import(pathToFileURL(path.join(this.resources, "sdk.mjs")).href);
      this.driver = sdk.CuaDriver.create(undefined) as Driver;
      return this.driver;
    })();
  }
  async execute(operation: string, parameters: Record<string, unknown>, timeout: number) {
    if (!computerOperations.includes(operation)) throw new Error("不支持的 computer use 操作");
    // Explicit sessions, arbitrary browser attachment and network/tool routing
    // cannot be supplied by a model through this adapter.
    if (["session", "session_id", "socket", "url", "profile", "screenshot_out_file"].some((key) => key in parameters)) throw new Error("不允许指定外部 computer use 会话、连接或文件输出");
    if (parameters.scope === "desktop" || (parameters.target && (parameters.target as { kind?: string }).kind !== "window")) throw new Error("请选定一个窗口，不能使用全局桌面输入");
    if (!["tools", "list_apps", "list_windows"].includes(operation)) {
      if (!Number.isSafeInteger(parameters.pid) || !Number.isSafeInteger(parameters.window_id) || Number(parameters.pid) <= 0 || Number(parameters.window_id) <= 0) throw new Error("必须传入观察到的 pid 和 window_id");
    }
    const windowKey = `${parameters.pid}:${parameters.window_id}`;
    if (!computerReads.includes(operation)) {
      // A model must not approve its own actions or edit its device grants by
      // operating the NexBot host window. The client SDK runs in Electron;
      // the Core SDK runs in that Electron process's owned child.
      if ([process.pid, process.ppid].includes(Number(parameters.pid))) throw new Error("不能操作 NexBot 自己的窗口来修改权限或批准操作");
      // Restoring a minimized, enumerated window is different from screen
      // input, which always requires fresh screenshot/accessibility evidence.
      const seenAt = operation === "bring_to_front" ? Math.max(this.observed.get(windowKey) ?? 0, this.listedWindows.get(windowKey) ?? 0) : this.observed.get(windowKey) ?? 0;
      if (Date.now() - seenAt > 120_000) throw new Error(operation === "bring_to_front" ? "请先重新观察 list_windows，使用其中真实的 pid 和 window_id 恢复窗口" : "窗口观察已过期，请重新观察 get_window_state 后操作；list_windows 不能替代截图观察");
      if (parameters.delivery_mode === "foreground" && !this.foregroundAllowed.has(windowKey)) throw new Error("请先尝试后台输入，执行器明确拒绝后再重新观察并申请前台输入");
    }
    const driver = await this.load();
    if (operation === "tools") {
      const listed = JSON.parse(await driver.listToolsJson());
      const tools = Array.isArray(listed) ? listed : listed.tools;
      if (!Array.isArray(tools)) throw new Error("computer use 工具目录格式错误");
      return { tools: tools.filter((tool: { name: string }) => computerOperations.includes(tool.name)).map((tool: { name: string; inputSchema: unknown }) => ({ name: tool.name, inputSchema: tool.inputSchema })), restrictions: "Window scope only. list_windows discovers real pid + window_id and permits bring_to_front to restore that window. After restoration, get_window_state is required before every click/type_text/press_key/scroll/drag. No session, screenshot_out_file, arbitrary connections, shell, clipboard or browser-profile attachment." };
    }
    const bounded = operation === "get_window_state" ? { ...parameters, max_elements: Math.min(Number(parameters.max_elements) || 200, 500), max_depth: Math.min(Number(parameters.max_depth) || 12, 20), max_dimension: Math.min(Number(parameters.max_dimension) || 1280, 1920) } : parameters;
    let result: NativeResult;
    try { result = await driver.callTool(operation, JSON.stringify(bounded), { signal: AbortSignal.timeout(Math.max(1, timeout)) }); }
    catch (error) {
      if (computerReads.includes(operation)) throw error;
      this.observed.delete(windowKey);
      this.listedWindows.delete(windowKey);
      this.foregroundAllowed.delete(windowKey);
      return { unknown: true, error: "电脑输入中断，结果未知；请在目标设备核实，不会自动重放", images: [] };
    }
    if (!computerReads.includes(operation) && result.action?.completion === 2) {
      this.observed.delete(windowKey);
      this.listedWindows.delete(windowKey);
      this.foregroundAllowed.delete(windowKey);
      return { unknown: true, error: "电脑输入结果未知；请核实，不会自动重放", images: [] };
    }
    const structured = result.structuredJson ? JSON.parse(result.structuredJson) : undefined;
    if (operation === "list_windows") {
      this.listedWindows.clear();
      if (!result.isError && Array.isArray(structured?.windows)) for (const window of structured.windows) {
        if (Number.isSafeInteger(window.pid) && Number.isSafeInteger(window.window_id) && window.pid > 0 && window.window_id > 0) this.listedWindows.set(`${window.pid}:${window.window_id}`, Date.now());
      }
    }
    if (operation === "get_window_state" && !result.isError) this.observed.set(windowKey, Date.now());
    if (operation === "get_window_state" && result.isError) this.observed.delete(windowKey);
    if (!computerReads.includes(operation)) {
      this.observed.delete(windowKey);
      this.listedWindows.delete(windowKey);
      if (result.isError && (result.errorCode === "background_unavailable" || result.text.includes("background_unavailable") || result.rawJson.includes("background_unavailable"))) this.foregroundAllowed.add(windowKey);
      else this.foregroundAllowed.delete(windowKey);
    }
    // Preserve native screenshot IDs/coordinates and image bytes. Never paste
    // base64 into model text. Bound the DCP response before journalling it.
    const images = (result.images ?? []).slice(0, 2).map((image) => ({ type: "image", data: image.dataBase64, mimeType: image.mimeType }));
    const payload = { text: result.text, structured, images, isError: result.isError, errorCode: result.errorCode };
    if (JSON.stringify(payload).length > 7_000_000) throw new Error("屏幕结果过大，请选定一个窗口后重新观察");
    return payload;
  }
  async close() { if (this.loading) { const driver = await this.loading.catch(() => undefined); if (driver) { await driver.shutdown(); driver.uniffiDestroy?.(); } } }
}
