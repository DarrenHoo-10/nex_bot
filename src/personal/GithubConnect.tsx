import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Plus } from "lucide-react";
import type { ConnectorOAuthView } from "../../shared/personal-connectors";
import { api, desktop } from "./api";

interface Flow { id: string; authorizationUrl?: string; userCode?: string; verificationUri?: string; expiresAt: number }
function safeAuthorizationUrl(raw: string) {
  const url = new URL(raw);
  const github = url.protocol === "https:" && url.hostname === "github.com" && !url.port && url.pathname === "/login/oauth/authorize";
  const fixture = window.location.protocol === "http:" && window.location.hostname === "127.0.0.1" && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/login/oauth/authorize";
  if ((!github && !fixture) || url.username || url.password || url.hash) throw new Error("GitHub 授权地址无效");
  return url.href;
}
function safeDeviceUrl(raw: string) {
  const url = new URL(raw);
  const github = url.protocol === "https:" && url.hostname === "github.com" && !url.port && url.pathname === "/login/device";
  const fixture = window.location.protocol === "http:" && window.location.hostname === "127.0.0.1" && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/login/device";
  if ((!github && !fixture) || url.username || url.password || url.hash) throw new Error("GitHub 设备页地址无效");
  return url.href;
}

/** GitHub 连接：设备码流（Core 会先跳转到 GitHub 设备页，授权完成后把那个标签页带回来）、
 * OAuth 应用重定向流、以及连接器表单的令牌入口。 */
export function GithubConnect({ connector, available, label = "连接 GitHub", variant = "primary", addAccount = false, connected }: {
  connector?: { id: string; version: number };
  available: boolean;
  label?: string;
  variant?: "primary" | "subtle" | "text";
  addAccount?: boolean;
  connected(id: string): Promise<void>;
}) {
  const [flow, setFlow] = useState<Flow | null>(null), [starting, setStarting] = useState(false), [error, setError] = useState(""), [copied, setCopied] = useState(false);
  const active = useRef<Flow | null>(null), mounted = useRef(false), generation = useRef(0), opening = useRef(false), onConnected = useRef(connected);
  /** 设备码流里替用户打开的 GitHub 设备页标签页：授权完成后把它带回 NexBot。 */
  const deviceTab = useRef<Window | null>(null);
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
          const tab = deviceTab.current;
          if (tab && !tab.closed) { try { tab.location.href = window.location.origin; tab.focus(); } catch { /* 跨域页面无法控制就留给用户 */ } }
          deviceTab.current = null;
          active.current = null; setFlow(null); await onConnected.current(result.connectorId); return;
        }
        if (result.status === "error" || result.status === "cancelled") throw new Error(result.error ?? "连接已取消");
        timer = setTimeout(() => void poll(), result.userCode ? 2000 : 1200);
      } catch (failure) {
        if (stopped) return;
        deviceTab.current = null;
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
    generation.current++; active.current = null; deviceTab.current = null; setFlow(null); setError("");
    if (pending) try { await api("connectors/oauth/cancel", { id: pending.id }); } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "取消失败，请重试"); }
  };
  const copyCode = async () => {
    if (!flow?.userCode) return;
    try { await navigator.clipboard.writeText(flow.userCode); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* 剪贴板不可用时保持代码可见，用户可手动选择 */ }
  };
  const start = async () => {
    if (opening.current) return;
    opening.current = true; const run = ++generation.current;
    setStarting(true); setError(""); setCopied(false);
    // 在点击时预留标签页：设备码流随后把它导航到 GitHub 设备页；OAuth 流导航到授权页。
    let page: Window | null = null, navigated = false;
    if (!desktop?.openExternal) try { page = window.open("", "_blank"); if (page) page.opener = null; } catch { page?.close(); page = null; }
    let created: Flow | undefined;
    try {
      created = await api<Flow>("connectors/oauth/start", { provider: "github", ...connector });
      if (!mounted.current || run !== generation.current) { await api("connectors/oauth/cancel", { id: created.id }).catch(() => {}); return; }
      if (created.userCode) {
        const target = safeDeviceUrl(created.verificationUri!);
        created.verificationUri = target;
        active.current = created; setFlow(created);
        if (desktop?.openExternal) await desktop.openExternal(target);
        else if (page && !page.closed) { page.location.replace(target); deviceTab.current = page; navigated = true; }
      } else {
        created.authorizationUrl = safeAuthorizationUrl(created.authorizationUrl!);
        active.current = created; setFlow(created);
        if (desktop?.openExternal) await desktop.openExternal(created.authorizationUrl);
        else if (page && !page.closed) { page.location.replace(created.authorizationUrl); navigated = true; }
      }
    } catch (failure) {
      if (mounted.current && run === generation.current) setError(failure instanceof Error ? failure.message : "无法打开授权页面，请重试");
      if (created && active.current?.id !== created.id) void api("connectors/oauth/cancel", { id: created.id }).catch(() => {});
      deviceTab.current = null;
    } finally { if (!navigated) page?.close(); opening.current = false; if (mounted.current) setStarting(false); }
  };
  const target = flow?.userCode ? flow.verificationUri! : flow?.authorizationUrl ?? "";
  return <div className={`gmail-connect is-${variant}`}>
    {flow ? <div className="gmail-authorization" role="status">
      {flow.userCode
        ? <span><LoaderCircle size={15} className="spin"/>已在 GitHub 设备页输入代码 <strong>{flow.userCode}</strong> 完成授权<button className="text-button" onClick={() => void copyCode()}>{copied ? "已复制" : "复制"}</button></span>
        : <span><LoaderCircle size={15} className="spin"/>等待 GitHub 授权</span>}
      <div className="actions">
        {target && <a href={target} target="_blank" rel="noopener noreferrer" onClick={desktop?.openExternal ? (event) => { event.preventDefault(); void desktop?.openExternal(target).catch(() => setError("无法打开浏览器，请重试")); } : undefined}>{flow.userCode ? "重新打开设备页" : "继续授权"}<ExternalLink size={13}/></a>}
        <button onClick={() => void cancel()}>取消连接</button>
      </div>
    </div> : <button className={variant === "primary" ? "primary" : undefined} disabled={!available || starting} onClick={() => void start()}>{starting ? <LoaderCircle size={14} className="spin"/> : addAccount ? <Plus size={17}/> : null}{starting ? "准备连接…" : label}</button>}
    {error && <p className="connector-feedback is-error" role="alert">{error}</p>}
  </div>;
}
