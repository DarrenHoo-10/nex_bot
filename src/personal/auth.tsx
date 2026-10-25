import { BrandMark } from "./components/BrandMark";
import { LogOut } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, desktop } from "./api";
import { HomePage, registerUrl } from "./HomePage";

interface IdentityStatus {
  authenticated: boolean; initialized: boolean; canInitialize: boolean; coreId: string;
  sessionId?: string; expiresAt?: number; account?: { displayName: string; protocol?: string; deviceName?: string };
}
interface LoginTransaction { transactionId: string; bindingToken: string; stepId: string }
export interface LoginSession { token: string; coreId: string; sessionId: string; expiresAt: number }
const Account = createContext<{ status?: IdentityStatus; logout(): Promise<void> }>({ logout: async () => {} });
export function useAccount() { return useContext(Account); }

function LogoutConfirmation({ close, confirm }: { close(): void; confirm(): Promise<void> }) {
  const modal = useRef<HTMLDialogElement>(null), title = useId(), detail = useId();
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  useEffect(() => { const dialog = modal.current!; dialog.dataset.dark = document.querySelector('.rk-workspace')?.getAttribute('data-dark') ?? "0"; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={modal} className="account-logout-modal" aria-labelledby={title} aria-describedby={detail} onCancel={(event) => { event.preventDefault(); if (!pending) close(); }}>
    <span className="logout-symbol"><LogOut size={23}/></span><h2 id={title}>退出当前账号？</h2><p id={detail}>退出后需要重新登录。你的聊天和助手会保留。</p>
    {error && <p className="login-error" role="alert">{error}</p>}
    <div className="logout-actions"><button autoFocus disabled={pending} onClick={close}>取消</button><button className="primary" disabled={pending} onClick={() => { setPending(true); setError(""); void confirm().catch(() => { setError("退出未完成，请重试"); setPending(false); }); }}>{pending ? "正在退出…" : "退出登录"}</button></div>
  </dialog>;
}

export function AccountControls() {
  const { status, logout } = useContext(Account);
  const [error, setError] = useState("");
  const name = status?.account?.displayName || "NexorAI 用户";
  const expiresLabel = status?.expiresAt ? new Date(status.expiresAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return <section className="preferences-section preferences-account">
    <div className="ds-account-row">
      <span className="account-avatar" aria-hidden="true">{Array.from(name.trim())[0] || "?"}</span>
      <div className="ds-account-meta">
        <strong className="ds-account-name">{name}</strong>
      </div>
      <div className="ds-account-actions">
        <button onClick={() => void logout().catch(() => setError("退出未完成，请重试"))}>退出登录</button>
      </div>
    </div>
    <dl className="preferences-facts">{expiresLabel && <div><dt>本次登录有效期</dt><dd>{expiresLabel}</dd></div>}</dl>
    {error ? <p role="alert" className="login-error">{error}</p> : null}
  </section>;
}

export function LoginGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<IdentityStatus>(), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const generation = useRef(0);
  const loggingOut = useRef(false);
  const returningToLogin = useRef(false);
  const refresh = useCallback(async () => {
    if (loggingOut.current || returningToLogin.current) return;
    const current = ++generation.current;
    try {
      const result = await api<IdentityStatus>("auth/status");
      if (current !== generation.current || loggingOut.current) return;
      if (!result.authenticated && desktop?.forgetLogin) {
        returningToLogin.current = true; setStatus(undefined); setLoading(true);
        try { await desktop.forgetLogin(); } catch { returningToLogin.current = false; setError("无法返回登录页，请重启应用"); }
        return;
      }
      setStatus(result);
    }
    catch (e) { if (current === generation.current) { setStatus(undefined); setError(e instanceof Error ? e.message : "无法验证登录，请重试"); } }
    finally { if (current === generation.current && !returningToLogin.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => { if (loggingOut.current || returningToLogin.current) return; setStatus(undefined); setLoading(true); setError("登录已失效，请重新登录"); void refresh(); };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("nex-session-expired", expired); document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { ++generation.current; clearInterval(timer); window.removeEventListener("nex-session-expired", expired); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  async function logout() {
    // Local access is revoked first by Core, even if upstream logout is down.
    loggingOut.current = true;
    try {
      ++generation.current;
      await desktop?.stopDevice?.();
      await api("auth/logout", {});
      if (desktop?.forgetLogin) { await desktop.forgetLogin(); return; }
      setConfirmLogout(false); setStatus(undefined); setError("");
      loggingOut.current = false; await refresh();
    }
    finally { loggingOut.current = false; }
  }
  if (status?.authenticated) return <Account.Provider value={{ status, logout: async () => { setConfirmLogout(true); } }}>{children}{confirmLogout && <LogoutConfirmation close={() => setConfirmLogout(false)} confirm={logout}/>}</Account.Provider>;
  const card = <section className="login-card"><BrandMark size={56}/><h1>登录 NexBot</h1>{loading ? <p role="status">正在检查登录状态…</p> : !status?.initialized && !status?.canInitialize ? <><p>暂时无法登录，请稍后重试。</p><button onClick={() => void refresh()}>重新检查</button></> : <form className="login-form" onSubmit={(event) => {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form); setBusy(true); setError("");
    void (async () => {
      try {
        const transaction = await api<LoginTransaction>("auth/start", { account: data.get("email"), name: desktop?.mode === "client" ? "NexBot Client" : "主设备" });
        const session = await api<LoginSession>("auth/respond", { ...transaction, password: data.get("password") });
        form.reset();
        await desktop?.rememberLogin?.(session); await refresh();
      } catch (e) { setError(e instanceof Error ? e.message : "登录失败，请重试"); const password = form.elements.namedItem("password") as HTMLInputElement; password.value = ""; }
      finally { setBusy(false); }
    })();
  }}><label className="field">邮箱<input name="email" type="email" required maxLength={254} autoComplete="username" disabled={busy} placeholder="输入你的邮箱"/></label><label className="field">密码<input name="password" type="password" required maxLength={4096} autoComplete="current-password" disabled={busy} placeholder="输入密码"/></label><button className="primary" disabled={busy}>{busy ? "正在登录…" : "登录"}</button></form>}{error ? <p className="login-error" role="alert">{error}</p> : null}<div className="login-signup">没有账号？<a href={registerUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => { if (desktop?.openExternal) { event.preventDefault(); void desktop.openExternal(event.currentTarget.href).catch(() => setError("无法打开注册页，请稍后重试")); } }}>去注册</a></div></section>;
  // Browsers get the public homepage; desktop and Android shells keep the bare login screen.
  if (!desktop) return loading && !status ? <main className="home-splash" aria-busy="true"><BrandMark size={48}/></main> : <HomePage login={card}/>;
  return <main className="login-screen">{card}</main>;
}
