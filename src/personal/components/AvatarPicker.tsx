import { useRef, useState, type CSSProperties } from "react";
import { Check, X } from "lucide-react";
import { GRAPHIC_AVATARS } from "../avatars/graphic";
import { api, type RecordRow } from "../api";
import { appearanceOf, colors, shapes, companionColors, companionShapes, companionLabels, type Appearance, type CompanionState } from "../avatars/appearance";
import { AgentAvatar } from "./AgentAvatar";

export function AvatarPicker({ bot, firstId, onChange, close }: { bot: RecordRow; firstId: string; onChange(): Promise<void>; close(): void }) {
  const [selected, setSelected] = useState<Appearance>(() => appearanceOf(bot, firstId));
  const [previewState, setPreviewState] = useState<CompanionState>("idle");
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const color = selected.kind === "companion" ? selected.color : "teal";
  const shape = selected.kind === "companion" ? selected.shape : "soft";
  const apply = async () => {
    setSaving(true); setError("");
    try { await api("bots/appearance", { id: bot.id, appearance: selected, version: Number(bot.appearance_version ?? 0) }); await onChange(); close(); }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败，请重试"); }
    finally { setSaving(false); }
  };
  return <div className="avatar-picker identity-picker" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape" && saving) { event.stopPropagation(); return; }
    if (event.key !== "Tab") return;
    const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
  }}>
    <div className="modal-heading"><div><span className="avatar-picker-eyebrow">NEXBOT COMPANIONS</span><h2>属于 {bot.name} 的形象</h2></div><button autoFocus className="icon-button" aria-label="关闭头像选择" disabled={saving} onClick={close}><X size={18}/></button></div>
    <div className="identity-editor-body" inert={saving}>
      <section className="identity-preview">
        <AgentAvatar appearance={selected} size={104} state={previewState} animate/>
        <strong>{bot.name}</strong><span aria-live="polite">{companionLabels[previewState]}</span>
        <div className="identity-state-picker" aria-label="预览状态">{(["idle", "thinking", "working", "approval", "done", "offline"] as CompanionState[]).map((state) => <button type="button" key={state} aria-pressed={previewState === state} onClick={() => setPreviewState(state)}>{({ idle: "待命", thinking: "思考", working: "执行", approval: "待确认", done: "完成", offline: "断线" } as Record<string, string>)[state]}</button>)}</div>
        <small>{selected.kind === "portrait" ? "预览状态" : "预览动效"}，不会启动任务</small>
      </section>
      <section className="identity-options" aria-label="角色">
        <h3 className="identity-section-title">角色</h3>
        <GraphicAvatarOptions selected={selected} select={setSelected}/>
        <section className="identity-originals" aria-label="基础角色">
          <h3 className="identity-section-title">基础角色</h3>
          <h3>轮廓</h3>
          <div className="identity-shapes">{companionShapes.map((id) => <button type="button" key={id} data-shape={id} aria-label={`选择${shapes[id].name}轮廓`} aria-pressed={selected.kind === "companion" && selected.shape === id} onClick={() => setSelected({ kind: "companion", shape: id, color })}><AgentAvatar appearance={{ kind: "companion", shape: id, color }} size={36}/></button>)}</div>
          <h3>专属颜色</h3>
          <div className="identity-colors">{companionColors.map((id) => <button type="button" key={id} data-color={id} aria-label={colors[id].name} aria-pressed={selected.kind === "companion" && selected.color === id} style={{ "--swatch": colors[id].value } as CSSProperties} onClick={() => setSelected({ kind: "companion", shape, color: id })}><span/>{selected.kind === "companion" && selected.color === id && <Check size={13}/>}</button>)}</div>
          <h3>搭配</h3>
          <div className="identity-presets">{companionShapes.flatMap((s) => companionColors.map((c) => <button type="button" key={s + c} data-preset={`${s}-${c}`} aria-label={`${colors[c].name}${shapes[s].name}`} aria-pressed={selected.kind === "companion" && selected.shape === s && selected.color === c} onClick={() => setSelected({ kind: "companion", shape: s, color: c })}><AgentAvatar appearance={{ kind: "companion", shape: s, color: c }} size={30}/></button>))}</div>
        </section>
      </section>
    </div>
    {error && <p role="alert" className="identity-error">{error}</p>}
    <div className="avatar-picker-footer"><span>应用后同步到此账号的其他设备</span><div><button type="button" disabled={saving} onClick={close}>取消</button><button type="button" className="primary" disabled={saving} onClick={() => void apply()}>{saving ? "保存中…" : "应用形象"}</button></div></div>
  </div>;
}

function GraphicAvatarOptions({ selected, select }: { selected: Appearance; select(appearance: Appearance): void }) {
  return <div className="graphic-picker-grid">
    {GRAPHIC_AVATARS.map((avatar) => <button
      type="button"
      key={avatar.id}
      className="graphic-avatar-option"
      data-graphic-option={avatar.id}
      aria-label={`选择${avatar.description}的角色`}
      aria-pressed={selected.kind === "graphic" && selected.id === avatar.id}
      onClick={() => select({ kind: "graphic", id: avatar.id })}
    >
      <AgentAvatar appearance={{ kind: "graphic", id: avatar.id }} size={52}/>
    </button>)}
  </div>;
}
