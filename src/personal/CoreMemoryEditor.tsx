import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api, str, type RecordRow } from "./api";

export interface CoreTopic { title: string; line: string; ref: string }
interface CoreEntry { content: { about: string[]; topics: CoreTopic[] }; version: number }
export interface CoreView { limit: number; tokens: number; bot: CoreEntry; workspace: CoreEntry }

const SEPARATOR = " — ";
/** A topic as one editable line: "标题 — 一句话 (memory:<id>)". */
export const topicLine = (topic: CoreTopic) => `${topic.title}${SEPARATOR}${topic.line}${topic.ref ? ` (${topic.ref})` : ""}`;
/** The topics of the edited lines; a line that is not "标题 — 一句话" is an error. */
export function parseTopics(value: string): CoreTopic[] {
  return value.split(/\r?\n/).map((raw) => raw.trim()).filter(Boolean).map((raw) => {
    const match = /^(.*?) — (.+?)(?: \(((?:memory|episode):[\w-]+)\))?$/.exec(raw.replace(/^[-•]\s*/, ""));
    if (!match || !match[1].trim()) throw new Error(`格式应为“标题 — 一句话”：${raw.slice(0, 40)}`);
    return { title: match[1].trim(), line: match[2].trim(), ref: match[3] ?? "" };
  });
}
export const parseAbout = (value: string) => value.split(/\r?\n/).map((raw) => raw.trim().replace(/^[-•]\s*/, "")).filter(Boolean);

function ScopeForm({ botId, scope, title, entry, onSaved }: { botId: string; scope: "bot" | "workspace"; title: string; entry: CoreEntry; onSaved: (view: CoreView) => void }) {
  const [pending, setPending] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState("");
  // Remounted after every save (key = version): the fields show what is stored.
  return <form key={`${scope}:${entry.version}`} aria-label={title} onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let about: string[], topics: CoreTopic[];
    try { about = parseAbout(String(form.get("about") ?? "")); topics = parseTopics(String(form.get("topics") ?? "")); } catch (failure) { setError(failure instanceof Error ? failure.message : "格式无效"); return; }
    setPending(true); setSaved(false); setError("");
    void api<CoreView>("memory/core", { botId, scope, about, topics, version: entry.version })
      .then((view) => { setSaved(true); onSaved(view); })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "保存失败"))
      .finally(() => setPending(false));
  }}>
    <fieldset disabled={pending}>
      <div className="preferences-section-heading"><h4>{title}</h4></div>
      <label className="field">关于用户<textarea name="about" rows={5} spellCheck={false} defaultValue={entry.content.about.join("\n")}/></label>
      <label className="field">主题索引<textarea name="topics" rows={5} spellCheck={false} defaultValue={entry.content.topics.map(topicLine).join("\n")}/></label>
      {error && <p role="alert" className="model-error">{error}</p>}
      <div className="preferences-actions">
        <button className="primary" type="submit">{pending ? "保存中…" : "保存"}</button>
        {saved && <span className="preferences-saved" role="status"><Check size={15}/>已保存</span>}
      </div>
    </fieldset>
  </form>;
}

/** The always-loaded core memory of an assistant and of the workspace, edited as plain lines. */
export function CoreMemoryEditor({ bots, active }: { bots: RecordRow[]; active: boolean }) {
  const [botId, setBotId] = useState(""), [view, setView] = useState<CoreView>(), [error, setError] = useState("");
  const selected = bots.some((bot) => str(bot.id) === botId) ? botId : str(bots[0]?.id);
  useEffect(() => {
    if (!active || !selected) return;
    let current = true;
    setView(undefined);
    void api<CoreView>(`memory/core?botId=${encodeURIComponent(selected)}`).then((result) => { if (current) { setView(result); setError(""); } }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : "读取失败"); });
    return () => { current = false; };
  }, [active, selected]);
  if (!bots.length) return null;
  return <section className="preferences-section core-memory" aria-label="核心记忆" data-core-memory>
    <div className="preferences-section-heading">
      <h3>核心记忆</h3>
      {view && <span className="preferences-status">{view.tokens} / {view.limit} Token</span>}
    </div>
    <label className="field">助手<select name="coreMemoryBot" value={selected} onChange={(event) => setBotId(event.target.value)}>{bots.map((bot) => <option key={str(bot.id)} value={str(bot.id)}>{str(bot.name)}</option>)}</select></label>
    {error && <p role="alert" className="model-error">{error}</p>}
    {view && <>
      <ScopeForm botId={selected} scope="bot" title={str(bots.find((bot) => str(bot.id) === selected)?.name)} entry={view.bot} onSaved={setView}/>
      <ScopeForm botId={selected} scope="workspace" title="共享" entry={view.workspace} onSaved={setView}/>
    </>}
  </section>;
}
