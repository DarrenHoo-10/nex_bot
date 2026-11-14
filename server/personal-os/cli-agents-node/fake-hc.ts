// An in-memory herdr-core for the bridge tests: the same calls the bridge makes
// (`HcLike`), terminals that record what they were given, and hooks to play the
// part of the person at the computer (a draft in the input line) and of the CLI
// (a program that exits, output that arrives). Test support only; production
// code never imports it.
import { EventEmitter } from "node:events";
import { HcError, type HcEvent, type HcListResult, type HcRunParams, type HcSendParams, type HcSendResult, type HcSnapshot, type HcState, type HcTerminal } from "./hc.ts";
import type { HcLike } from "./bridge.ts";
import type { TermAttachParams, TermStream } from "./streams.ts";

export class FakeStream extends EventEmitter implements TermStream {
  readonly terminal: { cols: number; rows: number };
  readonly observe: boolean;
  readonly writes: Buffer[] = [];
  readonly acks: number[] = [];
  readonly resizes: Array<[number, number]> = [];
  closed = false;

  constructor(readonly address: string, readonly params: TermAttachParams, cols: number, rows: number) {
    super();
    this.terminal = { cols, rows };
    this.observe = params.observe;
  }

  write(data: Uint8Array | string): void {
    if (this.observe) throw new HcError("hc_observe_only", "an observing stream takes no input");
    this.writes.push(Buffer.from(data));
  }
  resize(cols: number, rows: number): void {
    if (this.observe) throw new HcError("hc_observe_only", "an observing stream cannot resize");
    this.resizes.push([cols, rows]);
  }
  ack(bytes: number): void {
    this.acks.push(bytes);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { reason: "detached" });
  }
  /** Output as the terminal would produce it. */
  push(data: string | Uint8Array): void {
    if (!this.closed) this.emit("data", Buffer.from(data));
  }
  /** The program behind the terminal ended. */
  finish(reason = "exited", exitCode: number | null = 0): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { reason, exitCode });
  }
  text(): string {
    return Buffer.concat(this.writes).toString("utf8");
  }
}

export interface FakeTerminal extends HcTerminal {
  env: Record<string, string>;
  streams: FakeStream[];
  sent: HcSendParams[];
  interrupts: number;
}

export class FakeHc extends EventEmitter implements HcLike {
  readonly terminals = new Map<string, FakeTerminal>();
  readonly runs: HcRunParams[] = [];
  /** terminals where a person has typed something that is not sent yet */
  readonly drafts = new Set<string>();
  /** set to make the next ensureStarted() calls fail */
  unavailable: HcError | null = null;
  /** plays the CLI: runs after a terminal is created, before `run` answers */
  onRun: ((terminal: FakeTerminal, params: HcRunParams) => void) | null = null;
  /** delay of every `run`, to test slow starts */
  runDelayMs = 0;
  closed = false;
  starts = 0;
  subscribes = 0;
  private counter = 0;
  private turn = 0;

  async ensureStarted(): Promise<void> {
    this.starts += 1;
    if (this.unavailable) throw this.unavailable;
  }
  close(): void {
    this.closed = true;
  }
  state(): HcState {
    return { status: this.unavailable ? "unavailable" : "ready", since: 0, attempt: 0 };
  }

  async run(params: HcRunParams): Promise<HcTerminal> {
    if (this.runDelayMs) await new Promise((resolve) => setTimeout(resolve, this.runDelayMs));
    if (params.name && [...this.terminals.values()].some((t) => t.name === params.name && t.state === "live")) {
      throw new HcError("name_taken", `name ${params.name} is taken`);
    }
    this.runs.push(params);
    const address = `t-${++this.counter}`;
    const terminal: FakeTerminal = {
      address,
      name: params.name ?? null,
      state: "live",
      argv: params.argv,
      cwd: params.cwd ?? "",
      cols: params.size?.cols ?? 120,
      rows: params.size?.rows ?? 36,
      pid: 1000 + this.counter,
      labels: { ...params.labels },
      exit_code: null,
      reason: null,
      created_ms: Date.now(),
      finished_ms: null,
      env: { ...params.env },
      streams: [],
      sent: [],
      interrupts: 0,
    };
    this.terminals.set(address, terminal);
    this.onRun?.(terminal, params);
    this.emitEvent("created", address);
    return terminal;
  }

  async list(params: { all?: boolean; labels?: Record<string, string> } = {}): Promise<HcListResult> {
    const labels = params.labels ?? {};
    const terminals = [...this.terminals.values()].filter(
      (t) => (params.all || t.state === "live") && Object.entries(labels).every(([key, value]) => t.labels[key] === value),
    );
    return { terminals: terminals.map(plain), hidden_finished: 0, machines: [] };
  }

  async get(address: string): Promise<HcTerminal> {
    const terminal = this.terminals.get(address);
    if (!terminal) throw new HcError("not_found", "no such terminal");
    return plain(terminal);
  }

  async read(address: string): Promise<{ text: string }> {
    if (!this.terminals.has(address)) throw new HcError("not_found", "no such terminal");
    return { text: this.terminals.get(address)!.reason ?? "" };
  }

  async sendGuarded(params: HcSendParams): Promise<HcSendResult> {
    const terminal = this.live(params.terminal);
    if (this.drafts.has(terminal.address)) throw new HcError("hc_draft", "a person has an unsent draft", "ask them to send or clear it");
    terminal.sent.push(params);
    return { turn: ++this.turn, started: true };
  }

  async interrupt(address: string): Promise<{ outcome: string }> {
    const terminal = this.live(address);
    terminal.interrupts += 1;
    return { outcome: "interrupted" };
  }

  async attach(params: TermAttachParams & { resizeNotifications?: boolean }): Promise<TermStream> {
    const terminal = this.live(params.terminal);
    const stream = new FakeStream(terminal.address, params, terminal.cols, terminal.rows);
    terminal.streams.push(stream);
    return stream;
  }

  async subscribe(): Promise<HcSnapshot> {
    this.subscribes += 1;
    return { seq: 0, terminals: [...this.terminals.values()].filter((t) => t.state === "live").map(plain), resync: false };
  }

  // -- test controls ---------------------------------------------------------------

  /** The program exits; its streams close with `exited`. */
  exit(address: string, exitCode = 0, screen = ""): void {
    const terminal = this.terminals.get(address);
    if (!terminal || terminal.state !== "live") return;
    terminal.state = "finished";
    terminal.exit_code = exitCode;
    terminal.reason = screen;
    terminal.finished_ms = Date.now();
    for (const stream of terminal.streams) stream.finish("exited", exitCode);
    this.emitEvent("finished", address);
  }

  streamsOf(address: string): FakeStream[] {
    return this.terminals.get(address)?.streams ?? [];
  }

  /** The terminal that was created last. */
  last(): FakeTerminal {
    const all = [...this.terminals.values()];
    return all[all.length - 1] as FakeTerminal;
  }

  emitEvent(type: string, terminal: string): void {
    const event: HcEvent = { seq: ++this.counter, type, terminal, data: {} };
    this.emit("event", event);
  }

  private live(address: string): FakeTerminal {
    const terminal = this.terminals.get(address);
    if (!terminal) throw new HcError("not_found", "no such terminal");
    if (terminal.state !== "live") throw new HcError("finished", "the terminal has ended");
    return terminal;
  }
}

function plain(terminal: FakeTerminal): HcTerminal {
  const { env: _env, streams: _streams, sent: _sent, interrupts: _interrupts, ...rest } = terminal;
  return { ...rest };
}
