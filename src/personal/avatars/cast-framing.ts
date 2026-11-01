import sprites from './character-sprites.json';
import type { CharacterId } from './character-catalog';

export function castFraming(id: Exclude<CharacterId,'blue-maid'>, idle: boolean, frame: number) {
  const character = sprites.characters[id];
  const sheet = idle ? sprites.idle : character;
  const [x,y,width,height] = sheet.frames[frame];
  const rest = sprites.idle.frames[character.idleColumn];
  // Calibrate once per sheet against the neutral standing pose. Do not stretch
  // each pose to a target height: bowing and blinking must retain their motion.
  const scale = idle ? 1 : rest[3] / character.frames[0][3];
  const displayWidth = width*scale, displayHeight = height*scale;
  const portraitSide = rest[2]*.68/scale;
  return {
    sheet, source: [x,y,width,height].join(' '),
    body: {x:(370-displayWidth)/2,y:365-displayHeight,width:displayWidth,height:displayHeight},
    portrait: [x+(width-portraitSide)/2,y,portraitSide,portraitSide].join(' '),
  };
}
