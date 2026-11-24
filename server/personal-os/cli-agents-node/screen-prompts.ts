// Approval dialogs read off the screen of a nex_bot terminal: the fallback for
// a prompt no hook or daemon reported. A Claude terminal whose hook could not
// run, a Claude session taken over from the computer, and a Codex TUI (which
// has no hook at all) still show the dialog in the terminal; this turns it into
// the same `cli.request` card and answers it by pressing the dialog's key.
//
// The dialogs it knows (captured from the real CLIs on Windows 11, Claude Code
// 2.1.331; the Codex wording follows its TUI and is matched loosely):
//
//    Read file
//    Read(C:\Users\me\AppData\Local\Temp\x.png)
//    Do you want to proceed?
//    ❯ 1. Yes
//      2. Yes, allow reading from /c/Users/me/AppData/Local/Temp during this session
//      3. No
//
//    Would you like to run the following command?
//    $ git init probe
//    › 1. Yes, proceed (y)
//      2. Yes, and don't ask again for this command (p)
//      3. No, and tell Codex what to do differently (esc)
//
// Only a dialog whose first option says yes and one option says no counts, and
// an answer is only typed while the same dialog is still on the screen.
import { createHash, randomUUID } from "node:crypto";
import { CLI_LIMITS, SUMMARY_MAX, type CliEngine, type CliSessionRef, type DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { clipUnits } from "./items.ts";

export interface ScreenOption {
  /** the number shown before the label */
  number: string;
  label: string;
  /** the key that picks it: the hotkey in parentheses when the dialog shows one, else the number */
  key: string;
}

export interface ScreenPrompt {
  title: string;
  /** what the dialog shows between its title and the question */
  body: string[];
  question: string;
  options: ScreenOption[];
  allow: ScreenOption;
  /** allows this kind of call for the rest of the session, when the dialog offers it */
  always?: ScreenOption;
  deny: ScreenOption;
  /** the same dialog reads the same */
  fingerprint: string;
}

const OPTION_RE = /^\s*(?:[❯›>▶►→*]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/u;
const RULE_RE = /^[\s─━═╌┄┈╍┅┉\-_~·•]+$/u;
const BOX_EDGE_RE = /^[\s│┃|╭╮╰╯┌┐└┘]+|[\s│┃|╭╮╰╯┌┐└┘]+$/gu;
const YES_RE = /^(yes|allow|approve|proceed|run|是|允许|同意|确定|继续)\b/iu;
const NO_RE = /^(no|deny|reject|decline|cancel|否|拒绝|取消|不)\b/iu;
const ALWAYS_RE = /don.?t ask again|during this session|for (?:this|the) session|for the rest of|always allow|本次会话|本会话|不再询问/iu;
const NOT_ALWAYS_RE = /auto mode|switch to|bypass|自动模式/iu;
const QUESTION_RE = /[?？]\s*$/u;
const NOISE_RE = /^(tip:|esc to cancel|enter to confirm|tab to amend|press enter|↑\/↓|ctrl\+)/iu;
/** How far above the bottom of the screen the last option may sit (a footer and blank lines follow it). */
const TAIL_LINES = 8;
const BODY_LINES = 12;

function clean(line: string): string {
  return line.replace(BOX_EDGE_RE, "").trimEnd();
}

function keyOf(number: string, label: string): string {
  const hotkey = /\((esc|[a-z])\)\s*$/iu.exec(label);
  return hotkey ? hotkey[1]!.toLowerCase() : number;
}

/** The approval dialog at the bottom of a screen, or null when there is none. */
export function parsePromptScreen(text: string): ScreenPrompt | null {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split(/\r?\n/).map(clean);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (!lines.length) return null;
  // the last numbered option near the bottom
  let last = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - TAIL_LINES); i -= 1) {
    if (OPTION_RE.test(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  // walk up over consecutive options: n, n-1, ... 1
  const found: Array<{ number: string; label: string }> = [];
  let first = last;
  for (let i = last; i >= 0; i -= 1) {
    const match = OPTION_RE.exec(lines[i]!);
    if (!match) break;
    const expected = found.length ? Number(found[0]!.number) - 1 : undefined;
    if (expected !== undefined && Number(match[1]) !== expected) break;
    found.unshift({ number: match[1]!, label: match[2]!.trim() });
    first = i;
    if (match[1] === "1") break;
  }
  if (found.length < 2 || found[0]!.number !== "1") return null;
  const options = found.map((entry) => ({ ...entry, key: keyOf(entry.number, entry.label) }));
  const allow = options[0]!;
  if (!YES_RE.test(allow.label)) return null;
  const deny = options.find((option) => NO_RE.test(option.label));
  if (!deny) return null;
  const always = options.find((option) => option !== allow && option !== deny && YES_RE.test(option.label) && ALWAYS_RE.test(option.label) && !NOT_ALWAYS_RE.test(option.label));
  // the dialog above the options, up to its top rule
  const above: string[] = [];
  for (let i = first - 1; i >= 0 && above.length < BODY_LINES; i -= 1) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (RULE_RE.test(line)) {
      // a solid rule closes the dialog; the dotted ones (╌) only separate its parts
      if (/[─━═]{8,}/u.test(line) && !/[╌┄┈╍┅┉]/u.test(line)) break;
      continue;
    }
    above.unshift(line.trim());
  }
  const meaningful = above.filter((line) => !NOISE_RE.test(line));
  // Claude asks right above the options; Codex asks first and shows the command below the question
  let q = meaningful.length - 1;
  while (q >= 0 && !QUESTION_RE.test(meaningful[q]!)) q -= 1;
  if (q < 0) return null;
  const question = meaningful[q]!;
  const after = meaningful.slice(q + 1);
  const before = meaningful.slice(0, q);
  const title = after.length ? question : (before[0] ?? "");
  const body = after.length ? after : before.slice(1);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([title, body, question, options.map((option) => option.label)]))
    .digest("hex")
    .slice(0, 32);
  return { title, body, question, options, allow, ...(always ? { always } : {}), deny, fingerprint };
}

/** The card's tool name and text for a dialog. `Read(path)` names the tool and its argument. */
export function promptCard(prompt: ScreenPrompt, engine: CliEngine): { tool: string; summary: string; detail?: string } {
  const call = prompt.body.map((line) => /^([A-Za-z][\w.-]{0,60})\((.*)\)$/u.exec(line)).find((match) => match !== null);
  const command = [prompt.title, ...prompt.body].find((line) => /^\$\s/u.test(line));
  const tool = call ? call[1]! : command && engine === "codex" ? "shell" : prompt.title || (engine === "codex" ? "Codex" : "Claude");
  const lines = call ? prompt.body.filter((line) => line !== call[0]) : prompt.body;
  const summary = call ? call[2]! : (command?.replace(/^\$\s+/u, "") ?? lines[0] ?? prompt.question);
  const rest = [prompt.title, ...lines].filter((line) => line && line !== tool && line !== summary && line !== `$ ${summary}`);
  return {
    tool: clipUnits(tool, CLI_LIMITS.requestTool),
    summary: clipUnits(summary, SUMMARY_MAX),
    ...(rest.length ? { detail: clipUnits(rest.join("\n"), CLI_LIMITS.requestDetail) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tracking the dialogs of nex_bot's terminals

export interface ScreenTerminal {
  ref: CliSessionRef;
  engine: CliEngine;
  address: string;
}

export interface ScreenPromptsOptions {
  /** nex_bot's live Claude and Codex terminals */
  terminals: () => ScreenTerminal[];
  /** whether a hook or a daemon already reports a prompt of this session */
  reported: (ref: CliSessionRef) => boolean;
  /** whether the session may be waiting on a dialog (herdr says blocked, or the CLI's status says waiting) */
  maybeWaiting: (terminal: ScreenTerminal) => Promise<boolean>;
  read: (address: string) => Promise<string>;
  press: (address: string, key: string) => Promise<void>;
  emit: (message: DeviceCliMessage) => boolean;
  linked: () => boolean;
  now?: () => number;
  /** A dialog must stay this long before it becomes a card, so a hook that reports it wins. Default 4 s (Claude), 1 s (Codex). */
  graceMs?: (engine: CliEngine) => number;
  ttlMs?: number;
  log?: (message: string) => void;
}

interface Open {
  id: string;
  terminal: ScreenTerminal;
  prompt: ScreenPrompt;
  message: Extract<DeviceCliMessage, { type: "cli.request" }>;
}

export class ScreenPromptError extends Error {
  constructor(readonly code: "not_found" | "invalid", message?: string) {
    super(message ?? code);
  }
}

const SCREEN_TTL_MS = 30 * 60_000;

export class ScreenPrompts {
  private readonly open = new Map<CliSessionRef, Open>();
  /** closes Core did not hear because the link was down; sent by relink() */
  private readonly unsent: Array<{ id: string; by: "terminal" | "gone" | "timeout" }> = [];
  /** when each dialog was first seen, by session */
  private readonly seen = new Map<CliSessionRef, { fingerprint: string; at: number }>();
  private scanning = false;

  constructor(private readonly options: ScreenPromptsOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  owns(id: string): boolean {
    for (const open of this.open.values()) if (open.id === id) return true;
    return false;
  }

  get openCount(): number {
    return this.open.size;
  }

  /** One look at every terminal. Overlapping calls are dropped. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const terminals = this.options.terminals();
      const live = new Set(terminals.map((terminal) => terminal.ref));
      for (const [ref, open] of Array.from(this.open)) if (!live.has(ref)) this.close(open, "gone");
      for (const ref of Array.from(this.seen.keys())) if (!live.has(ref)) this.seen.delete(ref);
      for (const terminal of terminals) {
        try {
          await this.look(terminal);
        } catch (error) {
          this.options.log?.(`screen prompt of ${terminal.ref}: ${String(error)}`);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private async look(terminal: ScreenTerminal): Promise<void> {
    const open = this.open.get(terminal.ref);
    if (this.options.reported(terminal.ref)) {
      // the hook or daemon has the prompt: its card is the one to answer
      if (open) this.close(open, "terminal");
      this.seen.delete(terminal.ref);
      return;
    }
    const waiting = await this.options.maybeWaiting(terminal);
    const prompt = waiting || open ? parsePromptScreen(await this.options.read(terminal.address)) : null;
    if (open && (!prompt || prompt.fingerprint !== open.prompt.fingerprint)) this.close(open, "terminal");
    if (!prompt) {
      this.seen.delete(terminal.ref);
      return;
    }
    if (this.open.get(terminal.ref)?.prompt.fingerprint === prompt.fingerprint) return;
    const now = this.now();
    const grace = this.options.graceMs?.(terminal.engine) ?? (terminal.engine === "claude" ? 4000 : 1000);
    const seen = this.seen.get(terminal.ref);
    if (!seen || seen.fingerprint !== prompt.fingerprint) {
      this.seen.set(terminal.ref, { fingerprint: prompt.fingerprint, at: now });
      if (grace > 0) return;
    } else if (now - seen.at < grace) {
      return;
    }
    const card = promptCard(prompt, terminal.engine);
    const message: Extract<DeviceCliMessage, { type: "cli.request" }> = {
      type: "cli.request",
      ref: terminal.ref,
      id: randomUUID(),
      kind: "permission",
      ...card,
      ...(prompt.always ? { always: true } : {}),
      expiresAt: now + (this.options.ttlMs ?? SCREEN_TTL_MS),
    };
    this.open.set(terminal.ref, { id: message.id, terminal, prompt, message });
    if (this.options.linked()) this.options.emit(message);
  }

  private close(open: Open, by: "terminal" | "gone" | "timeout"): void {
    if (this.open.get(open.terminal.ref) !== open) return;
    this.open.delete(open.terminal.ref);
    if (!this.options.emit({ type: "cli.request.resolved", id: open.id, by }) && this.unsent.length < 200) this.unsent.push({ id: open.id, by });
  }

  /** Core came back: announce the open cards again. */
  relink(): void {
    if (!this.options.linked()) return;
    for (const closed of this.unsent.splice(0)) this.options.emit({ type: "cli.request.resolved", ...closed });
    const now = this.now();
    for (const open of Array.from(this.open.values())) {
      if (open.message.expiresAt <= now) this.close(open, "timeout");
      else this.options.emit(open.message);
    }
  }

  /** Presses the dialog's key, but only while the same dialog is on the screen. */
  async answer(args: { id: string; decision: "allow" | "deny"; always?: boolean }): Promise<string> {
    const open = [...this.open.values()].find((entry) => entry.id === args.id);
    if (!open) throw new ScreenPromptError("not_found", "request is closed");
    const current = parsePromptScreen(await this.options.read(open.terminal.address));
    if (!current || current.fingerprint !== open.prompt.fingerprint) {
      this.close(open, "terminal");
      throw new ScreenPromptError("not_found", "request is closed");
    }
    const option = args.decision === "deny" ? current.deny : args.always === true && current.always ? current.always : current.allow;
    // Core closes its copy when this answer succeeds; while the key is on its way no scan may take the dialog again
    this.open.delete(open.terminal.ref);
    try {
      await this.options.press(open.terminal.address, option.key);
    } catch (error) {
      if (!this.open.has(open.terminal.ref)) this.open.set(open.terminal.ref, open);
      throw error;
    }
    this.seen.delete(open.terminal.ref);
    return "ok";
  }

  /** Forgets everything without telling Core (the bridge is going away). */
  clear(): void {
    this.open.clear();
    this.seen.clear();
  }
}
