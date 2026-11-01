// @vitest-environment happy-dom
import {act,createElement,useLayoutEffect} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SpriteTransition} from './SpriteTransition';
import {QAvatar} from './QAvatar';
import {CastAvatar} from './CastAvatar';

let root:Root,container:HTMLDivElement,reduced=false;
const listeners=new Set<()=>void>();
beforeEach(()=>{
  vi.useFakeTimers();reduced=false;listeners.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.spyOn(document,'hidden','get').mockReturnValue(false);
  vi.stubGlobal('matchMedia',()=>({get matches(){return reduced;},addEventListener:(_event:string,fn:()=>void)=>listeners.add(fn),removeEventListener:(_event:string,fn:()=>void)=>listeners.delete(fn)}));
  vi.stubGlobal('Image',class {src='';decode(){return Promise.resolve();}});
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
const renderPose=(key:string)=>act(()=>root.render(createElement(SpriteTransition,{frameKey:key,children:createElement('svg',{'data-pose':key})})));
it('retains a pose through entry and exit, then releases it',()=>{
  renderPose('idle');renderPose('thinking');
  expect(container.querySelectorAll('.sprite-layer')).toHaveLength(2);
  expect(container.querySelector('.sprite-leaving [data-pose]')?.getAttribute('data-pose')).toBe('idle');
  act(()=>vi.advanceTimersByTime(160));
  expect(container.querySelectorAll('.sprite-layer')).toHaveLength(1);
  renderPose('idle');
  expect(container.querySelector('.sprite-leaving [data-pose]')?.getAttribute('data-pose')).toBe('thinking');
});
it('a task interrupts a gesture without stacking layers or stale cleanup',()=>{
  renderPose('idle');renderPose('eating');
  act(()=>vi.advanceTimersByTime(80));renderPose('working');
  act(()=>vi.advanceTimersByTime(80));
  expect(container.querySelectorAll('.sprite-layer')).toHaveLength(2);
  expect(container.querySelector('.sprite-entering [data-pose]')?.getAttribute('data-pose')).toBe('working');
  act(()=>vi.advanceTimersByTime(80));
  expect(container.querySelectorAll('.sprite-layer')).toHaveLength(1);
});
it('removes transitions when reduced motion is enabled',()=>{
  renderPose('idle');renderPose('thinking');
  act(()=>{reduced=true;listeners.forEach(fn=>fn());});
  expect(container.querySelectorAll('.sprite-layer')).toHaveLength(1);
  renderPose('idle');expect(container.querySelectorAll('.sprite-layer')).toHaveLength(1);
});
it('blue actions start at zero before the first paint instead of inheriting idle time',async()=>{
  const seen:string[]=[];
  function Probe({action}:{action:number}) {
    useLayoutEffect(()=>{seen.push(container.querySelector('[data-q-action]')!.getAttribute('data-q-action')!);},[action]);
    return createElement(QAvatar,{action});
  }
  await act(async()=>root.render(createElement(Probe,{action:0})));
  act(()=>vi.advanceTimersByTime(5000));
  await act(async()=>root.render(createElement(Probe,{action:11})));
  expect(seen).toEqual(['0','11']);
});
it('cast failure starts on its action frame even after long idle',async()=>{
  const seen:string[]=[];
  function Probe({failed}:{failed:boolean}) {
    useLayoutEffect(()=>{seen.push(container.querySelector('[data-cast-frame]')!.getAttribute('data-cast-frame')!);},[failed]);
    return createElement(CastAvatar,{id:'orange-flower',state:failed?'failed':'idle',size:180,animate:true});
  }
  await act(async()=>root.render(createElement(Probe,{failed:false})));
  act(()=>vi.advanceTimersByTime(5000));
  await act(async()=>root.render(createElement(Probe,{failed:true})));
  expect(seen).toEqual(['1','8']);
});
