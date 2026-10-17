import { useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { AVATARS } from "../avatars";
import { avatarForBot, saveAvatar } from "../avatars/preferences";

export function AvatarPicker({ botId, name, onChange, close }: { botId: string; name: string; onChange(): void; close(): void }) {
  const [selected, setSelected] = useState(avatarForBot(botId).id);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  return <div className="avatar-picker" ref={root} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>("button")];
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
  }}>
    <div className="modal-heading"><div><span className="avatar-picker-eyebrow">NEXBOT COMPANIONS</span><h2>给 {name} 一个新形象</h2></div><button className="icon-button" aria-label="关闭头像选择" onClick={close}><X size={18}/></button></div>
    <p className="avatar-picker-description">20 位小伙伴，选一个合眼缘的。</p>
    <div className="avatar-picker-grid" aria-label="20 个头像">{AVATARS.map((avatar) => <button type="button" key={avatar.id} className={`avatar-option ${selected === avatar.id ? "is-selected" : ""}`} data-avatar-option={avatar.id} aria-label={`选择${avatar.name}头像`} aria-pressed={selected === avatar.id} autoFocus={selected === avatar.id} onClick={() => {
      try { saveAvatar(botId, avatar.id); setSelected(avatar.id); setError(""); onChange(); }
      catch { setError("暂时无法保存头像，请重试。"); }
    }}><img src={avatar.src} alt="" width={64} height={64} draggable={false}/><span>{avatar.name}</span>{selected === avatar.id && <Check size={13} className="avatar-choice-check"/>}</button>)}</div>
    {error && <p role="alert">{error}</p>}
    <div className="avatar-picker-footer"><span>当前选择 · {AVATARS.find((avatar) => avatar.id === selected)?.name}</span><button className="primary" onClick={close}>完成</button></div>
  </div>;
}
