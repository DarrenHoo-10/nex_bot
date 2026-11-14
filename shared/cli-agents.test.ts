import { describe, expect, it } from "vitest";

import {
  CLI_ERROR_CODES,
  CLI_ERROR_TEXT,
  CLI_LIMITS,
  CLI_OP_MUTATING,
  CLI_OP_TIMEOUT_MS,
  CLI_OPS,
  clampTermSize,
  cliKey,
  cliRef,
  isAbsoluteCwd,
  isCliEngine,
  isCliKey,
  isCliRef,
  isSafeCliArg,
  ITEM_TEXT_MAX,
  MAX_ITEMS_PER_MESSAGE,
  MAX_SEND_TEXT,
  MAX_SESSIONS,
  parseClientMessage,
  parseCliAgentsCapability,
  parseCliItem,
  parseCliItems,
  parseCliKey,
  parseCliOpArgs,
  parseCliOpResult,
  parseCliRef,
  parseCliRequestView,
  parseCliSessionView,
  parseCliSessionWire,
  parseCoreCliMessage,
  parseDeviceCliMessage,
  parseServerMessage,
  SUMMARY_MAX,
  TERM_DEFAULT,
  TERM_LIMITS,
  TOOL_OUTPUT_MAX,
  truncateUtf8,
  utf8ByteLength,
  type CliItem,
} from "./cli-agents.ts";

const UUID = "3f2b8c1e-9a4d-4e7b-8c55-0a1b2c3d4e5f";

function wire(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: "claude",
    nativeId: UUID,
    configDir: "C:\\Users\\me\\.claude",
    cwd: "D:\\work\\app",
    title: "Fix the build",
    state: "running",
    lastActivityAt: 1_763_000_000_000,
    ...extra,
  };
}

function view(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...wire(), key: `dev-1:claude:${UUID}`, deviceId: "dev-1", hidden: false, online: true, ...extra };
}

const capability = {
  version: 1,
  engines: ["claude", "codex"],
  terminal: { name: "herdr-core", version: "0.1.21", ready: true },
};

const ALL_ITEMS: CliItem[] = [
  { kind: "user", id: "u1", ts: 1, text: "hi", images: ["C:\\a.png"], queued: true },
  { kind: "assistant", id: "a1:0", ts: 2, text: "hello" },
  { kind: "thinking", id: "a1:1", ts: 3, text: "hmm" },
  { kind: "tool", id: "a1:2", ts: 4, name: "Bash", input: "ls", status: "ok", output: "x" },
  { kind: "tool", id: "a1:3", ts: 5, name: "Bash", input: "ls", status: "running" },
  { kind: "notice", id: "n1", ts: 6, level: "error", text: "boom" },
  { kind: "turn", id: "t1", ts: 7, phase: "aborted" },
];

describe("refs and keys", () => {
  it("round trips ref and key", () => {
    const ref = cliRef("codex", UUID);
    expect(ref).toBe(`codex:${UUID}`);
    expect(parseCliRef(ref)).toEqual({ engine: "codex", nativeId: UUID });
    const key = cliKey("dev-abc-1", ref);
    expect(key).toBe(`dev-abc-1:codex:${UUID}`);
    expect(parseCliKey(key)).toEqual({ deviceId: "dev-abc-1", engine: "codex", nativeId: UUID, ref });
    expect(isCliRef(ref)).toBe(true);
    expect(isCliKey(key)).toBe(true);
  });

  it("allows dashes in device and native ids", () => {
    expect(parseCliKey("a-b-c:claude:x-y-z")).toMatchObject({ deviceId: "a-b-c", nativeId: "x-y-z" });
  });

  it("rejects malformed refs and keys", () => {
    for (const bad of [
      "",
      "claude",
      "claude:",
      ":x",
      "gemini:x",
      "claude:a:b",
      "claude:../x",
      "claude:-x",
      "claude:a b",
      "claude:a/b",
      `claude:${"a".repeat(201)}`,
      5,
      null,
      undefined,
      {},
    ]) {
      expect(parseCliRef(bad), String(bad)).toBeNull();
    }
    for (const bad of [
      "",
      "dev:claude",
      "dev:claude:x:y",
      ":claude:x",
      "dev:gemini:x",
      "d:ev:claude:x",
      `${"d".repeat(129)}:claude:x`,
      "dev:claude:",
      "dev :claude:x",
      7,
      null,
    ]) {
      expect(parseCliKey(bad), String(bad)).toBeNull();
    }
  });

  it("throws from the builders on invalid parts", () => {
    expect(() => cliRef("gemini" as "claude", "x")).toThrow(TypeError);
    expect(() => cliRef("claude", "a:b")).toThrow(TypeError);
    expect(() => cliRef("claude", "")).toThrow(TypeError);
    expect(() => cliKey("a:b", "claude:x")).toThrow(TypeError);
    expect(() => cliKey("dev", "claude")).toThrow(TypeError);
  });

  it("isCliEngine", () => {
    expect(isCliEngine("claude")).toBe(true);
    expect(isCliEngine("codex")).toBe(true);
    expect(isCliEngine("Claude")).toBe(false);
    expect(isCliEngine(undefined)).toBe(false);
  });
});

