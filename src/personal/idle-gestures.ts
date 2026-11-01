import type { CharacterId } from './avatars/character-catalog';

export type IdleGesture = {id:number;serial:number};
const blueGestures = [1,3,4,5,7,8,10,13];
const castGestures = [0,1,3];
export function startIdleGestures(character:CharacterId,onChange:(gesture:IdleGesture|undefined)=>void,random = Math.random) {
  let timer:ReturnType<typeof setTimeout>, serial=0, last=-1, stopped=false;
  const schedule = () => {
    timer=setTimeout(()=>{
      if(stopped)return;
      const pool=(character==='blue-maid'?blueGestures:castGestures).filter(id=>id!==last);
      const id=pool[Math.min(pool.length-1,Math.floor(random()*pool.length))];last=id;
      onChange({id,serial:++serial});
      // Let each blue action finish one sequence, including a single eating/drinking cycle.
      const duration=character==='blue-maid'?({1:2160,3:2540,4:3050,5:3850,7:6700,8:2450,10:2750,13:2750}[id]??3000):2400;
      timer=setTimeout(()=>{if(stopped)return;onChange(undefined);schedule();},duration);
    },5000);
  };
  schedule();
  return ()=>{stopped=true;clearTimeout(timer);};
}
