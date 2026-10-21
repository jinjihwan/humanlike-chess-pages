import { Chess } from 'chess.js';
import {ratingBucket,moveUci,normalizeExplorerUci,explorerMoveUci, gamesOf, evaluateBook, weightedChoice} from './book.js';
import {LiveEngine,ENGINE_SCRIPT,formatWhiteScore,whitePerspective,sanVariation} from './engine-analysis.js';
import {ReviewScorer,moveComparison,signedPawns,uciPosition} from './review-analysis.js';
import {rates,selectPct,arrowGeometry} from './book-insights.js';
import { Maia1 } from './maia1.js';

'use strict';
const $ = id => document.getElementById(id);
const PIECES={k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟',K:'♚',Q:'♛',R:'♜',B:'♝',N:'♞',P:'♟'};
const NAMES={k:'킹',q:'퀸',r:'룩',b:'비숍',n:'나이트',p:'폰'};
const SPEED_LABELS={bullet:'불릿',blitz:'블리츠',rapid:'래피드',classical:'클래시컬'};
const START_FEN='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BOOK_LIMIT=30;
const MODEL_URL='https://huggingface.co/cemoss17/maia3-onnx/resolve/main/maia3_5m.onnx';
const WASM_URL='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
let game=null, activeColor='white', busy=false, selected=null, promotionOptions=null;
let lichessToken='', maia=null, maiaPromise=null, recentBookErrors=0;
const maia1Models=new Map(), maia1Promises=new Map();
const MAIA1_TYPES={'maia1-1100':1100,'maia1-1500':1500,'maia1-1800':1800,'maia1-1900':1900};
const modelName=m=>m==='maia1-1800'?'공식 Maia 1800':m==='maia1-1900'?'Lichess Maia 1900 (@maia9)':m==='maia3'?'Maia-3 5M':`Maia-1 ${MAIA1_TYPES[m]}`;
let liveEngine=null, lastEngineEvaluation=null, reviewScorer=null;
let showBookArrows=false;
const escapeHtml = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shortNum = n => Number(n).toLocaleString('ko-KR');
const currentColor = () => game?.options.color || activeColor;
const toColor = c => c==='w'?'white':'black';
function placementMap(fen){const map={};fen.split(' ')[0].split('/').forEach((row,ri)=>{let fi=0;for(const c of row){if(/[1-8]/.test(c)){fi+=Number(c)}else{map['abcdefgh'[fi]+String(8-ri)]=c;fi++}}});return map}
function isPlaying(){return game && !game.resigned && !game.ended && !game.chess.isGameOver()}
function isHumanTurn(){return isPlaying() && !game.reviewMode && toColor(game.chess.turn())===game.options.color}
function playableMoves(){return isHumanTurn()?game.chess.moves({verbose:true}):[]}
function getSettings(){return {elo:Number($('elo').value),color:activeColor,speed:$('speed').value,minGames:Number($('min-games').value),model:$('model').value,useBook:$('use-opening-book').checked,startMode:$('start-mode').value,startMoves:$('start-moves').value.trim(),startFen:$('start-fen').value.trim()}}
function setBusy(flag,bot=false){busy=flag;$('board-wait').classList.toggle('hidden',!flag||!bot);$('start-button').disabled=flag;$('top-new').disabled=flag;renderBoard();renderControls()}
function showError(message){const a=$('alert');a.textContent=message;a.classList.remove('hidden')}
function clearError(){$('alert').classList.add('hidden')}
function setMessage(message){$('move-feedback').textContent=message}

function configurePosition(opts){
  let chess=new Chess();let baseFen=START_FEN;let setupCount=0;
  if(opts.startMode==='fen'){
    if(!opts.startFen || opts.startFen.trim().split(/\s+/).length!==6) throw new Error('FEN은 6개 항목을 모두 입력해 주세요.');
    chess=new Chess(opts.startFen);
    baseFen=chess.fen();
  } else if(opts.startMode==='moves'){
    if(!opts.startMoves)throw new Error('시작할 오프닝 수순을 입력해 주세요.');
    const s=opts.startMoves.replace(/\{[^}]*\}/g,' ').replace(/\([^)]*\)/g,' ').replace(/\d+\s*\.{1,3}/g,' ').replace(/\b(?:1-0|0-1|1\/2-1\/2|\*)\b/g,' ');
    const toks=s.trim().split(/\s+/).filter(Boolean);
    if(toks.length>80)throw new Error('시작 수순은 최대 80반수까지 입력할 수 있어요.');
    for(const [i,tok] of toks.entries()){
      try{chess.move(tok.replace(/0-0-0/g,'O-O-O').replace(/0-0/g,'O-O'))}
      catch(_){throw new Error(`${i+1}번째 수 '${tok}'를 이해하지 못했습니다.`)}
    }
    setupCount=chess.history().length;
  }
  if(chess.isGameOver())throw new Error('이미 대국이 종료된 위치에서는 시작할 수 없습니다.');
  return {chess,baseFen,setupCount};
}
function drawSquares(container,pieces,preview=false,legal=[]){
 const whiteBottom=currentColor()==='white',ranks=whiteBottom?[8,7,6,5,4,3,2,1]:[1,2,3,4,5,6,7,8];
 const files=whiteBottom?'abcdefgh':'hgfedcba';const targets=new Set(legal.filter(m=>m.from===selected).map(m=>m.to));const fragment=document.createDocumentFragment();
 ranks.forEach((rank,ri)=>{for(let fi=0;fi<8;fi++){
   const file=files[fi],sq=file+rank,pc=pieces[sq],light=('abcdefgh'.indexOf(file)+rank)%2===0;
   const b=document.createElement(preview?'div':'button');if(!preview)b.type='button';
   b.className=`${preview?'preview-square':'square'} ${light?'light':'dark'}`;
   if(!preview){b.dataset.square=sq;if(selected===sq)b.classList.add('selected');if(!game?.reviewMode&&game?.lastMove&&[game.lastMove.from,game.lastMove.to].includes(sq))b.classList.add('last-move');
     if(viewedChess()?.isCheck() && viewedChess().get(sq)?.type==='k' && viewedChess().get(sq)?.color===viewedChess().turn())b.classList.add('checked');
     if(targets.has(sq))b.classList.add('legal-target');b.addEventListener('click',()=>clickSquare(sq));
     b.setAttribute('aria-label',`${sq} ${pc ? ((pc===pc.toUpperCase())?'백 ':'흑 ')+(NAMES[pc.toLowerCase()]||'기물'):'빈 칸'}`);
   }
   if(pc){if(!preview)b.classList.add('occupied');const span=document.createElement('span');span.className=(preview?'':'piece ')+(pc===pc.toUpperCase()?'white-piece':'black-piece');span.textContent=PIECES[pc];b.append(span)}
   if(!preview){if(fi===0){const c=document.createElement('span');c.className='coordinate rank';c.textContent=rank;b.append(c)}if(ri===7){const c=document.createElement('span');c.className='coordinate file';c.textContent=file;b.append(c)}}fragment.append(b)
 }});container.replaceChildren(fragment);
}
function positionAt(ply){
 const replay=new Chess(game.baseFen);
 for(const move of game.chess.history({verbose:true}).slice(0,ply))replay.move(move);
 return replay;
}
function viewedChess(){return game?.reviewMode?positionAt(game.reviewPly):game?.chess}
function renderBoard(){
 const preview=showBookArrows && game?.lastBot?.source==='lichess' && !game.reviewMode;
 const fen=preview ? game.lastBot.beforeFen : (viewedChess()?.fen()||START_FEN);
 drawSquares($('board'),placementMap(fen),false,!preview&&!busy?playableMoves():[]);
 // The arrows are for the position BEFORE the bot's move, not today's board.
 // Keep current board and engine state untouched, only change the visual preview.
 $('book-arrow-layer').replaceChildren();
 if(preview)renderBookArrows(game.lastBot);
}
function renderBookArrows(report){
 const ns='http://www.w3.org/2000/svg',svg=$('book-arrow-layer');
 const candidates=[report.selected,...report.alternatives].slice(0,4);
 candidates.forEach((item,index)=>{
  if(!item.from||!item.to)return;
  let g;try{g=arrowGeometry(item.from,item.to,currentColor()==='white')}catch(_){return}
  const chosen=index===0,color=chosen?'#00a57d':'#3488d7';
  const line=document.createElementNS(ns,'line');
  for(const [k,v] of Object.entries({x1:g.start.x,y1:g.start.y,x2:g.end.x,y2:g.end.y,stroke:color,'stroke-width':chosen?13:9,'stroke-linecap':'round',opacity:chosen?.93:.78}))line.setAttribute(k,String(v));
  svg.append(line);
  const head=document.createElementNS(ns,'polygon');
  const size=chosen?17:13, x=g.end.x,y=g.end.y,cos=Math.cos(g.angle),sin=Math.sin(g.angle);
  const corners=[[x+cos*size,y+sin*size],[x-cos*size/2-sin*size*.65,y-sin*size/2+cos*size*.65],[x-cos*size/2+sin*size*.65,y-sin*size/2-cos*size*.65]];
  head.setAttribute('points',corners.map(p=>p.join(',')).join(' '));head.setAttribute('fill',color);head.setAttribute('opacity','0.93');svg.append(head);
  // Keep the text in a compact, opaque label rather than overlapping the destination piece.
  const labelX=Math.min(735,Math.max(65,g.label.x)),labelY=Math.min(765,Math.max(35,g.label.y));
  const group=document.createElementNS(ns,'g');group.setAttribute('transform',`translate(${labelX},${labelY})`);
  const rect=document.createElementNS(ns,'rect');
  for(const [k,v] of Object.entries({x:-49,y:-15,width:98,height:31,rx:9,fill:'#11252a','fill-opacity':'.93',stroke:color,'stroke-width':3}))rect.setAttribute(k,String(v));
  group.append(rect);
  const text=document.createElementNS(ns,'text');
  for(const [k,v] of Object.entries({x:0,y:7,'text-anchor':'middle','font-size':22,'font-weight':800,fill:'#f5faf9'}))text.setAttribute(k,String(v));
  text.textContent=`${index+1} · ${item.percent.toFixed(1)}%`;
  group.append(text);svg.append(group);
 });
}
function renderBookRibbon(){
 const bar=$('book-ribbon'),report=game?.lastBot;
 const visible=report?.source==='lichess'&&!game.reviewMode;
 bar.classList.toggle('hidden',!visible);
 $('book-candidates-toggle').setAttribute('aria-pressed',String(showBookArrows&&visible));
 $('book-candidates-toggle').textContent=showBookArrows&&visible?'화살표 닫기':'후보 화살표';
 if(!visible){showBookArrows=false;return}
 const s=report.selected;
 $('book-ribbon-summary').textContent=`LICHESS · ${s.san} ${s.percent.toFixed(1)}% 선택 · 봇 승률 ${s.winRate.toFixed(1)}%`;
 $('book-ribbon-note').classList.toggle('hidden',!showBookArrows);
 const choices=$('book-ribbon-choices');
 choices.classList.toggle('hidden',!showBookArrows);
 if(showBookArrows){
  choices.replaceChildren();
  [report.selected,...report.alternatives].slice(0,4).forEach((item,i)=>{
   const chip=document.createElement('span');chip.className='book-choice-chip'+(i===0?' chosen':'');
   chip.textContent=`${i+1}. ${item.san} ${item.percent.toFixed(1)}%`;choices.append(chip);
  });
 }
}
function toggleBookArrows(){
 if(game?.lastBot?.source!=='lichess'||game.reviewMode)return;
 showBookArrows=!showBookArrows;
 selected=null;renderBookRibbon();renderBoard();
}

