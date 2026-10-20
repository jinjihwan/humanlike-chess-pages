/* Pure data helpers. No secrets, network or browser state in this module. */
export const ratingBucket = (elo) => [0,1000,1200,1400,1600,1800,2000,2200,2500].filter(x=>x<=elo).at(-1) ?? 0;
export const moveUci = (move) => move.from + move.to + (move.promotion || '');
export const gamesOf = (entry) => ['white','draws','black'].reduce((n,k)=>n+Math.max(0,Number(entry?.[k]||0)),0);
export function evaluateBook(data, legalUcis, minGames=500, coverage=0.90) {
  const total=gamesOf(data);
  if (total < minGames) return {ok:false,reason:`표본 ${total.toLocaleString('ko-KR')}판이 최소 ${minGames.toLocaleString('ko-KR')}판보다 적습니다.`};
  const legal=new Set(legalUcis);
  const rows=(data?.moves||[]).filter(x=>legal.has(x.uci)).map(x=>({...x,count:gamesOf(x)})).filter(x=>x.count>0).sort((a,b)=>b.count-a.count);
  const represented=rows.reduce((n,x)=>n+x.count,0);
  if(!rows.length) return {ok:false,reason:'합법적인 통계 후보가 없습니다.'};
  if(represented/total<coverage) return {ok:false,reason:`상위 후보 포함 비율 ${(100*represented/total).toFixed(1)}%가 요구 기준 ${Math.round(100*coverage)}% 미만입니다.`};
  return {ok:true,total,represented,rows};
}
export function weightedChoice(rows, random=Math.random){
  const sum=rows.reduce((n,x)=>n+x.count,0);
  if(sum<=0) throw new Error('유효한 수 선택 가중치가 없습니다.');
  let r=random()*sum;
  for(const row of rows){r-=row.count;if(r<0)return row;}
  return rows.at(-1);
}
