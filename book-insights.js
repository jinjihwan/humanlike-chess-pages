/* Pure helpers for Lichess result breakdowns and on-board book arrows. */
export function rates(entry, sideToMove) {
  const white=Math.max(0, Number(entry?.white)||0);
  const draws=Math.max(0, Number(entry?.draws)||0);
  const black=Math.max(0, Number(entry?.black)||0);
  const total=white+draws+black;
  const toPercent=n=>total?100*n/total:0;
  return {
    total, white:toPercent(white), draws:toPercent(draws), black:toPercent(black),
    win:toPercent(sideToMove==='b'?black:white),
    loss:toPercent(sideToMove==='b'?white:black),
    draw:toPercent(draws),
  };
}
export const selectPct=(count,total)=> total>0 ? (100*count/total) : 0;
const FILES='abcdefgh';
export function squareCenter(square, whiteAtBottom=true) {
  if (!/^[a-h][1-8]$/.test(square || '')) throw new Error('Invalid chess square');
  const f=FILES.indexOf(square[0]), rank=Number(square[1]);
  return {x: whiteAtBottom ? (f+.5)*100 : (7.5-f)*100,
          y: whiteAtBottom ? (8.5-rank)*100 : (rank-.5)*100};
}
export function arrowGeometry(from,to,whiteAtBottom=true) {
  const a=squareCenter(from,whiteAtBottom),b=squareCenter(to,whiteAtBottom);
  const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
  if(length<1) throw new Error('Invalid arrow');
  const ux=dx/length,uy=dy/length;
  // Keep end marker close to, but not directly over, the destination square.
  const end={x:b.x-ux*15,y:b.y-uy*15};
  const start={x:a.x+ux*18,y:a.y+uy*18};
  return {start,end,label:{x:b.x,y:b.y},angle:Math.atan2(dy,dx)};
}