function clickSquare(square){if(showBookArrows||busy||!isHumanTurn())return;const moves=playableMoves();if(selected){const possibilities=moves.filter(m=>m.from===selected&&m.to===square);if(possibilities.length===1){selected=null;void humanMove(possibilities[0]);return}if(possibilities.length>1){promotionOptions=possibilities;showPromotion();return}}selected=moves.some(m=>m.from===square)?square:null;renderBoard()}
function showPromotion(){const popup=$('promotion-modal'),choices=$('promotion-choices');choices.replaceChildren();for(const kind of ['q','r','b','n']){const m=promotionOptions.find(x=>x.promotion===kind);if(!m)continue;const btn=document.createElement('button');btn.type='button';btn.textContent=PIECES[currentColor()==='white'?kind.toUpperCase():kind];btn.setAttribute('aria-label',`${NAMES[kind]}으로 승격`);btn.addEventListener('click',()=>{closePromotion();selected=null;void humanMove(m)});choices.append(btn)}popup.classList.remove('hidden')}
function closePromotion(){$('promotion-modal').classList.add('hidden');promotionOptions=null}
function setStartMode(){$('start-moves-area').classList.toggle('hidden',$('start-mode').value!=='moves');$('start-fen-area').classList.toggle('hidden',$('start-mode').value!=='fen');$('position-preview').classList.add('hidden');$('preview-error').classList.add('hidden')}
function previewPosition(){try{const p=configurePosition(getSettings());drawSquares($('preview-board'),placementMap(p.chess.fen()),true);$('preview-meta').textContent=`다음 차례: ${p.chess.turn()==='w'?'백':'흑'} · ${toColor(p.chess.turn())===activeColor?'내가 먼저':'봇이 먼저'}`;$('preview-fen').textContent=p.chess.fen();$('position-preview').classList.remove('hidden');$('preview-error').classList.add('hidden')}catch(e){$('preview-error').textContent=e.message;$('preview-error').classList.remove('hidden')}}

