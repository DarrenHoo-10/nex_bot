import { describe,expect,it } from 'vitest';
import { resolvePreviewAppearance } from './local-preview';
import { characterIds } from './character-catalog';

describe('local avatar choices',()=>{
  const fallback = {kind:'graphic',id:'secretary-01'} as const;
  it('restores every named character after saving and reloading',()=>{
    for(const id of characterIds) expect(resolvePreviewAppearance(JSON.stringify({kind:'q',id}),fallback,true)).toEqual({kind:'q',id});
  });
  it('keeps the explicit choice instead of forcing Q on the first bot',()=>{
    const other = {kind:'graphic',id:'female-03'} as const;
    expect(resolvePreviewAppearance(JSON.stringify(other),fallback,true)).toEqual(other);
    expect(resolvePreviewAppearance(JSON.stringify({kind:'q',id:'blue-maid'}),other,false)).toEqual({kind:'q',id:'blue-maid'});
  });
  it('safely ignores corrupt or unknown local preferences',()=>{
    expect(resolvePreviewAppearance('{',fallback,true)).toEqual({kind:'q',id:'blue-maid'});
    expect(resolvePreviewAppearance('{"kind":"q","id":"missing"}',fallback,false)).toEqual(fallback);
  });
});
