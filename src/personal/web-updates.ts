import type { ClientUpdateState } from "./api";

const CHECK_INTERVAL = 5 * 60_000;
const listeners = new Set<(state: ClientUpdateState) => void>();
let state: ClientUpdateState | undefined;
let pending: Promise<ClientUpdateState> | undefined;

function readBuild(doc: Document) {
  const version = doc.querySelector<HTMLMetaElement>('meta[name="nexbot-web-version"]')?.content ?? "";
  const revision = doc.querySelector<HTMLMetaElement>('meta[name="nexbot-web-revision"]')?.content ?? "";
  return /^\d+\.\d+\.\d+$/.test(version) && /^[a-f0-9]{16}$/.test(revision) ? { version, revision } : undefined;
}

function publish(next: ClientUpdateState): ClientUpdateState {
  state = next;
  for (const listener of listeners) listener(next);
  return next;
}

async function check(): Promise<ClientUpdateState> {
  const current = readBuild(document);
  if (!current) return publish({ status: "error", error: "无法读取网页版本" });
  publish({ status: "checking", current: current.version });
  try {
    const response = await fetch("/", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error("无法获取网页版本");
    const latest = readBuild(new DOMParser().parseFromString(await response.text(), "text/html"));
    if (!latest) throw new Error("网页版本信息无效");
    return publish(latest.revision === current.revision
      ? { status: "current", current: current.version }
      : { status: "ready", current: current.version, version: latest.version });
  } catch (error) {
    return publish({ status: "error", current: current.version, error: error instanceof Error ? error.message : "无法获取网页版本" });
  }
}

export const webUpdates = {
  async updateState(): Promise<ClientUpdateState> { return state ?? { status: "idle", current: readBuild(document)?.version }; },
  checkUpdate(): Promise<ClientUpdateState> {
    pending ??= check().finally(() => { pending = undefined; });
    return pending;
  },
  onUpdateState(listener: (state: ClientUpdateState) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  async installUpdate() { window.location.reload(); },
};

export function startWebUpdateChecks(): () => void {
  if (!readBuild(document)) return () => {};
  const refresh = () => { if (document.visibilityState === "visible") void webUpdates.checkUpdate(); };
  const timer = window.setInterval(refresh, CHECK_INTERVAL);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("online", refresh);
  refresh();
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", refresh);
    window.removeEventListener("online", refresh);
  };
}
