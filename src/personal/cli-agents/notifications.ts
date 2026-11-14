// "等你处理" notifications. Permission is asked for only when the user turns
// the bell on; a notification is shown only while the page is hidden.
import type { CliSessionKey, CliSessionState, CliSessionView } from "../../../shared/cli-agents";
import { sessionTitle } from "./session-model";

const STORE_KEY = "nexbot.cliNotify";

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

/** The user turned the bell on and the browser still allows it. */
export function notificationsEnabled(): boolean {
  if (!notificationsSupported() || Notification.permission !== "granted") return false;
  try { return localStorage.getItem(STORE_KEY) === "1"; } catch { return false; }
}

/** Call from a click only: this is what asks the browser for permission. */
export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  const granted = permission === "granted";
  try { localStorage.setItem(STORE_KEY, granted ? "1" : "0"); } catch { /* storage unavailable */ }
  return granted;
}

export function disableNotifications(): void {
  try { localStorage.setItem(STORE_KEY, "0"); } catch { /* storage unavailable */ }
}

export function sessionStates(sessions: readonly CliSessionView[]): Map<string, CliSessionState> {
  return new Map(sessions.map((session) => [session.key, session.state]));
}

/** Sessions that are waiting now and were not before. Nothing on the first
 * list (`previous` null): they were already waiting when the page opened. */
export function newlyWaiting(previous: ReadonlyMap<string, CliSessionState> | null, sessions: readonly CliSessionView[]): CliSessionView[] {
  if (!previous) return [];
  return sessions.filter((session) => session.online && !session.hidden && session.state === "waiting" && previous.get(session.key) !== "waiting");
}

/** Shows one notification when the page is not in front. Returns whether it did. */
export function notifyWaiting(session: CliSessionView, open: (key: CliSessionKey) => void): boolean {
  if (!notificationsEnabled() || !document.hidden) return false;
  const note = new Notification(sessionTitle(session), { body: "等你处理", tag: session.key });
  note.onclick = () => {
    window.focus();
    open(session.key);
    note.close();
  };
  return true;
}
