// Lightweight sequential position scorer. Runs in a separate Web Worker so review
// results are reproducible at one depth and never get mixed with live MultiPV.
import {parseInfo, whitePerspective} from './engine-analysis.js';

export function signedPawns(centipawns) {
  if(!Number.isFinite(centipawns))return '—';
  const p=centipawns/100;
  return `${p>=0?'+':''}${p.toFixed(2)}`;
}
export function moveComparison(before, after, bestAfter, mover) {
  if(!before||!after||!bestAfter)return null;
  if([before,after,bestAfter].some(x=>x.kind!=='cp'))return {mate:true};
  const sign=mover==='w'?1:-1;
  return {
    actual:sign*(after.white-before.white),
    best:sign*(bestAfter.white-before.white),
    loss:Math.max(0,sign*(bestAfter.white-after.white)),
    post:after.white,
  };
}
export function uciPosition(Chess,fen,uci) {
  if(!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci))return null;
  try {
    const position=new Chess(fen);
    const move=position.move({from:uci.slice(0,2),to:uci.slice(2,4),...(uci.length===5?{promotion:uci.slice(4)}:{})});
    return move?{fen:position.fen(),san:move.san}:null;
  }catch{return null;}
}
export class ReviewScorer {
  constructor({workerFactory,onStatus=()=>{},onResult=()=>{}}){
    this.workerFactory=workerFactory;this.onStatus=onStatus;this.onResult=onResult;
    this.results=new Map();this.queue=[];this.queued=new Set();this.worker=null;
    this.state='off';this.active=null;this.info=null;this.depth=10;this.timer=null;
  }
  start(depth=10){
    if(this.worker)return;
    this.depth=Number(depth)||10;this.state='booting';
    try{
      this.worker=this.workerFactory();
      this.worker.onmessage=e=>this.receive(String(e.data||''));
      this.worker.onerror=()=>this.fail('기보 분석 엔진 파일 로딩 실패');
      this.worker.onmessageerror=()=>this.fail('기보 분석 엔진 메시지 오류');
      this.worker.postMessage('uci');
      this.timer=setTimeout(()=>{if(this.state==='booting')this.fail('기보 분석 엔진 초기화 시간 초과')},30000);
    }catch(error){this.fail('기보 분석 엔진 시작 실패: '+error.message)}
  }
  stop(){clearTimeout(this.timer);this.timer=null;
    if(this.worker){try{this.worker.terminate()}catch{}}
    this.worker=null;this.state='off';this.active=null;this.info=null;
    this.queue=[];this.queued.clear();
  }
  reset(depth){this.stop();this.results.clear();this.start(depth);}
  fail(message){this.stop();this.onStatus(message,true)}
  enqueue(fen,priority=false){
    if(!fen||this.results.has(fen)||this.queued.has(fen)||this.active===fen)return;
    if(priority)this.queue.unshift(fen);else this.queue.push(fen);
    this.queued.add(fen);this.pump();
  }
  pump(){
    if(this.state!=='ready'||!this.worker)return;
    const fen=this.queue.shift();if(!fen){this.onStatus('기보 평가 계산 완료');return;}
    this.queued.delete(fen);this.active=fen;this.info=null;this.state='busy';
    this.worker.postMessage('position fen '+fen);
    this.worker.postMessage('go depth '+this.depth);
    this.onStatus(`기보 평가 계산 중… (남은 포지션 ${this.queue.length+1})`);
    clearTimeout(this.timer);this.timer=setTimeout(()=>{if(this.state==='busy')this.fail('기보 분석 계산 시간 초과')},45000);
  }
  receive(message){
    for(const line of message.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)){
      if(!this.worker)return;
      if(line==='uciok'&&this.state==='booting'){
        this.worker.postMessage('setoption name MultiPV value 1');
        this.worker.postMessage('setoption name Hash value 16');
        this.worker.postMessage('isready');
      }else if(line==='readyok'&&this.state==='booting'){
        clearTimeout(this.timer);this.timer=null;this.state='ready';this.pump();
      }else if(line.startsWith('info ')&&this.state==='busy'){
        const info=parseInfo(line);
        if(info && info.rank===1 && (!this.info||info.depth>=this.info.depth))this.info=info;
      }else if(line.startsWith('bestmove ')&&this.state==='busy'){
        const fen=this.active,info=this.info;
        clearTimeout(this.timer);this.timer=null;
        this.active=null;this.info=null;this.state='ready';
        if(info){
          const result={kind:info.type,white:whitePerspective(info,fen),bestUci:info.pv[0]||null,depth:info.depth};
          this.results.set(fen,result);
          this.onResult(fen,result);
        }else{
          this.results.set(fen,{kind:'unknown',white:null,bestUci:null,depth:this.depth});
          this.onResult(fen,this.results.get(fen));
        }
        this.pump();
      }
    }
  }
}
