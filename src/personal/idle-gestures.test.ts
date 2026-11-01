import { afterEach,describe,expect,it,vi } from 'vitest';
import { startIdleGestures } from './idle-gestures';
import { companionState } from './avatars/appearance';

afterEach(()=>vi.useRealTimers());
describe('idle gestures and task state',()=>{
  it('waits before a gesture, finishes it, then rests before a different gesture',()=>{
    vi.useFakeTimers();const change=vi.fn();const stop=startIdleGestures('blue-maid',change,()=>0);
    vi.advanceTimersByTime(4999);expect(change).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);expect(change).toHaveBeenLastCalledWith({id:1,serial:1});
    vi.advanceTimersByTime(2160);expect(change).toHaveBeenLastCalledWith(undefined);
    vi.advanceTimersByTime(4999);expect(change).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);expect(change).toHaveBeenLastCalledWith({id:3,serial:2});stop();
  });
  it('cancels a pending or active gesture when the owner stops the loop',()=>{
    vi.useFakeTimers();const change=vi.fn();let stop=startIdleGestures('blue-maid',change,()=>0);
    stop();vi.advanceTimersByTime(30000);expect(change).not.toHaveBeenCalled();
    stop=startIdleGestures('orange-flower',change,()=>0);
    vi.advanceTimersByTime(5000);expect(change).toHaveBeenLastCalledWith({id:0,serial:1});
    stop();vi.advanceTimersByTime(60000);expect(change).toHaveBeenCalledTimes(1);
  });
  it('uses only available neutral/positive poses for each cast member',()=>{
    vi.useFakeTimers();
    for(const character of ['orange-flower','white-dragon','purple-cat','gold-bat'] as const){
      const change=vi.fn(),stop=startIdleGestures(character,change,()=>.99);
      vi.advanceTimersByTime(5000);expect(change).toHaveBeenLastCalledWith({id:3,serial:1});stop();
    }
  });
  it('asks for reconciliation without treating it as failure',()=>{
    expect(companionState({status:'needs_reconciliation'})).toBe('approval');
    expect(companionState({status:'failed'})).toBe('failed');
    expect(companionState({status:'needs_reconciliation'},false,false)).toBe('offline');
    expect(companionState({status:'cancelled'})).toBe('paused');
  });
});
