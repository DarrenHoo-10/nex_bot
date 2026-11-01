import type { CompanionState } from './avatars/appearance';

export const qActionNames = ['待机眨眼','挥手招呼','托腮思考','开心点头','吃饭饭','喝口水','认真工作','困困打盹','收到任务','完成庆祝','递交成果','低头道歉','等待确认','重试打气'] as const;
export const qSheets = [
  {file:'actions-alpha.png',width:1254,height:1254,rows:4},
  {file:'actions-daily-alpha.png',width:1254,height:1254,rows:4},
  {file:'actions-success-v2-alpha.png',width:1447,height:1087,rows:3},
  {file:'actions-recovery-alpha.png',width:1448,height:1086,rows:3},
];
const sequences: [number,number][][] = [
  [[0,2900],[1,85],[2,110],[1,85],[0,1600]],
  [[0,300],[1,220],[2,240],[3,260],[2,240],[3,900]],
  [[0,1300],[1,450],[2,900],[3,1800]],
  [[0,500],[1,240],[2,800],[3,1000]],
  [[0,750],[1,300],[2,500],[3,1500]],
  [[0,1000],[1,350],[2,1100],[3,1400]],
  [[0,650],[1,350],[3,600],[1,350],[2,250],[3,900]],
  [[0,1600],[1,1100],[2,2600],[3,1400]],
  [[0,450],[1,450],[2,450],[3,1100]],
  [[0,350],[1,450],[2,850],[3,1000]],
  [[0,450],[1,500],[2,800],[3,1000]],
  [[0,450],[1,550],[2,700],[3,1000]],
  [[0,500],[1,600],[2,800],[3,1400]],
  [[0,650],[1,500],[2,600],[3,1000]],
];
export function qActionForState(state: CompanionState) {
  return ({idle:0,thinking:2,working:6,approval:12,done:9,failed:11,offline:0,paused:0})[state];
}
export function qFrame(action: number, elapsed: number) {
  const sequence = sequences[action] ?? sequences[0];
  const duration = sequence.reduce((n,entry) => n + entry[1],0);
  // Finite gestures return to neutral; they never keep celebrating or apologizing.
  const loop = [0,2,4,5,6,7].includes(action);
  if (!loop && elapsed >= duration) return {action:0,column:0};
  let time = Math.max(0,elapsed) % duration;
  for (const [column,ms] of sequence) { if (time < ms) return {action,column}; time -= ms; }
  return {action,column:0};
}
export function qCrop(action: number, column: number, portrait=false) {
  const index = action < 4 ? 0 : action < 8 ? 1 : action < 11 ? 2 : 3;
  const row = action - [0,4,8,11][index], sheet = qSheets[index];
  const cell = sheet.width / 4;
  const top = index === 2 ? [0,354,700][row] : row * sheet.height / sheet.rows;
  // The standalone character has no circular crop; retain hair, hands and feet.
  return {sheet,viewBox:(portrait?[column*cell+cell*.12,top,cell*.76,cell*.76]:[column * cell,top,cell,Math.min(cell,sheet.height-top)]).join(' ')};
}
