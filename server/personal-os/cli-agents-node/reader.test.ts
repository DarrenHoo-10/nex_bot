import { appendFileSync, copyFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliItem, type CliItem } from "../../../shared/cli-agents.ts";
import type { RowUpdate } from "./items.ts";
import { TranscriptReader, type ReaderPage, type TranscriptReaderOptions } from "./reader.ts";

let dir: string;
const readers: TranscriptReader[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cli-reader-"));
});
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string) => path.join(import.meta.dirname, "testdata", name);

function userLine(n: number, text = `message ${n}`): string {
  return JSON.stringify({
    type: "user",
    uuid: `u-${String(n).padStart(4, "0")}`,
    timestamp: new Date(Date.UTC(2026, 10, 15, 10, 0, n % 60)).toISOString(),
    message: { role: "user", content: text },
  });
}

function make(file: string, engine: "claude" | "codex", extra: Partial<TranscriptReaderOptions> = {}) {
  const items: CliItem[][] = [];
  const resets: ReaderPage[] = [];
  const rows: RowUpdate[] = [];
  const reader = new TranscriptReader({
    path: file,
    engine,
    watch: false,
    pollMs: 60_000,
    onItems: (batch) => items.push(batch),
    onReset: (page) => resets.push(page),
    onRow: (row) => rows.push(row),
    ...extra,
  });
  readers.push(reader);
  return { reader, items, resets, rows };
}

describe("TranscriptReader initial page", () => {
  it("reads a Claude fixture, completes the tool from its result and validates every item", async () => {
    const { reader } = make(fixture("claude-session.jsonl"), "claude");
    const page = await reader.start();
    expect(page.more).toBe(false);
    for (const item of page.items) expect(parseCliItem(item)).not.toBeNull();
    expect(page.items.map((item) => item.kind)).toEqual(["user", "thinking", "assistant", "tool", "assistant"]);
    expect(page.items.find((item) => item.kind === "tool")).toMatchObject({ kind: "tool", name: "Bash", status: "error" });
    expect(page.items[0]).toMatchObject({ kind: "user", text: "Fix the failing test" });
  });

  it("returns an empty page for a missing file and picks it up when it appears", async () => {
    const file = path.join(dir, "later.jsonl");
    const { reader, items } = make(file, "claude");
    expect(await reader.start()).toEqual({ items: [], more: false });
    writeFileSync(file, `${userLine(1)}\n`);
    await reader.poll();
    expect(items.flat().map((item) => item.id)).toEqual(["u-0001"]);
  });

  it("returns only the newest page and flags that more exists", async () => {
    const file = path.join(dir, "big.jsonl");
    writeFileSync(file, Array.from({ length: 100 }, (_, i) => userLine(i + 1)).join("\n") + "\n");
    const { reader } = make(file, "claude", { chunkBytes: 128 });
    const page = await reader.start();
    expect(page.items).toHaveLength(40);
    expect(page.more).toBe(true);
    expect(page.items[0].id).toBe("u-0061");
    expect(page.items[39].id).toBe("u-0100");
  });
});

