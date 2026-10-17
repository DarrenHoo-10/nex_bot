import { useEffect, useState, type CSSProperties } from "react";
import type { RecordRow } from "../api";
import { AVATARS } from "../avatars";
import { appearanceOf, colors, shapes, type Appearance, type CompanionState } from "../avatars/appearance";

export function AgentAvatar({ bot, allBots, size = 36, large, working, state, appearance, animate = false }: {
  bot?: RecordRow; allBots?: RecordRow[]; size?: number; large?: boolean; working?: boolean; interactive?: boolean;
  state?: CompanionState; appearance?: Appearance; animate?: boolean;
}) {
  const look = appearance ?? appearanceOf(bot, String(allBots?.[0]?.id ?? ""));
  const status = state ?? (working ? "working" : "idle");
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => { const change = () => setVisible(!document.hidden); document.addEventListener("visibilitychange", change); return () => document.removeEventListener("visibilitychange", change); }, []);
  const dimension = large ? Math.max(64, size) : size;
  if (look.kind === "portrait") return <span className="agent-glyph portrait-avatar" data-avatar={look.id} data-state={status} style={{ width: dimension, height: dimension }} aria-hidden="true"><img src={AVATARS.find((item) => item.id === look.id)!.src} alt="" draggable={false}/>{status !== "idle" && <i className={`companion-badge state-${status}`}/>}</span>;
  return <span className="agent-glyph companion-avatar" data-avatar={`${look.shape}-${look.color}`} data-state={status} data-animate={animate && visible ? "on" : "off"} style={{ width: dimension, height: dimension, "--companion-color": colors[look.color].value, "--companion-radius": shapes[look.shape].radius } as CSSProperties} aria-hidden="true">
    <span className="companion-body"><span className="companion-highlight"/><span className="companion-eyes"><span/><span/></span><span className="companion-cheek"/></span>
    {status !== "idle" && <i className={`companion-badge state-${status}`}/>}
  </span>;
}