describe("utf8 helpers", () => {
  it("returns the text unchanged when it fits", () => {
    expect(truncateUtf8("hello", 5)).toBe("hello");
    expect(truncateUtf8("你好", 6)).toBe("你好");
    expect(truncateUtf8("", 0)).toBe("");
  });

  it("cuts ASCII at the byte limit", () => {
    expect(truncateUtf8("hello", 3)).toBe("hel");
    expect(truncateUtf8("hello", 0)).toBe("");
    expect(truncateUtf8("hello", -4)).toBe("");
    expect(truncateUtf8("hello", Number.NaN)).toBe("");
  });

  it("never splits a CJK character", () => {
    expect(truncateUtf8("你好世界", 7)).toBe("你好");
    expect(truncateUtf8("你好世界", 8)).toBe("你好");
    expect(truncateUtf8("你好世界", 9)).toBe("你好世");
    expect(truncateUtf8("你好世界", 2)).toBe("");
  });

  it("never splits a surrogate pair", () => {
    const text = "a😀b😀";
    expect(truncateUtf8(text, 1)).toBe("a");
    expect(truncateUtf8(text, 4)).toBe("a");
    expect(truncateUtf8(text, 5)).toBe("a😀");
    expect(truncateUtf8(text, 6)).toBe("a😀b");
    expect(truncateUtf8(text, 9)).toBe("a😀b");
    expect(truncateUtf8(text, 10)).toBe(text);
  });

  it("always fits the limit and decodes cleanly", () => {
    const text = "x你😀y".repeat(200);
    for (const limit of [1, 2, 3, 4, 5, 17, 100, 1000]) {
      const cut = truncateUtf8(text, limit);
      expect(utf8ByteLength(cut)).toBeLessThanOrEqual(limit);
      expect(text.startsWith(cut)).toBe(true);
      expect(cut).not.toContain("\uFFFD");
    }
  });

  it("counts a lone surrogate as three bytes like TextEncoder", () => {
    const text = "a\uD800b";
    expect(utf8ByteLength(text)).toBe(5);
    expect(truncateUtf8(text, 3)).toBe("a");
    expect(truncateUtf8(text, 4)).toBe("a\uD800");
  });
});

