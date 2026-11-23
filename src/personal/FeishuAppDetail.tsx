import { userErrorText } from "../lib/http-errors";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { FeishuAvatar, FeishuStatus } from "./FeishuCard";
import { api, type FeishuAppView, type FeishuGroupView } from "./api";

type Option<T extends string> = [T, string, string];
export const feishuTriggers: Option<FeishuGroupView["trigger"]>[] = [
  ["always", "必须 @", "只回复 @ 它的消息"],
  ["topic", "话题内免 @", "它参与过的话题里不用 @"],
  ["ambient", "默认应答", "回复所有消息，有人 @ 别人时不插话"],
  ["never", "全部回复", "回复群里每条消息"],
];
export const feishuSessions: Option<FeishuGroupView["session"]>[] = [
  ["chat-topic", "群聊共享，话题独立", "直接发的消息共用一个会话，每个话题各一个"],
  ["chat", "整群一个会话", "群里所有消息共用一个会话"],
  ["new-topic", "每次 @ 开新话题", "每次 @ 都新开话题，在话题里继续"],
];
const label = <T extends string>(options: Option<T>[], value: T) => options.find(option => option[0] === value)?.[1] ?? value;
const CONTEXT_LIMIT = 2000;

export function feishuGroupSummary(group: FeishuGroupView) {
  const parts = [group.kind === "topic" ? "话题群" : "普通群"];
  if (group.members != null) parts.push(`${group.members} 人`);
  if (!group.claimed) parts.push("未接入");
  else {
    parts.push(label(feishuTriggers, group.trigger), group.kind === "topic" ? "每个话题一个会话" : label(feishuSessions, group.session));
    if (group.context) parts.push("已设上下文");
  }
  return parts.join(" · ");
}

function Choices<T extends string>({ name, options, value, onChange }: { name: string; options: Option<T>[]; value: T; onChange(value: T): void }) {
  return <div className="feishu-options" role="radiogroup">{options.map(([key, title, hint]) => <label key={key} className={`feishu-option ${value === key ? "is-selected" : ""}`}>
    <input type="radio" name={name} value={key} checked={value === key} onChange={() => onChange(key)}/><strong>{title}</strong><small>{hint}</small>
  </label>)}</div>;
}

function GroupSettings({ app, group, saved, cancel }: { app: FeishuAppView; group: FeishuGroupView; saved(group: FeishuGroupView): void; cancel(): void }) {
  const [draft, setDraft] = useState({ trigger: group.trigger, session: group.session, context: group.context });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dirty = !group.claimed || draft.trigger !== group.trigger || draft.session !== group.session || draft.context !== group.context;
  const save = async () => {
    setBusy(true); setError("");
    try { saved(await api<FeishuGroupView>("feishu/groups/save", { id: app.id, chatId: group.chatId, version: group.version, ...draft })); }
    catch (e) { setError(userErrorText(e, "保存失败")); }
    finally { setBusy(false); }
  };
  return <div className="feishu-group-body">
    <div className="feishu-field-title">触发方式</div>
    <Choices name={`trigger-${group.chatId}`} options={feishuTriggers} value={draft.trigger} onChange={trigger => setDraft({ ...draft, trigger })}/>
    <div className="feishu-field-title">会话方式</div>
    {group.kind === "topic" ? <p className="muted">话题群：每个话题一个会话</p>
      : <Choices name={`session-${group.chatId}`} options={feishuSessions} value={draft.session} onChange={session => setDraft({ ...draft, session })}/>}
    <label className="feishu-field-title" htmlFor={`context-${group.chatId}`}>系统上下文<span>{draft.context.length} / {CONTEXT_LIMIT}</span></label>
    <textarea id={`context-${group.chatId}`} rows={5} maxLength={CONTEXT_LIMIT} value={draft.context} placeholder="例如：成员是投研团队，回答先给结论。" onChange={event => setDraft({ ...draft, context: event.target.value })}/>
    {error && <p className="connector-feedback is-error" role="alert">{error}</p>}
    <div className="actions feishu-group-actions"><button type="button" disabled={busy} onClick={cancel}>取消</button><button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>{group.claimed ? "保存" : "接入并保存"}</button></div>
  </div>;
}

