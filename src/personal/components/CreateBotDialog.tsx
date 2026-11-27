import { useRef, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, UserRound } from "lucide-react";
import { userErrorText } from "../../lib/http-errors";
import { api } from "../api";
import type { Appearance } from "../avatars/appearance";
import { Button } from "../ui/Button";
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
  // On mobile (<=720px) the dialog renders as a top-anchored opaque full-screen sheet with
  // no dvh sizing or backdrop blur, so opening/closing the IME never bounces the layout.
  return <Dialog
    open
    variant="sheet"
    onClose={choice ? () => finishChoice(false) : onClose}
    busy={saving}
    title={choice ? "选择头像" : "添加 Agent"}
    headerStart={choice ? (
      <Button variant="icon" size="md" aria-label="返回" disabled={saving} onClick={() => finishChoice(false)}>
        <ChevronLeft size={18} />
      </Button>
    ) : undefined}
    className="create-bot-dialog"
    headerClassName="create-bot-header"
    bodyClassName="create-bot-body"
  >
    <form className="create-bot-form" hidden={!!choice} onSubmit={event => void submit(event)}>
      <div className="create-bot-fields">
        <button
          type="button"
          ref={avatarButton}
          className="create-bot-avatar"
          onClick={() => setChoice(appearance ?? { kind: "graphic", id: "secretary-01" })}
          disabled={saving}
        >
          <span className={`create-bot-avatar-preview${appearance ? " has-avatar" : ""}`} aria-hidden="true">
            {appearance ? <AgentAvatar appearance={appearance} size={44} /> : <UserRound size={22} />}
          </span>
          <span className="create-bot-avatar-label">{appearance ? "更换头像" : "选择头像"}</span>
          <ChevronRight className="create-bot-avatar-chevron" size={17} aria-hidden="true" />
        </button>
        <label className="field">
          <span>名字</span>
          <input name="name" required maxLength={80} placeholder="输入 Agent 名字" disabled={saving} />
        </label>
        <label className="field">
          <span>补充身份、职责与沟通方式（选填）</span>
          <textarea name="instructions" rows={4} placeholder="例如：角色、职责或沟通风格" disabled={saving} />
        </label>
        {error && <p className="identity-error" role="alert">{error}</p>}
        <div className="actions create-bot-actions">
          <button type="button" onClick={onClose} disabled={saving}>取消</button>
          <button className="primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </div>
    </form>
    {choice && <div className="create-bot-picker">
      <AvatarOptions selected={choice} setSelected={setChoice} />
      <div className="actions create-bot-picker-actions">
        <button type="button" onClick={() => finishChoice(false)}>取消</button>
        <button type="button" className="primary" onClick={() => finishChoice(true)}>使用头像</button>
      </div>
    </div>}
  </Dialog>;
}