describe("TranscriptReader tail", () => {
  it("emits appended lines once and holds a partial last line until it is complete", async () => {
    const file = path.join(dir, "tail.jsonl");
    writeFileSync(file, `${userLine(1)}\n`);
    const { reader, items } = make(file, "claude");
    await reader.start();
    const second = userLine(2);
    appendFileSync(file, second.slice(0, 30));
    await reader.poll();
    expect(items).toHaveLength(0);
    appendFileSync(file, `${second.slice(30)}\n${userLine(3)}\n`);
    await reader.poll();
    expect(items.flat().map((item) => item.id)).toEqual(["u-0002", "u-0003"]);
    await reader.poll();
    expect(items).toHaveLength(1);
  });

  it("splits a multi-byte character across reads without corrupting it", async () => {
    const file = path.join(dir, "utf8.jsonl");
    writeFileSync(file, "");
    const { reader, items } = make(file, "claude", { chunkBytes: 64 });
    await reader.start();
    const text = "你好".repeat(60);
    appendFileSync(file, `${userLine(1, text)}\n`);
    await reader.poll();
    expect(items.flat()[0]).toMatchObject({ text });
  });

  it("completes a running tool item that came from the initial page and emits the update", async () => {
    const file = path.join(dir, "tool.jsonl");
    const assistant = JSON.stringify({
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-11-15T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "Read", input: { file_path: "/x" } }] },
    });
    writeFileSync(file, `${assistant}\n`);
    const { reader, items } = make(file, "claude");
    const page = await reader.start();
    expect(page.items[0]).toMatchObject({ kind: "tool", status: "running" });
    appendFileSync(
      file,
      JSON.stringify({
        type: "user",
        uuid: "u-2",
        timestamp: "2026-11-15T10:00:01.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "ok" }] },
      }) + "\n",
    );
    await reader.poll();
    const updated = items.flat().filter((item) => item.kind === "tool");
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ id: page.items[0].id, status: "ok" });
  });

  it("counts invalid JSON lines and keeps going", async () => {
    const file = path.join(dir, "bad.jsonl");
    writeFileSync(file, `${userLine(1)}\nnot json\n${userLine(2)}\n`);
    const { reader } = make(file, "claude");
    const page = await reader.start();
    expect(page.items.map((item) => item.id)).toEqual(["u-0001", "u-0002"]);
    expect(reader.parseErrors).toBe(1);
    appendFileSync(file, "{broken\n");
    await reader.poll();
    expect(reader.parseErrors).toBe(2);
  });

  it("resets with a fresh page when the file is truncated", async () => {
    const file = path.join(dir, "trunc.jsonl");
    writeFileSync(file, `${userLine(1)}\n${userLine(2)}\n${userLine(3)}\n`);
    const { reader, resets, items } = make(file, "claude");
    await reader.start();
    truncateSync(file, 0);
    writeFileSync(file, `${userLine(9)}\n`);
    await reader.poll();
    expect(resets).toHaveLength(1);
    expect(resets[0].items.map((item) => item.id)).toEqual(["u-0009"]);
    expect(items).toHaveLength(0);
    appendFileSync(file, `${userLine(10)}\n`);
    await reader.poll();
    expect(items.flat().map((item) => item.id)).toEqual(["u-0010"]);
  });

  it("follows appends through fs.watch and the stat fallback", async () => {
    const file = path.join(dir, "watch.jsonl");
    writeFileSync(file, `${userLine(1)}\n`);
    let seen: (() => void) | null = null;
    const got = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const { reader } = make(file, "claude", { watch: true, pollMs: 25, onItems: () => seen?.() });
    await reader.start();
    appendFileSync(file, `${userLine(2)}\n`);
    await Promise.race([got, new Promise((_, reject) => setTimeout(() => reject(new Error("no event")), 5000))]);
  });

  it("stops emitting after close()", async () => {
    const file = path.join(dir, "close.jsonl");
    writeFileSync(file, `${userLine(1)}\n`);
    const { reader, items } = make(file, "claude");
    await reader.start();
    reader.close();
    appendFileSync(file, `${userLine(2)}\n`);
    await reader.poll();
    expect(items).toHaveLength(0);
  });
});

