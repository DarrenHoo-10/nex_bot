// Pending permission and question requests of Agent sessions (design section
// 8), kept as plain data: what Core sent, what this page did with it, and how a
// card reads at a given moment. No React, no network.
import type { CliRequestQuestion, CliRequestResolvedBy, CliRequestView, CliSessionKey } from "../../../shared/cli-agents";

/** Core closes a request at its own expiry; a card only reads "expired" a little after, so clock skew does not lock a live one. */
export const EXPIRY_GRACE_MS = 5000;
/** Closed cards kept per session, newest last. */
export const CLOSED_KEEP = 10;
/** How long a card stays above the box after it closed, so the answer is seen; then it leaves. */
export const CLOSED_SHOW_MS = 4000;

export interface RequestRecord {
  view: CliRequestView;
  closed: boolean;
  /** what this page answered, when it was this page */
  decision?: "allow" | "deny";
  /** allowed for the rest of the session */
  always?: boolean;
  by?: CliRequestResolvedBy;
  /** when this page saw it close */
  closedAt?: number;
}

export type RequestStore = ReadonlyMap<CliSessionKey, readonly RequestRecord[]>;

export const EMPTY_STORE: RequestStore = new Map();

function trim(records: RequestRecord[]): RequestRecord[] {
  const closed = records.filter((record) => record.closed);
  if (closed.length <= CLOSED_KEEP) return records;
  const drop = new Set(closed.slice(0, closed.length - CLOSED_KEEP));
  return records.filter((record) => !drop.has(record));
}

function put(store: RequestStore, key: CliSessionKey, records: RequestRecord[]): RequestStore {
  const next = new Map(store);
  if (records.length) next.set(key, trim(records));
  else next.delete(key);
  return next;
}

/** `requests` for one session is its whole pending list: it replaces the open
 * cards. A card that is no longer listed was closed without a word, so it goes.
 * A card this page already closed stays closed. */
export function setPending(store: RequestStore, key: CliSessionKey, views: readonly CliRequestView[]): RequestStore {
  const current = store.get(key) ?? [];
  const closed = current.filter((record) => record.closed);
  const seen = new Set(closed.map((record) => record.view.id));
  const open = views.filter((view) => !seen.has(view.id) && view.key === key).map((view) => ({ view, closed: false }) as RequestRecord);
  return put(store, key, [...closed, ...open]);
}

/** Adds the pending requests of an HTTP answer. Never removes: a push may
 * have arrived while the answer was on its way. */
export function mergePending(store: RequestStore, views: readonly CliRequestView[]): RequestStore {
  let next = store;
  for (const view of views) {
    const current = next.get(view.key) ?? [];
    if (current.some((record) => record.view.id === view.id)) continue;
    next = put(next, view.key, [...current, { view, closed: false }]);
  }
  return next;
}

/** A fresh list subscription follows with the pending cards of every session
 * that has any, so what was open before is stale. */
export function dropOpen(store: RequestStore): RequestStore {
  const next = new Map<CliSessionKey, readonly RequestRecord[]>();
  for (const [key, records] of store) {
    const closed = records.filter((record) => record.closed);
    if (closed.length) next.set(key, closed);
  }
  return next;
}

function close(store: RequestStore, key: CliSessionKey, id: string, patch: Pick<RequestRecord, "by" | "decision" | "always">): RequestStore {
  const current = store.get(key);
  const record = current?.find((entry) => entry.view.id === id && !entry.closed);
  if (!current || !record) return store;
  const rest = current.filter((entry) => entry !== record);
  return put(store, key, [...rest, { ...record, closed: true, closedAt: Date.now(), ...patch }]);
}

export function resolveRequest(store: RequestStore, key: CliSessionKey, id: string, by: CliRequestResolvedBy): RequestStore {
  const record = store.get(key)?.find((entry) => entry.view.id === id);
  // an answer from this page already said who closed it and with what
  if (record?.closed) return store;
  return close(store, key, id, { by });
}

export function markAnswered(store: RequestStore, key: CliSessionKey, id: string, decision: "allow" | "deny", always?: boolean): RequestStore {
  return close(store, key, id, { by: "nexbot", decision, ...(always && decision === "allow" ? { always: true } : {}) });
}

export type CardState = "pending" | "allowed" | "always" | "denied" | "answered" | "terminal" | "gone" | "expired";

