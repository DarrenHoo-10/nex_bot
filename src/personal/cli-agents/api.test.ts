// The one line the page shows for a failed call: Core's wording when it sent
// some (a device's own refusal), else the standard text for the code.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_ERROR_TEXT } from "../../../shared/cli-agents";
import { CliApiError, cliErrorText, continueSession, fetchSupervision, saveSupervision, searchSessions, sendMessage, startSession, uploadAttachment } from "./api";

const reply = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

afterEach(() => { vi.unstubAllGlobals(); });

describe("send result", () => {
  const key = "dev:claude:abc";

  it("carries delivery and waiting from a session outside nex_bot's terminals", async () => {
    reply(200, { turn: 0, started: false, delivery: "unconfirmed", waiting: true });
    expect(await sendMessage(key, "hi")).toEqual({ turn: 0, started: false, delivery: "unconfirmed", waiting: true });
    reply(200, { turn: 0, started: false, delivery: "confirmed" });
    expect(await sendMessage(key, "hi")).toEqual({ turn: 0, started: false, delivery: "confirmed" });
  });

  it("stays as it was for a terminal send, and ignores values it does not know", async () => {
    reply(200, { turn: 3, started: true });
    expect(await sendMessage(key, "hi")).toEqual({ turn: 3, started: true });
    reply(200, { turn: 1, delivery: "maybe", waiting: "yes" });
    expect(await sendMessage(key, "hi")).toEqual({ turn: 1 });
  });
});

describe("supervision settings", () => {
  it("reads all six switches, taking the global value over the default", async () => {
    reply(200, { defaults: { transientRetry: true, usageLimit: false, wakeup: false, triage: false, decide: false, wake: false }, global: { triage: true, wake: true }, workspaces: [], actions: [] });
    expect((await fetchSupervision()).settings).toEqual({ transientRetry: true, usageLimit: false, wakeup: false, triage: true, decide: false, wake: true });
  });

  it("falls back to the defaults of this page when Core sends none", async () => {
    reply(200, {});
    expect((await fetchSupervision()).settings).toEqual({ transientRetry: true, usageLimit: false, wakeup: false, triage: false, decide: false, wake: false });
  });

  it("saves only the switch that changed", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ defaults: {}, global: { decide: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await saveSupervision({ decide: true });
    expect(view.settings.decide).toBe(true);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe("/api/cli-agents/supervision");
    expect(calls[0][1]).toMatchObject({ method: "PUT", body: JSON.stringify({ settings: { decide: true } }) });
  });
});

describe("error wording", () => {
  const key = "dev:claude:abc";

  it("shows the device's own message for a refused send", async () => {
    reply(409, { error: "电脑上有人正在输入", code: "busy" });
    const error = await sendMessage(key, "hi").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CliApiError);
    expect(error).toMatchObject({ code: "busy", status: 409 });
    expect(cliErrorText(error)).toBe("电脑上有人正在输入");
  });

  it("falls back to the standard text when Core sent none", async () => {
    reply(409, { code: "busy" });
    const error = await sendMessage(key, "hi").catch((cause: unknown) => cause);
    expect(cliErrorText(error)).toBe(CLI_ERROR_TEXT.busy);
    expect(cliErrorText(new CliApiError("raw", "device_offline", 502))).toBe(CLI_ERROR_TEXT.device_offline);
    expect(cliErrorText(new CliApiError("raw", "busy", 409, "  "))).toBe(CLI_ERROR_TEXT.busy);
  });

  it("keeps the message of an error without a code", async () => {
    reply(500, { error: "服务异常" });
    const error = await sendMessage(key, "hi").catch((cause: unknown) => cause);
    expect(cliErrorText(error)).toBe("服务异常");
    expect(cliErrorText(new Error(""), "操作失败")).toBe("操作失败");
  });
});

describe("search, launch options and attachments", () => {
  const key = "dev:claude:abc";
  const capture = (body: unknown, status = 200) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("searches with the query encoded, passes the abort signal and keeps only well-formed hits", async () => {
    const fetchMock = capture({ hits: [{ key, snippet: "…部署 main…" }, { key: "not a key", snippet: "x" }, { key, snippet: 5 }, null] });
    const controller = new AbortController();
    expect(await searchSessions("部署 main", controller.signal)).toEqual([{ key, snippet: "…部署 main…" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/cli-agents/search?q=${encodeURIComponent("部署 main")}`);
    expect(init?.signal).toBe(controller.signal);
    capture({});
    await expect(searchSessions("x")).rejects.toBeInstanceOf(CliApiError);
  });

  it("lets an aborted search reject with the abort, not as a connection failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("{}");
    }));
    const controller = new AbortController();
    controller.abort();
    const error = await searchSessions("x", controller.signal).catch((cause: unknown) => cause);
    expect(error).not.toBeInstanceOf(CliApiError);
    expect((error as Error).name).toBe("AbortError");
  });

  it("sends model and effort only when picked", async () => {
    const fetchMock = capture({ key });
    await startSession("dev", "claude", "/w", { model: "opus", effort: "high" });
    await startSession("dev", "claude", "/w");
    await continueSession(key, { effort: "low" });
    await continueSession(key);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { deviceId: "dev", engine: "claude", cwd: "/w", model: "opus", effort: "high" },
      { deviceId: "dev", engine: "claude", cwd: "/w" },
      { key, effort: "low" },
      { key },
    ]);
  });

  it("uploads the file itself with its type and returns the path on the computer", async () => {
    const fetchMock = capture({ path: "C:\\Temp\\nexbot-attachments\\claude-abc\\1a2b3c4d-shot.png" });
    const file = new File([new Uint8Array([1, 2, 3])], "截图 1.png", { type: "image/png" });
    expect(await uploadAttachment(key, file)).toEqual({ path: "C:\\Temp\\nexbot-attachments\\claude-abc\\1a2b3c4d-shot.png" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/cli-agents/attach?key=${encodeURIComponent(key)}&name=${encodeURIComponent("截图 1.png")}`);
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "image/png" } });
    expect(init?.body).toBe(file);
  });

  it("refuses a file over 8 MB before uploading, and a reply without a path", async () => {
    const fetchMock = capture({ path: "" });
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "big.bin");
    await expect(uploadAttachment(key, big)).rejects.toMatchObject({ code: "too_large" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(uploadAttachment(key, new File(["x"], "a.txt"))).rejects.toBeInstanceOf(CliApiError);
    reply(400, { error: "电脑端版本过旧，升级后可用", code: "invalid" });
    const outdated = await uploadAttachment(key, new File(["x"], "a.txt")).catch((cause: unknown) => cause);
    expect(cliErrorText(outdated)).toBe("电脑端版本过旧，升级后可用");
  });
});
