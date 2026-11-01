import { useEffect, useState, type ReactNode } from 'react';

// Retain the last rendered pose across action changes. Only two layers may
// exist, even when a real task interrupts a gesture mid-transition.
export function SpriteTransition({frameKey,children,animate=true,duration=160}: {
  frameKey:string;children:ReactNode;animate?:boolean;duration?:number;
}) {
  const [reduced,setReduced]=useState(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [hidden,setHidden]=useState(()=>document.hidden);
  const blend=animate&&!reduced&&!hidden;
  const [pose,setPose]=useState({key:frameKey,current:children,previous:undefined as ReactNode});
  if(pose.key!==frameKey) {
    setPose({key:frameKey,current:children,previous:blend?pose.current:undefined});
  }
  useEffect(()=>{
    const preference=matchMedia('(prefers-reduced-motion: reduce)');
    const update=()=>{setReduced(preference.matches);setHidden(document.hidden);};
    preference.addEventListener('change',update);document.addEventListener('visibilitychange',update);
    return()=>{preference.removeEventListener('change',update);document.removeEventListener('visibilitychange',update);};
  },[]);
  useEffect(()=>{
    if(!pose.previous)return;
    const clear=()=>setPose(current=>current.key===frameKey?{...current,previous:undefined}:current);
    if(!blend){clear();return;}
    const timer=setTimeout(clear,duration);
    return()=>clearTimeout(timer);
  },[frameKey,pose.previous,blend,duration]);
  const transitioning=blend&&!!pose.previous;
  return <span className="sprite-transition" data-transitioning={transitioning}>
    {transitioning&&<span className="sprite-layer sprite-leaving" key={`old-${pose.key}`} style={{animationDuration:`${duration}ms`}}>{pose.previous}</span>}
    <span className={`sprite-layer${transitioning?' sprite-entering':''}`} key={pose.key} style={{animationDuration:`${duration}ms`}}>{children}</span>
  </span>;
}