export function cardState(record: RequestRecord, now: number): CardState {
  if (!record.closed) return now > record.view.expiresAt + EXPIRY_GRACE_MS ? "expired" : "pending";
  switch (record.by) {
    case "terminal": return "terminal";
    case "gone": return "gone";
    case "timeout": return "expired";
    default:
      if (record.decision === "deny") return "denied";
      if (record.decision === "allow") return record.view.kind === "question" ? "answered" : record.always ? "always" : "allowed";
      return "answered";
  }
}

export const CARD_STATE_TEXT: Record<CardState, string> = {
  pending: "等你处理",
  allowed: "已允许",
  always: "本会话已允许",
  denied: "已拒绝",
  answered: "已处理",
  terminal: "已在终端处理",
  gone: "会话已结束",
  expired: "已过期",
};

/** The cards shown above the box: open ones, and closed ones for CLOSED_SHOW_MS after they closed. Open cards first. */
export function shownCards(records: readonly RequestRecord[], now: number): RequestRecord[] {
  return records.filter((record) => !record.closed || now < (record.closedAt ?? 0) + CLOSED_SHOW_MS)
    .sort((a, b) => Number(a.closed) - Number(b.closed));
}

export function pendingOf(store: RequestStore, key: CliSessionKey, now: number): RequestRecord[] {
  return (store.get(key) ?? []).filter((record) => cardState(record, now) === "pending");
}

/** Pending requests per session, for the list's badges. */
export function pendingCounts(store: RequestStore, now: number): Map<CliSessionKey, number> {
  const counts = new Map<CliSessionKey, number>();
  for (const [key, records] of store) {
    const count = records.filter((record) => cardState(record, now) === "pending").length;
    if (count) counts.set(key, count);
  }
  return counts;
}

export function pendingViews(store: RequestStore, now: number): CliRequestView[] {
  const views: CliRequestView[] = [];
  for (const records of store.values()) for (const record of records) if (cardState(record, now) === "pending") views.push(record.view);
  return views;
}

/** The next time a card changes after `now` (an open card flips to expired, a closed one leaves), or null when none will. */
export function nextExpiry(store: RequestStore, now: number): number | null {
  let next: number | null = null;
  for (const records of store.values()) {
    for (const record of records) {
      const at = record.closed ? (record.closedAt ?? 0) + CLOSED_SHOW_MS + 1 : record.view.expiresAt + EXPIRY_GRACE_MS + 1;
      if (at <= now) continue;
      if (next === null || at < next) next = at;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Questions

/** Sentinel stored in Selection when the user picks the inline "其他" custom input. */
export const OTHER_CHOICE = "__other__";

/** Chosen labels per question index. */
export type Selection = Readonly<Record<number, readonly string[]>>;
/** Custom free-text answers per question index for the "其他" choice. */
export type OtherAnswers = Readonly<Record<number, string>>;

export function toggleChoice(selection: Selection, index: number, label: string, multi: boolean): Selection {
  const chosen = selection[index] ?? [];
  if (!multi) return { ...selection, [index]: [label] };
  return { ...selection, [index]: chosen.includes(label) ? chosen.filter((entry) => entry !== label) : [...chosen, label] };
}

export function answersComplete(
  questions: readonly CliRequestQuestion[] | undefined,
  selection: Selection,
  other: OtherAnswers = {},
): boolean {
  if (!questions?.length) return false;
  return questions.every((_, index) => {
    const chosen = selection[index] ?? [];
    if (!chosen.length) return false;
    const hasPreset = chosen.some((entry) => entry !== OTHER_CHOICE);
    const hasOther = chosen.includes(OTHER_CHOICE);
    const otherText = (other[index] ?? "").trim();
    if (hasOther && !otherText) return hasPreset;
    return hasPreset || (hasOther && otherText.length > 0);
  });
}

/** The `answers` Core takes: the question text to the chosen label, several labels joined by ", ". */
export function answersFor(
  questions: readonly CliRequestQuestion[],
  selection: Selection,
  other: OtherAnswers = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  questions.forEach((question, index) => {
    const chosen = selection[index] ?? [];
    const labels = question.options.map((option) => option.label).filter((label) => chosen.includes(label));
    if (chosen.includes(OTHER_CHOICE)) {
      const custom = (other[index] ?? "").trim();
      if (custom) labels.push(custom);
    }
    out[question.question] = labels.join(", ");
  });
  return out;
}