/** 单个飞书应用：只管理每个群的回复模式与系统上下文。 */
export function FeishuAppDetail({ app, refresh }: { app: FeishuAppView; refresh(): Promise<void> }) {
  const [groups, setGroups] = useState<FeishuGroupView[]>();
  const [error, setError] = useState(""), [open, setOpen] = useState(""), [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try { const result = await api<{ groups: FeishuGroupView[]; error: string | null }>(`feishu/groups?id=${encodeURIComponent(app.id)}`); setGroups(result.groups); setError(result.error ?? ""); }
    catch (e) { setError(userErrorText(e, "读取群列表失败")); setGroups(current => current ?? []); }
  }, [app.id]);
  useEffect(() => { void load(); }, [load, app.status]);
  const act = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key); setError("");
    try { await operation(); await refresh(); } catch (e) { setError(userErrorText(e, "操作失败")); } finally { setBusy(""); }
  };
  const banner = app.status === "error" ? <div className="feishu-banner is-error"><span>{app.error || "连接异常"}</span><button type="button" disabled={!!busy} onClick={() => void act("reconnect", async () => { await api("feishu/toggle", { id: app.id, version: app.version, enabled: false }); await api("feishu/toggle", { id: app.id, version: app.version + 1, enabled: true }); })}>重新连接</button></div>
    : app.status === "busy" ? <div className="feishu-banner is-busy"><span>另一个程序正在使用这个应用的长连接</span></div>
    : app.status === "disabled" ? <div className="feishu-banner"><span>已停用，不收发消息</span><button type="button" disabled={!!busy} onClick={() => void act("toggle", () => api("feishu/toggle", { id: app.id, version: app.version, enabled: true }))}>启用</button></div> : null;
  return <section className="connector-detail connector-profile feishu-page" aria-label={`飞书应用 ${app.name || app.appId}`}>
    <div className="connector-profile-heading"><FeishuAvatar app={app} large/><div><h2 className="connector-profile-title" tabIndex={-1}>{app.name || app.botName || app.appId}</h2>
      <span>{app.appId} · {app.brand === "lark" ? "Lark" : "飞书"} · 接收助手 {app.botName}</span></div><FeishuStatus status={app.status}/></div>
    {banner}
    {error && <p className="connector-feedback is-error" role="alert">{error}</p>}
    <div className="connector-profile-section"><h3>群{groups ? ` · ${groups.length}` : ""}</h3><div className="connector-surface feishu-groups">
      {!groups ? <p className="feishu-empty muted">正在读取…</p> : !groups.length ? <p className="feishu-empty muted">把机器人拉进飞书群后，群会出现在这里</p>
        : groups.map(group => <div className="feishu-group" key={group.chatId}>
          <button type="button" className="feishu-group-head" aria-expanded={open === group.chatId} onClick={() => setOpen(open === group.chatId ? "" : group.chatId)}>
            <span className="feishu-chat-icon" aria-hidden="true">{group.kind === "topic" ? "话" : "群"}</span>
            <span className="feishu-app-copy"><strong>{group.name || group.chatId}</strong><small>{feishuGroupSummary(group)}</small></span>
            <ChevronRight size={16} className={open === group.chatId ? "is-open" : ""}/>
          </button>
          {open === group.chatId && <GroupSettings key={group.version} app={app} group={group} cancel={() => setOpen("")} saved={next => { setGroups(list => list?.map(item => item.chatId === next.chatId ? next : item)); setOpen(""); void refresh(); }}/>}
        </div>)}
    </div></div>
  </section>;
}
