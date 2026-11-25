import { userErrorText } from "../lib/http-errors";
import { useEffect, useRef, useState } from "react";
import { desktop, type ClientUpdateState } from "./api";
import { webUpdates } from "./web-updates";

export function AboutSettings() {
  const updater = desktop ?? webUpdates;
  const [update, setUpdate] = useState<ClientUpdateState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef(false);
  useEffect(() => {
    let active = true, changed = false;
    const unsubscribe = updater.onUpdateState?.(state => { changed = true; if (active) setUpdate(state); });
    void updater.updateState?.().then(state => { if (active && !changed) setUpdate(state); })
      .catch(() => { if (active) setError("无法读取版本信息"); });
    return () => { active = false; unsubscribe?.(); };
  }, [updater]);
  const perform = async (install: boolean) => {
    if (operation.current) return;
    operation.current = true; setPending(true); setError("");
    try {
      if (install) await updater.installUpdate?.();
      else {
        setUpdate(state => ({ ...state, status: "checking" }));
        const state = await updater.checkUpdate?.();
        if (state) setUpdate(state);
      }
    } catch (cause) {
      setError(userErrorText(cause instanceof Error ? new Error(cause.message.replace(/^Error invoking remote method '[^']+': Error: /, "")) : cause, "检查更新失败"));
      if (!install) setUpdate(state => ({ ...state, status: "error" }));
    } finally { operation.current = false; setPending(false); }
  };
  const busy = pending || update?.status === "checking" || update?.status === "downloading";
  const ready = update?.status === "ready";
  const message = update?.status === "checking" ? "正在检查更新…"
    : update?.status === "current" ? "已是最新版"
    : update?.status === "downloading" ? `新版本 ${update.version ?? ""} 正在下载${typeof update.progress === "number" ? ` ${Math.round(update.progress * 100)}%` : "…"}`
    : ready ? (desktop ? `新版本 ${update.version} 已就绪` : "网页有新版本")
    : update?.status === "unsupported" ? "此安装方式不支持应用内更新"
    : update?.status === "error" && !error ? `检查更新失败${update.error ? `：${update.error}` : ""}` : "";
  return <>
    <div className="preferences-panel-heading"><h2>关于</h2></div>
    <section className="preferences-section">
      <div className="preferences-section-heading"><h3>NexBot</h3></div>
      <dl className="preferences-facts"><div><dt>当前版本</dt><dd>{update?.current || "—"}</dd></div></dl>
      <div className="preferences-actions">
        {ready && updater.installUpdate ? <button type="button" className="primary" disabled={busy} onClick={() => void perform(true)}>{pending ? "正在更新…" : desktop ? "立即更新" : "刷新页面"}</button>
          : updater.checkUpdate && update?.status !== "unsupported" ? <button type="button" disabled={busy} onClick={() => void perform(false)}>{update?.status === "downloading" ? "正在下载…" : busy ? "检查中…" : "检查更新"}</button> : null}
      </div>
      {message && <p role="status">{message}</p>}
      {!updater.checkUpdate && update?.status !== "unsupported" && <p role="status">此版本暂不支持手动检查更新</p>}
      {error && <p role="alert" className="model-error">{error}</p>}
    </section>
  </>;
}
