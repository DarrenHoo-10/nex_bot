import { useEffect, useState } from "react";
import { api, modelName, type Connection } from "./api";
import { ModelMenu, type ModelChoice } from "./components/ModelMenu";

interface Selection { connectionId: string; model: string }
interface Settings { selection: Selection | null; available: boolean; version: number }
const route = "cli-agents/translation-settings";
const emptyChoice: ModelChoice = { connectionId: "", model: "", reasoning: null };

export function TranslationSettings({ connections }: { connections: Connection[] }) {
  const [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const selected = settings?.selection;
  const provider = connections.find(connection => connection.id === selected?.connectionId);
  const available = !!(selected && provider?.enabled && provider.configured &&
    (provider.models === null || provider.models.includes(selected.model)));
  const usable = connections.some(connection => connection.enabled && connection.configured);

  useEffect(() => {
    const controller = new AbortController();
    void api<Settings>(route, undefined, controller.signal).then(setSettings, (failure: Error) => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [attempt]);

  async function save(selection: Selection | null) {
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    try {
      setSettings(await api<Settings>(route, { selection, version: settings.version }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败");
      try { setSettings(await api<Settings>(route)); } catch { /* keep the original error */ }
    } finally {
      setBusy(false);
    }
  }

  return <section className="preferences-section" aria-label="翻译服务">
    <div className="preferences-section-heading">
      <h3>翻译服务</h3>
      <span className="preferences-status">{busy ? "保存中…" : selected ? (available ? "已启用" : "所选模型不可用") : settings ? "未启用" : "未加载"}</span>
    </div>
    {settings ? <div className="actions">
      <ModelMenu connections={connections} choice={selected ? { ...selected, reasoning: null } : emptyChoice} label="选择翻译模型"
        displayValue={selected ? `${modelName(provider, selected.model)}${provider ? ` · ${provider.name}` : ""}` : "选择模型"}
        selectionOnly disabled={!usable || busy}
        onChange={({ connectionId, model }) => void save({ connectionId, model })}/>
      {selected && <button type="button" disabled={busy} onClick={() => void save(null)}>关闭翻译</button>}
    </div> : null}
    {settings && !usable && <span className="preferences-status">请先连接模型</span>}
    {error && <p role="alert" className="model-error">{error} {!settings && <button type="button" onClick={() => { setError(""); retry(value => value + 1); }}>重试</button>}</p>}
  </section>;
}
