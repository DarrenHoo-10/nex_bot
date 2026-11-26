import { useRef, useState, type FormEvent } from "react";
import { UserRound } from "lucide-react";
import { userErrorText } from "../../lib/http-errors";
import { api } from "../api";
import type { Appearance } from "../avatars/appearance";
import { Dialog } from "../ui/Dialog";
import { AgentAvatar } from "./AgentAvatar";
import { AvatarOptions } from "./AvatarPicker";

export function CreateBotDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const [appearance, setAppearance] = useState<Appearance>();
  const [choice, setChoice] = useState<Appearance>();
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const avatarButton = useRef<HTMLButtonElement>(null);
  function finishChoice(apply: boolean) {
    if (apply) setAppearance(choice);
    setChoice(undefined);
    requestAnimationFrame(() => avatarButton.current?.focus({ preventScroll: true }));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || choice) return;
    const fields = new FormData(event.currentTarget);
    setSaving(true); setError("");
    try {
      const { id } = await api<{ id: string }>("bots", { name: fields.get("name"), instructions: fields.get("instructions"), appearance });
      onCreated(id);
    } catch (cause) { setError(userErrorText(cause, "保存失败，请重试")); setSaving(false); }
  }
  // The native top layer isolates the workspace. Its first focusable control is Close,
  // not the name input: opening the form must not summon the keyboard and resize the chat.
  return <Dialog open onClose={choice ? () => finishChoice(false) : onClose} busy={saving} title={choice ? "选择头像" : "添加 Agent"}
    className="modal create-bot-dialog bg-[var(--card)] backdrop-filter-none backdrop:backdrop-filter-none">
    <form hidden={!!choice} onSubmit={event => void submit(event)}>
      <div className="create-bot-fields">
        <button type="button" ref={avatarButton} className="create-bot-avatar" onClick={() => setChoice(appearance ?? { kind: "graphic", id: "secretary-01" })} disabled={saving}>
          {appearance ? <AgentAvatar appearance={appearance} size={36}/> : <UserRound size={26} aria-hidden="true"/>}选择头像
        </button>
        <label className="field">名字<input name="name" required maxLength={80} disabled={saving}/></label>
        <label className="field">补充身份、职责与沟通方式（选填）<textarea name="instructions" rows={5} disabled={saving}/></label>
        {error && <p className="identity-error" role="alert">{error}</p>}
      </div>
      <div className="actions"><button type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button></div>
    </form>
    {choice && <div className="create-bot-picker">
      <AvatarOptions selected={choice} setSelected={setChoice}/>
      <div className="actions"><button type="button" onClick={() => finishChoice(false)}>取消</button><button type="button" className="primary" onClick={() => finishChoice(true)}>使用头像</button></div>
    </div>}
  </Dialog>;
}
