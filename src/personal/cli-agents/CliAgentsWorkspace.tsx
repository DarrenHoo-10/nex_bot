// "Agent 会话": the coding-agent sessions of the user's computers, with a live
// terminal and a conversation view. Full page like the todo workspace; the
// sidebar and overlay come from AgentDesktop.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, BellOff, PanelLeftOpen, Plus, SquareTerminal } from "lucide-react";
import type { CliDeviceView, CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { desktop } from "../api";
import { GlowButton } from "../todo/controls";
import { cliErrorText, fetchSnapshot, hideSession } from "./api";
import { NewSessionDialog } from "./NewSessionDialog";
import { disableNotifications, enableNotifications, newlyWaiting, notificationsEnabled, notificationsSupported, notifyWaiting, sessionStates } from "./notifications";
import { groupSessions, hiddenCount } from "./session-model";
import { SessionList } from "./SessionList";
import { SessionPane } from "./SessionPane";
import { CLOSE_UNAUTHORIZED, CliStream, type StreamStatus } from "./stream";
import "./cli-agents.css";

const SELECTED_KEY = "nexbot.cliSelected";

function readSelected(): CliSessionKey | null {
  try { return (localStorage.getItem(SELECTED_KEY) as CliSessionKey | null) || null; } catch { return null; }
}

function writeSelected(key: CliSessionKey | null): void {
  try {
    if (key) localStorage.setItem(SELECTED_KEY, key);
    else localStorage.removeItem(SELECTED_KEY);
  } catch { /* storage unavailable */ }
}

/** The list over HTTP once, then kept current by the stream. */
function useCliList(stream: CliStream) {
  const [devices, setDevices] = useState<CliDeviceView[]>([]);
  const [sessions, setSessions] = useState<CliSessionView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StreamStatus>(stream.status);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setError("");
    try {
      const snapshot = await fetchSnapshot();
      if (generation.current !== mine) return;
      setDevices(snapshot.devices);
      setSessions(snapshot.sessions);
      setLoaded(true);
    } catch (cause) {
      if (generation.current !== mine) return;
      setError(cliErrorText(cause, "读取失败"));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    const release = stream.subscribeList();
    const off = stream.on((event) => {
      if (event.type === "status") {
        setStatus(event.status);
        if (event.status === "closed" && event.code === CLOSE_UNAUTHORIZED) window.dispatchEvent(new Event("nex-session-expired"));
        return;
      }
      if (event.type !== "message") return;
      const message = event.message;
      if (message.type === "list") {
        // a push is newer than any HTTP answer still in flight
        generation.current++;
        setDevices(message.devices);
        setSessions(message.sessions);
        setLoaded(true);
        setError("");
      } else if (message.type === "list.delta") {
        const removed = new Set<string>(message.removes);
        setSessions((current) => {
          const next = new Map(current.filter((session) => !removed.has(session.key)).map((session) => [session.key, session]));
          for (const session of message.upserts) next.set(session.key, session);
          return [...next.values()];
        });
        if (message.devices) setDevices(message.devices);
      }
    });
    return () => {
      generation.current++;
      off();
      release();
    };
  }, [stream, reload]);

  return { devices, sessions, setSessions, loaded, error, setError, status, reload };
}

export interface CliAgentsWorkspaceProps {
  sidebar: ReactNode;
  overlay?: ReactNode;
  dark: boolean;
  collapsed: boolean;
  onNavigation(): void;
  /** tests pass their own stream */
  stream?: CliStream;
}