describe("TranscriptReader paging", () => {
  async function pagedAll(reader: TranscriptReader, first: ReaderPage, limit: number): Promise<CliItem[]> {
    let all = [...first.items];
    let more = first.more;
    while (more) {
      const page = await reader.page({ before: all[0].id, limit });
      expect(page.items.length).toBeGreaterThan(0);
      all = [...page.items, ...all];
      more = page.more;
    }
    return all;
  }

  it("walks back to the start with no gaps or duplicates", async () => {
    const file = path.join(dir, "pages.jsonl");
    writeFileSync(file, Array.from({ length: 130 }, (_, i) => userLine(i + 1)).join("\n") + "\n");
    const { reader } = make(file, "claude", { chunkBytes: 200 });
    const first = await reader.start();
    const all = await pagedAll(reader, first, 25);
    expect(all.map((item) => item.id)).toEqual(Array.from({ length: 130 }, (_, i) => `u-${String(i + 1).padStart(4, "0")}`));
  });

  it("fills a page with distinct items when every tool's result sits next to its call", async () => {
    // a tool call and its result map to the same item twice; a page of tool-heavy turns
    // must still hold `limit` items and say that older turns exist
    const lines: string[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      lines.push(userLine(turn, `turn ${turn}`));
      for (let n = 0; n < 30; n += 1) {
        const id = `t${turn}-${n}`;
        lines.push(JSON.stringify({ type: "assistant", uuid: `a-${id}`, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] } }));
        lines.push(JSON.stringify({ type: "user", uuid: `r-${id}`, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }));
      }
    }
    const file = path.join(dir, "tools.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    const { reader } = make(file, "claude");
    const first = await reader.start();
    expect(first.items).toHaveLength(40);
    expect(first.more).toBe(true);
    const all = await pagedAll(reader, first, 40);
    expect(all.filter((item) => item.kind === "user").map((item) => item.kind === "user" && item.text)).toEqual(["turn 1", "turn 2", "turn 3"]);
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    expect(all).toHaveLength(93);
  });

  it("returns an empty page for an unknown id", async () => {
    const file = path.join(dir, "unknown.jsonl");
    writeFileSync(file, `${userLine(1)}\n`);
    const { reader } = make(file, "claude");
    await reader.start();
    expect(await reader.page({ before: "nope" })).toEqual({ items: [], more: false });
  });

  it("includes items appended after start and honours the limit", async () => {
    const file = path.join(dir, "grow.jsonl");
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => userLine(i + 1)).join("\n") + "\n");
    const { reader } = make(file, "claude");
    await reader.start();
    appendFileSync(file, `${userLine(11)}\n`);
    await reader.poll();
    const page = await reader.page({ limit: 3 });
    expect(page.items.map((item) => item.id)).toEqual(["u-0009", "u-0010", "u-0011"]);
    expect(page.more).toBe(true);
  });

  it("completes a tool on an older page from a result that sits on a newer page", async () => {
    const file = path.join(dir, "span.jsonl");
    const lines: string[] = [];
    lines.push(
      JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        timestamp: "2026-11-15T10:00:00.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
      }),
    );
    for (let i = 1; i <= 60; i += 1) lines.push(userLine(i));
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: "u-res",
        timestamp: "2026-11-15T10:01:00.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] },
      }),
    );
    writeFileSync(file, lines.join("\n") + "\n");
    const { reader } = make(file, "claude");
    const first = await reader.start();
    expect(first.items.some((item) => item.kind === "tool")).toBe(false);
    const older = await reader.page({ before: first.items[0].id, limit: 100 });
    expect(older.items.find((item) => item.kind === "tool")).toMatchObject({ status: "ok" });
  });
});

describe("TranscriptReader Codex", () => {
  it("reads a legacy rollout", async () => {
    const { reader } = make(fixture("codex-rollout-legacy.jsonl"), "codex");
    const page = await reader.start();
    for (const item of page.items) expect(parseCliItem(item)).not.toBeNull();
    const kinds = page.items.map((item) => item.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("assistant");
    expect(page.items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(page.items.find((item) => item.kind === "user")).toMatchObject({ text: "List the files" });
    expect(page.items.find((item) => item.kind === "tool")).toMatchObject({ status: "ok" });
  });

  it("reads a v2 rollout from item_completed events only", async () => {
    const { reader } = make(fixture("codex-rollout-v2.jsonl"), "codex");
    const page = await reader.start();
    for (const item of page.items) expect(parseCliItem(item)).not.toBeNull();
    expect(page.items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(page.items.filter((item) => item.kind === "assistant")).toHaveLength(1);
    expect(page.items.find((item) => item.kind === "tool")).toMatchObject({ status: "ok" });
  });

  it("switches to v2 and resets when the first item_completed event is appended", async () => {
    const file = path.join(dir, "rollout.jsonl");
    copyFileSync(fixture("codex-rollout-legacy.jsonl"), file);
    const { reader, resets, items } = make(file, "codex");
    await reader.start();
    appendFileSync(
      file,
      JSON.stringify({
        timestamp: "2026-11-15T10:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: "t",
          turn_id: "x",
          item: { type: "UserMessage", id: "item-9", content: [{ type: "text", text: "again" }] },
        },
      }) + "\n",
    );
    await reader.poll();
    expect(resets).toHaveLength(1);
    expect(items).toHaveLength(0);
    expect(resets[0].items.some((item) => item.kind === "user" && item.text === "again")).toBe(true);
  });
});
