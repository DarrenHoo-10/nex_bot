import { Cpu, LogOut, Moon, PanelLeftClose, Plug, Plus, Search, Settings, Sun, X } from "lucide-react";
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
  const contacts = state.bots.filter((bot) => `${bot.name} ${bot.instructions ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const groups = [{ title: "置顶", items: contacts.filter((bot) => pinned.includes(str(bot.id))) }, { title: "我的 Agent", items: contacts.filter((bot) => !pinned.includes(str(bot.id))) }];
  return <>
    {props.open && <button className="sidebar-scrim" aria-label="关闭联系人列表" onClick={props.onClose}/>}
    <aside className={`contact-sidebar ${props.open ? "is-open" : ""}`} aria-label="联系人与导航">
      <div className="workspace-brand"><span className="workspace-monogram" aria-hidden="true">n</span><strong>NexBot</strong><button className="icon-button sidebar-dismiss" aria-label="收起联系人列表" onClick={props.onClose}><PanelLeftClose size={17}/></button><button className="icon-button" aria-label="添加 Agent" title="添加 Agent" onClick={props.onCreate}><Plus size={19}/></button></div>
      <label className="sidebar-search"><Search size={15}/><input aria-label="搜索 Agent" placeholder="搜索联系人" value={search} onChange={(event) => props.onSearch(event.target.value)}/>{search && <button className="icon-button" aria-label="清空搜索" onClick={() => props.onSearch("")}><X size={13}/></button>}</label>
      <div className="contact-list-label"><span>对话</span><span>{state.bots.length}</span></div><div className="contact-groups">
        {groups.map((group) => group.items.length ? <section key={group.title}><div className={`sidebar-section-title ${group.title === "我的 Agent" ? "is-default-group" : ""}`}><span>{group.title}</span></div>{group.items.map((bot) => {
          const task = state.tasks.find((item) => item.bot_id === bot.id && !ended.has(str(item.status)));
          return <button className={`contact-item ${selectedId === bot.id && page === "agent" ? "is-selected" : ""}`} key={str(bot.id)} data-agent={bot.id} aria-current={selectedId === bot.id && page === "agent" ? "page" : undefined} onClick={() => props.onSelect(str(bot.id))}>
            <Avatar bot={bot} allBots={state.bots} size={38} working={!!task}/><span className="contact-item-copy"><span className="contact-item-heading"><strong>{bot.name}</strong><time>{time(bot.last_message_at)}</time></span><span className="contact-item-preview"><span className={task ? "is-working" : ""}>{task ? taskPhrase(task) : str(bot.last_message) || str(bot.instructions) || "开始一段对话"}</span>{Number(bot.unread_count) > 0 && <b className="contact-unread">{Number(bot.unread_count) > 99 ? "99+" : bot.unread_count}</b>}</span></span>
          </button>;
        })}</section> : null)}
        {!contacts.length && <div className="sidebar-empty">{search ? "没有找到联系人" : "你的 Agent 会出现在这里"}{!search && <button className="text-button" onClick={props.onCreate}>创建第一个 Agent</button>}</div>}
      </div>
      <nav className="workspace-nav" aria-label="工作空间"><button className={page === "connectors" ? "is-selected" : ""} onClick={() => props.onPage("connectors")}><Plug size={17}/><span>连接器</span><small>{state.connectors?.filter((item) => item.enabled).length || ""}</small></button><button className={page === "devices" ? "is-selected" : ""} onClick={() => props.onPage("devices")}><Cpu size={17}/><span>设备</span><small>{state.onlineDevices.length}</small></button><button className={page === "settings" ? "is-selected" : ""} onClick={() => props.onPage("settings")}><Settings size={17}/><span>设置</span></button></nav>
      <footer className="workspace-account"><button className="workspace-account-name" onClick={() => props.onPage("settings")}><span className="account-initial">{props.userName.slice(0, 1)}<i className={props.connected ? "online" : "offline"}/></span><span><strong>{props.userName}</strong><small>{props.connected ? "个人工作空间" : "正在重新连接…"}</small></span></button><button className="icon-button" aria-label={props.dark ? "切换浅色模式" : "切换深色模式"} onClick={props.onTheme}>{props.dark ? <Sun size={16}/> : <Moon size={16}/>}</button><button className="icon-button" aria-label="退出当前账号" onClick={props.onLogout}><LogOut size={15}/></button></footer>
    </aside>
  </>;
}