function renderControls(){if(!game){$('turn-pill').textContent='대국 대기 중';$('move-feedback').textContent='새 대국을 시작하세요';$('undo-button').disabled=true;$('pgn-button').disabled=true;$('resign-button').disabled=true;$('finish-button').disabled=true;$('review-start').disabled=true;$('review-prev').disabled=true;$('review-next').disabled=true;$('start-position-label').classList.add('hidden');return}
 const over=!isPlaying(),me=game.options.color==='black',ch=game.chess;
 $('top-player').textContent=`Humanlike Bot · ${game.options.model==='maia3'?game.options.elo:MAIA1_TYPES[game.options.model]}`;$('top-player-sub').textContent=`${game.options.useBook?'Lichess + ':''}${modelName(game.options.model)}`;$('bottom-player-sub').textContent=me?'흑으로 플레이':'백으로 플레이';
 $('turn-pill').textContent=game.reviewMode?'복기 중':over?'대국 종료':ch.turn()==='w'?'백 차례':'흑 차례';
 if(game.reviewMode){$('move-feedback').textContent='수순을 선택해 복기할 수 있어요'}else if(over){$('move-feedback').textContent=game.resigned?'기권했습니다':game.ended?'직접 대국 종료':ch.isCheckmate()?(toColor(ch.turn())===game.options.color?'패배':'승리'):'무승부'} else $('move-feedback').textContent=isHumanTurn()?(ch.isCheck()?'체크 · 내 차례':'내 차례'):'봇 차례';
 $('undo-button').disabled=busy||over||game.reviewMode||game.chess.history().length<game.setupCount+(game.initialBotTurn?2:1);
 $('pgn-button').disabled=busy;$('resign-button').disabled=busy||over;
 $('finish-button').disabled=busy||over;
 $('review-start').disabled=busy||!over;
 $('review-start').textContent=game.reviewMode?'복기 종료':'마치고 분석';
 $('review-prev').disabled=!game.reviewMode||game.reviewPly<=game.setupCount;
 $('review-next').disabled=!game.reviewMode||game.reviewPly>=game.chess.history().length;
 $('start-button').innerHTML='새 대국 시작하기 <span aria-hidden="true">→</span>';
 const s=$('start-position-label');if(game.options.startMode!=='standard'){s.classList.remove('hidden');s.textContent=game.options.startMode==='moves'?`시작 수순: ${game.options.startMoves}`:`사용자 지정 FEN · ${game.baseFen}`}else s.classList.add('hidden');
}
function insightRow(x,selected=false){
 const pct=Number(x.percent)||0;
 return `<div class="book-stat-item ${selected?'book-stat-chosen':''}">
  <div class="stat-row"><span class="name">${escapeHtml(x.san)}</span><div class="stat-bar"><div class="stat-fill ${selected?'selected-fill':''}" style="width:${Math.min(100,Math.max(0,pct))}%"></div></div><span class="pct">${pct.toFixed(1)}% 선택</span></div>
  <div class="result-strip" role="img" aria-label="백 승리 ${x.whiteRate.toFixed(1)}%, 무승부 ${x.drawRate.toFixed(1)}%, 흑 승리 ${x.blackRate.toFixed(1)}%"><span class="result-white" style="width:${x.whiteRate}%"></span><span class="result-draw" style="width:${x.drawRate}%"></span><span class="result-black" style="width:${x.blackRate}%"></span></div>
  <div class="result-legend"><span>승률 <b>${x.winRate.toFixed(1)}%</b></span><span>무 ${x.drawRate.toFixed(1)}%</span><span>패 ${x.lossRate.toFixed(1)}%</span><span class="book-count">${shortNum(x.count)}판</span></div>
 </div>`;
}
function renderStats(){const el=$('stats-content'),tag=$('source-tag'),report=game?.lastBot;
 if(!report){tag.textContent='대기';el.innerHTML='<div class="empty-insight"><div class="empty-icon">◈</div><strong>착수 데이터가 여기에 표시돼요</strong><p>봇이 수를 두면 실제 선택 빈도와 다른 주요 후보를 확인할 수 있습니다.</p></div>';return}
 if(report.source==='maia'){const label=report.modelLabel||'Maia-3';tag.textContent=label;el.innerHTML=`<div class="maia-note"><h3>${escapeHtml(report.move)} · ${escapeHtml(label)}</h3><p>선택 사유: ${escapeHtml(report.reason)}</p><p>이 수는 브라우저의 ${escapeHtml(label)} 모델이 예측했으며, Lichess 등장 비율은 제공하지 않습니다.</p></div>`;return}
 tag.textContent='LICHESS DATA';const s=report.selected;
 el.innerHTML=`<div class="insight-heading"><div><small>봇이 선택한 수</small><strong>${escapeHtml(s.san)}</strong></div><span class="insight-percent">${s.percent.toFixed(1)}%</span></div>
  <p class="insight-desc">실제 ${shortNum(s.count)} / ${shortNum(report.total)}판에서 선택 · 봇(${report.mover==='w'?'백':'흑'}) 승률 <b>${s.winRate.toFixed(1)}%</b></p>
  ${insightRow(s,true)}<div class="alternative-title">다른 주요 후보 · 선택 비율 + 승/무/패</div>
  ${report.alternatives.map(x=>insightRow(x)).join('')||'<p class="insight-desc">다른 주요 후보 없음</p>'}
  <div class="insight-footer">승/무/패 비율은 <b>그 수를 둔 쪽(${report.mover==='w'?'백':'흑'}) 기준</b>이며, 승률과 선택 비율은 서로 다른 값입니다.<br/>
  ${escapeHtml(SPEED_LABELS[report.speed])} · 레이팅 ${report.bucket} 구간 · 전체 ${shortNum(report.total)}판 · 포함 ${(100*report.represented/report.total).toFixed(1)}%</div>`;
}
// A replay from the original FEN preserves move numbering and setup-move boundaries.
function getMoveFrames(){
 if(!game)return [];
 const replay=new Chess(game.baseFen),frames=[];
 for(const [i,move] of game.chess.history({verbose:true}).entries()){
  const beforeFen=replay.fen(),turn=replay.turn(),number=replay.moveNumber();
  replay.move(move);
  frames.push({index:i+1,number,turn,san:move.san,beforeFen,afterFen:replay.fen(),setup:i<game.setupCount});
 }
 return frames;
}
function comparisonFor(frame){
 if(!reviewScorer||frame.setup)return null;
 const before=reviewScorer.results.get(frame.beforeFen);
 const after=reviewScorer.results.get(frame.afterFen);
 const bestPosition=uciPosition(Chess,frame.beforeFen,before?.bestUci);
 const bestAfter=bestPosition?reviewScorer.results.get(bestPosition.fen):null;
 return moveComparison(before,after,bestAfter,frame.turn);
}
function scheduleReviewPositions(){
 if(!game||!reviewScorer?.worker||!$('analysis-toggle').checked)return;
 const frames=getMoveFrames().filter(x=>!x.setup);
 for(const frame of frames){
  reviewScorer.enqueue(frame.beforeFen);
  reviewScorer.enqueue(frame.afterFen);
  const bestUci=reviewScorer.results.get(frame.beforeFen)?.bestUci;
  const best=uciPosition(Chess,frame.beforeFen,bestUci);
  if(best)reviewScorer.enqueue(best.fen);
 }
}
function historyMove(frame){
 const comparison=comparisonFor(frame);
 const selected=game.reviewMode&&game.reviewPly===frame.index;
 let annotation=frame.setup?'<span class="move-metrics setup-metrics">시작 수순</span>':'';
 if(!frame.setup && ($('analysis-toggle').checked || comparison)){
  annotation=comparison?.mate?'<span class="move-metrics">메이트 상황 · 변화량 —</span>':comparison?
   `<span class="move-metrics">실제 Δ <b>${signedPawns(comparison.actual)}</b> · 최선 Δ <b>${signedPawns(comparison.best)}</b></span>`:
   '<span class="move-metrics waiting-eval">⏳ 계산 중…</span>';
 }
 const classes=`record-move ${frame.setup?'setup-move':''} ${selected?'review-selected':''}`;
 return `<button type="button" data-ply="${frame.index}" class="${classes}" ${game.reviewMode?'':'disabled'}><span class="move-san">${escapeHtml(frame.san)}</span>${annotation}</button>`;
}
function renderHistory(){
 const list=$('move-list');if(!game){list.innerHTML='<p class="empty-moves">아직 진행한 수가 없습니다.</p>';$('move-count').textContent='0수';return}
 const frames=getMoveFrames();$('move-count').textContent=`${Math.max(0,frames.length-game.setupCount)}반수 진행`;
 let rows=[],i=0;
 while(i<frames.length){
  const first=frames[i];const number=first.number;
  const white=first.turn==='w'?frames[i++]:null;
  const black=i<frames.length&&frames[i].turn==='b'&&frames[i].number===number?frames[i++]:null;
  rows.push(`<div class="move-row"><span class="move-number">${number}.</span>${white?historyMove(white):'<span class="record-placeholder">—</span>'}${black?historyMove(black):'<span class="record-placeholder">—</span>'}</div>`);
 }
 const oldScroll=list.scrollTop,nearBottom=list.scrollHeight-list.clientHeight-list.scrollTop<70;
 list.innerHTML=rows.join('')||'<p class="empty-moves">아직 진행한 수가 없습니다.</p>';
 for(const btn of list.querySelectorAll('button[data-ply]'))btn.addEventListener('click',()=>{
  if(!game.reviewMode)return;game.reviewPly=Number(btn.dataset.ply);render();
 });
 list.scrollTop=game.reviewMode?oldScroll:(nearBottom?list.scrollHeight:oldScroll);
 const done=frames.filter(x=>!x.setup&&comparisonFor(x)).length;
 if($('analysis-toggle').checked&&reviewScorer?.worker){
  const total=frames.filter(x=>!x.setup).length;
  $('review-status').textContent=`기보 평가 ${done}/${total}수 완료 · 깊이 ${reviewScorer.depth} · 최선 수의 가상 착수도 별도 평가`;
 }
}
function showReview(ply){showBookArrows=false;
 if(!game||busy||isPlaying())return;
 game.reviewMode=true;game.reviewPly=Math.max(game.setupCount,Math.min(game.chess.history().length,ply));
 selected=null;render();
}
function finishGame(){
 if(!game||busy||!isPlaying())return;
 if(!confirm('현재 대국을 여기서 마칠까요? 경기 결과는 미완료(*)로 저장됩니다.'))return;
 game.ended=true;render();
}
function render(){renderBookRibbon();renderBoard();renderControls();renderStats();renderHistory();refreshAnalysis();scheduleReviewPositions()}

