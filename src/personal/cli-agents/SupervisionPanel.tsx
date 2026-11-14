// The gear in the workspace header: the switches for what Core may do on its
// own after a turn ends. Each switch saves when it is flipped.
import { useCallback, useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { cliErrorText, fetchSupervision, saveSupervision, SUPERVISION_KEYS, type SupervisionSettings, type SupervisionView } from "./api";

export const SUPERVISION_LABEL: Record<keyof SupervisionSettings, string> = {
  transientRetry: "临时错误后自动继续",
  usageLimit: "额度恢复后继续",
  wakeup: "唤醒",
};

export function SupervisionPanel() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SupervisionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<keyof SupervisionSettings | null>(null);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await fetchSupervision();
      if (generation.current === mine) setView(next);
    } catch (cause) {
      if (generation.current === mine) setError(cliErrorText(cause, "读取失败"));
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const away = (event: Event) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      generation.current++;
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open, load]);

  const flip = async (key: keyof SupervisionSettings) => {
    if (!view || saving) return;
    setSaving(key);
    setError("");
    try {
      setView(await saveSupervision({ [key]: !view.settings[key] }));
    } catch (cause) {
      setError(cliErrorText(cause, "保存失败"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="cli-supervision" ref={root}>
      <button type="button" className="icon-button" aria-label="自动处理设置" title="自动处理设置" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Settings size={16} /></button>
      {open ? (
        <div className="cli-supervision-panel glass" role="dialog" aria-label="自动处理设置">
          {loading && !view ? <div className="cli-empty" role="status">正在读取…</div> : null}
          {view ? SUPERVISION_KEYS.map((key) => (
            <div key={key} className="cli-switch-row">
              <span id={`cli-sup-${key}`}>{SUPERVISION_LABEL[key]}</span>
              <button type="button" role="switch" className="cli-switch" aria-labelledby={`cli-sup-${key}`} aria-checked={view.settings[key]} disabled={!!saving} data-busy={saving === key ? "1" : undefined} onClick={() => void flip(key)} />
            </div>
          )) : null}
          {view && (view.pending > 0 || view.overrides > 0) ? (
            <div className="cli-supervision-status" role="status">
              {view.pending > 0 ? <span>{view.pending} 项待执行</span> : null}
              {view.overrides > 0 ? <span>{view.overrides} 个目录单独设置</span> : null}
            </div>
          ) : null}
          {error ? <div className="cli-notice" data-level="error" role="alert">{error}<button type="button" className="text-button" onClick={() => void load()}>重试</button></div> : null}
        </div>
      ) : null}
    </div>
  );
}
