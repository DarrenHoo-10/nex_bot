import { userErrorText } from "../lib/http-errors";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, MessagesSquare, UsersRound } from "lucide-react";
import { FeishuAvatar, FeishuProfileStatus, FeishuStatus } from "./FeishuCard";
import { api, type FeishuAppView, type State, type FeishuGroupView } from "./api";

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

export function feishuGroupSummary(group: FeishuGroupView, showConnection = true) {
  const parts = [group.kind === "topic" ? "话题群" : "普通群"];
  if (group.members != null) parts.push(`${group.members} 人`);
  if (!group.claimed && showConnection) parts.push("未开放");
  if (group.claimed) {
    parts.push(label(feishuTriggers, group.trigger), group.kind === "topic" ? "每个话题一个会话" : label(feishuSessions, group.session));
    if (group.context) parts.push("已设上下文");
  }
  return parts.join(" · ");
}

function FeishuGroupAvatar({ group }: { group: FeishuGroupView }) {
  const [failed, setFailed] = useState(false);
  return <span className="feishu-group-avatar" aria-hidden="true">{group.avatarUrl && !failed
    ? <img src={group.avatarUrl} alt="" loading="lazy" onError={() => setFailed(true)}/>
    : group.kind === "topic" ? <MessagesSquare size={16}/> : <UsersRound size={16}/>}</span>;
}

