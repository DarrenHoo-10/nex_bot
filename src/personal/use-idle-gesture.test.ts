// @vitest-environment happy-dom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useIdleGesture} from './use-idle-gesture';

let root:Root,container:HTMLDivElement,hidden=false,reduced=false;
const changes=new Set<()=>void>();
function Probe({enabled}:{enabled:boolean}) {
  const gesture=useIdleGesture('blue-maid','fixture',enabled);
  return createElement('span',{'data-gesture':gesture?.id});
}
beforeEach(()=>{
  vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(0);
  hidden=false;reduced=false;changes.clear();
  vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('matchMedia',()=>({get matches(){return reduced;},addEventListener:(_name:string,fn:()=>void)=>changes.add(fn),removeEventListener:(_name:string,fn:()=>void)=>changes.delete(fn)}));
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
const gesture=()=>container.querySelector('span')?.getAttribute('data-gesture');
it('interrupts an active idle gesture immediately when a real task starts',()=>{
  act(()=>root.render(createElement(Probe,{enabled:true})));
  act(()=>vi.advanceTimersByTime(5000));expect(gesture()).toBe('1');
  act(()=>root.render(createElement(Probe,{enabled:false})));expect(gesture()).toBeNull();
  act(()=>vi.advanceTimersByTime(60000));expect(gesture()).toBeNull();
});
it('stops for hidden/reduced-motion and restarts with a fresh idle delay',()=>{
  act(()=>root.render(createElement(Probe,{enabled:true})));
  act(()=>vi.advanceTimersByTime(5000));expect(gesture()).toBe('1');
  act(()=>{hidden=true;document.dispatchEvent(new Event('visibilitychange'));});expect(gesture()).toBeNull();
  act(()=>vi.advanceTimersByTime(60000));expect(gesture()).toBeNull();
  act(()=>{hidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  act(()=>vi.advanceTimersByTime(4999));expect(gesture()).toBeNull();
  act(()=>vi.advanceTimersByTime(1));expect(gesture()).toBe('1');
  act(()=>{reduced=true;for(const change of changes)change();});expect(gesture()).toBeNull();
  act(()=>vi.advanceTimersByTime(60000));expect(gesture()).toBeNull();
});