describe("clampTermSize", () => {
  it("passes valid sizes through", () => {
    expect(clampTermSize(100, 30)).toEqual({ cols: 100, rows: 30 });
  });
  it("clamps to the limits", () => {
    expect(clampTermSize(1, 1)).toEqual({ cols: TERM_LIMITS.minCols, rows: TERM_LIMITS.minRows });
    expect(clampTermSize(9999, 9999)).toEqual({ cols: TERM_LIMITS.maxCols, rows: TERM_LIMITS.maxRows });
    expect(clampTermSize(-5, 0)).toEqual({ cols: TERM_LIMITS.minCols, rows: TERM_LIMITS.minRows });
  });
  it("rounds and defaults non-numbers", () => {
    expect(clampTermSize(80.6, 24.4)).toEqual({ cols: 81, rows: 24 });
    expect(clampTermSize(undefined, "x")).toEqual(TERM_DEFAULT);
    expect(clampTermSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual(TERM_DEFAULT);
  });
});

describe("isSafeCliArg", () => {
  it("accepts plain tokens", () => {
    for (const ok of ["--resume", UUID, "cli-claude-ab12", "a/b:c=d.e", "--session-id"]) {
      expect(isSafeCliArg(ok), ok).toBe(true);
    }
  });
  it("rejects shell metacharacters, spaces and non-strings", () => {
    for (const bad of ["", "a b", "a;b", "a&b", "a|b", "$(x)", "`x`", "a\nb", "a\"b", "a'b", "a%b", "a\\b", "你好", 1, null]) {
      expect(isSafeCliArg(bad), String(bad)).toBe(false);
    }
  });
});

describe("isAbsoluteCwd", () => {
  it("accepts Windows drive, UNC and POSIX paths", () => {
    for (const ok of ["C:\\", "D:\\work\\app", "c:/work", "\\\\server\\share", "\\\\server\\share\\dir", "//server/share", "/", "/home/me/app"]) {
      expect(isAbsoluteCwd(ok), ok).toBe(true);
    }
  });
  it("rejects relative, device and malformed paths", () => {
    for (const bad of ["", "app", "./app", "../app", "C:", "C:app", "~", "~/app", "\\\\", "\\\\server", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "//x", "/a\0b", `/${"a".repeat(CLI_LIMITS.cwd)}`, 5, null]) {
      expect(isAbsoluteCwd(bad), String(bad)).toBe(false);
    }
  });
});

describe("constants and tables", () => {
  it("has a text for every error code", () => {
    for (const code of CLI_ERROR_CODES) expect(CLI_ERROR_TEXT[code].length).toBeGreaterThan(0);
    expect(CLI_ERROR_TEXT.open_elsewhere).toBe("这个会话正在电脑上运行");
    expect(Object.keys(CLI_ERROR_TEXT).sort()).toEqual([...CLI_ERROR_CODES].sort());
  });
  it("has a timeout for every op and marks the mutating ones", () => {
    for (const op of CLI_OPS) expect(CLI_OP_TIMEOUT_MS[op]).toBeGreaterThan(0);
    expect(CLI_OP_TIMEOUT_MS).toMatchObject({
      read: 15_000,
      watch: 5000,
      unwatch: 5000,
      start: 30_000,
      continue: 30_000,
      send: 70_000,
      interrupt: 10_000,
      open_local: 10_000,
      answer: 10_000,
    });
    expect([...CLI_OP_MUTATING].sort()).toEqual(["answer", "continue", "interrupt", "open_local", "send", "start"]);
  });
});

describe("parseCliSessionWire", () => {
  it("accepts a minimal row", () => {
    expect(parseCliSessionWire(wire())).toEqual(wire());
  });

  it("accepts every optional field", () => {
    const full = wire({
      engine: "codex",
      gitBranch: "main",
      state: "waiting",
      waitingFor: "approval",
      liveIn: "nexbot",
      terminal: "term-1",
      model: "gpt-5",
      cliVersion: "1.2.3",
      writerUnknown: true,
    });
    expect(parseCliSessionWire(full)).toEqual(full);
  });

  it("treats undefined optionals as absent and drops unknown keys", () => {
    const parsed = parseCliSessionWire(wire({ gitBranch: undefined, transcript: "C:\\secret.jsonl", extra: 1 }));
    expect(parsed).toEqual(wire());
    expect(parsed).not.toHaveProperty("transcript");
  });

  it("rejects wrong types, enums and ranges", () => {
    for (const bad of [
      null,
      "x",
      [],
      wire({ engine: "gemini" }),
      wire({ engine: 1 }),
      wire({ nativeId: "a:b" }),
      wire({ nativeId: "" }),
      wire({ configDir: 5 }),
      wire({ cwd: null }),
      wire({ title: {} }),
      wire({ state: "paused" }),
      wire({ liveIn: "cloud" }),
      wire({ terminal: "" }),
      wire({ lastActivityAt: "1" }),
      wire({ lastActivityAt: -1 }),
      wire({ lastActivityAt: 1.5 }),
      wire({ lastActivityAt: Number.NaN }),
      wire({ writerUnknown: "yes" }),
      wire({ gitBranch: 3 }),
      wire({ lastActivityAt: undefined }),
    ]) {
      expect(parseCliSessionWire(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("enforces size caps", () => {
    expect(parseCliSessionWire(wire({ title: "t".repeat(CLI_LIMITS.title) }))).not.toBeNull();
    expect(parseCliSessionWire(wire({ title: "t".repeat(CLI_LIMITS.title + 1) }))).toBeNull();
    expect(parseCliSessionWire(wire({ cwd: "c".repeat(CLI_LIMITS.cwd) }))).not.toBeNull();
    expect(parseCliSessionWire(wire({ cwd: "c".repeat(CLI_LIMITS.cwd + 1) }))).toBeNull();
    expect(parseCliSessionWire(wire({ configDir: "c".repeat(CLI_LIMITS.configDir + 1) }))).toBeNull();
    expect(parseCliSessionWire(wire({ gitBranch: "b".repeat(CLI_LIMITS.gitBranch + 1) }))).toBeNull();
    expect(parseCliSessionWire(wire({ waitingFor: "w".repeat(CLI_LIMITS.waitingFor + 1) }))).toBeNull();
    expect(parseCliSessionWire(wire({ terminal: "t".repeat(CLI_LIMITS.terminal + 1) }))).toBeNull();
    expect(parseCliSessionWire(wire({ model: "m".repeat(CLI_LIMITS.model + 1) }))).toBeNull();
    expect(parseCliSessionWire(wire({ cliVersion: "v".repeat(CLI_LIMITS.cliVersion + 1) }))).toBeNull();
  });
});

describe("parseCliSessionView", () => {
  it("accepts a view whose key matches", () => {
    expect(parseCliSessionView(view())).toEqual(view());
  });
  it("rejects a mismatched or missing key, bad device id and bad flags", () => {
    expect(parseCliSessionView(view({ key: `dev-2:claude:${UUID}` }))).toBeNull();
    expect(parseCliSessionView(view({ key: undefined }))).toBeNull();
    expect(parseCliSessionView(view({ deviceId: "a:b", key: `a:b:claude:${UUID}` }))).toBeNull();
    expect(parseCliSessionView(view({ hidden: 0 }))).toBeNull();
    expect(parseCliSessionView(view({ online: "true" }))).toBeNull();
    expect(parseCliSessionView(wire())).toBeNull();
  });
});

describe("parseCliItem / parseCliItems", () => {
  it("round trips every kind", () => {
    for (const entry of ALL_ITEMS) expect(parseCliItem(entry), entry.kind).toEqual(entry);
    expect(parseCliItems(ALL_ITEMS)).toEqual(ALL_ITEMS);
  });

  it("drops unknown keys", () => {
    expect(parseCliItem({ kind: "turn", id: "t", ts: 1, phase: "started", junk: { a: 1 } })).toEqual({
      kind: "turn",
      id: "t",
      ts: 1,
      phase: "started",
    });
  });

  it("rejects unknown kinds, bad enums and missing fields", () => {
    for (const bad of [
      null,
      "x",
      [],
      { kind: "image", id: "i", ts: 1 },
      { kind: "assistant", id: "", ts: 1, text: "x" },
      { kind: "assistant", id: "a", ts: -1, text: "x" },
      { kind: "assistant", id: "a", ts: 1.5, text: "x" },
      { kind: "assistant", id: "a", ts: 1 },
      { kind: "assistant", id: 1, ts: 1, text: "x" },
      { kind: "tool", id: "t", ts: 1, name: "n", input: "i", status: "done" },
      { kind: "tool", id: "t", ts: 1, name: "n", status: "ok" },
      { kind: "tool", id: "t", ts: 1, name: "n", input: "i", status: "ok", output: 5 },
      { kind: "notice", id: "n", ts: 1, level: "warn", text: "x" },
      { kind: "turn", id: "t", ts: 1, phase: "paused" },
      { kind: "user", id: "u", ts: 1, text: "x", images: "a.png" },
      { kind: "user", id: "u", ts: 1, text: "x", images: [1] },
      { kind: "user", id: "u", ts: 1, text: "x", images: [""] },
      { kind: "user", id: "u", ts: 1, text: "x", queued: "yes" },
      { kind: "user", id: "u", ts: 1, text: { nested: { deep: 1 } } },
    ]) {
      expect(parseCliItem(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("enforces text caps", () => {
    const a = (text: string) => ({ kind: "assistant", id: "a", ts: 1, text });
    expect(parseCliItem(a("x".repeat(ITEM_TEXT_MAX)))).not.toBeNull();
    expect(parseCliItem(a("x".repeat(ITEM_TEXT_MAX + 1)))).toBeNull();
    const think = (text: string) => ({ kind: "thinking", id: "a", ts: 1, text });
    expect(parseCliItem(think("x".repeat(SUMMARY_MAX)))).not.toBeNull();
    expect(parseCliItem(think("x".repeat(SUMMARY_MAX + 1)))).toBeNull();
    const tool = (extra: Record<string, unknown>) => ({ kind: "tool", id: "t", ts: 1, name: "n", input: "i", status: "ok", ...extra });
    expect(parseCliItem(tool({ output: "x".repeat(TOOL_OUTPUT_MAX) }))).not.toBeNull();
    expect(parseCliItem(tool({ output: "x".repeat(TOOL_OUTPUT_MAX + 1) }))).toBeNull();
    expect(parseCliItem(tool({ input: "x".repeat(SUMMARY_MAX + 1) }))).toBeNull();
    expect(parseCliItem(tool({ name: "x".repeat(CLI_LIMITS.toolName + 1) }))).toBeNull();
    expect(parseCliItem({ kind: "notice", id: "n", ts: 1, level: "info", text: "x".repeat(CLI_LIMITS.noticeText + 1) })).toBeNull();
    expect(parseCliItem(a("x"))).not.toBeNull();
    expect(parseCliItem({ ...a("x"), id: "i".repeat(CLI_LIMITS.itemId + 1) })).toBeNull();
    const images = Array.from({ length: CLI_LIMITS.images + 1 }, () => "C:\\a.png");
    expect(parseCliItem({ kind: "user", id: "u", ts: 1, text: "x", images })).toBeNull();
  });

  it("caps the list and rejects it whole when one item is bad", () => {
    const one = { kind: "turn", id: "t", ts: 1, phase: "started" };
    expect(parseCliItems(Array.from({ length: MAX_ITEMS_PER_MESSAGE }, () => one))).toHaveLength(MAX_ITEMS_PER_MESSAGE);
    expect(parseCliItems(Array.from({ length: MAX_ITEMS_PER_MESSAGE + 1 }, () => one))).toBeNull();
    expect(parseCliItems([one, { kind: "nope" }])).toBeNull();
    expect(parseCliItems("x")).toBeNull();
    expect(parseCliItems({})).toBeNull();
  });
});

describe("parseCliAgentsCapability", () => {
  it("accepts the hello shape and an error", () => {
    expect(parseCliAgentsCapability(capability)).toEqual(capability);
    const failed = { ...capability, terminal: { ...capability.terminal, ready: false, error: "no hc" } };
    expect(parseCliAgentsCapability(failed)).toEqual(failed);
  });
  it("dedupes engines", () => {
    expect(parseCliAgentsCapability({ ...capability, engines: ["claude", "claude"] })?.engines).toEqual(["claude"]);
  });
  it("rejects other versions, engines and terminals", () => {
    for (const bad of [
      null,
      { ...capability, version: 2 },
      { ...capability, version: "1" },
      { ...capability, engines: ["gemini"] },
      { ...capability, engines: "claude" },
      { ...capability, engines: ["claude", "codex", "claude", "codex", "claude"] },
      { ...capability, terminal: { ...capability.terminal, name: "tmux" } },
      { ...capability, terminal: { ...capability.terminal, ready: 1 } },
      { ...capability, terminal: { ...capability.terminal, version: "" } },
      { ...capability, terminal: { ...capability.terminal, error: "e".repeat(5000) } },
      { ...capability, terminal: undefined },
    ]) {
      expect(parseCliAgentsCapability(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("parseCliOpArgs", () => {
  it("accepts valid args for every op", () => {
    const ref = `claude:${UUID}`;
    expect(parseCliOpArgs("read", { ref })).toEqual({ ref });
    expect(parseCliOpArgs("read", { ref, before: "a1:2", limit: 40 })).toEqual({ ref, before: "a1:2", limit: 40 });
    expect(parseCliOpArgs("watch", { ref })).toEqual({ ref });
    expect(parseCliOpArgs("unwatch", { ref, junk: 1 })).toEqual({ ref });
    expect(parseCliOpArgs("start", { engine: "codex", cwd: "D:\\work" })).toEqual({ engine: "codex", cwd: "D:\\work" });
    expect(parseCliOpArgs("start", { engine: "claude", cwd: "/home/me", cols: 100, rows: 30 })).toEqual({
      engine: "claude",
      cwd: "/home/me",
      cols: 100,
      rows: 30,
    });
    expect(parseCliOpArgs("continue", { ref, cols: 80, rows: 24 })).toEqual({ ref, cols: 80, rows: 24 });
    expect(parseCliOpArgs("send", { ref, text: "你好\nworld" })).toEqual({ ref, text: "你好\nworld" });
    expect(parseCliOpArgs("interrupt", { ref })).toEqual({ ref });
    expect(parseCliOpArgs("open_local", { ref })).toEqual({ ref });
  });

  it("rejects invalid args", () => {
    const ref = `claude:${UUID}`;
    expect(parseCliOpArgs("read", { ref: "x" })).toBeNull();
    expect(parseCliOpArgs("read", { ref, limit: 0 })).toBeNull();
    expect(parseCliOpArgs("read", { ref, limit: MAX_ITEMS_PER_MESSAGE + 1 })).toBeNull();
    expect(parseCliOpArgs("read", { ref, before: "" })).toBeNull();
    expect(parseCliOpArgs("read", null)).toBeNull();
    expect(parseCliOpArgs("start", { engine: "claude", cwd: "relative" })).toBeNull();
    expect(parseCliOpArgs("start", { engine: "gemini", cwd: "/x" })).toBeNull();
    expect(parseCliOpArgs("start", { engine: "claude", cwd: "/x", cols: 10 })).toBeNull();
    expect(parseCliOpArgs("start", { engine: "claude", cwd: "/x", rows: 1000 })).toBeNull();
    expect(parseCliOpArgs("continue", { ref, cols: 80.5 })).toBeNull();
    expect(parseCliOpArgs("send", { ref, text: "" })).toBeNull();
    expect(parseCliOpArgs("send", { ref, text: 5 })).toBeNull();
    expect(parseCliOpArgs("send", { ref, text: "x".repeat(MAX_SEND_TEXT + 1) })).toBeNull();
    expect(parseCliOpArgs("interrupt", {})).toBeNull();
    expect(parseCliOpArgs("bogus" as "read", { ref })).toBeNull();
    expect(parseCliOpArgs("__proto__" as "read", { ref })).toBeNull();
  });

  it("limits send text by bytes, not characters", () => {
    const ref = `claude:${UUID}`;
    expect(parseCliOpArgs("send", { ref, text: "x".repeat(MAX_SEND_TEXT) })).not.toBeNull();
    // 11000 CJK characters is under 32768 characters but 33000 bytes
    expect(parseCliOpArgs("send", { ref, text: "你".repeat(11_000) })).toBeNull();
    expect(parseCliOpArgs("send", { ref, text: "你".repeat(10_922) })).not.toBeNull();
  });
});

describe("parseCliOpResult", () => {
  const ref = `codex:${UUID}`;
  it("accepts valid results", () => {
    expect(parseCliOpResult("read", { items: ALL_ITEMS, more: true })).toEqual({ items: ALL_ITEMS, more: true });
    expect(parseCliOpResult("watch", {})).toEqual({});
    expect(parseCliOpResult("unwatch", { x: 1 })).toEqual({});
    expect(parseCliOpResult("start", { ref, terminal: "t-1" })).toEqual({ ref, terminal: "t-1" });
    expect(parseCliOpResult("continue", { ref, terminal: "t-1" })).toEqual({ ref, terminal: "t-1" });
    expect(parseCliOpResult("send", { turn: 3, started: false })).toEqual({ turn: 3, started: false });
    expect(parseCliOpResult("interrupt", { outcome: "interrupted" })).toEqual({ outcome: "interrupted" });
    expect(parseCliOpResult("open_local", {})).toEqual({});
  });
  it("rejects invalid results", () => {
    expect(parseCliOpResult("read", { items: [], more: "no" })).toBeNull();
    expect(parseCliOpResult("read", { items: [{ kind: "x" }], more: false })).toBeNull();
    expect(parseCliOpResult("start", { ref: "bad", terminal: "t" })).toBeNull();
    expect(parseCliOpResult("start", { ref, terminal: "" })).toBeNull();
    expect(parseCliOpResult("send", { turn: -1, started: true })).toBeNull();
    expect(parseCliOpResult("send", { turn: 1 })).toBeNull();
    expect(parseCliOpResult("interrupt", { outcome: 1 })).toBeNull();
    expect(parseCliOpResult("watch", null)).toBeNull();
    expect(parseCliOpResult("nope" as "read", {})).toBeNull();
  });
});

describe("parseDeviceCliMessage", () => {
  const ref = `claude:${UUID}`;

  it("accepts every device message", () => {
    const messages = [
      { type: "cli.sessions", full: true, upserts: [wire()], removes: [ref], seq: 4 },
      { type: "cli.sessions", full: false, upserts: [], removes: [], seq: 0 },
      { type: "cli.items", ref, items: ALL_ITEMS },
      { type: "cli.items", ref, items: [], reset: true, more: false },
      { type: "cli.reply", opId: "op-1", ok: true, result: { turn: 1, started: true } },
      { type: "cli.reply", opId: "op-1", ok: false, error: { code: "busy", message: "wait" } },
      { type: "cli.term.opened", sid: 1, cols: 120, rows: 36, observe: false },
      { type: "cli.term.size", sid: 1, cols: 100, rows: 30 },
      { type: "cli.term.closed", sid: 1, reason: "exited", exitCode: 0 },
      { type: "cli.term.closed", sid: 0xffff_ffff, reason: "paused" },
      { type: "cli.term.error", sid: 2, code: "read_only" },
    ];
    for (const message of messages) expect(parseDeviceCliMessage(message), message.type).toEqual(message);
  });

  it("rejects invalid input", () => {
    for (const bad of [
      null,
      undefined,
      "cli.resync",
      42,
      [],
      {},
      { type: "cli.resync" },
      { type: "cli.unknown" },
      { type: "__proto__" },
      { type: "cli.sessions", full: "yes", upserts: [], removes: [], seq: 1 },
      { type: "cli.sessions", full: true, upserts: [wire({ engine: "x" })], removes: [], seq: 1 },
      { type: "cli.sessions", full: true, upserts: [], removes: ["claude"], seq: 1 },
      { type: "cli.sessions", full: true, upserts: [], removes: [], seq: -1 },
      { type: "cli.sessions", full: true, upserts: [], removes: [], seq: 1.5 },
      { type: "cli.sessions", full: true, upserts: {}, removes: [], seq: 1 },
      { type: "cli.items", ref: "x", items: [] },
      { type: "cli.items", ref, items: [{ kind: "nope" }] },
      { type: "cli.items", ref, items: [], reset: "1" },
      { type: "cli.reply", opId: "", ok: true },
      { type: "cli.reply", opId: "x".repeat(65), ok: true },
      { type: "cli.reply", opId: "a", ok: "true" },
      { type: "cli.reply", opId: "a", ok: false },
      { type: "cli.reply", opId: "a", ok: false, error: { code: "mystery" } },
      { type: "cli.reply", opId: "a", ok: false, error: { code: "busy", message: "m".repeat(5000) } },
      { type: "cli.reply", opId: "a", ok: true, result: "text" },
      { type: "cli.reply", opId: "a", ok: true, result: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } },
      { type: "cli.reply", opId: "a", ok: true, result: { n: Number.POSITIVE_INFINITY } },
      { type: "cli.term.opened", sid: -1, cols: 120, rows: 36, observe: false },
      { type: "cli.term.opened", sid: 1.5, cols: 120, rows: 36, observe: false },
      { type: "cli.term.opened", sid: 0x1_0000_0000, cols: 120, rows: 36, observe: false },
      { type: "cli.term.opened", sid: 1, cols: 19, rows: 36, observe: false },
      { type: "cli.term.opened", sid: 1, cols: 120, rows: 201, observe: false },
      { type: "cli.term.opened", sid: 1, cols: 120, rows: 36, observe: "no" },
      { type: "cli.term.size", sid: 1, cols: 501, rows: 36 },
      { type: "cli.term.closed", sid: 1 },
      { type: "cli.term.closed", sid: 1, reason: "r".repeat(CLI_LIMITS.reason + 1) },
      { type: "cli.term.closed", sid: 1, reason: "x", exitCode: "0" },
      { type: "cli.term.error", sid: 1, code: "nope" },
    ]) {
      expect(parseDeviceCliMessage(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });

  it("caps session counts", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => wire({ nativeId: `s${i}` }));
    const base = { type: "cli.sessions", full: true, removes: [], seq: 1 };
    expect(parseDeviceCliMessage({ ...base, upserts: rows(MAX_SESSIONS) })).not.toBeNull();
    expect(parseDeviceCliMessage({ ...base, upserts: rows(MAX_SESSIONS + 1) })).toBeNull();
    const removes = Array.from({ length: MAX_SESSIONS + 1 }, (_, i) => `claude:s${i}`);
    expect(parseDeviceCliMessage({ ...base, upserts: [], removes })).toBeNull();
  });

  it("drops unknown keys and never aliases the input", () => {
    const input = { type: "cli.term.size", sid: 1, cols: 100, rows: 30, junk: true };
    const parsed = parseDeviceCliMessage(input);
    expect(parsed).toEqual({ type: "cli.term.size", sid: 1, cols: 100, rows: 30 });
    const reply = { type: "cli.reply", opId: "a", ok: true, result: { x: [1] } };
    const out = parseDeviceCliMessage(reply);
    expect(out).toEqual(reply);
    expect((out as { result: object }).result).not.toBe(reply.result);
  });

  it("never throws on hostile values", () => {
    const hostile = {
      get type(): never {
        throw new Error("boom");
      },
    };
    expect(parseDeviceCliMessage(hostile)).toBeNull();
    expect(parseDeviceCliMessage(new Proxy({}, { get: () => { throw new Error("x"); } }))).toBeNull();
    expect(parseDeviceCliMessage({ type: "cli.reply", opId: "a", ok: true, result: JSON.parse('{"__proto__":{"x":1}}') })).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(parseDeviceCliMessage({ type: "cli.reply", opId: "a", ok: true, result: cyclic })).toBeNull();
  });
});

describe("parseCoreCliMessage", () => {
  const ref = `codex:${UUID}`;

  it("accepts every op with its args", () => {
    const ops: Record<string, unknown> = {
      read: { ref, before: "x:1", limit: 40 },
      watch: { ref },
      unwatch: { ref },
      start: { engine: "claude", cwd: "D:\\work", cols: 120, rows: 36 },
      continue: { ref },
      send: { ref, text: "go" },
      interrupt: { ref },
      open_local: { ref },
      answer: { id: "req-1", decision: "allow", answers: { "Which one?": "A" }, message: "ok" },
    };
    expect(Object.keys(ops).sort()).toEqual([...CLI_OPS].sort());
    for (const [op, args] of Object.entries(ops)) {
      const message = { type: "cli.op", opId: "op-9", op, args, deadlineMs: 5000 };
      expect(parseCoreCliMessage(message), op).toEqual(message);
    }
  });

  it("accepts the stream and resync messages", () => {
    const messages = [
      { type: "cli.term.open", sid: 3, ref, cols: 120, rows: 36, observe: true },
      { type: "cli.term.resize", sid: 3, cols: 100, rows: 30 },
      { type: "cli.term.credit", sid: 3, bytes: 32_768 },
      { type: "cli.term.close", sid: 3 },
      { type: "cli.resync" },
    ];
    for (const message of messages) expect(parseCoreCliMessage(message), message.type).toEqual(message);
  });

  it("rejects invalid input", () => {
    for (const bad of [
      null,
      "cli.op",
      [],
      {},
      { type: "cli.items" },
      { type: "cli.op", opId: "a", op: "format", args: {}, deadlineMs: 1 },
      { type: "cli.op", opId: "a", op: "send", args: { ref, text: "" }, deadlineMs: 1 },
      { type: "cli.op", opId: "a", op: "send", args: "text", deadlineMs: 1 },
      { type: "cli.op", opId: "a", op: "send", args: { ref, text: "x" } },
      { type: "cli.op", opId: "a", op: "send", args: { ref, text: "x" }, deadlineMs: 0 },
      { type: "cli.op", opId: "a", op: "send", args: { ref, text: "x" }, deadlineMs: 10 ** 9 },
      { type: "cli.op", opId: "", op: "watch", args: { ref }, deadlineMs: 1 },
      { type: "cli.op", opId: "a", op: "watch", args: { ref: "bad" }, deadlineMs: 1 },
      { type: "cli.term.open", sid: 3, ref: "x", cols: 120, rows: 36, observe: true },
      { type: "cli.term.open", sid: 3, ref, cols: 120, rows: 36 },
      { type: "cli.term.resize", sid: 3, cols: 0, rows: 30 },
      { type: "cli.term.credit", sid: 3, bytes: 0 },
      { type: "cli.term.credit", sid: 3, bytes: 2 ** 30 },
      { type: "cli.term.credit", sid: 3, bytes: 1.5 },
      { type: "cli.term.close", sid: "3" },
    ]) {
      expect(parseCoreCliMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("parseClientMessage", () => {
  const key = `dev-1:claude:${UUID}`;

  it("accepts every browser message", () => {
    const messages = [
      { type: "sub.list" },
      { type: "sub.session", key },
      { type: "unsub.session", key },
      { type: "term.open", req: "r1", key, cols: 120, rows: 36, observe: false },
      { type: "term.resize", sid: 5, cols: 100, rows: 30 },
      { type: "term.credit", sid: 5, bytes: 32_768 },
      { type: "term.close", sid: 5 },
      { type: "ping" },
    ];
    for (const message of messages) expect(parseClientMessage(message), message.type).toEqual(message);
  });

  it("rejects invalid input", () => {
    for (const bad of [
      null,
      undefined,
      "ping",
      7,
      [],
      {},
      { type: "pong" },
      { type: "list" },
      { type: "sub.session" },
      { type: "sub.session", key: `claude:${UUID}` },
      { type: "sub.session", key: { toString: () => key } },
      { type: "sub.session", key: `a:b:claude:${UUID}` },
      { type: "term.open", req: "", key, cols: 120, rows: 36, observe: false },
      { type: "term.open", req: "r".repeat(65), key, cols: 120, rows: 36, observe: false },
      { type: "term.open", req: "r", key, cols: 10, rows: 36, observe: false },
      { type: "term.open", req: "r", key, cols: 120, rows: 36 },
      { type: "term.open", req: "r", key, cols: "120", rows: 36, observe: false },
      { type: "term.resize", sid: 5, cols: 100 },
      { type: "term.credit", sid: -5, bytes: 1 },
      { type: "term.credit", sid: 5, bytes: Number.NaN },
      { type: "term.close", sid: null },
    ]) {
      expect(parseClientMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

const QUESTIONS = [
  {
    question: "Which database?",
    header: "DB",
    options: [{ label: "sqlite", description: "local file" }, { label: "postgres" }],
    multiSelect: false,
  },
];

function requestView(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r1",
    key: `dev-1:claude:${UUID}`,
    kind: "permission",
    tool: "Bash",
    summary: "git push origin main",
    options: ["allow", "deny"],
    createdAt: 1_763_000_000_000,
    expiresAt: 1_763_000_060_000,
    ...extra,
  };
}

describe("parseCliRequestView", () => {
  it("rebuilds a view and drops unknown keys", () => {
    const parsed = parseCliRequestView({ ...requestView(), extra: 1 });
    expect(parsed).toEqual(requestView());
    expect(parseCliRequestView(requestView({ options: undefined, questions: QUESTIONS, kind: "question" }))).toEqual(
      requestView({ options: undefined, questions: QUESTIONS, kind: "question" }),
    );
  });
  it("rejects bad views", () => {
    for (const bad of [
      null,
      {},
      requestView({ id: "" }),
      requestView({ kind: "nope" }),
      requestView({ key: "x" }),
      requestView({ expiresAt: -1 }),
      requestView({ summary: "s".repeat(SUMMARY_MAX + 1) }),
      requestView({ options: Array.from({ length: CLI_LIMITS.requestOptions + 1 }, () => "a") }),
      requestView({ questions: [{ question: "q" }] }),
    ]) {
      expect(parseCliRequestView(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });
});

describe("parseServerMessage", () => {
  const key = `dev-1:claude:${UUID}`;
  const device = { id: "dev-1", name: "Office PC", online: true, cliAgents: capability };

  it("accepts every server message", () => {
    const messages = [
      { type: "list", devices: [device, { ...device, id: "dev-2", online: false, cliAgents: null }], sessions: [view()] },
      { type: "list", devices: [], sessions: [] },
      { type: "list.delta", upserts: [view()], removes: [key] },
      { type: "list.delta", upserts: [], removes: [], devices: [device] },
      { type: "items", key, items: ALL_ITEMS },
      { type: "items", key, items: [], reset: true, more: true },
      { type: "term.opened", req: "r1", sid: 9, cols: 120, rows: 36, observe: true },
      { type: "term.size", sid: 9, cols: 100, rows: 30 },
      { type: "term.closed", sid: 9, reason: "exited" },
      { type: "error", code: "open_elsewhere" },
      { type: "error", code: "busy", req: "r1", message: "later" },
      { type: "summary", waiting: 2, running: 0 },
      { type: "requests", key, requests: [] },
      { type: "requests", key, requests: [requestView(), requestView({ id: "r2", kind: "question", questions: QUESTIONS })] },
      { type: "request.resolved", key, id: "r1", by: "terminal" },
      { type: "pong" },
    ];
    for (const message of messages) expect(parseServerMessage(message), message.type).toEqual(message);
  });

  it("rejects invalid input", () => {
    for (const bad of [
      null,
      "pong",
      [],
      {},
      { type: "ping" },
      { type: "list", devices: [], sessions: [{ ...view(), key: "x" }] },
      { type: "list", devices: [{ ...device, id: "a:b" }], sessions: [] },
      { type: "list", devices: [{ ...device, cliAgents: undefined }], sessions: [] },
      { type: "list", devices: [{ ...device, cliAgents: { ...capability, version: 2 } }], sessions: [] },
      { type: "list", devices: [device] },
      { type: "list", devices: Array.from({ length: CLI_LIMITS.devices + 1 }, () => device), sessions: [] },
      { type: "list.delta", upserts: [], removes: ["not-a-key"] },
      { type: "list.delta", upserts: [wire()], removes: [] },
      { type: "list.delta", upserts: [], removes: [], devices: "x" },
      { type: "items", key: "x", items: [] },
      { type: "items", key, items: [{ kind: "tool" }] },
      { type: "term.opened", sid: 9, cols: 120, rows: 36, observe: true },
      { type: "term.size", sid: 9, cols: 120 },
      { type: "term.closed", sid: 9 },
      { type: "error", code: "oops" },
      { type: "error", code: "busy", req: "" },
      { type: "error" },
      { type: "summary", waiting: -1, running: 0 },
      { type: "summary", waiting: 1.5, running: 0 },
      { type: "summary", waiting: "1", running: 0 },
      { type: "requests", key: "x", requests: [] },
      { type: "requests", key },
      { type: "requests", key, requests: [{ ...requestView(), key: "dev-2:claude:other" }] },
      { type: "requests", key, requests: [{ ...requestView(), kind: "other" }] },
      { type: "requests", key, requests: Array.from({ length: CLI_LIMITS.requestsPerSession + 1 }, () => requestView()) },
      { type: "request.resolved", key, id: "r1", by: "nobody" },
      { type: "request.resolved", key, id: "", by: "gone" },
      { type: "request.resolved", id: "r1", by: "gone" },
    ]) {
      expect(parseServerMessage(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });

  it("rejects an oversize session list", () => {
    const sessions = Array.from({ length: CLI_LIMITS.listSessions + 1 }, (_, i) =>
      view({ nativeId: `s${i}`, key: `dev-1:claude:s${i}` }),
    );
    expect(parseServerMessage({ type: "list", devices: [], sessions })).toBeNull();
  });
});

describe("answer op", () => {
  it("parses args strictly", () => {
    expect(parseCliOpArgs("answer", { id: "r1", decision: "deny" })).toEqual({ id: "r1", decision: "deny" });
    expect(parseCliOpArgs("answer", { id: "r1", decision: "allow", answers: { Q: "A" }, extra: 1 })).toEqual({
      id: "r1",
      decision: "allow",
      answers: { Q: "A" },
    });
    for (const bad of [
      {},
      { id: "r1" },
      { id: "", decision: "allow" },
      { id: "r1", decision: "maybe" },
      { id: "r1", decision: "allow", answers: { Q: 1 } },
      { id: "r1", decision: "allow", answers: "x" },
      { id: "r1", decision: "allow", answers: JSON.parse('{"__proto__":"x"}') },
      { id: "r1", decision: "allow", message: "m".repeat(CLI_LIMITS.answerMessage + 1) },
      { id: "r".repeat(CLI_LIMITS.requestId + 1), decision: "allow" },
    ]) {
      expect(parseCliOpArgs("answer", bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });
  it("parses the result", () => {
    expect(parseCliOpResult("answer", { outcome: "answered" })).toEqual({ outcome: "answered" });
    expect(parseCliOpResult("answer", {})).toEqual({ outcome: "ok" });
    expect(parseCliOpResult("answer", { outcome: 3 })).toBeNull();
  });
});

describe("cli.turn and cli.request", () => {
  const ref = `claude:${UUID}`;
  const request = {
    type: "cli.request",
    ref,
    id: "r1",
    kind: "permission",
    tool: "Bash",
    summary: "rm -rf build",
    options: ["allow", "deny"],
    expiresAt: 1_763_000_060_000,
  };

  it("accepts the new device messages", () => {
    const messages = [
      { type: "cli.turn", ref, turn: 3, endedAt: 1_763_000_000_000, reason: "end" },
      { type: "cli.turn", ref, turn: 4, endedAt: 1_763_000_000_000, reason: "error", error: "rate limit, resets 5pm" },
      { type: "cli.turn", ref, turn: 5, endedAt: 1_763_000_000_000, reason: "interrupted" },
      request,
      { ...request, id: "r2", kind: "question", options: undefined, questions: QUESTIONS },
      { type: "cli.request.resolved", id: "r1", by: "terminal" },
      { type: "cli.request.resolved", id: "r1", by: "gone" },
    ];
    for (const message of messages) {
      const expected = JSON.parse(JSON.stringify(message));
      expect(parseDeviceCliMessage(message), JSON.stringify(message).slice(0, 60)).toEqual(expected);
    }
  });

  it("drops unknown keys", () => {
    expect(parseDeviceCliMessage({ ...request, extra: 1, options: undefined })).toEqual({
      type: "cli.request",
      ref,
      id: "r1",
      kind: "permission",
      tool: "Bash",
      summary: "rm -rf build",
      expiresAt: 1_763_000_060_000,
    });
  });

  it("rejects bad turns and requests", () => {
    for (const bad of [
      { type: "cli.turn", ref, turn: -1, endedAt: 1, reason: "end" },
      { type: "cli.turn", ref, turn: 1, endedAt: 1, reason: "crash" },
      { type: "cli.turn", ref, turn: 1, reason: "end" },
      { type: "cli.turn", ref: "x", turn: 1, endedAt: 1, reason: "end" },
      { type: "cli.turn", ref, turn: 1, endedAt: 1, reason: "error", error: "e".repeat(CLI_LIMITS.turnError + 1) },
      { ...request, ref: "nope" },
      { ...request, kind: "other" },
      { ...request, id: "" },
      { ...request, expiresAt: "soon" },
      { ...request, options: "allow" },
      { ...request, options: [1] },
      { ...request, questions: [{ question: "q", options: [{ label: 1 }] }] },
      { ...request, questions: Array.from({ length: CLI_LIMITS.requestQuestions + 1 }, () => QUESTIONS[0]) },
      { type: "cli.request.resolved", id: "r1", by: "someone" },
      { type: "cli.request.resolved", by: "gone" },
    ]) {
      expect(parseDeviceCliMessage(bad), JSON.stringify(bad)?.slice(0, 70)).toBeNull();
    }
  });
});