function renderAnalysis(data){
 lastEngineEvaluation=data;
 const area=$('analysis-content');const banner=$('board-eval');
 banner.classList.toggle('hidden',!$('analysis-toggle').checked);
 $('board-eval-value').textContent='계산 중…';
 $('board-eval-best').textContent='최선 —';$('board-eval-second').textContent='차선 —';
 $('board-eval-depth').textContent='분석 중';
 if(!$('analysis-toggle').checked)return;
 if(!data||!data.lines.length){area.innerHTML='<p class="engine-empty">현재 포지션을 분석 중입니다…</p>';return}
 // Stockfish info scores are reported from the SIDE TO MOVE; always display White's POV.
 const top=data.lines.find(x=>x.rank===1);
 if(!top){area.innerHTML='<p class="engine-empty">최선 수 분석 중…</p>';return}
 $('board-eval-value').textContent=formatWhiteScore(top,data.fen);
 $('board-eval-best').textContent='최선 '+(sanVariation(Chess,data.fen,top.pv,1)[0]||top.pv[0]||'—');
 const second=data.lines.find(x=>x.rank===2);
 $('board-eval-second').textContent='차선 '+(second?(sanVariation(Chess,data.fen,second.pv,1)[0]||second.pv[0]||'—'):'계산 중…');
 $('board-eval-depth').textContent='깊이 '+data.depth;
 const value=whitePerspective(top,data.fen);
 const side=top.type==='mate'?(value>=0?'백 메이트 유리':'흑 메이트 유리'):(Math.abs(value)<25?'거의 균형':value>0?'백 우세':'흑 우세');
 const header=`<div class="engine-score"><div><small>현재 엔진 평가 · 백 기준</small><strong>${escapeHtml(formatWhiteScore(top,data.fen))}</strong></div><span class="engine-score-side">${side}<br><span class="engine-depth">분석 깊이 ${data.depth}</span></span></div>`;
 const lines=[1,2].map(rank=>{
  const info=data.lines.find(x=>x.rank===rank);
  if(!info)return `<div class="engine-line second"><div class="engine-line-top"><span class="engine-rank">${rank===1?'최선':'차선'}</span><span class="engine-depth">분석 중…</span></div></div>`;
  const variations=sanVariation(Chess,data.fen,info.pv,5);
  return `<div class="engine-line ${rank===2?'second':''}"><div class="engine-line-top"><span class="engine-rank">${rank===1?'최선 수':'차선 수'}</span><strong class="engine-move">${escapeHtml(variations[0]||info.pv[0]||'—')}</strong><span class="engine-eval">${escapeHtml(formatWhiteScore(info,data.fen))}</span></div><p class="engine-pv">${escapeHtml(variations.join(' → ')||'분석 중')}</p><span class="engine-depth">Depth ${info.depth}</span></div>`;
 }).join('');
 area.innerHTML=header+lines;
}
function setAnalysisStatus(message,error=false){const el=$('analysis-status');el.textContent=message;el.classList.toggle('error',error);$('analysis-tag').textContent=error?'ERROR':'ON'}
function refreshAnalysis(){
 if(!$('analysis-toggle').checked||!liveEngine?.worker)return;
 const fen=viewedChess()?.fen()||START_FEN;
 liveEngine.analyze(fen);
}
async function toggleAnalysis(){
 const enabled=$('analysis-toggle').checked;
 $('analysis-advanced').classList.toggle('hidden',!enabled);
 $('analysis-off-desc').classList.toggle('hidden',enabled);
 $('analysis-tag').textContent=enabled?'ON':'OFF';
 if(!enabled){liveEngine?.disable();liveEngine=null;reviewScorer?.stop();lastEngineEvaluation=null;
  $('board-eval').classList.add('hidden');$('review-status').textContent='엔진 분석을 켜면 착수별 평가를 기록합니다.';
  renderHistory();return;}
 $('analysis-status').textContent='Stockfish 파일 확인 중…';
 try{
  // Missing WASM/worker files should produce a helpful error rather than a silent spinner.
  const js=new URL(ENGINE_SCRIPT,import.meta.url);
  const wasm=new URL('./engine/stockfish-19-lite-single.wasm',import.meta.url);
  for(const u of [js,wasm]){
   const response=await fetch(u,{method:'HEAD',cache:'no-store'});
   if(!response.ok)throw new Error(`${u.pathname.split('/').at(-1)} 파일 없음 (HTTP ${response.status}). 설치 안내서를 확인하세요.`);
  }
  if(!$("analysis-toggle").checked)return;
  liveEngine=new LiveEngine({workerFactory:()=>new Worker(js),onUpdate:renderAnalysis,onStatus:setAnalysisStatus});
  liveEngine.setDepth($('analysis-depth').value);
  liveEngine.enable(viewedChess()?.fen()||START_FEN);
  const savedScores=reviewScorer?.results;
  reviewScorer=new ReviewScorer({workerFactory:()=>new Worker(js),onStatus:(msg,error)=>{
    $('review-status').textContent=msg;if(error)showError(msg);
  },onResult:()=>{renderHistory();scheduleReviewPositions();}});
  if(savedScores)reviewScorer.results=new Map(savedScores);
  reviewScorer.start(10);scheduleReviewPositions();renderHistory();
 }catch(error){if($('analysis-toggle').checked)setAnalysisStatus(`분석 엔진 오류: ${error.message||error}`,true)}
}


