import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, desktop } from "./api";

interface IdentityStatus {
  authenticated: boolean; initialized: boolean; canInitialize: boolean; coreId: string;
  sessionId?: string; expiresAt?: number; account?: { displayName: string };
}
interface LoginTransaction { transactionId: string; bindingToken: string; stepId: string }
export interface LoginSession { token: string; coreId: string; sessionId: string; expiresAt: number }
const Account = createContext<{ status?: IdentityStatus; logout(): Promise<void> }>({ logout: async () => {} });

export function AccountControls() {
  const { status, logout } = useContext(Account);
  const [error, setError] = useState("");
  return <section className="settings-info"><h2>当前账号</h2><p>{status?.account?.displayName}</p><p>使用 NexorAI 账号登录。消息和记忆由后端服务管理，各设备的登录可分别退出或撤销。</p><button onClick={() => void logout().catch(() => setError("退出未完成，请重试"))}>退出登录</button>{error ? <p role="alert">{error}</p> : null}</section>;
}

export function LoginGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<IdentityStatus>(), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0);
  const loggingOut = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try { const result = await api<IdentityStatus>("auth/status"); if (current === generation.current) setStatus(result); }
    catch (e) { if (current === generation.current) { setStatus(undefined); setError(e instanceof Error ? e.message : "无法验证登录，请重试"); } }
    finally { if (current === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => { if (loggingOut.current) return; setStatus(undefined); setError("登录已失效，请重新登录"); void refresh(); };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("nex-session-expired", expired); document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { ++generation.current; clearInterval(timer); window.removeEventListener("nex-session-expired", expired); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  async function logout() {
    // Local access is revoked first by Core, even if upstream logout is down.
    loggingOut.current = true;
    try { await api("auth/logout", {}); ++generation.current; setStatus(undefined); setError(""); await desktop?.forgetLogin?.(); await refresh(); }
    finally { loggingOut.current = false; }
  }
  if (status?.authenticated) return <Account.Provider value={{ status, logout }}>{children}</Account.Provider>;
  return <main className="login-screen"><section className="login-card"><span className="login-mark">N</span><p className="login-eyebrow">NEXBOT · PERSONAL AI OS</p><h1>登录你的个人 Agent</h1><p>使用 NexorAI 账号登录，连接你的 Agent、消息与记忆。</p>{loading ? <p role="status">正在检查登录状态…</p> : !status?.initialized && !status?.canInitialize ? <><p>请先在后端服务器运行 init，完成账号关联。</p><button onClick={() => void refresh()}>重新检查</button>{desktop?.mode === "client" ? <button onClick={() => void desktop?.disconnect?.()}>返回连接设置</button> : null}</> : <form className="login-form" onSubmit={(event) => {
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
  }}><label className="field">邮箱<input name="email" type="email" required maxLength={254} autoComplete="username" disabled={busy}/></label><label className="field">密码<input name="password" type="password" required maxLength={4096} autoComplete="current-password" disabled={busy}/></label><button className="primary" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>{status?.canInitialize ? <small>首次登录会将此账号关联到这台主设备，保留已有数据。</small> : null}</form>}{error ? <p className="login-error" role="alert">{error}</p> : null}<button className="login-help" onClick={() => void desktop?.openExternal("https://user.nexorai.com.cn/login")}>打开 NexorAI 账号中心</button></section></main>;
}
