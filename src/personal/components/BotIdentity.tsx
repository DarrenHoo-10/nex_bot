import { useRef, useState } from "react";
import { api, str, type RecordRow } from "../api";

export function BotIdentity({ bot, refresh }: { bot: RecordRow; refresh(): Promise<void> }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const original = useRef(bot);
  async function save() {
    if (pending) return;
    setPending(true); setError("");
    try {
      await api("bots/update", { id: original.current.id, name: original.current.name, version: original.current.version, instructions: draft });
      await refresh(); setEditing(false);
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败，请重试"); }
    finally { setPending(false); }
  }
  if (!editing) return <button type="button" className="bot-identity-link" aria-label="编辑 bot身份信息" onClick={() => { original.current = bot; setDraft(str(bot.instructions)); setError(""); setEditing(true); }}>{str(bot.instructions).trim() ? str(bot.instructions) : "bot身份信息"}</button>;
  return <form className="bot-identity-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
    <textarea autoFocus name="instructions" aria-label="bot身份信息" placeholder="填写身份、职责与沟通方式" rows={5} value={draft} disabled={pending} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape" && !pending) { event.preventDefault(); event.stopPropagation(); setEditing(false); }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
    }}/>
    {error && <p role="alert" className="model-error">{error}</p>}
    <div className="actions"><button className="primary" type="submit" disabled={pending}>{pending ? "保存中…" : "保存"}</button><button type="button" disabled={pending} onClick={() => setEditing(false)}>取消</button></div>
  </form>;
}