function plyOf(chess){const f=chess.fen().split(' ');return (Number(f[5])-1)*2+(f[1]==='b'?1:0)}
function priorFens(){const replay=new Chess(game.baseFen),out=[];for(const move of game.chess.history({verbose:true})){out.push(replay.fen());replay.move(move)}return out.slice(-8)}
function bookReason(ch){if(plyOf(ch)>=BOOK_LIMIT)return `오프닝 제한 ${BOOK_LIMIT}반수 초과`;if(!lichessToken)return 'Lichess 토큰 미입력';if(recentBookErrors>=3)return 'Lichess 오류가 반복되어 잠시 통계 조회 중지';return ''}
async function getBookChoice(){
 if(!game.options.useBook)return {reason:'설정에서 Lichess 오프닝 통계를 사용하지 않도록 선택함'};
 const ch=game.chess,why=bookReason(ch);if(why)return {reason:why};
 const params=new URLSearchParams({variant:'standard',ratings:String(ratingBucket(game.options.elo)),speeds:game.options.speed,moves:'16',topGames:'0',recentGames:'0'});
 if(game.options.startMode==='fen')params.set('fen',ch.fen());else params.set('play',ch.history({verbose:true}).map(explorerMoveUci).join(','));
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),22000);
 const fetchBook=async count=>{
  params.set('moves',String(count));
  const resp=await fetch(`https://explorer.lichess.org/lichess?${params}`,{headers:{Authorization:`Bearer ${lichessToken}`,Accept:'application/json'},mode:'cors',credentials:'omit',cache:'no-store',signal:controller.signal});
  if(!resp.ok)throw new Error(`Lichess HTTP ${resp.status}`);
  return resp.json();
 };
 try{
  const legal=ch.moves({verbose:true});
  let data=await fetchBook(16),valid=evaluateBook(data,legal.map(moveUci),game.options.minGames,0.9);
  // 16개로 후보 분포가 충분히 설명되지 않으면 더 많은 후보를 받아 재검사한다.
  // 이때 실제 수 선택 비율은 여전히 전체 대국 수를 분모로 사용한다.
  if(!valid.ok && valid.total>=game.options.minGames && valid.represented/valid.total<0.9){
   try{
    const expanded=await fetchBook(99);
    const retest=evaluateBook(expanded,legal.map(moveUci),game.options.minGames,0.9);
    data=expanded;valid=retest;
   }catch(err){valid.reason+=` 추가 후보 조회 실패: ${err.message||err}.`}
  }
  recentBookErrors=0;
  if(!valid.ok)return {reason:valid.reason};
  const choice=weightedChoice(valid.rows),picked=legal.find(m=>moveUci(m)===choice.matchedUci);
  const mover=ch.turn();
  const toView=row=>{
   const legalMove=legal.find(m=>moveUci(m)===row.matchedUci),r=rates(row,mover);
   return {san:legalMove?.san||row.san,from:legalMove?.from,to:legalMove?.to,
    percent:selectPct(row.count,valid.total),count:row.count,
    whiteRate:r.white,drawRate:r.draws,blackRate:r.black,
    winRate:r.win,lossRate:r.loss};
  };
  const report={source:'lichess',mover,beforeFen:ch.fen(),selected:toView(choice),
   alternatives:valid.rows.filter(x=>x.matchedUci!==choice.matchedUci).slice(0,3).map(toView),
   total:valid.total,represented:valid.represented,bucket:ratingBucket(game.options.elo),speed:game.options.speed};
  return {move:picked,report};
 }catch(error){recentBookErrors++;return {reason:`통계 API ${error?.name==='AbortError'?'시간 초과':(error?.message||'연결 오류')}`}}
 finally{clearTimeout(timer)}
}
async function prepareMaia(){
 if(maia)return maia;
 if(maiaPromise)return maiaPromise;
 maiaPromise=(async()=>{
   setMessage('Maia-3 엔진 다운로드 및 초기화 중…');$('model-status').textContent='AI 엔진 다운로드 및 초기화 중…';
   const ort=await import('onnxruntime-web');
   ort.env.wasm.wasmPaths=WASM_URL;
   ort.env.wasm.numThreads=1;
   const {Maia3}=await import('maia3-js/web');
   const m=new Maia3({variant:'5m',url:MODEL_URL,executionProviders:['wasm'],temperature:1,topP:1,topK:1,onProgress:(loaded,total)=>{if(total>0){const txt=`Maia-3 모델 다운로드 ${Math.round(100*loaded/total)}%`;setMessage(txt);$('model-status').textContent=txt}}});
   await m.load();maia=m;$('model-status').textContent='Maia-3 5M 모델 로딩 성공. 브라우저에서 사용할 수 있습니다.';return m;
 })();
 try{return await maiaPromise}catch(e){maiaPromise=null;$('model-status').textContent=`모델 로딩 실패: ${e.message||e}`;throw new Error(`Maia-3 초기화 실패: ${e.message||e}. 네트워크 또는 브라우저 호환성을 확인하세요.`)}
}
async function prepareMaia1(elo) {
 if(maia1Models.has(elo))return maia1Models.get(elo);
 if(maia1Promises.has(elo))return maia1Promises.get(elo);
 const promise=(async()=>{
   const ort=await import('onnxruntime-web');
   ort.env.wasm.wasmPaths=WASM_URL;ort.env.wasm.numThreads=1;
   const engine=new Maia1(elo,{onStatus:message=>{$('model-status').textContent=message;setMessage(message)}});
   await engine.load(ort);
   maia1Models.set(elo,engine);
   return engine;
 })();
 maia1Promises.set(elo,promise);
 try{return await promise}finally{maia1Promises.delete(elo)}
}
async function getMaiaMove(){
 if(game.options.model!=='maia3'){
   const elo=MAIA1_TYPES[game.options.model],m=await prepareMaia1(elo);
   const result=await m.predict(game.chess,{sample:game.options.model==='maia1-1800'});
   return result.move;
 }
 const m=await prepareMaia();const legal=game.chess.moves({verbose:true}),result=await m.predict({fen:game.chess.fen(),priorFens:priorFens(),selfElo:game.options.elo,oppoElo:game.options.elo,temperature:1,topP:1,topK:5});
 const uci=result.bestMove;const pick=legal.find(x=>moveUci(x)===normalizeExplorerUci(uci));
 if(!pick)throw new Error(`Maia-3가 현재 포지션에 합법적이지 않은 수를 반환했습니다 (${uci||'없음'}).`);
 return pick;
}
async function botTurn(){if(!game||!isPlaying()||isHumanTurn())return;
 showBookArrows=false;const current=game;setBusy(true,true);clearError();
 try{const choice=await getBookChoice();const move=choice.move||await getMaiaMove();
   if(current!==game)return;
   game.lastBot=choice.move?choice.report:{source:'maia',move:move.san,modelLabel:modelName(game.options.model),reason:choice.reason};
   game.chess.move(move);game.lastMove={from:move.from,to:move.to};selected=null;setMessage('봇이 착수했습니다');
 }catch(e){showError(e.message+' — 연결을 확인한 뒤 아래 「봇 착수 다시 시도」를 눌러 주세요.');$('retry-bot').classList.remove('hidden')}
 finally{setBusy(false);render()}
}
async function humanMove(move){if(busy||!isHumanTurn())return;
 showBookArrows=false;try{const result=game.chess.move(move);if(!result)return;game.lastMove={from:result.from,to:result.to};selected=null;game.lastBot=null;render();if(isPlaying()&&!isHumanTurn())await botTurn()}
 catch(e){showError('이동할 수 없습니다: '+e.message)}
}
async function startGame(){if(busy)return;clearError();
 try{const opts=getSettings(),s=configurePosition(opts);game={...s,options:opts,lastBot:null,lastMove:null,resigned:false,ended:false,reviewMode:false,reviewPly:0,initialBotTurn:toColor(s.chess.turn())!==opts.color};recentBookErrors=0;selected=null;showBookArrows=false;if(reviewScorer)reviewScorer.reset(10);$('retry-bot').classList.add('hidden');render();if(isPlaying()&&!isHumanTurn())await botTurn()}
 catch(e){showError(e.message)}
}
function undo(){if(busy||!game||game.chess.history().length<game.setupCount+(game.initialBotTurn?2:1))return;
 game.chess.undo();if(!isHumanTurn()&&game.chess.history().length>game.setupCount)game.chess.undo();
 game.lastBot=null;game.lastMove=null;selected=null;showBookArrows=false;$('retry-bot').classList.add('hidden');clearError();render();if(!isHumanTurn()&&isPlaying())void botTurn()}
