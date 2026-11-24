// Workbench sessions and the outbox queue (workbench plan sections 3 and 4).
// A logical session (`cli_agent_workbench`) sits above the native session keys
// a conversation has been bound to, so a resume that changed the key keeps the
// tree row, the display title and the queue. Messages the user composes while
// a turn runs go into `cli_agent_outbox`; the consumer dispatches the head
// when the session is free, pauses when the user stops the session or a
// dispatch ends uncertain, and never re-sends an entry whose outcome nobody
// can confirm. Core owns the queue: the device only ever sees one send, steer
// or interrupt at a time, through the hub.
import {
  CLI_LIMITS,
  type CliDelivery,
  type CliDeliveryAction,
  type CliErrorCode,
  type CliQueueEntryView,
  type CliQueueStatus,
  type CliQueueView,
  type CliSessionKey,
  type CliWorkbenchKind,
  type CliWorkbenchSessionView,
  parseCliKey,
} from "../../../shared/cli-agents.ts";
import { id, now, type CoreStore, type Row } from "../store.ts";
import { CliOpError, TrackedOpError, type CliAgentHub, type CliTurnEvent } from "./hub.ts";
import type { CliImages } from "./images.ts";

export interface WorkbenchSubmitInput {
  text: string;
  delivery: CliDeliveryAction;
  /** the composer's id for this message; unique per logical session */
  clientMessageId: string;
  /** unique per account: a retry with the same id and the same parameters
   * returns the first result, different parameters are a conflict */
  requestId: string;
  /** the transcript message this entry revises (edit-and-resend) */
  revisesMessageId?: string;
  /** attachment references recorded with the entry; delivery stays text-only */
  attachments?: string[];
}

export interface WorkbenchSubmitResult {
  messageId: string;
  operationId: string | null;
  status: CliQueueStatus;
  version: number;
  /** true when the entry waits in the outbox instead of having been dispatched */
  queued: boolean;
  /** a session outside nex_bot's terminals: whether its transcript showed the message arrive */
  delivery?: CliDelivery;
  /** a session outside nex_bot's terminals that was waiting on a question when the message went */
  waiting?: boolean;
}

export interface WorkbenchEntryInput {
  entryId: string;
  expectedVersion: number;
}

/** What the page sends to create a note. `start`/`end` are the selection
 * offsets inside the message text, kept so the mark can be painted again. */
export interface CliNoteInput {
  id?: string;
  message: string;
  quote: string;
  body: string;
  num?: number;
  start?: number;
  end?: number;
}

export interface CliNoteView {
  id: string;
  sessionKey: CliSessionKey | null;
  message: string;
  num: number;
  start: number | null;
  end: number | null;
  quote: string;
  body: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

const MAX_NOTES_PER_SESSION = 500;

/** An op that reached the device: the id survives a rejection, so an uncertain
 * outcome can be reconciled against the op row later. */
class DispatchFailure extends Error {
  constructor(
    readonly opId: string | null,
    readonly code: CliErrorCode,
  ) {
    super(code);
  }
}

/** What a successful send to a session outside nex_bot's terminals reported back. */
interface DispatchOutcome { delivery?: CliDelivery; waiting?: boolean }

/** Outbox statuses a browser is shown, oldest queue position first. */
const LIVE_STATUSES: readonly CliQueueStatus[] = ["pending", "claimed", "sent", "uncertain", "failed"];

/** Harnesses whose sessions take a new message while a turn runs (their inbox
 * accepts it); their send results report started=false, so the queue advances
 * right after the dispatch instead of waiting for a turn end nobody reports. */
const OUTSIDE_VIA = new Set(["inbox", "daemon", "host"]);

const fingerprintOf = (input: { key: string; delivery: string; text: string; revisesMessageId?: string }): string =>
  JSON.stringify({ key: input.key, delivery: input.delivery, text: input.text, ...(input.revisesMessageId ? { revises: input.revisesMessageId } : {}) });

export class CliAgentWorkbench {
  /** Single-flight per logical session: a re-entrant pump sets this and runs once more. */
  private readonly pumping = new Set<string>();
  private readonly repump = new Set<string>();
  /** The last dispatch's device answer: did this message begin a turn? */
  private lastDispatchStarted = false;
  /** Queues whose dispatched message started a turn: the next entry waits for
   * that turn's end, whatever the session rows say in between. */
  private readonly awaitingTurnEnd = new Set<string>();
  private readonly detach = new Set<() => void>();

  constructor(
    private readonly hub: CliAgentHub,
    private readonly store: CoreStore,
    private readonly images?: CliImages,
  ) {
    hub.workbench = { queueForSessionKey: (key) => this.queueForSessionKey(key) };
    this.detach.add(hub.onTurnEnd((event) => this.onTurnEnd(event)));
    this.detach.add(hub.onDeviceOnline((deviceId) => this.onDeviceOnline(deviceId)));
    this.detach.add(hub.onList((delta) => this.onListDelta(delta)));
  }

