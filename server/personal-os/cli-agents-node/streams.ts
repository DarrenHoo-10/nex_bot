// Terminal streams of the Agent bridge (plan 3.6): one herdr-core attach per
// stream Core opens, output relayed as DCP binary frames, input and credit
// relayed back. The sid is Core's; the herdr-core channel stays inside the
// attach object.
import {
  FRAME_PAYLOAD_MAX,
  TERM_HISTORY,
  clampTermSize,
  type CliErrorCode,
  type CliSessionRef,
  type DeviceCliMessage,
} from "../../../shared/cli-agents.ts";
import { TERM_INPUT, TERM_OUTPUT, decodeTermFrame, encodeTermFrame, splitPayload } from "../../../shared/cli-agent-frames.ts";

/** Output of one stream is merged for this long before it is framed. */
export const OUTPUT_COALESCE_MS = 16;
/** Open streams per device. */
export const MAX_STREAMS = 8;

/** The part of an herdr-core attach stream the relay uses (HcAttachStream fits). */
export interface TermStream {
  readonly terminal: { cols: number; rows: number };
  readonly observe: boolean;
  on(event: "data", listener: (data: Buffer) => void): unknown;
  on(event: "resize", listener: (size: { cols: number; rows: number }) => void): unknown;
  on(event: "close", listener: (reason: { reason: string; exitCode?: number | null }) => void): unknown;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  ack(bytes: number): void;
  close(): void;
}

export interface TermAttachParams {
  terminal: string;
  cols: number;
  rows: number;
  history: number;
  observe: boolean;
}

export interface TermStreamsOptions {
  attach: (params: TermAttachParams) => Promise<TermStream>;
  /** Sends a message to Core; a closed link drops it. */
  send: (message: DeviceCliMessage) => void;
  sendBinary: (frame: Uint8Array) => void;
  /** Maps an attach or write failure to the code Core shows. */
  errorCode?: (error: unknown) => CliErrorCode;
  /** The program behind a stream exited. */
  onExited?: (address: string, exitCode: number | undefined) => void;
  coalesceMs?: number;
  maxStreams?: number;
  log?: (message: string) => void;
}

interface Entry {
  sid: number;
  address: string;
  stream: TermStream;
  observe: boolean;
  chunks: Buffer[];
  bytes: number;
  timer: NodeJS.Timeout | null;
  /** we closed it ourselves: no `closed` message to Core */
  silent: boolean;
}

/** Why Core is told a stream ended. */
export type StreamEnd = "paused" | "disabled" | "detached" | "link_lost";

function defaultErrorCode(error: unknown): CliErrorCode {
  return hcErrorCode(error);
}

/** herdr-core and client failures as the error code Core and the web show. */
export function hcErrorCode(error: unknown): CliErrorCode {
  const kind = typeof error === "object" && error !== null ? String((error as { kind?: unknown }).kind ?? "") : "";
  switch (kind) {
    case "hc_unavailable":
    case "hc_disconnected":
    case "hc_closed":
    case "hc_protocol":
      return "hc_unavailable";
    case "hc_version":
      return "hc_version";
    case "hc_draft":
      return "busy";
    case "hc_observe_only":
      return "read_only";
    case "not_found":
    case "finished":
    case "exited":
    case "terminal_finished":
      return "stopped";
    case "invalid_params":
      return "invalid";
    default:
      return "unknown";
  }
}

export class TermStreams {
  private readonly entries = new Map<number, Entry>();
  private readonly opening = new Set<number>();
  private blocked: "paused" | "disabled" | null = null;

  constructor(private readonly options: TermStreamsOptions) {}

  get count(): number {
    return this.entries.size;
  }

  has(sid: number): boolean {
    return this.entries.has(sid);
  }

  /** Streams of one terminal, for tests and status. */
  addresses(): string[] {
    return [...this.entries.values()].map((entry) => entry.address);
  }

  /** While paused or disabled no stream opens and no input passes. */
  block(reason: "paused" | "disabled" | null): void {
    this.blocked = reason;
  }

  async open(request: { sid: number; ref: CliSessionRef; address: string | null; cols: number; rows: number; observe: boolean }): Promise<void> {
    const { sid } = request;
    const fail = (code: CliErrorCode): void => this.options.send({ type: "cli.term.error", sid, code });
    if (this.blocked) return fail(this.blocked);
    if (this.entries.has(sid) || this.opening.has(sid)) return fail("invalid");
    if (!request.address) return fail("not_in_terminal");
    if (this.entries.size + this.opening.size >= (this.options.maxStreams ?? MAX_STREAMS)) return fail("busy");
    this.opening.add(sid);
    let stream: TermStream;
    try {
      const size = clampTermSize(request.cols, request.rows);
      stream = await this.options.attach({ terminal: request.address, cols: size.cols, rows: size.rows, history: TERM_HISTORY, observe: request.observe });
    } catch (error) {
      this.opening.delete(sid);
      return fail((this.options.errorCode ?? defaultErrorCode)(error));
    }
    this.opening.delete(sid);
    if (this.blocked) {
      // paused while the attach was under way
      silentClose(stream);
      return fail(this.blocked);
    }
    const entry: Entry = { sid, address: request.address, stream, observe: request.observe, chunks: [], bytes: 0, timer: null, silent: false };
    this.entries.set(sid, entry);
    stream.on("data", (data) => this.onData(entry, data));
    stream.on("resize", (size) => {
      if (entry.observe && this.entries.get(sid) === entry) this.options.send({ type: "cli.term.size", sid, cols: size.cols, rows: size.rows });
    });
    stream.on("close", (reason) => this.onClosed(entry, reason));
    const terminal = stream.terminal;
    this.options.send({
      type: "cli.term.opened",
      sid,
      cols: clampTermSize(terminal.cols, terminal.rows).cols,
      rows: clampTermSize(terminal.cols, terminal.rows).rows,
      observe: request.observe,
    });
  }

