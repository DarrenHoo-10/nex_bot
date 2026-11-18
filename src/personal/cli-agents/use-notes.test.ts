// @vitest-environment happy-dom
// Notes in production live in Core: loaded per session, saved optimistically,
// put back with a short error when a save fails.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliApiError, type CliNote } from "./api";

const api = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...api }));

import { useNotes } from "./use-notes";
import type { Note } from "./WorkbenchReview";

const KEY = "dev1:claude:s1" as const;
let latest: ReturnType<typeof useNotes>;
let root: Root;
let container: HTMLDivElement;

function Harness({ persisted = true, sessionKey = KEY }: { persisted?: boolean; sessionKey?: typeof KEY }) {
  latest = useNotes(sessionKey, persisted);
  return null;
}
const mount = async (props: { persisted?: boolean } = {}) => {
  await act(async () => { root.render(createElement(Harness, props)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const note = (id: string, body = "注释", extra: Partial<Note> = {}): Note => ({ id, message: "m1", start: 2, end: 6, quote: "竞态条件", body, num: 1, ...extra });
const saved = (n: Note, version = 1): CliNote => ({ id: n.id, message: n.message, start: n.start, end: n.end, quote: n.quote, body: n.body, num: n.num, version });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchNotes.mockResolvedValue([]);
  api.createNote.mockImplementation(async (_key: string, n: Note) => saved(n, 1));
  api.updateNote.mockImplementation(async (id: string, version: number, body: string) => saved(note(id, body), version + 1));
  api.deleteNote.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("persisted notes", () => {
  it("loads the session's notes from Core", async () => {
    api.fetchNotes.mockResolvedValue([saved(note("a", "已保存"), 3)]);
    await mount();
    expect(api.fetchNotes).toHaveBeenCalledWith(KEY);
    expect(latest.notes.map((entry) => entry.body)).toEqual(["已保存"]);
  });

  it("shows a new note at once and saves it, then edits and deletes with the version Core gave", async () => {
    await mount();
    await act(async () => { latest.update([note("a", "第一版")]); });
    expect(latest.notes.map((entry) => entry.body)).toEqual(["第一版"]);
    await settle();
    expect(api.createNote).toHaveBeenCalledWith(KEY, { id: "a", message: "m1", quote: "竞态条件", body: "第一版", num: 1, start: 2, end: 6 });
    await act(async () => { latest.update([note("a", "第二版")]); });
    await settle();
    expect(api.updateNote).toHaveBeenCalledWith("a", 1, "第二版");
    await act(async () => { latest.update([]); });
    await settle();
    expect(api.deleteNote).toHaveBeenCalledWith("a", 2);
    expect(latest.notes).toEqual([]);
    expect(latest.error).toBe("");
  });

  it("runs an edit after the create it follows even when both happen before the create returns", async () => {
    let finish!: () => void;
    api.createNote.mockImplementationOnce((_key: string, n: Note) => new Promise((resolve) => { finish = () => resolve(saved(n, 1)); }));
    await mount();
    await act(async () => { latest.update([note("a", "草稿")]); });
    await act(async () => { latest.update([note("a", "改过的")]); });
    expect(api.updateNote).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await settle();
    expect(api.updateNote).toHaveBeenCalledWith("a", 1, "改过的");
  });

  it("takes a note back and says so when the save fails", async () => {
    api.createNote.mockRejectedValueOnce(new CliApiError("raw", "device_offline", 502, "保存失败，请重试"));
    await mount();
    await act(async () => { latest.update([note("a")]); });
    await settle();
    expect(latest.notes).toEqual([]);
    expect(latest.error).toBe("保存失败，请重试");
  });

  it("restores the old text when an edit fails, and puts a deleted note back", async () => {
    api.fetchNotes.mockResolvedValue([saved(note("a", "原文"), 1)]);
    await mount();
    api.updateNote.mockRejectedValueOnce(new CliApiError("网络", undefined, 0));
    await act(async () => { latest.update([note("a", "新文")]); });
    await settle();
    expect(latest.notes.map((entry) => entry.body)).toEqual(["原文"]);
    expect(latest.error).toBe("网络");
    api.deleteNote.mockRejectedValueOnce(new CliApiError("删不掉", undefined, 0));
    await act(async () => { latest.update([]); });
    await settle();
    expect(latest.notes.map((entry) => entry.id)).toEqual(["a"]);
    expect(latest.error).toBe("删不掉");
  });

  it("shows what Core has after another client changed the note", async () => {
    api.fetchNotes.mockResolvedValueOnce([saved(note("a", "原文"), 1)]);
    await mount();
    api.updateNote.mockRejectedValueOnce(new CliApiError("raw", "conflict", 409));
    api.fetchNotes.mockResolvedValueOnce([saved(note("a", "别处改的"), 2)]);
    await act(async () => { latest.update([note("a", "我的")]); });
    await settle();
    expect(latest.notes.map((entry) => entry.body)).toEqual(["别处改的"]);
    expect(latest.error).not.toBe("");
  });

  it("moves notes an older build kept in the tab up to Core once", async () => {
    sessionStorage.setItem("nexagent.notes." + KEY, JSON.stringify([note("old", "旧的")]));
    await mount();
    await settle();
    expect(api.createNote).toHaveBeenCalledWith(KEY, expect.objectContaining({ id: "old", body: "旧的" }));
    expect(latest.notes.map((entry) => entry.id)).toEqual(["old"]);
    expect(JSON.parse(sessionStorage.getItem("nexagent.notes." + KEY) || "[]")).toEqual([]);
  });
});

describe("review fixture notes", () => {
  it("stay in the tab and never reach Core", async () => {
    await mount({ persisted: false });
    await act(async () => { latest.update([note("a")]); });
    await settle();
    expect(api.fetchNotes).not.toHaveBeenCalled();
    expect(api.createNote).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem("nexagent.notes." + KEY) || "[]")).toHaveLength(1);
  });
});
