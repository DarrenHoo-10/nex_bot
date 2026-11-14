// The one line the page shows for a failed call: Core's wording when it sent
// some (a device's own refusal), else the standard text for the code.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_ERROR_TEXT } from "../../../shared/cli-agents";
import { CliApiError, cliErrorText, fetchSupervision, saveSupervision, sendMessage } from "./api";

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
