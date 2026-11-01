import { describe, expect, it } from 'vitest';
import { qActionForState, qCrop, qFrame } from './q-avatar-motion';

describe('Q avatar playback', () => {
  it('uses the upper part of every source cell for head thumbnails',()=>{
    for(let action=0;action<14;action++)for(let column=0;column<4;column++){
      const full=qCrop(action,column).viewBox.split(' ').map(Number);
      const head=qCrop(action,column,true).viewBox.split(' ').map(Number);
      expect(head[0]).toBeGreaterThan(full[0]);expect(head[1]).toBe(full[1]);
      expect(head[0]+head[2]).toBeLessThan(full[0]+full[2]);expect(head[3]).toBeLessThan(full[3]);
      expect(head[2]).toBe(head[3]);
    }
  });
  it('finishes celebration and apology instead of repeating them', () => {
    for (const action of [1,3,8,9,10,11,12,13]) {
      expect(qFrame(action,7000)).toEqual({action:0,column:0});
      expect(qFrame(action,70000)).toEqual({action:0,column:0});
    }
  });
  it('keeps confirmation and connection states separate from failure', () => {
    expect(qActionForState('approval')).toBe(12);
    expect(qActionForState('failed')).toBe(11);
    expect(qActionForState('offline')).toBe(0);
    expect(qActionForState('paused')).toBe(0);
    expect(qActionForState('working')).toBe(6);
  });
  it('keeps all 56 crops inside their own cells without neighboring frames', () => {
    for (let action=0;action<14;action++) for (let column=0;column<4;column++) {
      const {sheet,viewBox} = qCrop(action,column);
      const [x,y,w,h] = viewBox.split(' ').map(Number), cell = sheet.width/4;
      expect(x).toBeGreaterThanOrEqual(column*cell);
      expect(x+w).toBeLessThanOrEqual((column+1)*cell);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y+h).toBeLessThanOrEqual(sheet.height);
      expect(w).toBe(h);
    }
  });
});
