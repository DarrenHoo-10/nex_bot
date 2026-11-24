// Approval dialogs read off a terminal screen. The Claude screens are what
// Claude Code 2.1.331 drew in a herdr-core terminal on Windows 11; the Codex one
// follows the Codex TUI's wording.
import { describe, expect, it } from "vitest";
import type { CliSessionRef, DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { ScreenPromptError, ScreenPrompts, parsePromptScreen, promptCard, type ScreenTerminal } from "./screen-prompts.ts";

const RULE = "─".repeat(120);
const DOTS = "╌".repeat(120);

const CLAUDE_READ = [
  "● I'll read the file.",
  RULE,
  " Read file",
  DOTS,
  " Read(C:\\Users\\Administrator\\AppData\\Local\\Temp\\permprobe\\outside\\x.txt)",
  DOTS,
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, allow reading from /c/Users/Administrator/AppData/Local/Temp/permprobe/outside during this session",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
  "",
].join("\n");

const CLAUDE_BASH = [
  RULE,
  " Bash command",
  " Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below",
  " Initialize a new git repository named probe-repo",
  DOTS,
  " git init probe-repo",
  DOTS,
  " This command requires approval",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don’t ask again for: git init *",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  " Esc to cancel · Tab to amend",
].join("\n");

const CODEX = [
  "• Running git init probe2",
  "",
  "  Would you like to run the following command?",
  "",
  "  $ git init probe2",
  "",
  "  Reason: create the repository",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for this command (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
].join("\n");

// the same dialog with the question right above the options
const CODEX_QUESTION_LAST = [
  "  $ git init probe2",
  "  Would you like to run the following command?",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for this command (p)",
  "  3. No, and tell Codex what to do differently (esc)",
].join("\n");

describe("parsePromptScreen", () => {
  it("reads Claude's Read dialog: the call, its argument and the session option", () => {
    const prompt = parsePromptScreen(CLAUDE_READ)!;
    expect(prompt).toMatchObject({ title: "Read file", question: "Do you want to proceed?" });
    expect(prompt.options.map((option) => option.key)).toEqual(["1", "2", "3"]);
    expect(prompt.allow.key).toBe("1");
    expect(prompt.always?.key).toBe("2");
    expect(prompt.deny.key).toBe("3");
    expect(promptCard(prompt, "claude")).toEqual({
      tool: "Read",
      summary: "C:\\Users\\Administrator\\AppData\\Local\\Temp\\permprobe\\outside\\x.txt",
      detail: "Read file",
    });
  });

  it("reads Claude's Bash dialog and never takes the auto-mode option for always", () => {
    const prompt = parsePromptScreen(CLAUDE_BASH)!;
    expect(prompt.title).toBe("Bash command");
    expect(prompt.always?.label).toBe("Yes, and don’t ask again for: git init *");
    expect(prompt.deny).toMatchObject({ key: "4", label: "No" });
    const card = promptCard(prompt, "claude");
    expect(card.tool).toBe("Bash command");
    expect(card.summary).toBe("Initialize a new git repository named probe-repo");
    expect(card.detail).toContain("git init probe-repo");
    expect(card.detail).not.toContain("Tip:");
  });

  it("uses the hotkeys a Codex dialog shows, with the command below the question", () => {
    const prompt = parsePromptScreen(CODEX)!;
    expect(prompt).toMatchObject({ title: "Would you like to run the following command?", body: ["$ git init probe2", "Reason: create the repository"] });
    expect(prompt.allow.key).toBe("y");
    expect(prompt.always?.key).toBe("p");
    expect(prompt.deny.key).toBe("esc");
    expect(promptCard(prompt, "codex")).toEqual({
      tool: "shell",
      summary: "git init probe2",
      detail: "Would you like to run the following command?\nReason: create the repository",
    });
    expect(promptCard(parsePromptScreen(CODEX_QUESTION_LAST)!, "codex").summary).toBe("git init probe2");
  });

  it("ignores screens that are no approval dialog", () => {
    const cases = [
      "",
      "❯ \n" + RULE + "\n  ? for shortcuts",
      // numbered text in an answer, no question above
      "Steps:\n1. Yes we can\n2. No we cannot",
      // a list that does not start at 1
      "Pick one?\n2. Yes\n3. No",
      // options without a no
      "Which model?\n❯ 1. Yes, opus\n  2. Yes, sonnet",
      // a numbered dialog far above the bottom of the screen
      CLAUDE_READ + "\n" + Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"),
    ];
    for (const screen of cases) expect(parsePromptScreen(screen), JSON.stringify(screen.slice(0, 40))).toBeNull();
  });

  it("reads the same dialog the same and a different one differently", () => {
    expect(parsePromptScreen(CLAUDE_READ)!.fingerprint).toBe(parsePromptScreen("noise above\n" + CLAUDE_READ)!.fingerprint);
    expect(parsePromptScreen(CLAUDE_READ)!.fingerprint).not.toBe(parsePromptScreen(CLAUDE_READ.replace("x.txt", "y.txt"))!.fingerprint);
  });
});

describe("ScreenPrompts", () => {
  const REF = "claude:11111111-1111-4111-8111-111111111111" as CliSessionRef;
  const terminal: ScreenTerminal = { ref: REF, engine: "claude", address: "t-1" };

  function rig(options: { grace?: number } = {}) {
    const state = { screen: CLAUDE_READ, waiting: true, reported: false, linked: true, terminals: [terminal], now: 1000 };
    const messages: DeviceCliMessage[] = [];
    const pressed: string[] = [];
    const prompts = new ScreenPrompts({
      terminals: () => state.terminals,
      reported: () => state.reported,
      maybeWaiting: async () => state.waiting,
      read: async () => state.screen,
      press: async (_address, key) => void pressed.push(key),
      emit: (message) => (state.linked ? (messages.push(message), true) : false),
      linked: () => state.linked,
      now: () => state.now,
      graceMs: () => options.grace ?? 0,
    });
    const requests = () => messages.filter((m): m is Extract<DeviceCliMessage, { type: "cli.request" }> => m.type === "cli.request");
    const resolved = () => messages.filter((m) => m.type === "cli.request.resolved");
    return { state, messages, pressed, prompts, requests, resolved };
  }

  it("turns a waiting dialog into one card and answers it with the dialog's keys", async () => {
    const r = rig();
    await r.prompts.scan();
    await r.prompts.scan();
    expect(r.requests()).toHaveLength(1);
    const card = r.requests()[0];
    expect(card).toMatchObject({ ref: REF, kind: "permission", tool: "Read", always: true });
    expect(r.prompts.owns(card.id)).toBe(true);
    expect(await r.prompts.answer({ id: card.id, decision: "allow", always: true })).toBe("ok");
    expect(r.pressed).toEqual(["2"]);
    expect(r.prompts.owns(card.id)).toBe(false);
  });

  it("denies with the dialog's no option and allows once with its first option", async () => {
    const r = rig();
    await r.prompts.scan();
    await r.prompts.answer({ id: r.requests()[0].id, decision: "deny" });
    expect(r.pressed).toEqual(["3"]);
    // the same dialog still on the screen comes back as a new card
    await r.prompts.scan();
    await r.prompts.answer({ id: r.requests()[1].id, decision: "allow" });
    expect(r.pressed).toEqual(["3", "1"]);
  });

  it("waits out the grace time so a hook can report the prompt first", async () => {
    const r = rig({ grace: 4000 });
    await r.prompts.scan();
    expect(r.requests()).toHaveLength(0);
    r.state.now += 1000;
    await r.prompts.scan();
    expect(r.requests()).toHaveLength(0);
    r.state.now += 3500;
    await r.prompts.scan();
    expect(r.requests()).toHaveLength(1);
  });

  it("leaves a prompt to the hook that reported it and closes its own card", async () => {
    const r = rig();
    r.state.reported = true;
    await r.prompts.scan();
    expect(r.requests()).toHaveLength(0);
    r.state.reported = false;
    await r.prompts.scan();
    expect(r.requests()).toHaveLength(1);
    r.state.reported = true;
    await r.prompts.scan();
    expect(r.resolved()).toEqual([{ type: "cli.request.resolved", id: r.requests()[0].id, by: "terminal" }]);
  });

  it("closes the card when the dialog was answered at the computer and refuses a late answer", async () => {
    const r = rig();
    await r.prompts.scan();
    const card = r.requests()[0];
    r.state.screen = "● Done.\n" + RULE + "\n❯ ";
    r.state.waiting = false;
    await r.prompts.scan();
    expect(r.resolved()).toEqual([{ type: "cli.request.resolved", id: card.id, by: "terminal" }]);
    await expect(r.prompts.answer({ id: card.id, decision: "allow" })).rejects.toBeInstanceOf(ScreenPromptError);
    expect(r.pressed).toEqual([]);
  });

  it("keeps the card when the key could not be pressed", async () => {
    let fail = true;
    const messages: DeviceCliMessage[] = [];
    const prompts = new ScreenPrompts({
      terminals: () => [terminal],
      reported: () => false,
      maybeWaiting: async () => true,
      read: async () => CLAUDE_READ,
      press: async () => { if (fail) throw new Error("terminal busy"); },
      emit: (message) => (messages.push(message), true),
      linked: () => true,
      graceMs: () => 0,
    });
    await prompts.scan();
    const id = (messages[0] as { id: string }).id;
    await expect(prompts.answer({ id, decision: "allow" })).rejects.toThrow("terminal busy");
    expect(prompts.owns(id)).toBe(true);
    // the next scan sees the same dialog and keeps the same card
    await prompts.scan();
    expect(messages.filter((m) => m.type === "cli.request")).toHaveLength(1);
    fail = false;
    expect(await prompts.answer({ id, decision: "allow" })).toBe("ok");
  });

  it("tells Core on relink about a card that closed while the link was down", async () => {
    const r = rig();
    await r.prompts.scan();
    const card = r.requests()[0];
    r.state.linked = false;
    r.state.screen = "● Done.";
    r.state.waiting = false;
    await r.prompts.scan();
    expect(r.resolved()).toHaveLength(0);
    r.state.linked = true;
    r.prompts.relink();
    expect(r.resolved()).toEqual([{ type: "cli.request.resolved", id: card.id, by: "terminal" }]);
  });

  it("never types into a different dialog than the card showed", async () => {
    const r = rig();
    await r.prompts.scan();
    const card = r.requests()[0];
    r.state.screen = CLAUDE_BASH;
    await expect(r.prompts.answer({ id: card.id, decision: "allow" })).rejects.toMatchObject({ code: "not_found" });
    expect(r.pressed).toEqual([]);
  });

  it("closes the card when the terminal goes and announces open cards again after a reconnect", async () => {
    const r = rig();
    r.state.linked = false;
    await r.prompts.scan();
    expect(r.requests()).toHaveLength(0);
    r.state.linked = true;
    r.prompts.relink();
    expect(r.requests()).toHaveLength(1);
    r.state.terminals = [];
    await r.prompts.scan();
    expect(r.resolved()).toEqual([{ type: "cli.request.resolved", id: r.requests()[0].id, by: "gone" }]);
  });

  it("does not read a screen while the session is not waiting", async () => {
    const r = rig();
    r.state.waiting = false;
    let reads = 0;
    const prompts = new ScreenPrompts({
      terminals: () => [terminal],
      reported: () => false,
      maybeWaiting: async () => false,
      read: async () => (reads++, CLAUDE_READ),
      press: async () => undefined,
      emit: () => true,
      linked: () => true,
      graceMs: () => 0,
    });
    await prompts.scan();
    expect(reads).toBe(0);
    expect(prompts.openCount).toBe(0);
  });
});
