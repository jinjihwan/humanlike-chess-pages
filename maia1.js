/*
 * Maia (KDD 2020) inference adapter for browser-only chess.
 * Original model: CSSLab/maia-chess (GPL-3.0).
 * ONNX conversions: cstr/maia-chess-onnx-opset15 (GPL-3.0).
 * LC0 policy vocabulary and classical 112-plane input (LeelaChessZero/lc0).
 * This module has no dependency on Maia-3's inference code.
 */

const HF_BASE = 'https://huggingface.co/cstr/maia-chess-onnx-opset15/resolve/main/';
const MODEL_ELOS = new Set([1100,1200,1300,1400,1500,1600,1700,1800,1900]);
const PCS = ['p','n','b','r','q','k'];
const FILES = 'abcdefgh';

export function policyMoves() {
  const result = [];
  for (let from=0; from<64; from++) {
    const fx=from%8, fy=Math.floor(from/8);
    for(let to=0; to<64; to++) {
      if(to===from)continue;
      const dx=Math.abs(to%8-fx),dy=Math.abs(Math.floor(to/8)-fy);
      if(dx===0||dy===0||dx===dy||(Math.min(dx,dy)===1&&Math.max(dx,dy)===2)) {
        result.push(indexSquare(from)+indexSquare(to));
      }
    }
  }
  // Lc0 appends the 66 additional promotion moves to the main 1792.
  // The unadorned policy index represents the knight promotion.
  for(let fromFile=0;fromFile<8;fromFile++) {
    for(let toFile=Math.max(0,fromFile-1);toFile<=Math.min(7,fromFile+1);toFile++) {
      for(const promotion of ['q','r','b']) {
        result.push(FILES[fromFile]+'7'+FILES[toFile]+'8'+promotion);
      }
    }
  }
  return result;
}
function indexSquare(i){return FILES[i%8]+String(Math.floor(i/8)+1)}
const POLICY_MAP = new Map(policyMoves().map((m,i)=>[m,i]));
// Reference values from Leela Chess Zero neural/encoder.cc kMoveStrs.
if (POLICY_MAP.size !== 1858 || POLICY_MAP.get('e2e4') !== 322 ||
    POLICY_MAP.get('d2d4') !== 293 || POLICY_MAP.get('g1f3') !== 159) {
  throw new Error('Maia-1 정책 좌표 테이블 검증 실패');
}

function cloneBoardAt(fen){
  const [placements, side,castle, ep,half] = fen.split(/\s+/);
  if(!placements||!side)return null;
  const board = Array.from({length:8},()=>Array(8).fill(null));
  for(const [r,row] of placements.split('/').entries()){
    let file=0;
    for(const char of row){if(/\d/.test(char))file+=Number(char);else{if(file>7)throw new Error('잘못된 FEN');board[7-r][file++]=char}}
    if(file!==8)throw new Error('잘못된 FEN');
  }
  return {board,side,castle:castle||'-',ep:ep||'-',half:Number(half)||0};
}
function turnedSquare(sq, turnBlack){
  const file=FILES.indexOf(sq[0]),rank=Number(sq[1])-1;
  return FILES[file]+String(turnBlack?8-rank:rank+1);
}
function moveKey(move, turnBlack){
  const from=turnedSquare(move.from,turnBlack),to=turnedSquare(move.to,turnBlack);
  const promotion=move.promotion;
  // Lc0 white-side vocabulary uses q/r/b suffix, and the unsuffixed
  // advance represents the knight promotion. Do not confuse ordinary advances.
  return from+to+(promotion&&promotion!=='n'?promotion:'');
}

export function encodeClassical112(chess) {
  // The LC0 classical encoding uses planes: for each of 8 positions,
  // 6 our piece planes, 6 their piece planes, 1 repetition plane;
  // then own/other castling Q,K, side-to-move, halfmove, zero, ones.
  // The side-to-move orientation is always upward for the current player.
  const current=cloneBoardAt(chess.fen());
  const turnBlack=current.side==='b';
  const bytes=new Float32Array(112*64);
  const positions=[];
  // For full games, reconstruct prior boards by replaying the history
  // backwards from chess.js's verbose history. FEN-only starting positions
  // have no known prior boards; use the current board as padding.
  if(typeof chess.history==='function' && typeof chess.undo==='function') {
    const gameHistory=chess.history({verbose:true});
    const initialFen = chess.fen();
    positions.push(current);
    for(let i=gameHistory.length-1;i>=0&&positions.length<8;i--){
      chess.undo();positions.push(cloneBoardAt(chess.fen()));
    }
    for(let i=gameHistory.length-positions.length+1;i<gameHistory.length;i++){
      if(i>=0)chess.move(gameHistory[i]);
    }
    // Bail out rather than silently corrupting the ongoing game.
    if(chess.fen()!==initialFen)throw new Error('Maia-1 인코딩 후 체스판 복구 실패');
  } else positions.push(current);
  while(positions.length<8) positions.push(positions[positions.length-1]);
  for(let h=0;h<8;h++){
    const pos=positions[h];
    for(let r=0;r<8;r++)for(let f=0;f<8;f++){
      const piece=pos.board[r][f];if(!piece)continue;
      const color=piece===piece.toUpperCase()?'w':'b';
      const ours=color===current.side;
      const type=PCS.indexOf(piece.toLowerCase());
      const rank=turnBlack?7-r:r;
      bytes[(h*13+(ours?0:6)+type)*64+rank*8+f]=1;
    }
  }
  const castle=current.castle;
  const own=turnBlack?['q','k']:['Q','K'];
  const other=turnBlack?['Q','K']:['q','k'];
  const castleList=[...own,...other];
  for(let n=0;n<4;n++)if(castle.includes(castleList[n]))bytes.fill(1,(104+n)*64,(105+n)*64);
  if(turnBlack)bytes.fill(1,108*64,109*64);
  bytes.fill(current.half,109*64,110*64);
  bytes.fill(1,111*64,112*64);
  return bytes;
}

