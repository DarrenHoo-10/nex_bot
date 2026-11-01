import { useEffect, useState, type CSSProperties } from "react";
import type { RecordRow } from "../api";
import { AVATARS } from "../avatars";
import { appearanceOf, colors, shapes, type CompanionState } from "../avatars/appearance";
import { useLocalAppearance, type PreviewAppearance } from '../avatars/local-preview';
import { GraphicPortrait } from "./GraphicPortrait";
import { QAvatar } from './QAvatar';
import { CastAvatar } from './CastAvatar';
import { qActionForState } from '../q-avatar-motion';
import { useIdleGesture } from '../use-idle-gesture';

export function AgentAvatar({ bot, allBots, size = 36, large, working, state, appearance, animate = false, idleGestures = false }: {
  bot?: RecordRow; allBots?: RecordRow[]; size?: number; large?: boolean; working?: boolean; interactive?: boolean;
  state?: CompanionState; appearance?: PreviewAppearance; animate?: boolean; idleGestures?:boolean;
}) {
  const localLook = useLocalAppearance(bot,String(allBots?.[0]?.id ?? ''));
  const look = appearance ?? localLook ?? appearanceOf(bot, String(allBots?.[0]?.id ?? ""));
  const status = state ?? (working ? "working" : "idle");
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => { const change = () => setVisible(!document.hidden); document.addEventListener("visibilitychange", change); return () => document.removeEventListener("visibilitychange", change); }, []);
  const dimension = large ? Math.max(64, size) : size;
  const gesture=useIdleGesture(look.kind==='q'?look.id:'blue-maid',String(bot?.id??''),idleGestures&&look.kind==='q'&&status==='idle'&&animate&&visible);
  const portrait=dimension<=48;
  if (look.kind === 'q') return <span className="agent-glyph q-agent-avatar" data-avatar={look.id} data-state={status} data-idle-gesture={gesture?.id} data-framing={portrait?'head':'body'} style={{width:dimension,height:dimension}} aria-hidden="true">{look.id === 'blue-maid' ? <QAvatar key={look.id} action={gesture?.id??qActionForState(status)} animate={animate && visible} size={dimension} portrait={portrait}/> : <CastAvatar key={look.id} id={look.id} state={status} gesture={gesture?.id} animate={animate && visible} size={dimension} portrait={portrait}/>} {status !== 'idle' && <i className={`companion-badge state-${status}`}/>}</span>;
  if (look.kind === "graphic") return <span className="agent-glyph graphic-avatar" data-avatar={look.id} data-state={status} data-animate={animate && visible ? "on" : "off"} style={{ width: dimension, height: dimension }} aria-hidden="true"><GraphicPortrait key={`${look.id}-${status}`} id={look.id}/>{status !== "idle" && <i className={`companion-badge state-${status}`}/>}</span>;
  if (look.kind === "portrait") return <span className="agent-glyph portrait-avatar" data-avatar={look.id} data-state={status} style={{ width: dimension, height: dimension }} aria-hidden="true"><img src={AVATARS.find((item) => item.id === look.id)!.src} alt="" draggable={false}/>{status !== "idle" && <i className={`companion-badge state-${status}`}/>}</span>;
  return <span className="agent-glyph companion-avatar" data-avatar={`${look.shape}-${look.color}`} data-state={status} data-animate={animate && visible ? "on" : "off"} style={{ width: dimension, height: dimension, "--companion-size": `${dimension}px`, "--companion-color": colors[look.color].value, "--companion-radius": shapes[look.shape].radius } as CSSProperties} aria-hidden="true">
    <span className="companion-body"><span className="companion-highlight"/><span className="companion-eyes"><span/><span/></span><span className="companion-cheek"/></span>
    {status !== "idle" && <i className={`companion-badge state-${status}`}/>}
  </span>;
}
