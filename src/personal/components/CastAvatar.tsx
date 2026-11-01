import { useEffect, useState } from 'react';
import type { CharacterId } from '../avatars/character-catalog';
import type { CompanionState } from '../avatars/appearance';
import sprites from '../avatars/character-sprites.json';
import { castFraming } from '../avatars/cast-framing';
import { SpriteTransition } from './SpriteTransition';
import './q-avatar.css';

const base = '/companions/cast/';
const decoded = new Map<string,Promise<void>>();
function preload(file: string) {
  let pending = decoded.get(file);
  if (!pending) {
    const image = new Image(); image.src = base + file;
    pending = image.decode().catch(error => {decoded.delete(file);throw error;}); decoded.set(file,pending);
  }
  return pending;
}

export function CastAvatar({id,state,size,animate,portrait=false,gesture}: {id:Exclude<CharacterId,'blue-maid'>;state:CompanionState;size:number;animate:boolean;portrait?:boolean;gesture?:number}) {
  const character = sprites.characters[id];
  const playbackKey=`${id}:${state}:${gesture??'none'}`;
  const [clock,setClock] = useState({key:playbackKey,elapsed:0});
  const elapsed=clock.key===playbackKey?clock.elapsed:0;
  useEffect(()=>{
    let disposed=false, timer: ReturnType<typeof setTimeout> | undefined, elapsed=0;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    setClock({key:playbackKey,elapsed:0});
    if (animate) void Promise.all([preload(sprites.idle.file),preload(character.file)]).then(()=>{
      if(disposed)return;
      let previous=performance.now();
      const tick=()=>{const now=performance.now();if(!document.hidden&&!preference.matches){elapsed+=Math.min(now-previous,120);setClock({key:playbackKey,elapsed});}previous=now;timer=setTimeout(tick,80);};
      tick();
    }).catch(()=>{/* Keep the initial pose if loading another sheet fails. */});
    return()=>{disposed=true;clearTimeout(timer);};
  },[playbackKey,animate,character.file]);
  // Six existing paired poses: acknowledge, think, work, celebrate, apologize, ask.
  const group = state==='idle'&&gesture!==undefined?gesture:({idle:-1,thinking:1,working:2,approval:5,done:3,failed:4,offline:-1,paused:-1})[state];
  const finished = (state==='done'||state==='failed') && elapsed>=2400;
  const idle = group<0 || finished;
  const phase = elapsed % 6000;
  const blink = phase<5400 ? 0 : phase<5500 ? 1 : phase<5620 ? 2 : phase<5720 ? 1 : 0;
  const index = idle ? character.idleColumn + blink*5 : group*2 + Number(elapsed>=650);
  const framing = castFraming(id,idle,index);
  const {sheet} = framing;
  // A fixed stage and clipped source rectangle keep neighboring sprites out.
  return <span className="q-avatar" data-portrait={portrait} data-character={id} data-cast-frame={index} style={{width:size,height:size}} aria-hidden="true">
    <SpriteTransition frameKey={`${sheet.file}:${index}:${portrait}`} animate={animate} duration={idle?120:160}>
    {portrait?<svg viewBox={framing.portrait} focusable="false"><image href={base+sheet.file} width={sheet.width} height={sheet.height}/></svg>:<svg viewBox="0 0 370 370" focusable="false"><svg {...framing.body} viewBox={framing.source} overflow="hidden"><image href={base+sheet.file} width={sheet.width} height={sheet.height}/></svg></svg>}
    </SpriteTransition>
  </span>;
}
