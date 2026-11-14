import { describe, expect, it, vi } from "vitest";
import { CREDIT_CHUNK } from "../../../shared/cli-agents";
import { acceptsOpened, closeReasonText, createCreditMeter, fitScale, initialTermState, TERM_STATUS_TEXT, termReducer, termStatus, type TermEvent, type TermState } from "./terminal-session";

const run = (events: TermEvent[], from: TermState = initialTermState()) => events.reduce(termReducer, from);
const opened = (req = "r1", sid = 7, observe = true): TermEvent => ({ type: "opened", req, sid, cols: 100, rows: 30, observe });
const live = () => run([{ type: "start" }, { type: "requested", req: "r1" }, opened()]);

describe("terminal state machine", () => {
  it("starts in observe mode and asks for an open", () => {
    expect(run([{ type: "start" }])).toMatchObject({ phase: "idle", want: "observe", needsOpen: true });
  });

  it("goes from request to observing", () => {
    expect(live()).toMatchObject({ phase: "observing", sid: 7, mode: "observe", cols: 100, rows: 30, needsOpen: false, req: null });
  });

  it("follows the mode the server actually granted", () => {
    const state = run([{ type: "start", want: "control" }, { type: "requested", req: "r1" }, opened("r1", 7, true)]);
    expect(state.phase).toBe("observing");
    expect(state.want).toBe("observe");
  });

  it("ignores a term.opened for another request", () => {
    const pending = run([{ type: "start" }, { type: "requested", req: "r2" }]);
    expect(acceptsOpened(pending, "r1")).toBe(false);
    expect(acceptsOpened(pending, "r2")).toBe(true);
    expect(termReducer(pending, opened("r1"))).toBe(pending);
  });

  it("reopens after an overflow close", () => {
    expect(termReducer(live(), { type: "closed", sid: 7, reason: "overflow" })).toMatchObject({ phase: "reconnecting", needsOpen: true, sid: null });
  });

  it("ends on other close reasons and keeps the reason", () => {
    const state = termReducer(live(), { type: "closed", sid: 7, reason: "exited" });
    expect(state).toMatchObject({ phase: "closed", needsOpen: false, reason: "exited" });
    expect(closeReasonText(state.reason)).toBe("程序已退出");
  });

  it("ignores a close for an old stream", () => {
    const state = live();
    expect(termReducer(state, { type: "closed", sid: 3, reason: "exited" })).toBe(state);
  });

  it("recovers a live or pending stream after a disconnect, not an idle one", () => {
    const pending = run([{ type: "start" }, { type: "requested", req: "r1" }]);
    expect(termReducer(pending, { type: "disconnected" })).toMatchObject({ phase: "reconnecting", needsOpen: true, req: null });
    const idle = initialTermState();
    expect(termReducer(idle, { type: "disconnected" })).toBe(idle);
  });

  it("closes on an error for its own request only", () => {
    const pending = run([{ type: "start" }, { type: "requested", req: "r1" }]);
    expect(termReducer(pending, { type: "error", code: "read_only", req: "other" })).toBe(pending);
    expect(termReducer(pending, { type: "error", code: "read_only", req: "r1" })).toMatchObject({ phase: "closed", error: "read_only" });
  });

  it("switching mode clears the stream and asks to reopen", () => {
    const state = live();
    expect(termReducer(state, { type: "mode", want: "observe" })).toBe(state);
    expect(termReducer(state, { type: "mode", want: "control" })).toMatchObject({ phase: "idle", want: "control", needsOpen: true, sid: null });
  });

  it("a mode switch after the stream ended reopens it", () => {
    const ended = termReducer(live(), { type: "closed", sid: 7, reason: "exited" });
    expect(termReducer(ended, { type: "mode", want: "observe" })).toMatchObject({ phase: "idle", needsOpen: true });
  });

  it("follows size changes of its own stream", () => {
    const state = live();
    expect(termReducer(state, { type: "size", sid: 7, cols: 80, rows: 24 })).toMatchObject({ cols: 80, rows: 24 });
    expect(termReducer(state, { type: "size", sid: 9, cols: 80, rows: 24 })).toBe(state);
  });
});

describe("status text", () => {
  it("names each state", () => {
    const control = run([{ type: "start", want: "control" }, { type: "requested", req: "r1" }, opened("r1", 7, false)]);
    expect(TERM_STATUS_TEXT[termStatus(live(), true)]).toBe("只看");
    expect(TERM_STATUS_TEXT[termStatus(control, true)]).toBe("操作中");
    expect(TERM_STATUS_TEXT[termStatus(run([{ type: "start" }]), true)]).toBe("正在连接");
    expect(TERM_STATUS_TEXT[termStatus(live(), false)]).toBe("正在重新连接");
    expect(TERM_STATUS_TEXT[termStatus(termReducer(live(), { type: "disconnected" }), true)]).toBe("正在重新连接");
    expect(TERM_STATUS_TEXT[termStatus(termReducer(live(), { type: "closed", sid: 7, reason: "exited" }), true)]).toBe("已结束");
  });

  it("has a fallback for an unknown close reason", () => {
    expect(closeReasonText("weird")).toBe("终端已断开");
    expect(closeReasonText(null)).toBe("");
  });
});

describe("credit meter", () => {
  it("returns credit once a chunk of bytes was drawn", () => {
    const send = vi.fn();
    const meter = createCreditMeter(send);
    meter.wrote(CREDIT_CHUNK - 1);
    expect(send).not.toHaveBeenCalled();
    meter.wrote(1);
    expect(send).toHaveBeenCalledWith(CREDIT_CHUNK);
    expect(meter.pending).toBe(0);
  });

  it("grants everything drawn, not just the chunk", () => {
    const send = vi.fn();
    const meter = createCreditMeter(send, 100);
    meter.wrote(60);
    meter.wrote(70);
    expect(send).toHaveBeenCalledWith(130);
  });
});

describe("fitScale", () => {
  it("shrinks to fit and never enlarges", () => {
    expect(fitScale(500, 1000)).toBe(0.5);
    expect(fitScale(2000, 1000)).toBe(1);
    expect(fitScale(0, 1000)).toBe(1);
    expect(fitScale(500, 0)).toBe(1);
  });
});
