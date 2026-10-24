import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Plus } from "lucide-react";
import type { ConnectorOAuthView } from "../../shared/personal-connectors";
import { api, desktop } from "./api";

interface Flow { id: string; authorizationUrl: string; expiresAt: number }
function safeAuthorizationUrl(raw: string) {
  const url = new URL(raw);
  const google = url.protocol === "https:" && url.hostname === "accounts.google.com" && !url.port && url.pathname === "/o/oauth2/v2/auth";
  const fixture = window.location.protocol === "http:" && window.location.hostname === "127.0.0.1" && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/authorize";
  if ((!google && !fixture) || url.username || url.password || url.hash) throw new Error("Google 授权地址无效");
  return url.href;
}

export function GmailConnect({ connector, available, label = "连接 Gmail", variant = "primary", addAccount = false, connected }: {
  connector?: { id: string; version: number };
  available: boolean;
  label?: string;
  variant?: "primary" | "subtle" | "text";
  addAccount?: boolean;
  connected(id: string): Promise<void>;
}) {
  const [flow, setFlow] = useState<Flow | null>(null), [starting, setStarting] = useState(false), [error, setError] = useState("");
  const active = useRef<Flow | null>(null), mounted = useRef(false), generation = useRef(0), opening = useRef(false), onConnected = useRef(connected);
  onConnected.current = connected;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; const pending = active.current; active.current = null; if (pending) void api("connectors/oauth/cancel", { id: pending.id }).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!flow) return;
    let stopped = false, polling = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped || polling) return;
      clearTimeout(timer); polling = true;
      try {
        if (Date.now() >= flow.expiresAt) throw new Error("授权已过期，请重新连接");
        const result = await api<ConnectorOAuthView>("connectors/oauth/status?id=" + encodeURIComponent(flow.id));
        if (stopped || active.current?.id !== flow.id) return;
        if (result.id !== flow.id) throw new Error("授权状态无效，请重新连接");
        if (result.status === "connected" && result.connectorId) {
          active.current = null; setFlow(null); await onConnected.current(result.connectorId); return;
        }
        if (result.status === "error" || result.status === "cancelled") throw new Error(result.error ?? "连接已取消");
        timer = setTimeout(() => void poll(), 1200);
      } catch (failure) {
        if (stopped) return;
        active.current = null; setFlow(null); setError(failure instanceof Error ? failure.message : "连接失败，请重试");
        void api("connectors/oauth/cancel", { id: flow.id }).catch(() => {});
      } finally { polling = false; }
    };
    const resume = () => { if (document.visibilityState !== "hidden" && active.current?.id === flow.id) void poll(); };
    window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    timer = setTimeout(() => void poll(), 500);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [flow]);
  const cancel = async () => {
    const pending = active.current;
    generation.current++; active.current = null; setFlow(null); setError("");
    if (pending) try { await api("connectors/oauth/cancel", { id: pending.id }); } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "取消失败，请重试"); }
  };
  const start = async () => {
    if (opening.current) return;
    opening.current = true; const run = ++generation.current;
    setStarting(true); setError("");
    // Reserve a blank during the user's click; preserve a link if popups are blocked.
    let page: Window | null = null, navigated = false;
    if (!desktop?.openExternal) try { page = window.open("", "_blank"); if (page) page.opener = null; } catch { page?.close(); page = null; }
    let created: Flow | undefined;
    try {
      created = await api<Flow>("connectors/oauth/start", { provider: "gmail", ...connector });
      if (!mounted.current || run !== generation.current) { await api("connectors/oauth/cancel", { id: created.id }).catch(() => {}); return; }
      created.authorizationUrl = safeAuthorizationUrl(created.authorizationUrl);
      active.current = created; setFlow(created);
      if (desktop?.openExternal) await desktop.openExternal(created.authorizationUrl);
      else if (page && !page.closed) { page.location.replace(created.authorizationUrl); navigated = true; }
    } catch (failure) {
      if (mounted.current && run === generation.current) setError(failure instanceof Error ? failure.message : "无法打开授权页面，请重试");
      if (created && active.current?.id !== created.id) void api("connectors/oauth/cancel", { id: created.id }).catch(() => {});
    } finally { if (!navigated) page?.close(); opening.current = false; if (mounted.current) setStarting(false); }
  };
  return <div className={`gmail-connect is-${variant}`}>
    {flow ? <div className="gmail-authorization" role="status"><span><LoaderCircle size={15} className="spin"/>等待 Google 授权</span><div className="actions"><a href={flow.authorizationUrl} target="_blank" rel="noopener noreferrer" onClick={desktop?.openExternal ? (event) => { event.preventDefault(); void desktop?.openExternal(flow.authorizationUrl).catch(() => setError("无法打开浏览器，请重试")); } : undefined}>继续授权<ExternalLink size={13}/></a><button onClick={() => void cancel()}>取消连接</button></div></div> : <button className={variant === "primary" ? "primary" : undefined} disabled={!available || starting} onClick={() => void start()}>{starting ? <LoaderCircle size={14} className="spin"/> : addAccount ? <Plus size={17}/> : null}{starting ? "准备连接…" : label}</button>}
    {error && <p className="connector-feedback is-error" role="alert">{error}</p>}
  </div>;
}