function GroupSettingSelect<T extends string>({ title, options, value, onChange, disabled }: { title: string; options: Option<T>[]; value: T; onChange(value: T): void; disabled: boolean }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, name, hint] = options.find(([key]) => key === value) ?? options[0];
  const popupId = `${id}-options`;
  const position = useCallback(() => {
    const panel = menu.current, anchor = trigger.current?.getBoundingClientRect();
    if (!panel || !anchor) return;
    const gutter = 12, gap = 6;
    const width = Math.min(Math.max(anchor.width, 248), window.innerWidth - 2 * gutter);
    const rightAligned = anchor.right - width;
    const left = rightAligned >= gutter ? rightAligned : anchor.left;
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(gutter, Math.min(left, window.innerWidth - width - gutter))}px`;
    const below = window.innerHeight - anchor.bottom - gap - gutter;
    const above = anchor.top - gap - gutter;
    const down = below >= panel.scrollHeight + 2 || below >= above;
    panel.style.maxHeight = `${Math.max(0, down ? below : above)}px`;
    panel.style.top = `${down ? anchor.bottom + gap : anchor.top - gap - panel.offsetHeight}px`;
  }, []);
  useEffect(() => {
    if (!open) return;
    const scroll = (event: Event) => { if (event.target !== menu.current) position(); };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, position]);
  const close = () => {
    menu.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  };
  return <div className="feishu-setting-row">
    <div><label htmlFor={id}>{title}</label>{hint && <small id={`${id}-hint`}>{hint}</small>}</div>
    <button type="button" id={id} ref={trigger} className="model-picker-trigger feishu-setting-trigger" disabled={disabled}
      popoverTarget={popupId} aria-haspopup="listbox" aria-expanded={open} aria-controls={popupId}
      aria-label={`${title}：${name}`} aria-describedby={`${id}-hint`} onKeyDown={event => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}>
      <span>{name}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>
    <div id={popupId} ref={menu} popover="auto" className="model-picker-popover feishu-setting-menu" role="listbox" aria-label={title}
      onToggle={event => {
        const panel = event.currentTarget;
        const visible = panel.matches(":popover-open");
        setOpen(visible);
        if (!visible) return;
        position();
        panel.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
      }}
      onKeyDown={event => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=option]"));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
          (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {options.map(([key, optionName, detail]) => <button key={key} type="button" className="model-option" role="option"
        aria-selected={key === selected} tabIndex={-1} disabled={disabled} onClick={() => { onChange(key); close(); }}>
        <span>{optionName}<small>{detail}</small></span>{key === selected && <Check size={15} aria-hidden="true"/>}
      </button>)}
    </div>
  </div>;
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
  const canOpen = group.claimed || (app.ownerBound && app.enabled);
  return <form className="feishu-group-body" onSubmit={event => {
    event.preventDefault();
    if (!busy && dirty && canOpen) void save();
  }}>
    <GroupSettingSelect title="回复时机" options={feishuTriggers} value={draft.trigger} disabled={busy}
      onChange={trigger => setDraft({ ...draft, trigger })}/>
    {group.kind === "topic"
      ? <div className="feishu-setting-row"><span>会话方式</span><span className="feishu-setting-value">每个话题一个会话</span></div>
      : <GroupSettingSelect title="会话方式" options={feishuSessions} value={draft.session} disabled={busy}
        onChange={session => setDraft({ ...draft, session })}/>}
    <div className="feishu-setting-context">
      <label htmlFor={`context-${group.chatId}`}>群聊提示词 {draft.context.length > 0 && <small>{draft.context.length} / {CONTEXT_LIMIT}</small>}</label>
      <textarea id={`context-${group.chatId}`} rows={2} maxLength={CONTEXT_LIMIT} value={draft.context} disabled={busy}
        placeholder="可选，例如：回答先给结论" onChange={event => setDraft({ ...draft, context: event.target.value })}/>
    </div>
    {error && <p className="connector-feedback is-error" role="alert">{error}</p>}
    <div className="feishu-group-footer">
      {!group.claimed && <small>{!app.ownerBound ? "先绑定应用主人，再向群成员开放。" : !app.enabled ? "启用飞书应用后，可向群成员开放。" : "保存设置后，群成员可按所选规则触发助手。"}</small>}
      <div className="actions feishu-group-actions">
        <button type="button" disabled={busy} onClick={cancel}>取消</button>
        <button type="submit" className="primary" disabled={busy || !dirty || !canOpen}>
          {busy ? "保存中…" : group.claimed ? "保存" : "允许群成员使用"}
        </button>
      </div>
    </div>
  </form>;
}

type GroupList = { groups: FeishuGroupView[]; error: string | null; cacheForMs?: number };
export type FeishuGroupCache = Map<string, { list: GroupList; expiresAt: number }>;

export function FeishuAppDetail({ app, bots, cache, refresh }: { app: FeishuAppView; bots: State["bots"]; cache: FeishuGroupCache; refresh(): Promise<void> }) {
  const [receiver, setReceiver] = useState<string | null>(null);
  const receiverEditor = useId();
  const receiverButton = useRef<HTMLButtonElement>(null);
  const receiverSelect = useRef<HTMLSelectElement>(null);
  const restoreReceiverFocus = useRef(false);
  const editingReceiver = receiver !== null;
  useEffect(() => {
    if (editingReceiver) receiverSelect.current?.focus();
    else if (restoreReceiverFocus.current) {
      restoreReceiverFocus.current = false;
      receiverButton.current?.focus();
    }
  }, [editingReceiver]);
  const closeReceiverEditor = () => {
    restoreReceiverFocus.current = true;
    setReceiver(null);
  };
  const cacheKey = app.id + ":" + app.status;
  const [groups, setGroups] = useState<FeishuGroupView[]>(() => cache.get(cacheKey)?.list.groups ?? []);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [groupError, setGroupError] = useState("");
  const [actionError, setActionError] = useState("");
  const [open, setOpen] = useState(""), [busy, setBusy] = useState("");
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const cached = cache.get(cacheKey);
      const result = cached && cached.expiresAt > Date.now() ? cached.list :
        await api<GroupList>(`feishu/groups?id=${encodeURIComponent(app.id)}`, undefined, signal);
      if (signal.aborted) return;
      if ((!cached || cached.list !== result) && !result.error) {
        cache.delete(cacheKey);
        cache.set(cacheKey, { list: result, expiresAt: Date.now() + Math.min(300_000, result.cacheForMs ?? 300_000) });
        if (cache.size > 12) cache.delete(cache.keys().next().value!);
      }
      setGroups(result.groups);
      setGroupError(result.error ?? "");
    } catch (e) {
      if (!signal.aborted) setGroupError(userErrorText(e, "读取群列表失败"));
    } finally {
      if (!signal.aborted) setGroupsLoaded(true);
    }
  }, [app.id, cache, cacheKey]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const act = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key); setActionError("");
    try { await operation(); await refresh(); return true; }
    catch (e) { setActionError(userErrorText(e, "操作失败")); return false; }
    finally { setBusy(""); }
  };
  const banner = app.status === "error" ? <div className="feishu-banner is-error"><span>{app.error || "连接异常"}</span><button type="button" disabled={!!busy} onClick={() => void act("reconnect", async () => { await api("feishu/toggle", { id: app.id, version: app.version, enabled: false }); await api("feishu/toggle", { id: app.id, version: app.version + 1, enabled: true }); })}>重新连接</button></div>
    : app.status === "busy" ? <div className="feishu-banner is-busy"><span>另一个程序正在使用这个应用的长连接</span></div>
    : app.status === "disabled" ? <div className="feishu-banner"><span>已停用，不收发消息</span><button type="button" disabled={!!busy} onClick={() => void act("toggle", () => api("feishu/toggle", { id: app.id, version: app.version, enabled: true }))}>启用</button></div> : null;
  const name = app.name || app.botName || app.appId;
  return <section className="connector-detail connector-profile feishu-page feishu-app-detail" aria-label={`飞书应用 ${name}`}>
    <div className="connector-surface feishu-app-overview">
      <div className="feishu-app-identity">
        <FeishuAvatar app={app}/>
        <div className="feishu-app-identity-copy">
          <h2 tabIndex={-1}>{name}</h2>
          {name !== app.appId && <span className="feishu-app-identifier">{app.appId}{app.brand === "lark" ? " · Lark" : ""}</span>}
          <FeishuProfileStatus status={app.profileStatus}/>
        </div>
        <FeishuStatus status={app.status}/>
      </div>
      <div className="feishu-receiver">
        <div className="feishu-receiver-summary">
          <span>接收助手</span>
          <strong>{app.botName || "未选择"}</strong>
          <button ref={receiverButton} type="button" className="feishu-receiver-change" aria-label="更换接收助手"
            aria-expanded={editingReceiver} aria-controls={editingReceiver ? receiverEditor : undefined} disabled={!!busy}
            onClick={() => {
              setActionError("");
              if (editingReceiver) closeReceiverEditor();
              else setReceiver(app.botId);
            }}>{editingReceiver ? "收起" : "更换"}</button>
        </div>
        {editingReceiver && <form id={receiverEditor} className="feishu-receiver-editor" onSubmit={event => {
          event.preventDefault();
          if (!receiver || receiver === app.botId || busy) return;
          void act("receiver", () => api("feishu/receiver", { id: app.id, version: app.version, botId: receiver }))
            .then(saved => { if (saved) closeReceiverEditor(); });
        }}>
          <select ref={receiverSelect} aria-label="选择接收助手" value={receiver} disabled={!!busy} onChange={event => setReceiver(event.target.value)}>
            {!bots.some(bot => bot.id === receiver) && <option value={receiver} disabled>请选择助手</option>}
            {bots.map(bot => <option key={String(bot.id)} value={String(bot.id)}>{String(bot.name)}</option>)}
          </select>
          <div className="actions">
            <button type="button" disabled={!!busy} onClick={() => { setActionError(""); closeReceiverEditor(); }}>取消</button>
            <button type="submit" className="primary" disabled={!!busy || !receiver || receiver === app.botId}>{busy === "receiver" ? "保存中…" : "保存"}</button>
          </div>
        </form>}
      </div>
    </div>
    {banner}
    {actionError && <p className="connector-feedback is-error" role="alert">{actionError}</p>}
    <section className="feishu-app-groups" aria-label="群聊">
      <div className="feishu-group-list-title"><h3>群聊</h3>{(groupsLoaded || groups.length > 0) && <span>{groups.length} 个群</span>}</div>
      {groupError && <p className="connector-feedback is-error" role="alert">{groupError}</p>}
      <div className="feishu-groups">
      {!groupsLoaded && !groups.length ? <p className="feishu-empty muted">正在读取…</p> : !groups.length ? <p className="feishu-empty muted">把机器人拉进飞书群后，群会出现在这里</p>
        : groups.map(group => <div className="feishu-group" key={group.chatId}>
          <button type="button" className="feishu-group-head" aria-expanded={open === group.chatId} onClick={() => setOpen(open === group.chatId ? "" : group.chatId)}>
            <FeishuGroupAvatar key={group.avatarUrl ?? ""} group={group}/>
            <span className="feishu-app-copy"><strong>{group.name || group.chatId}</strong><small>{feishuGroupSummary(group, false)}</small></span>
            {!group.claimed && <span className="feishu-group-connection">未开放</span>}
            <ChevronRight size={16} className={open === group.chatId ? "is-open" : ""}/>
          </button>
          {open === group.chatId && <GroupSettings key={group.version} app={app} group={group} cancel={() => setOpen("")} saved={next => {
            cache.delete(cacheKey);
            setGroups(list => list.map(item => item.chatId === next.chatId ? next : item));
            setOpen(""); void refresh();
          }}/>}
        </div>)}
      </div>
    </section>
  </section>;
}
