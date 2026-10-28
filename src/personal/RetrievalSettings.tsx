import { useEffect, useId, useState } from "react";
import { Check, Eye, EyeOff } from "lucide-react";
import { api } from "./api";

type Kind = "embedding" | "rerank";
type Format = "cohere" | "tei";
interface Item {
  source: "custom" | "default" | "disabled"; model?: string; format?: Format; version: number;
  default: { model: string; format?: Format } | null;
  custom: { enabled: boolean; baseUrl: string; model: string; dimensions?: number | null; format?: Format; hasKey: boolean } | null;
}
export interface RetrievalView { embedding: Item; rerank: Item }

const sources = { custom: "自定义", default: "默认", disabled: "未启用" };
/** "自定义 · 模型名", "默认 · 模型名" or "未启用": the item in effect; a default shows its model name only. */
export function retrievalStatus(item: Item): string {
  if (item.source === "disabled") return sources.disabled;
  return `${sources[item.source]} · ${item.model || (item.format === "tei" ? "TEI" : "—")}`;
}

function ModelForm({ kind, item, onSaved }: { kind: Kind; item: Item; onSaved: (view: RetrievalView) => void }) {
  const [pending, setPending] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState(""), [showKey, setShowKey] = useState(false);
  const keyId = useId(), custom = item.custom;
  const submit = (data: Record<string, unknown>) => {
    setPending(true); setSaved(false); setError("");
    void api<RetrievalView>("memory/retrieval", { kind, version: item.version, ...data })
      .then((view) => { setSaved(true); setShowKey(false); onSaved(view); })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "保存失败"))
      .finally(() => setPending(false));
  };
  const title = kind === "embedding" ? "向量模型" : "重排模型";
  // Remounted after every save: the key box empties and the fields show what is stored.
  return <form key={item.version} className="retrieval-model" aria-label={title} onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget), text = (name: string) => String(form.get(name) ?? "").trim();
    submit({
      enabled: form.get("enabled") === "on", baseUrl: text("baseUrl"), model: text("model"), apiKey: text("apiKey"),
      ...(kind === "embedding" ? { dimensions: text("dimensions") ? Number(text("dimensions")) : null } : { format: text("format") || "cohere" }),
    });
  }}>
    <fieldset disabled={pending}>
      <div className="preferences-section-heading"><h4>{title}</h4><span className="preferences-status">{retrievalStatus(item)}</span></div>
      <div className="preferences-form-grid">
        <label className="field">地址<input name="baseUrl" type="url" spellCheck={false} defaultValue={custom?.baseUrl ?? ""} placeholder="https://"/></label>
        <label className="field">模型<input name="model" spellCheck={false} defaultValue={custom?.model ?? ""}/></label>
        {kind === "embedding"
          ? <label className="field">维度<input name="dimensions" type="number" min="1" max="8192" step="1" defaultValue={custom?.dimensions ?? ""}/></label>
          : <label className="field">格式<select name="format" defaultValue={custom?.format ?? "cohere"}><option value="cohere">Cohere</option><option value="tei">TEI</option></select></label>}
        <div className="field"><label htmlFor={keyId}>API Key</label><div className="preferences-secret-input"><input id={keyId} name="apiKey" type={showKey ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={custom?.hasKey ? "留空保留已保存的 Key" : ""}/><button type="button" aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} aria-pressed={showKey} onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></div>
      </div>
      <label className="preferences-toggle"><strong>启用</strong><input type="checkbox" role="switch" name="enabled" defaultChecked={custom ? custom.enabled : true}/></label>
      {error && <p role="alert" className="model-error">{error}</p>}
      <div className="preferences-actions">
        <button className="primary" type="submit">{pending ? "测试并保存中…" : "保存"}</button>
        {custom && <button type="button" onClick={() => submit({ reset: true })}>使用默认</button>}
        {saved && <span className="preferences-saved" role="status"><Check size={15}/>已保存</span>}
      </div>
    </fieldset>
  </form>;
}

/** Embedding and rerank models for memory retrieval, each independent of the other and of the chat model. */
export function RetrievalSettings({ active }: { active: boolean }) {
  const [view, setView] = useState<RetrievalView>(), [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let current = true;
    void api<RetrievalView>("memory/retrieval").then((result) => { if (current) { setView(result); setError(""); } }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : "读取失败"); });
    return () => { current = false; };
  }, [active]);
  return <section className="preferences-section" aria-label="记忆检索" data-retrieval-settings>
    <div className="preferences-section-heading"><h3>记忆检索</h3></div>
    {error && <p role="alert" className="model-error">{error}</p>}
    {view && <><ModelForm kind="embedding" item={view.embedding} onSaved={setView}/><ModelForm kind="rerank" item={view.rerank} onSaved={setView}/></>}
  </section>;
}
