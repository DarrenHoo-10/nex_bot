import { useEffect, useId, useRef, useState } from "react";
import { ChevronUp, LogOut, Moon, PanelLeftClose, Plus, Search, Settings, Sun, UserRound, X } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { companionState } from "../avatars/appearance";
import { AgentAvatar as Avatar } from "./AgentAvatar";
import { str, taskPhrase, type State } from "../api";

interface Props {
  state: State; selectedId: string; page: string; search: string; pinned: string[];
  dark: boolean; connected: boolean; userName: string; open: boolean;
  onSearch(value: string): void; onSelect(id: string): void; onPage(page: string): void;
  onCreate(): void; onTheme(): void; onLogout(): void; onClose(): void;
}
const ended = new Set(["succeeded", "failed", "cancelled", "rejected"]);
function time(value: string | number | null | undefined) {
  if (!value) return "";
  const date = new Date(Number(value));
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
export function ContactSidebar(props: Props) {
  const { state, selectedId, page, pinned, search } = props;
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRoot = useRef<HTMLElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const dismissAccount = () => { setAccountOpen(false); accountButton.current?.focus(); };
  const accountAction = (action: () => void) => { dismissAccount(); action(); };
  useEffect(() => {
    if (!accountOpen) return;
    accountRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!accountRoot.current?.contains(event.target as Node)) setAccountOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [accountOpen]);
  const contacts = state.bots.filter((bot) => `${bot.name} ${bot.instructions ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const groups = [{ title: "置顶", items: contacts.filter((bot) => pinned.includes(str(bot.id))) }, { title: "我的 Agent", items: contacts.filter((bot) => !pinned.includes(str(bot.id))) }];
  return <>
    {props.open && <button className="sidebar-scrim" aria-label="关闭联系人列表" onClick={props.onClose}/>}
    <aside className={`contact-sidebar ${props.open ? "is-open" : ""}`} aria-label="联系人与导航">
      <div className="workspace-brand"><BrandMark size={30}/><strong>NexBot</strong><button className="icon-button sidebar-dismiss" aria-label="收起联系人列表" onClick={props.onClose}><PanelLeftClose size={17}/></button><button className="icon-button" aria-label="添加 Agent" title="添加 Agent" onClick={props.onCreate}><Plus size={19}/></button></div>
      <label className="sidebar-search"><Search size={15}/><input aria-label="搜索 Agent" placeholder="搜索联系人" value={search} onChange={(event) => props.onSearch(event.target.value)}/>{search && <button className="icon-button" aria-label="清空搜索" onClick={() => props.onSearch("")}><X size={13}/></button>}</label>
      <div className="contact-list-label"><span>对话</span><span>{state.bots.length}</span></div><div className="contact-groups">
        {groups.map((group) => group.items.length ? <section key={group.title}><div className={`sidebar-section-title ${group.title === "我的 Agent" ? "is-default-group" : ""}`}><span>{group.title}</span></div>{group.items.map((bot) => {
          const task = state.tasks.find((item) => item.bot_id === bot.id && !ended.has(str(item.status)));
          return <button className={`contact-item ${selectedId === bot.id && page === "agent" ? "is-selected" : ""}`} key={str(bot.id)} data-agent={bot.id} aria-current={selectedId === bot.id && page === "agent" ? "page" : undefined} onClick={() => props.onSelect(str(bot.id))}>
            <Avatar bot={bot} allBots={state.bots} size={40} animate={!!task} state={companionState(task, state.approvals.some((a) => a.bot_id === bot.id), props.connected)}/><span className="contact-item-copy"><span className="contact-item-heading"><strong>{bot.name}</strong><time>{time(bot.last_message_at)}</time></span><span className="contact-item-preview"><span className={task ? "is-working" : ""}>{task ? taskPhrase(task) : str(bot.last_message) || str(bot.instructions) || "开始一段对话"}</span>{Number(bot.unread_count) > 0 && <b className="contact-unread">{Number(bot.unread_count) > 99 ? "99+" : bot.unread_count}</b>}</span></span>
          </button>;
        })}</section> : null)}
        {!contacts.length && <div className="sidebar-empty">{search ? "没有找到联系人" : "你的 Agent 会出现在这里"}{!search && <button className="text-button" onClick={props.onCreate}>创建第一个 Agent</button>}</div>}
      </div>
      <footer className="workspace-account" ref={accountRoot} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAccountOpen(false); }} onKeyDown={(event) => {
        if (event.key === "Escape" && accountOpen) { event.preventDefault(); event.stopPropagation(); dismissAccount(); }
      }}>
        {accountOpen && <div className="account-menu" id={menuId} role="menu" aria-label="账号菜单" onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}>
          <button type="button" role="menuitem" className={page === "settings" ? "is-selected" : ""} onClick={() => accountAction(() => props.onPage("settings"))}><Settings size={18}/><span>设置</span></button>
          <button type="button" role="menuitem" onClick={() => accountAction(props.onTheme)}>{props.dark ? <Sun size={18}/> : <Moon size={18}/>}<span>{props.dark ? "切换浅色模式" : "切换深色模式"}</span></button>
          <div className="account-menu-divider" role="separator"/>
          <button type="button" role="menuitem" onClick={() => accountAction(props.onLogout)}><LogOut size={18}/><span>退出当前账号</span></button>
        </div>}
        <button type="button" ref={accountButton} className="workspace-account-name" aria-label={`${props.userName}，账号菜单`} aria-haspopup="menu" aria-expanded={accountOpen} aria-controls={accountOpen ? menuId : undefined} onClick={() => setAccountOpen((value) => !value)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setAccountOpen(true); } }}><span className="account-avatar" aria-hidden="true"><UserRound size={19} strokeWidth={1.7}/><i className={props.connected ? "online" : "offline"}/></span><span className="workspace-account-copy"><strong>{props.userName}</strong>{!props.connected && <small>正在重新连接…</small>}</span><ChevronUp className="account-menu-chevron" size={16}/></button>
      </footer>
    </aside>
  </>;
}
