import { useEffect, useRef, useState } from 'react';
import { qCrop, qFrame, qSheets } from '../q-avatar-motion';
import { SpriteTransition } from './SpriteTransition';
import './q-avatar.css';

const base = '/companions/blue-q/';
let decoded: Promise<void> | undefined;
function preload() {
  return decoded ??= Promise.all(qSheets.map(sheet => {
    const image = new Image(); image.src = base + sheet.file; return image.decode();
  })).then(() => undefined).catch(error => { decoded = undefined; throw error; });
}
export function QAvatar({action = 0,animate = true,size = 40,portrait=false}: {action?: number;animate?: boolean;size?: number;portrait?:boolean}) {
  const [playback,setPlayback] = useState({action,elapsed:0});
  const elapsed=playback.action===action?playback.elapsed:0;
  const clock = useRef(0);
  useEffect(() => {clock.current = 0;setPlayback({action,elapsed:0});},[action]);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let previous = performance.now();
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const tick = () => {
      const now = performance.now();
      if (!document.hidden && !preference.matches) {
        clock.current += Math.min(now - previous,100); setPlayback({action,elapsed:clock.current});
      }
      previous = now; timer = setTimeout(tick,60);
    };
    if (animate) void preload().then(() => {if (!disposed) {previous = performance.now();tick();}}).catch(() => { /* first frame remains available */ });
    return () => {disposed = true; clearTimeout(timer);};
  },[action,animate]);
  const frame = qFrame(action,elapsed), {sheet,viewBox} = qCrop(frame.action,frame.column,portrait);
  return <span className="q-avatar" data-portrait={portrait} data-q-action={frame.action} data-q-frame={frame.column} style={{width:size,height:size}} aria-hidden="true">
    <SpriteTransition frameKey={`${frame.action}:${frame.column}:${portrait}`} animate={animate} duration={frame.action===0?70:140}>
    <svg viewBox={viewBox} focusable="false"><image href={base + sheet.file} width={sheet.width} height={sheet.height}/></svg>
    </SpriteTransition>
  </span>;
}
