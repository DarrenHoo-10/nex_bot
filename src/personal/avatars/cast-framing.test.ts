import { describe, expect, it } from 'vitest';
import sprites from './character-sprites.json';
import { castFraming } from './cast-framing';

describe('cast sheet registration',()=>{
  for(const id of Object.keys(sprites.characters) as (keyof typeof sprites.characters)[]) {
    it(`${id}: neutral and thinking retain body size and floor`,()=>{
      const rest=castFraming(id,true,sprites.characters[id].idleColumn).body;
      const neutral=castFraming(id,false,0).body;
      expect(neutral.height).toBeCloseTo(rest.height);
      for(let frame=0;frame<12;frame++) {
        const body=castFraming(id,false,frame).body;
        expect(body.y+body.height).toBeCloseTo(rest.y+rest.height);
        expect(body.x+body.width/2).toBeCloseTo(185);
        if(frame===2||frame===3) expect(Math.abs(body.height/rest.height-1)).toBeLessThan(.04);
      }
    });
    it(`${id}: arm and hair width changes do not zoom the portrait`,()=>{
      const sides=Array.from({length:12},(_,frame)=>castFraming(id,false,frame).portrait.split(' ').map(Number)[2]);
      expect(new Set(sides).size).toBe(1);
    });
  }
});