  close(): void {
    for (const off of this.detach) off();
    this.detach.clear();
    this.hub.workbench = null;
  }

  // -------------------------------------------------------------------------
  // Logical sessions

  private rowOf(logicalId: string): Row | undefined {
    return this.store.get("SELECT * FROM cli_agent_workbench WHERE id=? AND deleted_at IS NULL", logicalId);
  }

  /** The logical session bound to a native key, created as a root `main` when
   * the workbench touches the session for the first time. Old data keeps
   * working this way; nothing guesses a parent from the folder. */
  ensureSession(key: string): Row {
    const parsed = parseCliKey(key);
    if (!parsed) throw new CliOpError("invalid");
    const existing = this.store.get("SELECT * FROM cli_agent_workbench WHERE session_key=? AND deleted_at IS NULL", key);
    if (existing) return existing;
    const session = this.hub.session(key);
    if (!session) throw new CliOpError("not_found");
    const at = now();
    this.store.insert("cli_agent_workbench", {
      id: id(), session_key: key, device_id: session.deviceId, engine: session.engine, cwd: session.cwd,
      parent_id: null, kind: "main", title: "", archived: 0, deleted_at: null,
      version: 1, created_at: at, updated_at: at,
    });
    const row = this.store.get("SELECT * FROM cli_agent_workbench WHERE session_key=? AND deleted_at IS NULL", key) as Row;
    this.pushWorkbench();
    return row;
  }

  /** By logical id, or the logical session of a native key; both work so the
   * routes can accept either shape. */
  resolve(ref: string): Row {
    const row = this.rowOf(ref);
    if (row) return row;
    return this.ensureSession(ref);
  }

  /** Creates a fork (or side-chat) row under `parentId`. Retrying the same
   * requestId returns the same child; a different shape is a conflict. The
   * child binds to a native key later, when the device created the session. */
  branch(parentId: string, requestId: string, input: { kind?: CliWorkbenchKind; title?: string } = {}): Row {
    const parent = this.rowOf(parentId);
    if (!parent) throw new CliOpError("not_found");
    const kind = input.kind ?? "fork";
    if (kind === "fork") {
      const grand = parent.parent_id === null ? null : this.rowOf(String(parent.parent_id));
      if (grand && grand.parent_id !== null) throw new CliOpError("invalid", "已达到分支层级上限");
    }
    const shape = fingerprintOf({ key: String(parent.id), delivery: `branch:${kind}`, text: input.title ?? "" });
    const existing = this.store.get("SELECT * FROM cli_agent_send_requests WHERE request_id=?", requestId);
    if (existing) {
      if (String(existing.fingerprint) !== shape) throw new CliOpError("conflict");
      const row = existing.outbox_id === null ? undefined : this.rowOf(String(existing.outbox_id));
      if (!row) throw new CliOpError("not_found");
      return row;
    }
    const at = now();
    const childId = id();
    this.store.transaction(() => {
      this.store.insert("cli_agent_workbench", {
        id: childId, session_key: null, device_id: parent.device_id, engine: parent.engine, cwd: String(parent.cwd),
        parent_id: parent.id, kind, title: input.title ?? "", archived: 0, deleted_at: null,
        version: 1, created_at: at, updated_at: at,
      });
      this.store.insert("cli_agent_send_requests", { request_id: requestId, fingerprint: shape, outbox_id: childId, created_at: at });
    });
    this.pushWorkbench();
    return this.rowOf(childId) as Row;
  }

  /** Binds a logical session to the native key its device session now has; the
   * pending queue follows the new key. */
  bind(logicalId: string, key: string): Row {
    const row = this.rowOf(logicalId);
    if (!row) throw new CliOpError("not_found");
    // The device may answer a start before its session row reaches the hub; the
    // key itself names the device and engine, so the binding does not wait
    // (otherwise the first send would create a root row for the new session).
    const session = this.hub.session(key);
    const parsed = parseCliKey(key);
    if (!session && !parsed) throw new CliOpError("not_found");
    this.store.transaction(() => {
      this.store.run(
        "UPDATE cli_agent_workbench SET session_key=?,device_id=?,engine=?,cwd=?,version=version+1,updated_at=? WHERE id=?",
        key, session?.deviceId ?? parsed!.deviceId, session?.engine ?? parsed!.engine, session?.cwd ?? String(row.cwd), now(), logicalId,
      );
      this.store.run(
        `INSERT INTO cli_agent_queue_state(workbench_id,session_key,paused,pause_reason,next_seq,updated_at)
         VALUES(?,?,0,NULL,1,?)
         ON CONFLICT(workbench_id) DO UPDATE SET session_key=excluded.session_key,pause_reason=NULL,updated_at=excluded.updated_at`,
        logicalId, key, now(),
      );
      this.store.run("UPDATE cli_agent_outbox SET session_key=? WHERE workbench_id=? AND status IN ('pending','claimed')", key, logicalId);
    });
    this.pushWorkbench();
    return this.rowOf(logicalId) as Row;
  }

