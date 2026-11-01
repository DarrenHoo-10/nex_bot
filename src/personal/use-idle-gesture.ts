import { useEffect,useState } from 'react';
import type { CharacterId } from './avatars/character-catalog';
import { startIdleGestures,type IdleGesture } from './idle-gestures';

export function useIdleGesture(character:CharacterId,owner:string,enabled:boolean) {
  const [gesture,setGesture]=useState<IdleGesture>();
  useEffect(()=>{
    if(!enabled){setGesture(undefined);return;}
    const preference=matchMedia('(prefers-reduced-motion: reduce)');
    let stop:(()=>void)|undefined;
    const reset=()=>{stop?.();stop=undefined;setGesture(undefined);if(enabled&&!document.hidden&&!preference.matches)stop=startIdleGestures(character,setGesture);};
    reset();document.addEventListener('visibilitychange',reset);preference.addEventListener('change',reset);
    return()=>{stop?.();document.removeEventListener('visibilitychange',reset);preference.removeEventListener('change',reset);};
  },[character,owner,enabled]);
  return enabled?gesture:undefined;
}