export function CliAgentsWorkspace({ sidebar, overlay, dark, collapsed, onNavigation, stream: provided }: CliAgentsWorkspaceProps) {
  const stream = useMemo(() => provided ?? new CliStream(), [provided]);
  useEffect(() => {
    stream.start();
    const online = () => stream.reconnectNow();
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("online", online);
      stream.stop();
    };
  }, [stream]);

  const { devices, sessions, setSessions, loaded, error, setError, status, reload } = useCliList(stream);
  const [selectedKey, setSelectedKey] = useState<CliSessionKey | null>(readSelected);
  const [mobileView, setMobileView] = useState<"list" | "pane">("list");
  const [showHidden, setShowHidden] = useState(false);
  const [creating, setCreating] = useState<{ deviceId?: string } | null>(null);
  const [notify, setNotify] = useState(notificationsEnabled);

  const select = useCallback((key: CliSessionKey | null) => {
    setSelectedKey(key);
    writeSelected(key);
    if (key) setMobileView("pane");
  }, []);

  const groups = useMemo(() => groupSessions(devices, sessions, showHidden), [devices, sessions, showHidden]);
  const selected = sessions.find((session) => session.key === selectedKey) ?? null;

  // one notification per session that starts waiting while the page is hidden
  const previous = useRef<Map<string, CliSessionView["state"]> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    for (const session of newlyWaiting(previous.current, sessions)) notifyWaiting(session, select);
    previous.current = sessionStates(sessions);
  }, [loaded, sessions, select]);

  const toggleNotify = async () => {
    if (notify) {
      disableNotifications();
      setNotify(false);
    } else {
      setNotify(await enableNotifications());
    }
  };

  const hide = async (session: CliSessionView, hidden: boolean) => {
    setSessions((current) => current.map((entry) => (entry.key === session.key ? { ...entry, hidden } : entry)));
    try {
      await hideSession(session.key, hidden);
    } catch (cause) {
      setSessions((current) => current.map((entry) => (entry.key === session.key ? { ...entry, hidden: session.hidden } : entry)));
      setError(cliErrorText(cause));
    }
  };

  const connected = status === "open";
  const linkText = status === "connecting" ? "正在连接" : status === "reconnecting" ? "正在重新连接" : status === "closed" ? "连接已断开" : "";
  return (
    <div className="workspace-stage" data-shell={desktop?.mode === "client" ? "1" : "0"} data-dark={dark ? "1" : "0"}>
      <div className="app rk-workspace cli-app" data-dark={dark ? "1" : "0"} data-theme="studio" data-left={collapsed ? "closed" : "open"} data-right="closed" data-page="cli" data-mobile={mobileView}>
        {sidebar}
        <main className="cli-main">
          <header>
            <div className="header-side">
              <button type="button" className="bt-round mobile-menu" aria-label="打开导航" onClick={onNavigation}><PanelLeftOpen size={19} /></button>
            </div>
            <div className="contact-heading who glass">
              <SquareTerminal size={16} />
              <strong>Agent 会话</strong>
              {linkText ? <span className="cli-link-state" role="status">{linkText}</span> : null}
            </div>
            <div className="header-actions">
              {notificationsSupported() ? (
                <button type="button" className="icon-button" aria-label={notify ? "关闭通知" : "开启通知"} aria-pressed={notify} title={notify ? "关闭通知" : "开启通知"} onClick={() => void toggleNotify()}>
                  {notify ? <Bell size={16} /> : <BellOff size={16} />}
                </button>
              ) : null}
              <GlowButton aria-label="新建会话" onClick={() => setCreating({ deviceId: selected?.deviceId })}><Plus size={16} /><span>新建会话</span></GlowButton>
            </div>
          </header>
          {error ? (
            <div role="alert" className="cli-banner">
              {error}
              <button type="button" className="text-button" onClick={() => { setError(""); void reload(); }}>重新加载</button>
            </div>
          ) : null}
          <div className="cli-body">
            <aside className="cli-side glass" aria-busy={!loaded}>
              {!loaded ? <div className="cli-empty" role="status">正在读取…</div> : null}
              {loaded && !groups.length ? <div className="cli-empty">还没有电脑接入</div> : null}
              <SessionList
                groups={groups}
                selectedKey={selectedKey}
                hiddenTotal={hiddenCount(sessions)}
                showHidden={showHidden}
                onSelect={select}
                onNew={(deviceId) => setCreating({ deviceId })}
                onHide={(session, hidden) => void hide(session, hidden)}
                onToggleHidden={() => setShowHidden((value) => !value)}
              />
            </aside>
            <div className="cli-content glass">
              {selected ? (
                <SessionPane key={selected.key} session={selected} stream={stream} connected={connected} onKeyChange={select} onBack={() => setMobileView("list")} />
              ) : (
                <div className="cli-placeholder">选择一个会话</div>
              )}
            </div>
          </div>
        </main>
      </div>
      {creating ? (
        <NewSessionDialog
          devices={devices}
          sessions={sessions}
          initialDeviceId={creating.deviceId}
          onClose={() => setCreating(null)}
          onStarted={(key) => { setCreating(null); select(key); }}
        />
      ) : null}
      {overlay}
    </div>
  );
}