  rename(logicalId: string, title: string, expectedVersion: number): Row {
    const changes = Number(this.store.run(
      "UPDATE cli_agent_workbench SET title=?,version=version+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND version=?",
      title, now(), logicalId, expectedVersion,
    ).changes);
    if (!changes) throw this.staleOrMissing(logicalId);
    this.pushWorkbench();
    return this.rowOf(logicalId) as Row;
  }

  setArchived(logicalId: string, archived: boolean, expectedVersion: number): Row {
    const changes = Number(this.store.run(
      "UPDATE cli_agent_workbench SET archived=?,version=version+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND version=?",
      archived ? 1 : 0, now(), logicalId, expectedVersion,
    ).changes);
    if (!changes) throw this.staleOrMissing(logicalId);
    this.pushWorkbench();
    return this.rowOf(logicalId) as Row;
  }

  /** A soft delete. Children move up to their grandparent instead of
   * disappearing with the parent; native sessions are never touched. */
  remove(logicalId: string, expectedVersion: number): Row {
    const parent = this.store.get("SELECT parent_id FROM cli_agent_workbench WHERE id=? AND deleted_at IS NULL", logicalId);
    if (!parent) throw new CliOpError("not_found");
    const changes = Number(this.store.run(
      "UPDATE cli_agent_workbench SET deleted_at=?,version=version+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND version=?",
      now(), now(), logicalId, expectedVersion,
    ).changes);
    if (!changes) throw this.staleOrMissing(logicalId);
    this.store.run(
      "UPDATE cli_agent_workbench SET parent_id=?,version=version+1,updated_at=? WHERE parent_id=? AND deleted_at IS NULL",
      parent.parent_id, now(), logicalId,
    );
    this.store.run("UPDATE cli_agent_outbox SET status='withdrawn',version=version+1,updated_at=? WHERE workbench_id=? AND status='pending'", now(), logicalId);
    this.pushWorkbench();
    return this.rowOf(logicalId) as Row;
  }

  /** Non-deleted rows, parents before children. */
  list(): CliWorkbenchSessionView[] {
    return this.store.all("SELECT * FROM cli_agent_workbench WHERE deleted_at IS NULL ORDER BY created_at,id").map((row) => this.workbenchView(row));
  }

  /** One row as the wire sees it, for the mutation answers. */
  viewOf(row: Row): CliWorkbenchSessionView {
    return this.workbenchView(row);
  }

