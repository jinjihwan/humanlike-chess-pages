/* Pure data helpers. No secrets, network or browser state in this module. */
export const ratingBucket = (elo) => [0,1000,1200,1400,1600,1800,2000,2200,2500].filter(x=>x<=elo).at(-1) ?? 0;
export const moveUci = (move) => move.from + move.to + (move.promotion || '');

// Opening Explorer can encode castling as king-to-rook (UCI_Chess960), even in
// standard chess. chess.js uses king-to-destination. These are the same move.
const CASTLE_TO_STANDARD = Object.freeze({
  e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8',
});
const CASTLE_TO_EXPLORER = Object.freeze({
  e1g1: 'e1h1', e1c1: 'e1a1', e8g8: 'e8h8', e8c8: 'e8a8',
});
export const normalizeExplorerUci = uci => CASTLE_TO_STANDARD[uci] || uci;

// For API play history, castling should use the king-to-rook representation.
// Only convert actual castling moves, not a hypothetical ordinary king move.
export function explorerMoveUci(move) {
  const uci = moveUci(move);
  if (/^O-O(?:[+#])?$/.test(move.san || '') || /^O-O-O(?:[+#])?$/.test(move.san || '') || /[kq]/.test(move.flags || '')) {
    return CASTLE_TO_EXPLORER[uci] || uci;
  }
  return uci;
}
export const gamesOf = (entry) => ['white','draws','black'].reduce((n,k)=>n+Math.max(0,Number(entry?.[k]||0)),0);
export function evaluateBook(data, legalUcis, minGames=500, coverage=0.90) {
  const total=gamesOf(data);
  const legal=new Set(legalUcis);
  const rawRows=(data?.moves||[]).map(x=>({...x,count:gamesOf(x)})).filter(x=>x.count>0);
  const rows=rawRows.filter(x=>legal.has(normalizeExplorerUci(x.uci))).map(x=>({...x,matchedUci:normalizeExplorerUci(x.uci)})).sort((a,b)=>b.count-a.count);
  const rawRepresented=rawRows.reduce((n,x)=>n+x.count,0);
  const represented=rows.reduce((n,x)=>n+x.count,0);
  const stats={total,represented,rawRepresented,rawCount:rawRows.length,legalCount:rows.length,excluded:rawRows.filter(x=>!legal.has(normalizeExplorerUci(x.uci))).map(x=>x.uci)};
  if (total < minGames) return {ok:false,reason:`표본 ${total.toLocaleString('ko-KR')}판이 최소 ${minGames.toLocaleString('ko-KR')}판보다 적습니다.`,...stats};
  if (!rows.length) return {ok:false,reason:`합법적 통계 후보가 없습니다. (원본 후보 ${rawRows.length}개, 제외된 UCI: ${stats.excluded.slice(0,5).join(', ')||'없음'})`,...stats};
  if (represented / total < coverage) {
    const f = n=>(100*n/total).toFixed(1)+'%';
    return {ok:false,reason:`후보 포함 비율 ${f(represented)} (기준 ${Math.round(100*coverage)}%). API 원본 후보 ${rawRows.length}개 합계 ${f(rawRepresented)}, 합법 판정 ${rows.length}개 합계 ${f(represented)}${stats.excluded.length?`, 제외 ${stats.excluded.length}개 [${stats.excluded.slice(0,5).join(', ')}]`:''}.`,...stats};
  }
  return {ok:true,rows,...stats};
}
export function weightedChoice(rows, random=Math.random){
  const sum=rows.reduce((n,x)=>n+x.count,0);
  if(sum<=0) throw new Error('유효한 수 선택 가중치가 없습니다.');
  let r=random()*sum;
  for(const row of rows){r-=row.count;if(r<0)return row;}
  return rows.at(-1);
}