function exportPgn(){
 if(!game)return;
 // Rebuild the game so comments are saved as standard PGN annotations.
 const ch=new Chess(game.baseFen),frames=getMoveFrames();
 ch.setHeader('Event','Humanlike Browser Chess');
 ch.setHeader('White',game.options.color==='white'?'Human':modelName(game.options.model));
 ch.setHeader('Black',game.options.color==='black'?'Human':modelName(game.options.model));
 ch.setHeader('Result',game.resigned?(game.options.color==='white'?'0-1':'1-0'):
   ch.isGameOver()?(ch.isCheckmate()?(ch.turn()==='w'?'0-1':'1-0'):'1/2-1/2'):'*');
 for(const frame of frames){
  ch.move(frame.san);
  const comparison=comparisonFor(frame);
  if(comparison&&!comparison.mate&&typeof ch.setComment==='function'){
   const best=uciPosition(Chess,frame.beforeFen,reviewScorer?.results.get(frame.beforeFen)?.bestUci);
   const score=reviewScorer?.results.get(frame.afterFen);
   const text=`Stockfish depth ${reviewScorer.depth}; 실제 변화 ${signedPawns(comparison.actual)}; 최선 ${best?.san||'?'} 변화 ${signedPawns(comparison.best)}; 착수후 백 평가 ${signedPawns(score?.white)}`;
   ch.setComment(text);
  }
 }
 // Determine the result from the ORIGINAL game, not the replay during export.
 const actual=game.chess;
 ch.setHeader('Result',game.resigned?(game.options.color==='white'?'0-1':'1-0'):
   actual.isGameOver()?(actual.isCheckmate()?(actual.turn()==='w'?'0-1':'1-0'):'1/2-1/2'):'*');
 const blob=new Blob([ch.pgn()],{type:'application/x-chess-pgn;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download='humanlike-chess-annotated.pgn';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
async function testToken(){const token=$('lichess-token').value.trim();if(!token){$('token-status').textContent='먼저 토큰을 입력해 주세요.';return}
 $('test-token').disabled=true;$('token-status').textContent='Lichess API 연결 중…';
 const params=new URLSearchParams({variant:'standard',play:'d2d4',ratings:'1400',speeds:'blitz',moves:'8',topGames:'0',recentGames:'0'});
 try{const resp=await fetch('https://explorer.lichess.org/lichess?'+params,{mode:'cors',credentials:'omit',cache:'no-store',headers:{Authorization:'Bearer '+token}});
   if(!resp.ok)throw new Error('HTTP '+resp.status);
   const data=await resp.json();if(!Array.isArray(data.moves))throw new Error('응답 형식 오류');lichessToken=token;$('lichess-token').value='';$('token-status').textContent=`연결 성공 · 1.d4 통계 ${shortNum(gamesOf(data))}판 · 현재 탭 메모리에만 토큰 보관`;
 }catch(e){$('token-status').textContent=`통계 연결 실패: ${e.message}. 토큰을 확인하거나 나중에 재시도하세요.`}
 finally{$('test-token').disabled=false}
}
function init(){
 $('analysis-toggle').addEventListener('change',()=>void toggleAnalysis());
 $('book-candidates-toggle').addEventListener('click',toggleBookArrows);
 $('analysis-depth').addEventListener('change',()=>{
  liveEngine?.setDepth($('analysis-depth').value);
  // History is always scored at fixed depth 10 for mobile performance.
 });
 $('server-indicator').classList.add('online');$('server-indicator').querySelector('span').textContent='브라우저 모드';
 $('elo').addEventListener('input',()=>{$('elo-label').textContent=$('elo').value});
 $('start-mode').addEventListener('change',setStartMode);
 $('opening-preset').addEventListener('change',()=>{if($('opening-preset').value)$('start-moves').value=$('opening-preset').value;$('position-preview').classList.add('hidden')});
 for(const id of ['start-moves','start-fen'])$(id).addEventListener('input',()=>{$('position-preview').classList.add('hidden')});
 $('preview-position').addEventListener('click',previewPosition);$('test-token').addEventListener('click',()=>void testToken());
 const describeSelectedModel = () => {
   const m=$('model').value;
   $('model-description').textContent=m==='maia1-1800'
     ? 'maiachess.com의 Maia-1 1800 가중치와 sampleMoves=true에 가까운 수 선택 방식으로 작동합니다. 세부 실행 환경이 달라 모든 응수가 동일하지는 않을 수 있습니다.'
     : 'Lichess @maia9의 Maia-1 1900 가중치로 가장 높은 예측 확률의 수를 선택합니다. Lichess 봇 전용 오프닝북과 착수 시간 정책은 포함되지 않습니다.';
   $('elo-field-label').textContent='오프닝 통계 레이팅';
   $('test-maia').textContent='선택 모델 로딩 테스트';
   $('model-status').textContent='선택한 모델은 아직 테스트하지 않았습니다.';
 };
 $('model').addEventListener('change',describeSelectedModel);
 describeSelectedModel();
 $('test-maia').addEventListener('click',async()=>{$('test-maia').disabled=true;
  try{
   const selected=$('model').value;
   let move;
   if(selected==='maia3'){
      await prepareMaia();const result=await maia.predict({fen:START_FEN,selfElo:1500,oppoElo:1500,temperature:1,topK:1});move=result.bestMove;
   } else {
      const m=await prepareMaia1(MAIA1_TYPES[selected]);const result=await m.predict(new Chess(START_FEN),{sample:selected==='maia1-1800'});move=result.uci;
   }
   if(!move)throw new Error('AI가 수를 반환하지 않았습니다.');
   $('model-status').textContent=`${modelName(selected)} 착수 예측 성공 (${move}).`;
  }catch(e){$('model-status').textContent='모델 테스트 실패: '+(e.message||e)}finally{$('test-maia').disabled=false}
 });
 for(const b of document.querySelectorAll('[data-color]'))b.addEventListener('click',()=>{activeColor=b.dataset.color;document.querySelectorAll('[data-color]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b))});if(!game)renderBoard()});
 $('start-button').addEventListener('click',()=>void startGame());$('top-new').addEventListener('click',()=>void startGame());
 $('undo-button').addEventListener('click',undo);$('pgn-button').addEventListener('click',exportPgn);
 $('finish-button').addEventListener('click',finishGame);
 $('review-start').addEventListener('click',()=>{
  if(!game||isPlaying())return;
  if(game.reviewMode){game.reviewMode=false;render();return;}
  showReview(game.setupCount);
  if(!$('analysis-toggle').checked){$('analysis-toggle').checked=true;void toggleAnalysis();}
 });
 $('review-prev').addEventListener('click',()=>showReview((game?.reviewPly||0)-1));
 $('review-next').addEventListener('click',()=>showReview((game?.reviewPly||0)+1));
 $('resign-button').addEventListener('click',()=>{if(game&&!busy&&isPlaying()&&confirm('정말 기권하시겠습니까?')){game.resigned=true;render()}});
 $('retry-bot').addEventListener('click',()=>{if(!busy){$('retry-bot').classList.add('hidden');void botTurn()}});
 $('promotion-cancel').addEventListener('click',()=>{closePromotion();renderBoard()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&promotionOptions){closePromotion();renderBoard()}});
 setStartMode();render();
}
init();