  private workbenchView(row: Row): CliWorkbenchSessionView {
    const sessionKey = row.session_key === null ? null : (String(row.session_key) as CliSessionKey);
    return {
      id: String(row.id),
      cwd: String(row.cwd),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      kind: String(row.kind) as CliWorkbenchKind,
      title: String(row.title),
      archived: row.archived === 1,
      deleted: false,
      version: Number(row.version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      sessionKey,
      deviceId: row.device_id === null ? null : String(row.device_id),
      engine: row.engine === null ? null : (String(row.engine) as CliWorkbenchSessionView["engine"]),
    };
  }

  private pushWorkbench() {
    this.hub.notifyWorkbench(this.list());
  }

  private staleOrMissing(logicalId: string): CliOpError {
    return this.rowOf(logicalId) ? new CliOpError("conflict") : new CliOpError("not_found");
  }

  // -------------------------------------------------------------------------
  // Notes: annotations on a conversation's messages

  /** The notes of one logical session, by logical id or native key. A session
   * the workbench never touched has none, and asking does not create its row. */
  listNotes(ref: string): CliNoteView[] {
    const row = this.rowOf(ref) ?? this.store.get("SELECT * FROM cli_agent_workbench WHERE session_key=? AND deleted_at IS NULL", ref);
    if (!row) return [];
    return this.store.all("SELECT * FROM cli_agent_notes WHERE workbench_id=? ORDER BY created_at,id", String(row.id)).map((note) => this.noteView(note, row));
  }

  /** Creates a note. The client's id makes a retry harmless: the same id under
   * the same session answers with the stored note, under another one it is a conflict. */
  createNote(ref: string, input: CliNoteInput): CliNoteView {
    const row = this.resolve(ref);
    const noteId = input.id ?? id();
    const existing = this.store.get("SELECT * FROM cli_agent_notes WHERE id=?", noteId);
    if (existing) {
      if (String(existing.workbench_id) !== String(row.id)) throw new CliOpError("conflict");
      return this.noteView(existing, row);
    }
    const count = Number(this.store.get("SELECT COUNT(*) n FROM cli_agent_notes WHERE workbench_id=?", String(row.id))?.n ?? 0);
    if (count >= MAX_NOTES_PER_SESSION) throw new CliOpError("too_large", "注释太多，先删除一些");
    const at = now();
    this.store.insert("cli_agent_notes", {
      id: noteId, workbench_id: String(row.id), message_id: input.message, num: input.num ?? count + 1,
      sel_start: input.start ?? null, sel_end: input.end ?? null,
      content: this.store.encrypt(JSON.stringify({ quote: input.quote, body: input.body })),
      version: 1, created_at: at, updated_at: at,
    });
    return this.noteView(this.noteRow(noteId), row);
  }

  /** Changes the text of a note; a stale version is a conflict. */
  updateNote(noteId: string, expectedVersion: number, body: string): CliNoteView {
    const current = this.noteRow(noteId);
    const content = this.noteContent(current);
    const changes = Number(this.store.run(
      "UPDATE cli_agent_notes SET content=?,version=version+1,updated_at=? WHERE id=? AND version=?",
      this.store.encrypt(JSON.stringify({ quote: content.quote, body })), now(), noteId, expectedVersion,
    ).changes);
    if (!changes) throw new CliOpError("conflict");
    return this.noteView(this.noteRow(noteId), this.rowOf(String(current.workbench_id)));
  }

  deleteNote(noteId: string, expectedVersion: number): void {
    this.noteRow(noteId);
    const changes = Number(this.store.run("DELETE FROM cli_agent_notes WHERE id=? AND version=?", noteId, expectedVersion).changes);
    if (!changes) throw new CliOpError("conflict");
  }

  private noteRow(noteId: string): Row {
    const row = this.store.get("SELECT * FROM cli_agent_notes WHERE id=?", noteId);
    if (!row) throw new CliOpError("not_found");
    return row;
  }

  private noteContent(row: Row): { quote: string; body: string } {
    try {
      const value = JSON.parse(this.store.decrypt(String(row.content))) as { quote?: string; body?: string };
      return { quote: typeof value.quote === "string" ? value.quote : "", body: typeof value.body === "string" ? value.body : "" };
    } catch {
      return { quote: "", body: "" };
    }
  }

  private noteView(row: Row, workbench: Row | undefined): CliNoteView {
    const { quote, body } = this.noteContent(row);
    return {
      id: String(row.id),
      sessionKey: workbench?.session_key == null ? null : (String(workbench.session_key) as CliSessionKey),
      message: String(row.message_id),
      num: Number(row.num),
      start: row.sel_start === null ? null : Number(row.sel_start),
      end: row.sel_end === null ? null : Number(row.sel_end),
      quote,
      body,
      version: Number(row.version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // -------------------------------------------------------------------------
  // Submitting: send, queue, steer, edit-and-resend

  async submit(actor: string, key: string, input: WorkbenchSubmitInput): Promise<WorkbenchSubmitResult> {
    const row = this.ensureSession(key);
    const workbenchId = String(row.id);
    const shape = fingerprintOf({ key, delivery: input.delivery, text: input.text, ...(input.revisesMessageId ? { revisesMessageId: input.revisesMessageId } : {}) });
    const request = this.store.get("SELECT * FROM cli_agent_send_requests WHERE request_id=?", input.requestId);
    if (request) {
      if (String(request.fingerprint) !== shape) throw new CliOpError("conflict");
      const entry = this.entryRow(String(request.outbox_id));
      return this.submitResult(entry, null);
    }
    const duplicate = this.store.get(
      "SELECT * FROM cli_agent_outbox WHERE workbench_id=? AND client_message_id=? AND status!='withdrawn'",
      workbenchId, input.clientMessageId,
    );
    if (duplicate) return this.submitResult(duplicate, null);
    const pendingCount = Number(this.store.get(
      "SELECT COUNT(*) n FROM cli_agent_outbox WHERE workbench_id=? AND status='pending'", workbenchId,
    )?.n ?? 0);
    if (pendingCount >= CLI_LIMITS.requestsPerSession) throw new CliOpError("busy", "排队条目太多，先处理再发");
    const session = this.hub.session(key);
    if (!session) throw new CliOpError("not_found");
    const queueState = this.queueState(workbenchId);
    const outside = OUTSIDE_VIA.has(session.sendVia ?? "");
    if (input.delivery === "steer") {
      if (queueState.paused && queueState.pauseReason === "stopped") throw new CliOpError("busy", "停止受理中，引导已拒绝");
      if (session.liveIn !== "nexbot" || !session.terminal) throw new CliOpError("turn_changed");
      if (session.state !== "running" && session.state !== "waiting") throw new CliOpError("turn_changed");
    }
    if (input.delivery === "send" && !outside) {
      if (session.state === "stopped") throw new CliOpError("stopped");
      if (session.state === "running" || session.state === "waiting") throw new CliOpError("busy", "当前轮次还在运行");
    }
    // The entry is recorded before anything leaves Core, so a crash between the
    // two leaves a pending row instead of a message nobody can account for.
    const entryId = this.store.transaction(() => {
      this.images?.publish(input.text, session.deviceId);
      return this.insertEntry(workbenchId, key, input, { status: "pending" });
    });
    if (input.delivery === "queue") {
      this.pump(workbenchId);
      return this.submitResult(this.entryRow(entryId), null);
    }
    const op = input.delivery === "steer" ? ("steer" as const) : ("send" as const);
    if (input.delivery === "steer" || !outside) {
      const claimed = Number(this.store.run(
        "UPDATE cli_agent_outbox SET status='claimed',version=version+1,updated_at=? WHERE id=? AND status='pending'",
        now(), entryId,
      ).changes);
      if (!claimed) return this.submitResult(this.entryRow(entryId), null);
    }
    const outcome: DispatchOutcome = {};
    const failure = await this.dispatch(actor, key, session.deviceId, op, entryId, outcome);
    if (!failure) return { ...this.submitResult(this.entryRow(entryId), this.entryOpId(entryId)), ...outcome };
    if (failure.code === "unknown") {
      this.store.run("UPDATE cli_agent_outbox SET status='uncertain',op_id=?,version=version+1,updated_at=? WHERE id=?", failure.opId, now(), entryId);
      this.pause(workbenchId, "uncertain");
      this.pushQueue(workbenchId);
    } else if (failure.code === "device_offline" || failure.code === "busy") {
      // nothing left Core: back to pending, the consumer decides when it may go
      this.store.run("UPDATE cli_agent_outbox SET status='pending',version=version+1,updated_at=? WHERE id=?", now(), entryId);
      this.pump(workbenchId);
    } else {
      this.store.run("UPDATE cli_agent_outbox SET status='failed',error_code=?,version=version+1,updated_at=? WHERE id=?", failure.code, now(), entryId);
      this.pause(workbenchId, "failed");
      this.pushQueue(workbenchId);
    }
    return this.submitResult(this.entryRow(entryId), failure.opId);
  }

  private submitResult(entry: Row, operationId: string | null): WorkbenchSubmitResult {
    return {
      messageId: String(entry.id),
      operationId,
      status: String(entry.status) as CliQueueStatus,
      version: Number(entry.version),
      queued: !["sent", "confirmed"].includes(String(entry.status)),
    };
  }

  /** Sends or steers one recorded entry and settles it. Returns null on
   * success, otherwise the failure code (with the op id when the device
   * actually got the command). Sets `lastDispatchStarted` to the device's
   * "this began a turn" answer, which the consumer uses to wait or advance. */
  private async dispatch(actor: string, key: string, deviceId: string, op: "send" | "steer", entryId: string, outcome?: DispatchOutcome): Promise<DispatchFailure | null> {
    const ref = parseCliKey(key)?.ref ?? "";
    try {
      const message = this.entryText(this.entryRow(entryId));
      const text = this.images?.delivery(message, deviceId) ?? message;
      const { result, opId } = await this.hub.opTracked(actor, deviceId, key, op, { ref, text });
      this.lastDispatchStarted = (result as { started?: boolean }).started === true;
      const { delivery, waiting } = result as { delivery?: unknown; waiting?: unknown };
      if (outcome && (delivery === "confirmed" || delivery === "unconfirmed")) outcome.delivery = delivery;
      if (outcome && waiting === true) outcome.waiting = true;
      this.store.run(
        "UPDATE cli_agent_outbox SET status=?,op_id=?,version=version+1,updated_at=? WHERE id=?",
        (result as { delivery?: string }).delivery === "confirmed" ? "confirmed" : "sent", opId, now(), entryId,
      );
      return null;
    } catch (error) {
      if (error instanceof TrackedOpError) return new DispatchFailure(error.opId, error.error.code);
      if (error instanceof CliOpError) return new DispatchFailure(null, error.code);
      return new DispatchFailure(null, "unknown");
    }
  }

  private entryOpId(entryId: string): string | null {
    const row = this.store.get("SELECT op_id FROM cli_agent_outbox WHERE id=?", entryId);
    return row && row.op_id !== null ? String(row.op_id) : null;
  }

  private insertEntry(workbenchId: string, key: string, input: WorkbenchSubmitInput, extra: { status: CliQueueStatus }): string {
    const at = now();
    const entryId = id();
    const seq = Number(this.store.get("SELECT next_seq FROM cli_agent_queue_state WHERE workbench_id=?", workbenchId)?.next_seq ?? 1);
    this.store.transaction(() => {
      this.store.insert("cli_agent_outbox", {
        id: entryId, workbench_id: workbenchId, session_key: key, seq,
        client_message_id: input.clientMessageId, request_id: input.requestId,
        body: this.store.encrypt(JSON.stringify({ text: input.text, ...(input.attachments?.length ? { attachments: input.attachments } : {}) })),
        revises_message_id: input.revisesMessageId ?? null,
        delivery: input.delivery, status: extra.status, error_code: null,
        op_id: null, version: 1, created_at: at, updated_at: at,
      });
      this.store.run(
        `INSERT INTO cli_agent_queue_state(workbench_id,session_key,paused,pause_reason,next_seq,updated_at)
         VALUES(?,?,0,NULL,?,?)
         ON CONFLICT(workbench_id) DO UPDATE SET next_seq=excluded.next_seq,updated_at=excluded.updated_at`,
        workbenchId, key, seq + 1, at,
      );
      this.store.insert("cli_agent_send_requests", {
        request_id: input.requestId,
        fingerprint: fingerprintOf({ key, delivery: input.delivery, text: input.text, ...(input.revisesMessageId ? { revisesMessageId: input.revisesMessageId } : {}) }),
        outbox_id: entryId, created_at: at,
      });
    });
    return entryId;
  }

  private entryRow(entryId: string): Row {
    const row = this.store.get("SELECT * FROM cli_agent_outbox WHERE id=?", entryId);
    if (!row) throw new CliOpError("not_found");
    return row;
  }

  // -------------------------------------------------------------------------
  // Queue commands

  /** Edits a queued entry in place. Only still-pending entries move; anything
   * a consumer claimed answers with a conflict so the caller can decide. */
  editEntry(input: WorkbenchEntryInput, text: string): CliQueueEntryView {
    const row = this.entryRow(input.entryId);
    if (String(row.status) !== "pending") throw new CliOpError("conflict", "条目已投递，可编辑后重发");
    this.store.transaction(() => {
      const changes = Number(this.store.run(
        "UPDATE cli_agent_outbox SET body=?,version=version+1,updated_at=? WHERE id=? AND status='pending' AND version=?",
        this.store.encrypt(JSON.stringify({ text })), now(), input.entryId, input.expectedVersion,
      ).changes);
      if (!changes) throw this.staleEntry(input.entryId);
      const deviceId = parseCliKey(String(row.session_key))?.deviceId;
      if (deviceId) this.images?.publish(text, deviceId);
    });
    this.pushQueue(String(row.workbench_id));
    return this.entryView(this.entryRow(input.entryId));
  }

  /** Withdraws a queued entry; terminal state, the consumer never dispatches it. */
  withdrawEntry(input: WorkbenchEntryInput): CliQueueEntryView {
    const row = this.entryRow(input.entryId);
    if (String(row.status) !== "pending") throw new CliOpError("conflict", "条目已投递，不能撤回");
    const changes = Number(this.store.run(
      "UPDATE cli_agent_outbox SET status='withdrawn',version=version+1,updated_at=? WHERE id=? AND status='pending' AND version=?",
      now(), input.entryId, input.expectedVersion,
    ).changes);
    if (!changes) throw this.staleEntry(input.entryId);
    this.pushQueue(String(row.workbench_id));
    return this.entryView(this.entryRow(input.entryId));
  }

  /** Turns a queued entry into guidance for the running turn. The entry must
   * still be pending and the session running; otherwise the text comes back
   * and the caller chooses queueing or resending. `expectedTurnId` stays part
   * of the contract for a device-side turn check once a harness offers one. */
  async steerEntry(input: WorkbenchEntryInput, expectedTurnId?: string): Promise<CliQueueEntryView> {
    void expectedTurnId;
    const row = this.entryRow(input.entryId);
    if (String(row.status) !== "pending") throw new CliOpError("conflict", "条目已投递");
    const workbenchId = String(row.workbench_id);
    const wb = this.rowOf(workbenchId);
    const key = String(wb?.session_key ?? row.session_key);
    const session = this.hub.session(key);
    if (!session) throw new CliOpError("not_found");
    if (session.liveIn !== "nexbot" || !session.terminal || (session.state !== "running" && session.state !== "waiting")) {
      throw new CliOpError("turn_changed");
    }
    const claimed = Number(this.store.run(
      "UPDATE cli_agent_outbox SET status='claimed',version=version+1,updated_at=? WHERE id=? AND status='pending'",
      now(), input.entryId,
    ).changes);
    if (!claimed) throw this.staleEntry(input.entryId);
    const failure = await this.dispatch("workbench", key, session.deviceId, "steer", input.entryId);
    if (!failure) {
      this.pushQueue(workbenchId);
      return this.entryView(this.entryRow(input.entryId));
    }
    if (failure.code === "unknown") {
      this.store.run("UPDATE cli_agent_outbox SET status='uncertain',op_id=?,version=version+1,updated_at=? WHERE id=?", failure.opId, now(), input.entryId);
      this.pause(workbenchId, "uncertain");
    } else {
      // steering did not happen: put the text back where it was
      this.store.run("UPDATE cli_agent_outbox SET status='pending',version=version+1,updated_at=? WHERE id=?", now(), input.entryId);
    }
    this.pushQueue(workbenchId);
    return this.entryView(this.entryRow(input.entryId));
  }

  /** Stops the running turn: the queue pauses before the interrupt leaves, so
   * no queued message can fire into the turn that follows. */
  async stop(actor: string, key: string): Promise<{ outcome: string }> {
    const row = this.ensureSession(key);
    this.pause(String(row.id), "stopped");
    const result = await this.hub.interrupt(actor, key);
    this.pushQueue(String(row.id));
    return result;
  }

  /** Clears whatever pause holds the queue and tries the head again. */
  resume(actor: string, key: string): void {
    void actor;
    const row = this.resolve(key);
    const workbenchId = String(row.id);
    this.store.run("UPDATE cli_agent_queue_state SET paused=0,pause_reason=NULL,updated_at=? WHERE workbench_id=?", now(), workbenchId);
    this.awaitingTurnEnd.delete(workbenchId);
    this.reconcileUncertain(workbenchId);
    this.pushQueue(workbenchId);
    this.pump(workbenchId);
  }

  queueForSessionKey(key: string): CliQueueView | null {
    const row = this.store.get("SELECT id FROM cli_agent_workbench WHERE session_key=? AND deleted_at IS NULL", key);
    return row ? this.queueForWorkbench(String(row.id)) : null;
  }

  queueForWorkbench(workbenchId: string): CliQueueView {
    const wb = this.rowOf(workbenchId);
    if (!wb) throw new CliOpError("not_found");
    const key = String(wb.session_key ?? "");
    const state = this.queueState(workbenchId);
    const entries = this.store.all(
      `SELECT * FROM cli_agent_outbox WHERE workbench_id=? AND status IN (${LIVE_STATUSES.map(() => "?").join(",")}) ORDER BY seq`,
      workbenchId, ...LIVE_STATUSES,
    ).map((row) => this.entryView(row));
    return {
      workbenchId,
      sessionKey: key as CliSessionKey,
      paused: state.paused,
      ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
      entries,
    };
  }

  /** Every live queue, for a client that just loaded the page. */
  queues(): CliQueueView[] {
    return this.store.all("SELECT id FROM cli_agent_workbench WHERE deleted_at IS NULL").flatMap((row) => {
      const view = this.queueForWorkbench(String(row.id));
      return view.entries.length || view.paused ? [view] : [];
    });
  }

  private queueState(workbenchId: string): { paused: boolean; pauseReason?: string } {
    const row = this.store.get("SELECT paused,pause_reason FROM cli_agent_queue_state WHERE workbench_id=?", workbenchId);
    if (!row) return { paused: false };
    return { paused: row.paused === 1, ...(row.pause_reason !== null ? { pauseReason: String(row.pause_reason) } : {}) };
  }

  private pause(workbenchId: string, reason: "stopped" | "uncertain" | "failed" | "device_offline" | "not_found") {
    const wb = this.rowOf(workbenchId);
    const key = !wb || wb.session_key === null ? "" : String(wb.session_key);
    this.store.run(
      `INSERT INTO cli_agent_queue_state(workbench_id,session_key,paused,pause_reason,next_seq,updated_at)
       VALUES(?,?,1,?,1,?)
       ON CONFLICT(workbench_id) DO UPDATE SET paused=1,pause_reason=excluded.pause_reason,updated_at=excluded.updated_at`,
      workbenchId, key, reason, now(),
    );
  }

  private staleEntry(entryId: string): CliOpError {
    const row = this.store.get("SELECT status FROM cli_agent_outbox WHERE id=?", entryId);
    return row ? new CliOpError("conflict") : new CliOpError("not_found");
  }

  private headEntry(workbenchId: string): Row | undefined {
    return this.store.get("SELECT * FROM cli_agent_outbox WHERE workbench_id=? AND status='pending' ORDER BY seq LIMIT 1", workbenchId);
  }

  private entryText(row: Row): string {
    try {
      const body = JSON.parse(this.store.decrypt(String(row.body))) as { text?: string };
      return typeof body.text === "string" ? body.text : "";
    } catch {
      return "";
    }
  }

  private entryView(row: Row): CliQueueEntryView {
    const view: CliQueueEntryView = {
      id: String(row.id),
      seq: Number(row.seq),
      text: this.entryText(row),
      status: String(row.status) as CliQueueStatus,
      version: Number(row.version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
    if (row.revises_message_id !== null) view.revisesMessageId = String(row.revises_message_id);
    if (row.error_code !== null) view.errorCode = String(row.error_code) as CliErrorCode;
    return view;
  }

  private pushQueue(workbenchId: string) {
    const wb = this.rowOf(workbenchId);
    if (!wb || wb.session_key === null) return;
    this.hub.notifyQueue(this.queueForWorkbench(workbenchId));
  }

  // -------------------------------------------------------------------------
  // The consumer

  pump(workbenchId: string): void {
    if (this.pumping.has(workbenchId)) {
      this.repump.add(workbenchId);
      return;
    }
    this.pumping.add(workbenchId);
    void (async () => {
      try {
        do {
          this.repump.delete(workbenchId);
          await this.pumpOnce(workbenchId);
        } while (this.repump.has(workbenchId));
      } catch {
        // a bug here must not break the queue for everyone else
      } finally {
        this.pumping.delete(workbenchId);
      }
    })();
  }

  /** One dispatch attempt for the head of one queue. Everything that may take
   * time runs after the entry was atomically claimed, so a second consumer or
   * a second client cannot double-send. */
  private async pumpOnce(workbenchId: string): Promise<void> {
    const wb = this.rowOf(workbenchId);
    if (!wb || wb.session_key === null) return;
    if (this.queueState(workbenchId).paused) return;
    // the previous dispatch opened a turn nobody has ended yet: even an idle
    // session row in between does not release the next entry
    if (this.awaitingTurnEnd.has(workbenchId)) return;
    const head = this.headEntry(workbenchId);
    if (!head) return;
    const key = String(wb.session_key);
    const session = this.hub.session(key);
    if (!session) {
      this.pause(workbenchId, "not_found");
      this.pushQueue(workbenchId);
      return;
    }
    if (!session.online) {
      this.pause(workbenchId, "device_offline");
      this.pushQueue(workbenchId);
      return;
    }
    if (session.state === "stopped") {
      this.pause(workbenchId, "stopped");
      this.pushQueue(workbenchId);
      return;
    }
    if (session.state === "running" || session.state === "waiting" || this.hub.busy(key)) return;
    const claimed = Number(this.store.run(
      "UPDATE cli_agent_outbox SET status='claimed',version=version+1,updated_at=? WHERE id=? AND status='pending'",
      now(), head.id,
    ).changes);
    if (!claimed) return;
    const failure = await this.dispatch("workbench", key, session.deviceId, "send", String(head.id));
    if (!failure) {
      this.pushQueue(workbenchId);
      // the dispatch started a turn: the next entry waits for its end; a
      // delivery that started no turn (inbox append, daemon) advances at once
      if (this.lastDispatchStarted) this.awaitingTurnEnd.add(workbenchId);
      else this.pump(workbenchId);
      return;
    }
    if (failure.code === "unknown") {
      this.store.run("UPDATE cli_agent_outbox SET status='uncertain',op_id=?,version=version+1,updated_at=? WHERE id=?", failure.opId, now(), head.id);
      this.pause(workbenchId, "uncertain");
    } else if (failure.code === "device_offline" || failure.code === "busy") {
      // nothing left Core: the entry goes back to pending and waits
      this.store.run("UPDATE cli_agent_outbox SET status='pending',version=version+1,updated_at=? WHERE id=?", now(), head.id);
    } else {
      this.store.run("UPDATE cli_agent_outbox SET status='failed',error_code=?,version=version+1,updated_at=? WHERE id=?", failure.code, now(), head.id);
      this.pause(workbenchId, "failed");
    }
    this.pushQueue(workbenchId);
  }

  /** A turn ended on the device: the next queued message may go. */
  private onTurnEnd(event: CliTurnEvent) {
    const row = this.store.get("SELECT id FROM cli_agent_workbench WHERE session_key=? AND deleted_at IS NULL", event.key);
    if (!row) return;
    this.awaitingTurnEnd.delete(String(row.id));
    this.pump(String(row.id));
  }

  /** A device came back: uncertain outcomes reconcile against the op rows the
   * device answered late, device_offline pauses retry. */
  private onDeviceOnline(deviceId: string) {
    for (const row of this.store.all("SELECT id FROM cli_agent_workbench WHERE device_id=? AND deleted_at IS NULL", deviceId)) {
      const workbenchId = String(row.id);
      // a restart lost the turn the last dispatch opened: reconnect ends the wait
      this.awaitingTurnEnd.delete(workbenchId);
      this.reconcileUncertain(workbenchId);
      const state = this.queueState(workbenchId);
      if (state.paused && state.pauseReason === "device_offline") {
        this.store.run("UPDATE cli_agent_queue_state SET paused=0,pause_reason=NULL,updated_at=? WHERE workbench_id=?", now(), workbenchId);
      }
      this.pump(workbenchId);
    }
  }

  /** An uncertain entry whose op row settled while nobody watched moves to its
   * real outcome; nobody is ever re-sent here. */
  private reconcileUncertain(workbenchId: string) {
    for (const row of this.store.all("SELECT * FROM cli_agent_outbox WHERE workbench_id=? AND status='uncertain' AND op_id IS NOT NULL", workbenchId)) {
      const op = this.store.get("SELECT status,error_code FROM cli_agent_ops WHERE id=?", String(row.op_id));
      if (!op || String(op.status) === "sent") continue;
      const settled = op.status === "succeeded" ? "sent" : "failed";
      this.store.run(
        "UPDATE cli_agent_outbox SET status=?,error_code=?,version=version+1,updated_at=? WHERE id=? AND status='uncertain'",
        settled, settled === "failed" ? (op.error_code ?? "unknown") : null, now(), row.id,
      );
      if (settled === "failed") this.pause(workbenchId, "failed");
    }
  }

  /** Harnesses without turn events still end turns: their session row flips to
   * idle, which is a list delta. */
  private onListDelta(delta: { upserts: { key: string; state: string }[] }) {
    for (const upsert of delta.upserts) {
      if (upsert.state !== "idle") continue;
      const row = this.store.get("SELECT id FROM cli_agent_workbench WHERE session_key=? AND deleted_at IS NULL", upsert.key);
      if (row) this.pump(String(row.id));
    }
  }
}