  /** A DCP binary frame from Core: terminal input. */
  input(frame: Uint8Array): void {
    const decoded = decodeTermFrame(frame);
    if (!decoded || decoded.type !== TERM_INPUT) return;
    const entry = this.entries.get(decoded.sid);
    if (!entry) return;
    if (entry.observe || this.blocked) {
      this.options.send({ type: "cli.term.error", sid: entry.sid, code: "read_only" });
      return;
    }
    try {
      entry.stream.write(decoded.payload);
    } catch (error) {
      this.options.send({ type: "cli.term.error", sid: entry.sid, code: (this.options.errorCode ?? defaultErrorCode)(error) });
    }
  }

  resize(sid: number, cols: number, rows: number): void {
    const entry = this.entries.get(sid);
    if (!entry || entry.observe || this.blocked) return;
    const size = clampTermSize(cols, rows);
    try {
      entry.stream.resize(size.cols, size.rows);
    } catch (error) {
      this.options.log?.(`resize failed: ${String(error)}`);
    }
  }

  /** Core's browser has consumed `bytes`: herdr-core may send that much more. */
  credit(sid: number, bytes: number): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    try {
      entry.stream.ack(bytes);
    } catch (error) {
      this.options.log?.(`credit failed: ${String(error)}`);
    }
  }

  /** Core closed the stream: nothing is sent back. */
  close(sid: number): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    entry.silent = true;
    this.flush(entry);
    this.drop(entry);
    silentClose(entry.stream);
  }

  /** Ends every stream; Core is told why unless the link is gone (`link_lost`).
   * The terminals themselves are never touched. */
  closeAll(reason: StreamEnd): void {
    for (const entry of Array.from(this.entries.values())) {
      entry.silent = true;
      this.flush(entry);
      this.drop(entry);
      silentClose(entry.stream);
      if (reason !== "link_lost" && reason !== "detached") this.options.send({ type: "cli.term.closed", sid: entry.sid, reason });
    }
    this.opening.clear();
  }

  /** Ends the streams of one terminal (the session was stopped or removed). */
  closeTerminal(address: string, reason: string): void {
    for (const entry of Array.from(this.entries.values())) {
      if (entry.address !== address) continue;
      entry.silent = true;
      this.flush(entry);
      this.drop(entry);
      silentClose(entry.stream);
      this.options.send({ type: "cli.term.closed", sid: entry.sid, reason });
    }
  }

  // -- internals --------------------------------------------------------------

  private onData(entry: Entry, data: Buffer): void {
    if (this.entries.get(entry.sid) !== entry || data.length === 0) return;
    entry.chunks.push(data);
    entry.bytes += data.length;
    if (entry.bytes >= FRAME_PAYLOAD_MAX) {
      this.flush(entry);
      return;
    }
    if (entry.timer) return;
    entry.timer = setTimeout(() => this.flush(entry), this.options.coalesceMs ?? OUTPUT_COALESCE_MS);
    entry.timer.unref?.();
  }

  private flush(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.bytes === 0) return;
    const merged = entry.chunks.length === 1 ? entry.chunks[0] : Buffer.concat(entry.chunks, entry.bytes);
    entry.chunks = [];
    entry.bytes = 0;
    for (const part of splitPayload(merged, FRAME_PAYLOAD_MAX)) this.options.sendBinary(encodeTermFrame(TERM_OUTPUT, entry.sid, part));
  }

  private drop(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.entries.delete(entry.sid);
  }

  private onClosed(entry: Entry, reason: { reason: string; exitCode?: number | null }): void {
    if (this.entries.get(entry.sid) !== entry) return;
    this.flush(entry);
    this.drop(entry);
    const exitCode = typeof reason.exitCode === "number" ? reason.exitCode : undefined;
    if (reason.reason === "exited" || reason.reason === "killed") this.options.onExited?.(entry.address, exitCode);
    if (entry.silent || reason.reason === "detached") return;
    this.options.send({
      type: "cli.term.closed",
      sid: entry.sid,
      reason: reason.reason.slice(0, 64) || "closed",
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  }
}

function silentClose(stream: TermStream): void {
  try {
    stream.close();
  } catch {
    // the connection is already gone
  }
}
