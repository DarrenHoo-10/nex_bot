import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliLocalStore, OPS_RETENTION_MS } from "./local-store.ts";

let dir: string;
const opened: CliLocalStore[] = [];
const open = (file = path.join(dir, "cli-agents.db"), clock?: () => number) => {
  const store = new CliLocalStore(file, clock);
  opened.push(store);
  return store;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cli-store-"));
});
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("CliLocalStore operations", () => {
  it("claims an opId once and replays its stored reply", () => {
    const store = open();
    expect(store.beginOp("op-1", "send")).toEqual({ state: "new" });
    expect(store.beginOp("op-1", "send")).toEqual({ state: "running", op: "send" });
    store.finishOp("op-1", { ok: true, result: { turn: 3, started: true } });
    expect(store.beginOp("op-1", "send")).toEqual({ state: "done", op: "send", reply: { ok: true, result: { turn: 3, started: true } } });
    store.beginOp("op-2", "start");
    store.finishOp("op-2", { ok: false, error: { code: "busy", message: "x" } });
    expect(store.opEntry("op-2")).toMatchObject({ state: "done", reply: { ok: false, error: { code: "busy" } } });
    expect(store.opEntry("missing")).toBeNull();
  });

  it("fails an operation that was still running when the process died", () => {
    const file = path.join(dir, "cli-agents.db");
    const first = open(file);
    first.beginOp("op-1", "continue");
    first.close();
    const second = open(file);
    expect(second.opEntry("op-1")).toMatchObject({ state: "done", reply: { ok: false, error: { code: "unknown" } } });
  });

  it("forgets a running operation so a re-send runs again", () => {
    const store = open();
    store.beginOp("op-1", "send");
    store.forgetOp("op-1");
    expect(store.beginOp("op-1", "send")).toEqual({ state: "new" });
    store.finishOp("op-1", { ok: true, result: {} });
    store.forgetOp("op-1");
    expect(store.opEntry("op-1")).toMatchObject({ state: "done" });
  });

  it("prunes operations older than the retention", () => {
    let now = 1_000_000;
    const store = open(path.join(dir, "a.db"), () => now);
    store.beginOp("old", "send");
    store.finishOp("old", { ok: true, result: {} });
    now += OPS_RETENTION_MS + 1;
    store.beginOp("new", "send");
    expect(store.pruneOps()).toBe(1);
    expect(store.opEntry("old")).toBeNull();
    expect(store.opCount()).toBe(1);
  });
});

describe("CliLocalStore terminals", () => {
  it("records terminals, learns a native id and notes how they ended", () => {
    const store = open();
    store.upsertTerminal({ address: "t-1", engine: "codex", nativeId: "pending", cwd: "/work", createdAt: 5 });
    store.upsertTerminal({ address: "t-2", engine: "claude", nativeId: "abc", cwd: "/work", createdAt: 6 });
    expect(store.openTerminals().map((row) => row.address)).toEqual(["t-1", "t-2"]);
    store.setNativeId("t-1", "019a-real");
    expect(store.terminal("t-1")).toMatchObject({ nativeId: "019a-real", endedAt: null });
    store.endTerminal("t-1", 3);
    expect(store.terminal("t-1")).toMatchObject({ exitCode: 3 });
    expect(store.terminal("t-1")?.endedAt).not.toBeNull();
    expect(store.openTerminals().map((row) => row.address)).toEqual(["t-2"]);
    expect(store.terminal("none")).toBeNull();
  });

  it("keeps the first end time when ended twice", () => {
    let now = 10;
    const store = open(path.join(dir, "b.db"), () => now);
    store.upsertTerminal({ address: "t-1", engine: "claude", nativeId: "x", cwd: "/w" });
    store.endTerminal("t-1");
    now = 99;
    store.endTerminal("t-1", 1);
    expect(store.terminal("t-1")).toMatchObject({ endedAt: 10, exitCode: 1 });
  });
});

describe("CliLocalStore scan files", () => {
  it("stores, reads and prunes parse results", () => {
    const store = open();
    store.putScanFile({ path: "/a.jsonl", size: 10, mtimeMs: 20, engine: "claude", nativeId: "a", head: { title: "A" }, updatedAt: 1 });
    store.putScanFile({ path: "/b.jsonl", size: 11, mtimeMs: 21, engine: "codex", nativeId: "b", head: null, updatedAt: 2 });
    store.putScanFile({ path: "/a.jsonl", size: 12, mtimeMs: 22, engine: "claude", nativeId: "a", head: { title: "A2" }, updatedAt: 3 });
    expect(store.scanFile("/a.jsonl")).toMatchObject({ size: 12, head: { title: "A2" } });
    expect(store.pruneScanFiles(["/a.jsonl"])).toBe(1);
    expect(store.scanFile("/b.jsonl")).toBeNull();
  });
});

describe("CliLocalStore persistence", () => {
  it("keeps data across reopen", () => {
    const file = path.join(dir, "cli-agents.db");
    const first = open(file);
    first.upsertTerminal({ address: "t-1", engine: "claude", nativeId: "x", cwd: "/w" });
    first.close();
    expect(open(file).terminal("t-1")).toMatchObject({ engine: "claude" });
  });
});
