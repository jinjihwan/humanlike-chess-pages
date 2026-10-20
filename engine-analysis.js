// Stockfish UCI live-analysis adapter. No imports: can also be tested with Node.
export const ENGINE_SCRIPT = './engine/stockfish-19-lite-single.js';

export function parseInfo(line) {
  if (typeof line !== 'string' || !line.startsWith('info ') || /\b(?:upperbound|lowerbound)\b/.test(line)) return null;
  const depth = /\bdepth (\d+)\b/.exec(line);
  const multipv = /\bmultipv (\d+)\b/.exec(line);
  const score = /\bscore (cp|mate) (-?\d+)\b/.exec(line);
  const pv = /\bpv\s+((?:[a-h][1-8][a-h][1-8][qrbn]?\s*)+)/.exec(line);
  if (!depth || !score || !pv) return null;
  return {depth:Number(depth[1]),rank:multipv?Number(multipv[1]):1,type:score[1],value:Number(score[2]),pv:pv[1].trim().split(/\s+/)};
}

export function whitePerspective(info,fen) {
  const turn=fen.trim().split(/\s+/)[1];
  if (turn!=='w'&&turn!=='b') throw new Error('잘못된 FEN의 차례 정보입니다.');
  return (turn==='w'?1:-1)*info.value;
}
export function formatWhiteScore(info,fen) {
  const score=whitePerspective(info,fen);
  if(info.type==='mate') return score>=0?`+#${score}`:`-#${Math.abs(score)}`;
  const pawns=score/100;
  return `${pawns>=0?'+':''}${pawns.toFixed(2)}`;
}

export function sanVariation(Chess, fen, pv, maxPlies=5) {
  const board=new Chess(fen),moves=[];
  for(const uci of pv.slice(0,maxPlies)) {
    try {
      const result=board.move({from:uci.slice(0,2),to:uci.slice(2,4),...(uci.length===5?{promotion:uci.slice(4,5)}:{})});
      if(!result)break;
      moves.push(result.san);
    } catch(_) {break;}
  }
  return moves;
}

export class LiveEngine {
  constructor({workerFactory=()=>new Worker(ENGINE_SCRIPT),onUpdate=()=>{},onStatus=()=>{}}={}) {
    this.workerFactory=workerFactory;
    this.onUpdate=onUpdate;
    this.onStatus=onStatus;
    this.worker=null;
    this.state='off';
    this.desiredFen=null;
    this.activeFen=null;
    this.depth=14;
    this.lines=new Map();
    this.timer=null;
  }
  enable(fen) {
    if(this.worker){this.analyze(fen);return;}
    this.desiredFen=fen;
    this.onStatus('엔진 초기화 중…');
    try {
      this.worker=this.workerFactory();
      this.state='loading';
      this.worker.onmessage=e=>this.handle(String(e.data??''));
      this.worker.onerror=e=>this.fail('Stockfish 엔진 파일을 불러오지 못했습니다. engine 폴더의 JS/WASM 파일을 확인하세요.');
      this.worker.onmessageerror=()=>this.fail('Stockfish 메시지 수신 오류');
      this.worker.postMessage('uci');
      this.timer=setTimeout(()=>{if(this.state==='loading')this.fail('Stockfish 시작 시간 초과. 다운로드 또는 WASM 파일을 확인하세요.')},30000);
    } catch(e){this.fail(`Stockfish 시작 실패: ${e.message||e}`)}
  }
  fail(msg){this.disable(false);this.onStatus(msg,true)}
  disable(showStatus=true) {
    clearTimeout(this.timer);this.timer=null;
    const worker=this.worker;this.worker=null;this.state='off';this.desiredFen=null;this.activeFen=null;this.lines.clear();
    if(worker){try{worker.terminate()}catch(_){}}
    this.onUpdate(null);
    if(showStatus)this.onStatus('분석 꺼짐');
  }
  setDepth(d){
    const x=Number(d);if(![10,14,18].includes(x))return;
    if(x===this.depth)return;
    this.depth=x;
    if(this.worker&&this.desiredFen){
      this.lines.clear();this.onUpdate(null);
      if(this.state==='searching'){this.state='stopping';this.worker.postMessage('stop')}
      else if(this.state==='ready')this.beginSearch();
    }
  }
  analyze(fen){
    if(!this.worker||!fen||fen===this.desiredFen)return;
    this.desiredFen=fen;
    this.lines.clear();this.onUpdate(null);
    if(this.state==='searching'){this.state='stopping';this.worker.postMessage('stop')}
    else if(this.state==='ready')this.beginSearch();
  }
  beginSearch(){
    if(!this.worker||!this.desiredFen)return;
    this.activeFen=this.desiredFen;
    this.lines.clear();this.state='searching';
    this.worker.postMessage('position fen '+this.activeFen);
    this.worker.postMessage('go depth '+this.depth);
    this.onStatus('현재 포지션 분석 중…');
  }
  handle(data){
    for(const line of data.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)){
      if(!this.worker) return;
      if(line==='uciok'&&this.state==='loading'){
        clearTimeout(this.timer);this.timer=null;
        this.worker.postMessage('setoption name MultiPV value 2');
        this.worker.postMessage('setoption name Hash value 16');
        this.worker.postMessage('isready');
      }else if(line==='readyok'&&this.state==='loading'){
        this.state='ready';this.beginSearch();
      }else if(line.startsWith('bestmove ')&&(this.state==='searching'||this.state==='stopping')){
        const wasStopped=this.state==='stopping';this.state='ready';
        if(wasStopped||this.desiredFen!==this.activeFen)this.beginSearch();
        else this.onStatus('분석 완료');
      }else if(line.startsWith('info ')&&this.state==='searching'&&this.activeFen===this.desiredFen){
        const parsed=parseInfo(line);if(!parsed||parsed.rank>2||parsed.rank<1)continue;
        const prev=this.lines.get(parsed.rank);
        if(!prev||parsed.depth>=prev.depth){
          this.lines.set(parsed.rank,parsed);
          this.onUpdate({fen:this.activeFen,lines:[this.lines.get(1),this.lines.get(2)].filter(Boolean),depth:Math.min(...[...this.lines.values()].map(x=>x.depth))});
        }
      }
    }
  }
}