export class Maia1 {
  constructor(elo,{onStatus=()=>{}}={}){
    this.elo=Number(elo);if(!MODEL_ELOS.has(this.elo))throw new Error('지원하지 않는 Maia-1 모델');
    this.onStatus=onStatus;
    this.session=null;
  }
  async load(ort){
    if(this.session)return;
    this.onStatus(`Maia-1 ${this.elo} 모델 다운로드 및 준비 중…`);
    const url=HF_BASE+`maia-${this.elo}.onnx`;
    // Fetch explicitly: a 404/CORS/network error is more useful than a generic
    // ONNX Runtime error. Model must be a real ONNX binary, not an HTML error.
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),90000);
    let bytes;
    try {
      const response=await fetch(url,{mode:'cors',credentials:'omit',signal:controller.signal});
      if(!response.ok) throw new Error(`모델 다운로드 HTTP ${response.status} (${url})`);
      const contentType=(response.headers.get('content-type')||'').toLowerCase();
      if(contentType.includes('text/html')) throw new Error('모델 주소가 ONNX 대신 HTML을 반환했습니다.');
      bytes=new Uint8Array(await response.arrayBuffer());
      if(bytes.byteLength<1000000) throw new Error(`모델 파일 크기 비정상 (${bytes.byteLength} bytes)`);
    } catch (error) {
      if(error?.name==='AbortError') throw new Error('모델 다운로드 시간 초과 (90초)');
      throw new Error('ONNX 파일 가져오기 실패: '+(error?.message||error));
    } finally { clearTimeout(timer); }
    this.onStatus(`Maia-1 ${this.elo} 모델 ${ (bytes.byteLength/1048576).toFixed(1) }MiB 수신 · 추론 준비 중…`);
    this.session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    if(!this.session.inputNames.length||!this.session.outputNames.length) throw new Error('ONNX 입력/출력 정보를 읽지 못했습니다.');
    this.ort=ort;
    this.onStatus(`Maia-1 ${this.elo} 모델 준비 완료`);
  }
  async predict(chess,{sample=true,temperature=1}={}){
    if(!this.session)throw new Error('Maia-1 모델을 먼저 로딩해야 합니다.');
    const legal=chess.moves({verbose:true});if(!legal.length)throw new Error('합법적인 수가 없습니다.');
    const input = encodeClassical112(chess);
    const name=this.session.inputNames[0];
    const outputs=await this.session.run({[name]:new this.ort.Tensor('float32',input,[1,112,8,8])});
    const policy=outputs['/output/policy']?.data||outputs[this.session.outputNames.find(k=>/policy/.test(k))]?.data;
    if(!policy||policy.length!==1858)throw new Error('Maia-1 모델 출력 형식이 예상과 다릅니다.');
    const turnBlack=chess.turn()==='b';
    const choices=legal.map(move=>({move,score:policy[POLICY_MAP.get(moveKey(move,turnBlack))]})).filter(x=>Number.isFinite(x.score));
    if(!choices.length)throw new Error('Maia-1의 합법 수 매핑을 찾지 못했습니다.');
    const best=Math.max(...choices.map(x=>x.score));
    const weights=choices.map(x=>Math.exp((x.score-best)/Math.max(.05,temperature)));
    let idx=weights.indexOf(Math.max(...weights));
    if(sample){let rnd=Math.random()*weights.reduce((a,b)=>a+b,0);for(let i=0;i<weights.length;i++){rnd-=weights[i];if(rnd<=0){idx=i;break}}}
    return {move:choices[idx].move,uci:choices[idx].move.from+choices[idx].move.to+(choices[idx].move.promotion||''),legalCount:choices.length};
  }
}
