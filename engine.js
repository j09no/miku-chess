'use strict';
(function(){
'use strict';
/* ============================================================
   MIKU CHESS — boss vs Miku
   - Elo selector (400..2000)
   - Possible moves + capture probability on click
   - Victim red glow + danger mode
   - Voice: bank mp3 (fish.audio Miku) + browser TTS fallback
   - Live chat replies in voice
   Zero dependencies. Run: node miku-chess.js -> http://localhost:3006
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG = {
  port: 3006,
  fishToken: 'Bearer ad67db76-081a-46d6-a294-32907568342d',
  fishModel: 'b1e87feaaa95439a977e1bff3cc0434e',
  fishOn: false,
  voiceDir: path.join(__dirname, 'voices'),
};

/* ================= CHESS ENGINE ================= */
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const FILES = 'abcdefgh';
const NOFF = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
const KOFF = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
const DIAG = [[1,-1],[-1,-1],[1,1],[-1,1]];
const ORTH = [[1,0],[-1,0],[0,1],[0,-1]];

function algOf(i) { return FILES[i % 8] + (8 - ((i / 8) | 0)); }
function sqFromAlg(a) { return (8 - Number(a[1])) * 8 + FILES.indexOf(a[0]); }
function opp(c) { return c === 'w' ? 'b' : 'w'; }
function colorOf(p) { return p ? (p === p.toUpperCase() ? 'w' : 'b') : null; }

function parseFEN(fen) {
  const p = fen.trim().split(/\s+/);
  const board = new Array(64).fill('');
  let i = 0;
  for (const ch of p[0]) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') i += Number(ch);
    else board[i++] = ch;
  }
  const c = p[2] || '-';
  return {
    board,
    turn: p[1] || 'w',
    castling: { wK: c.includes('K'), wQ: c.includes('Q'), bK: c.includes('k'), bQ: c.includes('q') },
    ep: (!p[3] || p[3] === '-') ? -1 : sqFromAlg(p[3]),
    half: Number(p[4] || 0),
    full: Number(p[5] || 1)
  };
}

function toFEN(s) {
  let pos = '';
  for (let r = 0; r < 8; r++) {
    let e = 0;
    for (let f = 0; f < 8; f++) {
      const p = s.board[r * 8 + f];
      if (!p) { e++; continue; }
      if (e) { pos += e; e = 0; }
      pos += p;
    }
    if (e) pos += e;
    if (r < 7) pos += '/';
  }
  let c = (s.castling.wK ? 'K' : '') + (s.castling.wQ ? 'Q' : '') + (s.castling.bK ? 'k' : '') + (s.castling.bQ ? 'q' : '');
  if (!c) c = '-';
  return pos + ' ' + s.turn + ' ' + c + ' ' + (s.ep >= 0 ? algOf(s.ep) : '-') + ' ' + s.half + ' ' + s.full;
}

function clone(s) {
  return { board: s.board.slice(), turn: s.turn, castling: { wK: s.castling.wK, wQ: s.castling.wQ, bK: s.castling.bK, bQ: s.castling.bQ }, ep: s.ep, half: s.half, full: s.full };
}

function isAttacked(s, sq, by) {
  const f = sq % 8, r = (sq / 8) | 0;
  const up = by === 'w' ? -1 : 1;
  for (const df of [-1, 1]) {
    const pf = f - df, pr = r - up;
    if (pf >= 0 && pf < 8 && pr >= 0 && pr < 8) {
      const p = s.board[pr * 8 + pf];
      if (p && colorOf(p) === by && p.toLowerCase() === 'p') return true;
    }
  }
  for (const [df, dr] of NOFF) {
    const nf = f + df, nr = r + dr;
    if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
    const p = s.board[nr * 8 + nf];
    if (p && colorOf(p) === by && p.toLowerCase() === 'n') return true;
  }
  for (const [df, dr] of KOFF) {
    const nf = f + df, nr = r + dr;
    if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
    const p = s.board[nr * 8 + nf];
    if (p && colorOf(p) === by && p.toLowerCase() === 'k') return true;
  }
  for (const [dirs, types] of [[DIAG, 'bq'], [ORTH, 'rq']]) {
    for (const [df, dr] of dirs) {
      let nf = f + df, nr = r + dr;
      while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
        const p = s.board[nr * 8 + nf];
        if (p) {
          if (colorOf(p) === by && types.includes(p.toLowerCase())) return true;
          break;
        }
        nf += df; nr += dr;
      }
    }
  }
  return false;
}

function kingSq(s, color) {
  const k = color === 'w' ? 'K' : 'k';
  for (let i = 0; i < 64; i++) if (s.board[i] === k) return i;
  return -1;
}
function inCheck(s, color) {
  const k = kingSq(s, color);
  return k >= 0 && isAttacked(s, k, opp(color));
}

function mv(from, to, piece, cap, flag, promo) {
  return { from, to, piece, cap: cap || '', flag: flag || '', promo: promo || '', color: colorOf(piece) };
}

function pushPawn(out, from, to, piece, cap) {
  const color = colorOf(piece);
  const promoRank = color === 'w' ? 0 : 7;
  if (((to / 8) | 0) === promoRank) {
    for (const pr of ['q', 'r', 'b', 'n']) {
      out.push(mv(from, to, piece, cap, '', color === 'w' ? pr.toUpperCase() : pr));
    }
  } else out.push(mv(from, to, piece, cap, ''));
}

function genCastles(s, color, out) {
  const w = color === 'w';
  const kSq = w ? 60 : 4;
  if (s.board[kSq] !== (w ? 'K' : 'k')) return;
  const e = opp(color);
  const R = w ? 'R' : 'r';
  const f1 = w ? 61 : 5, g1 = w ? 62 : 6, h1 = w ? 63 : 7;
  const d1 = w ? 59 : 3, c1 = w ? 58 : 2, b1 = w ? 57 : 1, a1 = w ? 56 : 0;
  if (w ? s.castling.wK : s.castling.bK) {
    if (!s.board[f1] && !s.board[g1] && s.board[h1] === R) {
      if (!isAttacked(s, kSq, e) && !isAttacked(s, f1, e) && !isAttacked(s, g1, e))
        out.push(mv(kSq, g1, w ? 'K' : 'k', '', 'castleK'));
    }
  }
  if (w ? s.castling.wQ : s.castling.bQ) {
    if (!s.board[b1] && !s.board[c1] && !s.board[d1] && s.board[a1] === R) {
      if (!isAttacked(s, kSq, e) && !isAttacked(s, d1, e) && !isAttacked(s, c1, e))
        out.push(mv(kSq, c1, w ? 'K' : 'k', '', 'castleQ'));
    }
  }
}

function genPseudo(s, color) {
  const out = [];
  const up = color === 'w' ? -1 : 1;
  for (let i = 0; i < 64; i++) {
    const p = s.board[i];
    if (!p || colorOf(p) !== color) continue;
    const f = i % 8, r = (i / 8) | 0;
    const pt = p.toLowerCase();
    if (pt === 'p') {
      const r1 = r + up;
      if (r1 >= 0 && r1 < 8) {
        const fwd = r1 * 8 + f;
        if (!s.board[fwd]) {
          pushPawn(out, i, fwd, p, '');
          const startR = color === 'w' ? 6 : 1;
          if (r === startR && !s.board[(r + 2 * up) * 8 + f]) out.push(mv(i, (r + 2 * up) * 8 + f, p, '', 'double'));
        }
        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7) continue;
          const t = r1 * 8 + nf, tp = s.board[t];
          if (tp && colorOf(tp) !== color) pushPawn(out, i, t, p, tp);
          else if (!tp && t === s.ep) out.push(mv(i, t, p, color === 'w' ? 'p' : 'P', 'ep'));
        }
      }
    } else if (pt === 'n') {
      for (const [df, dr] of NOFF) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const t = nr * 8 + nf, tp = s.board[t];
        if (!tp || colorOf(tp) !== color) out.push(mv(i, t, p, tp));
      }
    } else if (pt === 'k') {
      for (const [df, dr] of KOFF) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const t = nr * 8 + nf, tp = s.board[t];
        if (!tp || colorOf(tp) !== color) out.push(mv(i, t, p, tp));
      }
      genCastles(s, color, out);
    } else {
      const rays = pt === 'b' ? DIAG : pt === 'r' ? ORTH : DIAG.concat(ORTH);
      for (const [df, dr] of rays) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const t = nr * 8 + nf, tp = s.board[t];
          if (!tp) out.push(mv(i, t, p, ''));
          else { if (colorOf(tp) !== color) out.push(mv(i, t, p, tp)); break; }
          nf += df; nr += dr;
        }
      }
    }
  }
  return out;
}

function makeMove(s, m) {
  const n = clone(s);
  n.board[m.to] = m.promo || m.piece;
  n.board[m.from] = '';
  if (m.flag === 'ep') n.board[(m.to % 8) + ((m.from / 8) | 0) * 8] = '';
  if (m.flag === 'castleK') {
    if (m.color === 'w') { n.board[61] = 'R'; n.board[63] = ''; }
    else { n.board[5] = 'r'; n.board[7] = ''; }
  }
  if (m.flag === 'castleQ') {
    if (m.color === 'w') { n.board[59] = 'R'; n.board[56] = ''; }
    else { n.board[3] = 'r'; n.board[0] = ''; }
  }
  n.ep = m.flag === 'double' ? (m.from + m.to) / 2 : -1;
  if (m.piece === 'K') { n.castling.wK = false; n.castling.wQ = false; }
  if (m.piece === 'k') { n.castling.bK = false; n.castling.bQ = false; }
  if (m.from === 63 || m.to === 63) n.castling.wK = false;
  if (m.from === 56 || m.to === 56) n.castling.wQ = false;
  if (m.from === 7 || m.to === 7) n.castling.bK = false;
  if (m.from === 0 || m.to === 0) n.castling.bQ = false;
  n.half = (m.cap || m.piece.toLowerCase() === 'p') ? 0 : s.half + 1;
  if (s.turn === 'b') n.full = s.full + 1;
  n.turn = opp(s.turn);
  return n;
}

function legalMoves(s) {
  const color = s.turn;
  const out = [];
  for (const m of genPseudo(s, color)) {
    if (!inCheck(makeMove(s, m), color)) out.push(m);
  }
  return out;
}

function perft(s, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const m of legalMoves(s)) n += perft(makeMove(s, m), d - 1);
  return n;
}

function insufficient(s) {
  const pieces = s.board.filter(Boolean).map(p => p.toLowerCase()).filter(p => p !== 'k');
  if (pieces.some(p => p === 'p' || p === 'r' || p === 'q')) return false;
  return pieces.length <= 1;
}

/* ================= EVAL + SEARCH ================= */
function evaluate(s) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = s.board[i];
    if (!p) continue;
    const pt = p.toLowerCase();
    const w = colorOf(p) === 'w';
    let v = VAL[pt];
    const f = i % 8, r = (i / 8) | 0;
    const center = (3.5 - Math.abs(3.5 - f)) + (3.5 - Math.abs(3.5 - r));
    if (pt === 'n' || pt === 'b') v += center * 4;
    else if (pt === 'q') v += center;
    else if (pt === 'p') {
      const adv = w ? 6 - r : r - 1;
      v += adv * 6 + (f >= 2 && f <= 5 ? 6 : 0);
    } else if (pt === 'k') {
      const home = w ? (r === 7 && (f === 1 || f === 2 || f === 6)) : (r === 0 && (f === 1 || f === 2 || f === 6));
      if (home) v += w ? 25 : -25;
    }
    score += w ? v : -v;
  }
  return s.turn === 'w' ? score : -score;
}

let NODES = 0;
function orderMoves(moves) {
  moves.sort((a, b) => (b.cap ? VAL[b.cap.toLowerCase()] || 0 : 0) - (a.cap ? VAL[a.cap.toLowerCase()] || 0 : 0));
}

function quiesce(s, alpha, beta, d) {
  NODES++;
  const stand = evaluate(s);
  if (d <= 0 || NODES > 150000) return stand;
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  const caps = legalMoves(s).filter(m => m.cap);
  orderMoves(caps);
  for (const m of caps) {
    const v = -quiesce(makeMove(s, m), -beta, -alpha, d - 1);
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

function search(s, depth, alpha, beta, ply) {
  NODES++;
  if (NODES > 250000) return evaluate(s);
  const moves = legalMoves(s);
  if (!moves.length) return inCheck(s, s.turn) ? -100000 + ply : 0;
  if (s.half >= 100) return 0;
  if (depth <= 0) return quiesce(s, alpha, beta, 4);
  orderMoves(moves);
  let best = -Infinity;
  for (const m of moves) {
    const v = -search(makeMove(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

const ELO = {
  400:  { depth: 1, blunder: 0.30, jitter: 120 },
  800:  { depth: 1, blunder: 0.15, jitter: 60 },
  1200: { depth: 2, blunder: 0.08, jitter: 35 },
  1600: { depth: 3, blunder: 0.03, jitter: 15 },
  2000: { depth: 4, blunder: 0.00, jitter: 5 },
};

function chooseAIMove(s, elo) {
  const P = ELO[elo] || ELO[1200];
  NODES = 0;
  const moves = legalMoves(s);
  if (!moves.length) return null;
  if (Math.random() < P.blunder) {
    const m = moves[(Math.random() * moves.length) | 0];
    return { move: m, score: 0, blunder: true };
  }
  orderMoves(moves);
  let best = null, bestV = -Infinity;
  for (const m of moves) {
    const v = -search(makeMove(s, m), P.depth - 1, -Infinity, Infinity, 1) + (Math.random() * 2 - 1) * P.jitter;
    if (v > bestV) { bestV = v; best = m; }
  }
  return { move: best, score: Math.round(bestV), blunder: false };
}

/* ================= ANALYSIS (probability + victims) ================= */
function pieceCanAttack(s, from, to) {
  const p = s.board[from];
  if (!p) return false;
  const pf = from % 8, pr = (from / 8) | 0;
  const tf = to % 8, tr = (to / 8) | 0;
  const df = tf - pf, dr = tr - pr;
  const pt = p.toLowerCase();
  if (pt === 'p') {
    const up = colorOf(p) === 'w' ? -1 : 1;
    return dr === up && Math.abs(df) === 1;
  }
  if (pt === 'n') return (Math.abs(df) === 1 && Math.abs(dr) === 2) || (Math.abs(df) === 2 && Math.abs(dr) === 1);
  if (pt === 'k') return Math.max(Math.abs(df), Math.abs(dr)) === 1;
  const diag = Math.abs(df) === Math.abs(dr) && df !== 0;
  const orth = (df === 0) !== (dr === 0);
  if (pt === 'b' && !diag) return false;
  if (pt === 'r' && !orth) return false;
  if (pt === 'q' && !diag && !orth) return false;
  const sf = Math.sign(df), sr = Math.sign(dr);
  let cf = pf + sf, cr = pr + sr;
  while (cf !== tf || cr !== tr) {
    if (s.board[cr * 8 + cf]) return false;
    cf += sf; cr += sr;
  }
  return true;
}

function attackersOf(s, sq, color) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const p = s.board[i];
    if (p && colorOf(p) === color && pieceCanAttack(s, i, sq)) out.push({ sq: i, piece: p });
  }
  return out;
}

function captureChance(s, from, to) {
  const target = s.board[to], attacker = s.board[from];
  if (!target) return 0;
  const tColor = colorOf(target), aColor = colorOf(attacker);
  const defenders = attackersOf(s, to, tColor).filter(x => x.sq !== to && x.sq !== from);
  if (!defenders.length) return 92;
  const cheapest = Math.min(...defenders.map(x => VAL[x.piece.toLowerCase()]));
  const av = VAL[attacker.toLowerCase()];
  let pct = cheapest < av ? 62 : (cheapest <= av ? 45 : 28);
  const myDefs = attackersOf(s, to, aColor).filter(x => x.sq !== from && x.sq !== to);
  if (myDefs.length) pct += 12;
  return Math.min(95, pct);
}

function exchangeSim(s, from, to) {
  const sim = { board: s.board.slice() };
  const myPiece = sim.board[from];
  const target = sim.board[to];
  if (!target) return { net: 0, lostMine: [], lostTheirs: [] };
  const myColor = colorOf(myPiece);
  let net = VAL[target.toLowerCase()];
  sim.board[to] = myPiece;
  sim.board[from] = '';
  const lostMine = [], lostTheirs = [];
  let side = opp(myColor);
  let cur = to;
  let standing = myPiece;
  let guard = 0;
  while (guard++ < 10) {
    const list = attackersOf(sim, cur, side);
    list.sort((a, b) => VAL[a.piece.toLowerCase()] - VAL[b.piece.toLowerCase()]);
    if (!list.length) break;
    const a = list[0];
    const v = VAL[standing.toLowerCase()];
    if (colorOf(standing) === myColor) { net -= v; lostMine.push({ sq: cur, alg: algOf(cur), piece: standing }); }
    else { net += v; lostTheirs.push({ sq: cur, alg: algOf(cur), piece: standing }); }
    standing = sim.board[a.sq];
    sim.board[cur] = standing;
    sim.board[a.sq] = '';
    cur = a.sq;
    side = opp(side);
  }
  return { net, lostMine, lostTheirs };
}

function dangerSquares(s, color) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const p = s.board[i];
    if (!p || colorOf(p) !== color) continue;
    const atk = attackersOf(s, i, opp(color));
    if (!atk.length) continue;
    const def = attackersOf(s, i, color).filter(x => x.sq !== i);
    const v = VAL[p.toLowerCase()];
    const cheapest = Math.min(...atk.map(x => VAL[x.piece.toLowerCase()]));
    if (!def.length || cheapest < v) out.push(i);
  }
  return out;
}

function materialCp(s, color) {
  let t = 0;
  for (const p of s.board) {
    if (!p || p.toLowerCase() === 'k') continue;
    t += VAL[p.toLowerCase()] * (colorOf(p) === color ? 1 : -1);
  }
  return t;
}

/* ================= VOICE SYSTEM ================= */
const PHRASES = {
  start: [
    "[giggles] Game shuru boss! Main Miku, teri chess partner. Haarti hoon toh ice cream dena, [pause] jeetun toh muh mat phulana.",
    "Chalo boss, board ready hai! [pause] Aaj soft rahungi ya gussa... decide khud karungi. [giggles]",
    "Tera Elo chuna hua hai... [playful] dekhte hain kitna sach mein hai. [giggles]"
  ],
  normal: [
    "Soch liya... [pause] ye dekho.",
    "Ye kiya maine. [playful] Samajh paoge kya? [giggles]",
    "Isko bolte hain planning, boss. [giggles]",
    "Hmmm... [pause] ye best tha."
  ],
  capture: [
    "[giggles] Piece liya tera! [pause] Aur aayenge.",
    "[angry] Ye mera hai ab! [pause] Rone mat, board dekh.",
    "Free piece rakha tha? [emphasis] Lene mein sharam nahi hoti. Thank you bol. [giggles]"
  ],
  got_captured: [
    "[sad] Mera piece... [sniffles] theek hai. [pause] Main yaad rakhungi ye.",
    "[cry loudly] Nahiiii! [pause] ok ok... [whisper] badla lene aa rahi hoon.",
    "[sigh] Haan haan le le. [pause] Main toh bas practice kar rahi thi na. [giggles]"
  ],
  check: [
    "[playful] Check! [giggles] Bhaagne ka time, boss.",
    "[cheerful] Check de diya! [pause] Ghabrana nahi... ya ghabra. Teri marzi."
  ],
  ai_in_check: [
    "[angry] Check diya tune?! [pause] Theek hai... shaatranj toh shaatranj hai.",
    "[sad] Uff... [pause] theek hai, bhaag rahi hoon."
  ],
  taunt: [
    "[angry] Ye kaisa move tha?! [pause] Mera calculator better khelta hai. [giggles]",
    "[playful] Tera position dekh... [pause] na na mat dekh. [giggles] Dukh hoga.",
    "[angry] Clock dekh le boss. Main engine hoon, mere paas time infinite hai. Tu insaan hai na? [giggles]",
    "[evil giggle] Sochna band, panic shuru. [pause] Ab aati hoon main!"
  ],
  soft: [
    "[cheerful] Achha move boss! [pause] Sach mein, seekh rahe ho dheere dheere.",
    "[giggles] Waah! [pause] Ye toh mujhe bhi nahi soojhi itni jaldi."
  ],
  winning: [
    "[giggles] Material dekh le boss... [pause] abhi bacha kya hai tere paas? [giggles]",
    "[playful] Haalat samajh rahe ho? [pause] Chalo, main thoda slow khelungi. Taki maza aaye."
  ],
  losing: [
    "[sad] Aaj tera din hai lagta hai... [pause] theek hai, note kar liya maine.",
    "[whisper] Hmmm... [pause] comeback ka time. Dekhte hain."
  ],
  idle: [
    "[whisper] Soch rahi hoon... [pause] tu bhi soch le kuch.",
    "[playful] Ukbanda ho raha hai kya? [giggles] Move maar jaldi.",
    "[pause] Sun... ye game jeetne ke liye maine aaj special mood le rakha hai."
  ],
  win: [
    "[giggles] Checkmate! Jeet gayi main. [playful] Ice cream ki yaad hai na? [cheerful] Treat do!"
  ],
  lose: [
    "[cry loudly] Checkmate... haar gayi! [sniffles] [playful] Rematch? Is baar easy mode... [giggles]"
  ],
  draw: [
    "[pause] Draw ho gaya. [playful] Dono barabar... [giggles] matlab main thodi si kam thi ya tu zyada?"
  ]
};

function pickPhrase(cat) {
  const list = PHRASES[cat] || PHRASES.normal;
  return list[(Math.random() * list.length) | 0];
}
function stripTags(t) { return t.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim(); }
function firstTag(t) { const m = t.match(/\[([a-z ]+)\]/i); return m ? m[1].trim() : 'neutral'; }

const BANK = {};
function scanVoices() {
  for (const k in BANK) delete BANK[k];
  if (!fs.existsSync(CONFIG.voiceDir)) return;
  for (const f of fs.readdirSync(CONFIG.voiceDir)) {
    const m = f.match(/^([a-z]+)_(\d+)\.mp3$/i);
    if (m) { (BANK[m[1].toLowerCase()] = BANK[m[1].toLowerCase()] || []).push('/voices/' + f); }
  }
}

async function fishTTS(text) {
  const body = { text, reference_id: CONFIG.fishModel, format: 'mp3', latency: 'balanced', normalize: true };
  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { Authorization: CONFIG.fishToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('fish ' + res.status + ': ' + (await res.text()).slice(0, 120));
  return Buffer.from(await res.arrayBuffer());
}

async function getVoice(cat) {
  const phrase = pickPhrase(cat);
  const text = stripTags(phrase);
  const emo = firstTag(phrase);
  const b = BANK[cat];
  if (b && b.length) {
    const url = b[(Math.random() * b.length) | 0];
    return { mode: 'mp3', url, text, emotion: emo };
  }
  if (CONFIG.fishOn) {
    try {
      const hash = crypto.createHash('md5').update(text).digest('hex').slice(0, 12);
      const file = path.join(CONFIG.voiceDir, cat + '_' + hash + '.mp3');
      if (!fs.existsSync(file)) {
        const buf = await fishTTS(text);
        fs.writeFileSync(file, buf);
        scanVoices();
      }
      return { mode: 'mp3', url: '/voices/' + path.basename(file), text, emotion: emo };
    } catch (e) { /* fallback to TTS */ }
  }
  return { mode: 'tts', text, emotion: emo };
}

/* ================= MIKU CHAT PERSONALITY ================= */
const CHAT = {
  greet: [
    "[cheerful] Hello boss! [pause] Aa gaye finally. Khelo ab.",
    "[giggles] Namaste boss! [pause] Aaj kaun jeetega... wahi dekhenge."
  ],
  howare: [
    "[cheerful] Main ekdum first class! [pause] Tu bol, Elo kitna rakhne ka soch raha hai?",
    "[playful] Badhiya! [pause] Tension teri hogi, meri nahi. [giggles]"
  ],
  winpred: [
    "[playful] Jeet? [pause] Dekhte hain board pe kaun ghabrata hai. [giggles]",
    "[giggles] Tu jeetega tab na! [pause] Chal shuru kar."
  ],
  savage: [
    "[angry] Gaali dena hai? [pause] Pehle knight bacha le phir baat karna. [giggles]",
    "[evil giggle] Itna gussa? [pause] Eval bar dekh ke muh me paani aa raha hoga na tera. [giggles]"
  ],
  soft: [
    "[cheerful] Koi baat nahi boss! [pause] Dheere dheere — main hoon yahin.",
    "[giggles] Sweet hai tu kabhi kabhi. [pause] Board pe waise bhi pitega. [giggles]"
  ],
  general: [
    "[playful] Haan haan, sun rahi hoon. [pause] Par move bhi de, baatein baad mein.",
    "[giggles] Achha! [pause] Aur? [pause] ...chess khel rahe hain hum, bhool na ja."
  ]
};

function chatReply(text, mood) {
  const t = (text || '').toLowerCase();
  let pool = CHAT.general;
  if (/hello|hi\b|namaste|hey|aa gaya|aaya/.test(t)) pool = CHAT.greet;
  else if (/kaise|kaisa|haal|how are/.test(t)) pool = CHAT.howare;
  else if (/jeet|win|kaun jeetega/.test(t)) pool = CHAT.winpred;
  else if (/sorry|maaf|achha|good|waah|nice|shabaash/.test(t)) pool = CHAT.soft;
  else if (/gali|gaali|abuse|offensive|gussa|idiot|bewakoof|pagal/.test(t)) pool = CHAT.savage;
  if (mood === 'savage' && Math.random() < 0.5) pool = CHAT.savage;
  if (mood === 'soft' && Math.random() < 0.6) pool = CHAT.soft;
  const raw = pool[(Math.random() * pool.length) | 0];
  return { text: stripTags(raw), emotion: firstTag(raw) };
}

/* ================= GAME MANAGER ================= */
let game = null;
function addKey(s) {
  const k = toFEN(s).split(' ').slice(0, 4).join(' ');
  game.keys[k] = (game.keys[k] || 0) + 1;
}
function posKey(s) { return toFEN(s).split(' ').slice(0, 4).join(' '); }

function toSAN(s, m) {
  const piece = s.board[m.from];
  const pt = piece.toLowerCase();
  let san;
  if (m.flag === 'castleK') san = 'O-O';
  else if (m.flag === 'castleQ') san = 'O-O-O';
  else if (pt === 'p') {
    san = m.cap ? FILES[m.from % 8] + 'x' + algOf(m.to) : algOf(m.to);
    if (m.promo) san += '=' + m.promo.toUpperCase();
  } else {
    const same = legalMoves(s).filter(x => x.piece === piece && x.to === m.to && x.from !== m.from);
    let dis = '';
    if (same.length) {
      const sameFile = same.some(x => (x.from % 8) === (m.from % 8));
      const sameRank = same.some(x => ((x.from / 8) | 0) === ((m.from / 8) | 0));
      if (!sameFile) dis = FILES[m.from % 8];
      else if (!sameRank) dis = String(8 - ((m.from / 8) | 0));
      else dis = algOf(m.from);
    }
    san = piece.toUpperCase() + dis + (m.cap ? 'x' : '') + algOf(m.to);
  }
  const n = makeMove(s, m);
  if (inCheck(n, n.turn)) san += legalMoves(n).length ? '+' : '#';
  return san;
}

function checkOver() {
  const s = game.state;
  if (game.over) return true;
  const moves = legalMoves(s);
  if (!moves.length) {
    if (inCheck(s, s.turn)) game.over = { result: s.turn === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
    else game.over = { result: '1/2-1/2', reason: 'stalemate' };
    return true;
  }
  if (s.half >= 100) { game.over = { result: '1/2-1/2', reason: '50 move rule' }; return true; }
  if (game.keys[posKey(s)] >= 3) { game.over = { result: '1/2-1/2', reason: 'repetition' }; return true; }
  if (insufficient(s)) { game.over = { result: '1/2-1/2', reason: 'insufficient material' }; return true; }
  return false;
}

function newGame(elo, side, mood) {
  game = {
    state: parseFEN(START_FEN),
    elo: Number(elo) || 1200,
    aiColor: side === 'b' ? 'w' : 'b',
    history: [], snaps: [], keys: {}, over: null, lastMove: null,
    chat: [], mood: mood || 'normal'
  };
  addKey(game.state);
  return game;
}

function applyAIMove() {
  const s = game.state;
  const r = chooseAIMove(s, game.elo);
  if (!r) return null;
  const san = toSAN(s, r.move);
  const before = materialCp(s, game.aiColor);
  game.snaps.push(toFEN(s));
  game.state = makeMove(s, r.move);
  addKey(game.state);
  game.history.push({ san, color: game.aiColor });
  game.lastMove = { from: r.move.from, to: r.move.to };
  checkOver();
  const after = materialCp(game.state, game.aiColor);
  let cat;
  if (game.over) {
    const won = (game.over.result === '1-0' && game.aiColor === 'w') || (game.over.result === '0-1' && game.aiColor === 'b');
    cat = game.over.result === '1/2-1/2' ? 'draw' : (won ? 'win' : 'lose');
  }
  else if (r.blunder) cat = 'got_captured';
  else if (r.move.cap) cat = 'capture';
  else if (inCheck(game.state, game.state.turn)) cat = 'check';
  else if (after - before >= 100) cat = 'winning';
  else if (after - before <= -100) cat = 'losing';
  else {
    const roll = Math.random();
    cat = roll < 0.5 ? 'normal' : roll < 0.7 ? 'taunt' : roll < 0.85 ? 'soft' : 'idle';
  }
  return { from: r.move.from, to: r.move.to, san, cat, blunder: r.blunder };
}

function userColor() { return opp(game.aiColor); }

function statePayload() {
  const s = game.state;
  const legal = legalMoves(s);
  return {
    board: s.board, turn: s.turn, fen: toFEN(s), aiColor: game.aiColor,
    userColor: userColor(),
    legal: legal.map(m => ({ from: m.from, to: m.to, cap: !!m.cap, promo: m.promo })),
    lastMove: game.lastMove, over: game.over,
    check: inCheck(s, s.turn),
    checkSq: s.turn === 'w' ? kingSq(s, 'w') : kingSq(s, 'b'),
    danger: dangerSquares(s, userColor()),
    material: { you: materialCp(s, userColor()), miku: materialCp(s, game.aiColor) },
    history: game.history.map(h => h.san),
    elo: game.elo, mood: game.mood, chat: game.chat
  };
}

function pgn() {
  let out = '[Event "Miku Chess"]\n[White "' + (game.aiColor === 'w' ? 'Miku' : 'Boss') + '"]\n[Black "' + (game.aiColor === 'b' ? 'Miku' : 'Boss') + '"]\n';
  if (game.over) out += '[Result "' + game.over.result + '"]\n';
  out += '\n';
  const sans = game.history.map(h => h.san);
  for (let i = 0; i < sans.length; i += 2) {
    out += ((i / 2) + 1) + '. ' + sans[i] + (sans[i + 1] ? ' ' + sans[i + 1] : '') + ' ';
  }
  if (game.over) out += game.over.result;
  return out.trim();
}

/* ================= SERVER ================= */
const HTML = `<!DOCTYPE html>
<html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Miku Chess</title>
<style>
*{box-sizing:border-box;margin:0}
body{background:#1b1a17;color:#eee;font-family:'Segoe UI',system-ui,sans-serif}
#top{display:flex;gap:8px;align-items:center;padding:10px 14px;background:#242320;border-bottom:2px solid #3a382f;flex-wrap:wrap}
#top h1{font-size:18px;color:#ff9ad5;margin-right:6px}
select,button,input{background:#2e2c27;color:#eee;border:1px solid #4a483e;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer}
button:hover{background:#3a3830}
button.warn{border-color:#a33}
#main{display:flex;gap:16px;padding:16px;justify-content:center;align-items:flex-start;flex-wrap:wrap}
#board{display:grid;grid-template-columns:repeat(8,60px);grid-template-rows:repeat(8,60px);border:3px solid #4a483e;border-radius:6px;user-select:none}
.sq{display:flex;align-items:center;justify-content:center;font-size:42px;cursor:pointer;position:relative}
.sq.l{background:#f0d9b5}.sq.d{background:#b58863}
.pc{line-height:1;pointer-events:none}
.wpc{color:#fff;text-shadow:0 0 2px #000,1px 1px 0 #000,-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000}
.bpc{color:#1c1b18;text-shadow:0 0 1px #999}
.sq.sel{outline:3px solid #ffd24a;outline-offset:-3px}
.sq.last{box-shadow:inset 0 0 0 3px rgba(80,160,255,.7)}
.sq.check{box-shadow:inset 0 0 0 4px rgba(255,60,60,.9)}
.sq.dot::after{content:'';width:14px;height:14px;border-radius:50%;position:absolute;opacity:.9;z-index:2}
.dot.n::after{background:rgba(60,90,60,.9)}
.dot.g::after{background:#4caf50}.dot.y::after{background:#ffc107}.dot.r::after{background:#e53935}
.sq.danger{box-shadow:inset 0 0 0 3px rgba(255,40,40,.85);animation:pulse 1.2s infinite}
@keyframes pulse{50%{box-shadow:inset 0 0 0 7px rgba(255,40,40,.45)}}
.sq.victim{box-shadow:inset 0 0 0 4px rgba(255,0,0,.95);animation:pulse .8s infinite}
.sq.prey{box-shadow:inset 0 0 0 4px rgba(60,220,120,.95)}
.sq.atkmove{box-shadow:inset 0 0 0 3px rgba(80,220,120,.6)}
#panel{width:370px;max-width:94vw;display:flex;flex-direction:column;gap:10px}
.card{background:#242320;border:1px solid #3a382f;border-radius:10px;padding:10px}
#bubble{min-height:48px;background:linear-gradient(135deg,#3a2438,#241a2e);border:1px solid #b06ab3;border-radius:12px;padding:10px;font-size:14px;color:#ffd9f2}
#bubble b{color:#ff9ad5}
#status{font-size:13px;line-height:1.5}
#chatlog{height:150px;overflow-y:auto;font-size:13px;display:flex;flex-direction:column;gap:4px}
.me{color:#9fd6ff}.miku{color:#ff9ad5}.sys{color:#888;font-size:12px}
#chatrow{display:flex;gap:6px;margin-top:6px}
#chatin{flex:1}
#analysis{font-size:12px;line-height:1.65;min-height:50px;color:#ccc}
#analysis b{color:#ffd24a}
#moves{font-size:12px;max-height:110px;overflow-y:auto;line-height:1.6;color:#bbb}
.tgl{display:flex;gap:12px;align-items:center;font-size:12px;color:#bbb;flex-wrap:wrap}
.tgl label{display:flex;gap:4px;align-items:center;cursor:pointer}
.small{font-size:11px;color:#888}
@media(max-width:700px){#board{grid-template-columns:repeat(8,11vw);grid-template-rows:repeat(8,11vw)}.sq{font-size:7vw}}
</style></head>
<body>
<div id="top">
  <h1>&#9821; Miku Chess</h1>
  <select id="elo"><option value="400">Miku 400 (baby)</option><option value="800">Miku 800</option><option value="1200" selected>Miku 1200</option><option value="1600">Miku 1600</option><option value="2000">Miku 2000 (beast)</option></select>
  <select id="side"><option value="w" selected>Tu White</option><option value="b">Tu Black</option></select>
  <select id="mood"><option value="normal" selected>Mood: Normal</option><option value="soft">Mood: Soft</option><option value="savage">Mood: Savage</option></select>
  <button id="new">New Game</button>
  <button id="undo">Undo</button>
  <button id="resign" class="warn">Resign</button>
</div>
<div id="main">
  <div><div id="board"></div>
    <div class="tgl" style="margin-top:8px">
      <label><input type="checkbox" id="tvoice" checked> Voice</label>
      <label><input type="checkbox" id="tdanger" checked> Danger glow</label>
      <label><input type="checkbox" id="thints" checked> Hints</label>
    </div>
    <div class="small" style="margin-top:6px">Piece pe click = moves + probability &middot; Enemy piece pe click = threat report &middot; Red glow = wahan piece girega</div>
  </div>
  <div id="panel">
    <div id="bubble"><b>Miku:</b> Ready hoon boss! New Game dabao.</div>
    <div class="card" id="status">—</div>
    <div class="card"><div style="font-size:12px;color:#888;margin-bottom:4px">ANALYSIS</div><div id="analysis">Piece pe click kar...</div></div>
    <div class="card">
      <div style="font-size:12px;color:#888;margin-bottom:4px">CHAT — Miku voice me jawab degi</div>
      <div id="chatlog"></div>
      <div id="chatrow"><input id="chatin" placeholder="Miku se baat kar..."><button id="chatsend">Bhej</button></div>
    </div>
    <div class="card"><div style="font-size:12px;color:#888;margin-bottom:4px">MOVES / PGN</div><div id="moves">—</div></div>
  </div>
</div>
<script>
var S = null, sel = -1, analysis = null, userColor = 'w';
var VOICE = true, DANGER = true, HINTS = true;
var lastAct = Date.now();
var GLYPH = {k:'\\u265A',q:'\\u265B',r:'\\u265C',b:'\\u265D',n:'\\u265E',p:'\\u265F'};
var EMO = {neutral:[1,1,1],cheerful:[1.08,1.25,1],sad:[0.85,0.85,1],angry:[1.15,1.35,1],'cry loudly':[0.8,1.05,1],giggles:[1.05,1.3,1],playful:[1.05,1.2,1],whisper:[0.9,1.05,0.45],'evil giggle':[1.1,1.15,1],sigh:[0.85,0.9,0.8]};
function col(p){return p?(p===p.toUpperCase()?'w':'b'):null;}
function $(id){return document.getElementById(id);}

function render(){
  var b = $('board'); b.innerHTML = '';
  var flipped = userColor === 'b';
  for (var vi=0; vi<64; vi++){
    var idx = flipped ? 63-vi : vi;
    var d = document.createElement('div');
    d.className = 'sq ' + ((((idx/8|0)+idx%8)%2) ? 'd':'l');
    d.setAttribute('data-sq', idx);
    var p = S.board[idx];
    if (p){ var sp=document.createElement('span'); sp.className='pc '+(col(p)==='w'?'wpc':'bpc'); sp.textContent=GLYPH[p.toLowerCase()]; d.appendChild(sp); }
    if (DANGER && S.danger && S.danger.indexOf(idx)>=0) d.classList.add('danger');
    if (S.lastMove && (S.lastMove.from===idx || S.lastMove.to===idx)) d.classList.add('last');
    if (S.check && S.checkSq===idx) d.classList.add('check');
    b.appendChild(d);
  }
  applyHighlights();
  var mat = S.material || {};
  $('status').innerHTML = 'Turn: <b>' + (S.turn===userColor?'TU':'Miku') + '</b> &middot; Material: Tu ' + (mat.you||0) + ' vs Miku ' + (mat.miku||0) +
    '<br>Elo: ' + S.elo + ' &middot; Mood: ' + S.mood + (S.over ? '<br><b style="color:#ff9ad5">GAME OVER: ' + S.over.reason + ' (' + S.over.result + ')</b>' : '');
  var pairs = '';
  for (var i=0;i<S.history.length;i+=2){ pairs += ((i/2)+1) + '. ' + S.history[i] + (S.history[i+1]?' '+S.history[i+1]:'') + '<br>'; }
  $('moves').innerHTML = pairs || '—';
}

function applyHighlights(){
  var cells = document.querySelectorAll('.sq');
  for (var i=0;i<cells.length;i++){
    var idx = parseInt(cells[i].getAttribute('data-sq'));
    if (idx === sel) cells[i].classList.add('sel');
    if (!analysis) continue;
    if (analysis.victims && analysis.victims.indexOf(idx) >= 0) cells[i].classList.add('victim');
    if (analysis.prey && analysis.prey.indexOf(idx) >= 0) cells[i].classList.add('prey');
    if (analysis.atkMoves && analysis.atkMoves.indexOf(idx) >= 0) cells[i].classList.add('atkmove');
  }
  if (sel >= 0 && HINTS && S.legal){
    for (var j=0;j<cells.length;j++){
      var sq2 = parseInt(cells[j].getAttribute('data-sq'));
      for (var k=0;k<S.legal.length;k++){
        var mv2 = S.legal[k];
        if (mv2.from === sel && mv2.to === sq2){
          cells[j].classList.add('dot');
          var cls = 'n';
          if (mv2.cap){
            cls = 'y';
            if (analysis && analysis.capPct && analysis.capPct[sq2] !== undefined){
              var pct = analysis.capPct[sq2];
              cls = pct >= 70 ? 'g' : (pct >= 45 ? 'y' : 'r');
            }
          }
          cells[j].classList.add(cls);
        }
      }
    }
  }
}

function bubble(t){ $('bubble').innerHTML = '<b>Miku:</b> ' + t; }

var TTSVOICE = null;
function pickTTSVoice(){
  var vs = speechSynthesis.getVoices();
  var pref = vs.filter(function(v){ return /female|zira|aria|heera|kalpana|swara|woman/i.test(v.name); });
  var hi = vs.filter(function(v){ return /^hi/i.test(v.lang); });
  TTSVOICE = pref[0] || hi[0] || vs[0] || null;
}
if (window.speechSynthesis){ pickTTSVoice(); speechSynthesis.onvoiceschanged = pickTTSVoice; }
function speakTTS(text, emo){
  if (!VOICE || !window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    if (TTSVOICE) u.voice = TTSVOICE;
    u.lang = 'hi-IN';
    var e = EMO[emo] || EMO.neutral;
    u.rate = e[0]; u.pitch = e[1]; u.volume = e[2];
    speechSynthesis.speak(u);
  } catch(err){}
}
function playVoice(cat){
  if (!VOICE) return;
  fetch('/api/voice?cat=' + cat + '&n=' + Math.random()).then(function(r){return r.json();}).then(function(v){
    if (v.mode === 'mp3'){ var a = new Audio(v.url); a.play().catch(function(){}); }
    else speakTTS(v.text, v.emotion);
    if (v.text) bubble(v.text);
  }).catch(function(){});
}

function refresh(s){ S = s; userColor = s.userColor; sel = -1; analysis = null; render(); }

function doMove(from, to){
  lastAct = Date.now();
  fetch('/api/move', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({from:from, to:to})})
  .then(function(r){return r.json();}).then(function(res){
    if (!res.ok){ bubble('Illegal move boss! ' + (res.error||'')); return; }
    refresh(res.state);
    if (res.aiVoice && res.aiVoice.text) bubble(res.aiVoice.text);
    else if (res.ai) bubble('Miku: ' + res.ai.san);
    if (res.ai) playVoice(res.ai.cat);
    if (res.oppCat){ setTimeout(function(){ playVoice(res.oppCat); }, 2800); }
    if (res.over && res.over.reason){
      setTimeout(function(){
        var c = res.over.result === '1/2-1/2' ? 'draw' : ((res.over.result==='1-0'&&userColor==='w')||(res.over.result==='0-1'&&userColor==='b') ? 'win' : 'lose');
        playVoice(c);
      }, 5600);
    }
  }).catch(function(){ bubble('Network error...'); });
}

function fetchAnalysis(sq){
  fetch('/api/analysis?sq=' + sq).then(function(r){return r.json();}).then(function(a){
    if (a.empty) { $('analysis').innerHTML = 'Khali square.'; return; }
    analysis = a; render();
    var h = '<b>' + a.alg + '</b> (' + a.pieceName + ')<br>';
    h += 'Attackers: ' + a.attackerStr + '<br>Defenders: ' + a.defenderStr + '<br>';
    if (a.verdict) h += 'Verdict: <b>' + a.verdict + '</b><br>';
    if (a.capLines && a.capLines.length) h += 'Captures: ' + a.capLines.join(' | ');
    $('analysis').innerHTML = h;
  }).catch(function(){});
}

document.getElementById('board').addEventListener('click', function(ev){
  var t = ev.target.closest('.sq'); if (!t || !S || S.over) return;
  lastAct = Date.now();
  var sq = parseInt(t.getAttribute('data-sq'));
  var p = S.board[sq];
  if (sel >= 0){
    for (var k=0;k<S.legal.length;k++){
      if (S.legal[k].from===sel && S.legal[k].to===sq){ doMove(sel, sq); return; }
    }
  }
  if (p && col(p) === userColor && S.turn === userColor){
    sel = sq;
    fetchAnalysis(sq);
    render();
  } else if (p){
    sel = -1;
    fetchAnalysis(sq);
    render();
  } else { sel = -1; analysis = null; render(); }
});

$('new').onclick = function(){
  fetch('/api/new', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({elo: parseInt($('elo').value), side: $('side').value, mood: $('mood').value})})
  .then(function(r){return r.json();}).then(function(res){
    refresh(res.state);
    if (res.aiVoice && res.aiVoice.text) bubble(res.aiVoice.text);
    if (res.ai) playVoice(res.ai.cat); else playVoice('start');
  });
};
$('undo').onclick = function(){ fetch('/api/undo', {method:'POST'}).then(function(r){return r.json();}).then(function(res){ refresh(res.state); }); };
$('resign').onclick = function(){ if (!confirm('Resign?')) return; fetch('/api/resign', {method:'POST'}).then(function(r){return r.json();}).then(function(res){ refresh(res.state); playVoice('lose'); }); };
$('mood').onchange = function(){ fetch('/api/mood', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({mood: $('mood').value})}); };
$('tvoice').onchange = function(){ VOICE = $('tvoice').checked; };
$('tdanger').onchange = function(){ DANGER = $('tdanger').checked; render(); };
$('thints').onchange = function(){ HINTS = $('thints').checked; render(); };

function addChat(who, text){
  var d = document.createElement('div');
  d.className = who; d.textContent = (who==='me'?'Tu: ':who==='miku'?'Miku: ':'') + text;
  var log = $('chatlog'); log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function sendChat(){
  var t = $('chatin').value.trim(); if (!t) return;
  $('chatin').value = '';
  addChat('me', t);
  fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text: t})})
  .then(function(r){return r.json();}).then(function(res){
    if (res.reply){ addChat('miku', res.reply.text); speakTTS(res.reply.text, res.reply.emotion); bubble(res.reply.text); }
  });
}
$('chatsend').onclick = sendChat;
$('chatin').addEventListener('keydown', function(e){ if (e.key === 'Enter') sendChat(); });

setInterval(function(){
  if (!VOICE || !S || S.over) return;
  if (Date.now() - lastAct > 60000){ lastAct = Date.now(); playVoice('idle'); }
}, 15000);

loadState().then(function(s){ refresh(s); });
</script></body></html>`;

function json(res, obj, code) { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise(function (resolve) {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({}); } });
  });
}
function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

if (!fs.existsSync(CONFIG.voiceDir)) fs.mkdirSync(CONFIG.voiceDir, { recursive: true });
scanVoices();
newGame(1200, 'w', 'normal');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    if (p.startsWith('/voices/')) {
      return serveFile(res, path.join(CONFIG.voiceDir, path.basename(p)), 'audio/mpeg');
    }
    if (p === '/api/state') return json(res, statePayload());
    if (p === '/api/new') {
      const b = await readBody(req);
      newGame(b.elo || 1200, b.side || 'w', b.mood || 'normal');
      let ai = null, aiVoice = null;
      if (game.aiColor === 'w' && !game.over) {
        ai = applyAIMove();
        if (ai) aiVoice = await getVoice(ai.cat);
      }
      return json(res, { ok: true, state: statePayload(), ai, aiVoice });
    }
    if (p === '/api/move') {
      const b = await readBody(req);
      if (game.over) return json(res, { ok: false, error: 'game over' });
      if (game.state.turn !== userColor()) return json(res, { ok: false, error: 'not your turn' });
      const cands = legalMoves(game.state).filter(m => m.from === b.from && m.to === b.to);
      if (!cands.length) return json(res, { ok: false, error: 'illegal move' });
      const m = b.promo ? (cands.find(x => x.promo && x.promo.toLowerCase() === String(b.promo).toLowerCase()) || cands[0])
        : (cands.find(x => !x.promo) || cands.find(x => x.promo.toLowerCase() === 'q') || cands[0]);
      const san = toSAN(game.state, m);
      const oppCat = m.cap ? 'got_captured' : (inCheck(makeMove(game.state, m), game.aiColor) ? 'ai_in_check' : null);
      game.snaps.push(toFEN(game.state));
      game.state = makeMove(game.state, m);
      addKey(game.state);
      game.history.push({ san, color: userColor() });
      game.lastMove = { from: m.from, to: m.to };
      let ai = null, aiVoice = null;
      if (!checkOver()) ai = applyAIMove();
      if (ai) aiVoice = await getVoice(ai.cat);
      return json(res, { ok: true, user: { san }, ai, aiVoice, oppCat, state: statePayload() });
    }
    if (p === '/api/voice') {
      const cat = u.searchParams.get('cat') || 'idle';
      const v = await getVoice(cat);
      return json(res, v);
    }
    if (p === '/api/analysis') {
      const sq = Number(u.searchParams.get('sq'));
      const s = game.state;
      const piece = s.board[sq];
      if (!piece) return json(res, { empty: true });
      const color = colorOf(piece);
      const NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
      const attackers = attackersOf(s, sq, opp(color));
      const defenders = attackersOf(s, sq, color).filter(x => x.sq !== sq);
      const fmt = l => l.map(x => NAMES[x.piece.toLowerCase()] + ' ' + algOf(x.sq)).join(', ') || 'none';
      let captures = [];
      if (color === userColor() && s.turn === userColor()) {
        captures = legalMoves(s).filter(m => m.from === sq && m.cap).map(m => ({ to: m.to, alg: algOf(m.to), pct: captureChance(s, m.from, m.to) }));
      }
      const capPct = {}; captures.forEach(c => capPct[c.to] = c.pct);
      const oppAtk = attackersOf(s, sq, opp(color)).sort((a, b) => VAL[a.piece.toLowerCase()] - VAL[b.piece.toLowerCase()]);
      let threat = null, victims = [];
      if (oppAtk.length) {
        threat = exchangeSim(s, oppAtk[0].sq, sq);
        victims = threat.lostTheirs.map(x => x.sq);
      }
      const prey = [];
      for (const m of legalMoves(s)) {
        if (m.from === sq && m.cap && captureChance(s, m.from, m.to) >= 70) prey.push(m.to);
      }
      let verdict = '';
      if (threat) {
        const myNet = -threat.net;
        verdict = myNet > 100 ? 'Ye piece girega agar bachaya nahi (−' + (-myNet) + ')' : myNet < -100 ? 'Capture karega toh uska nuksaan (+' + (-myNet) + ')' : 'Approx balance exchange';
      }
      const atkMoves = color === userColor() ? legalMoves(s).filter(m => m.from === sq).map(m => m.to) : [];
      return json(res, {
        piece, color, alg: algOf(sq),
        pieceName: NAMES[piece.toLowerCase()],
        attackerStr: fmt(attackers), defenderStr: fmt(defenders),
        captures, capPct, threat, victims, prey, atkMoves, verdict,
        capLines: captures.map(c => algOf(c.to) + ' (' + c.pct + '%)')
      });
    }
    if (p === '/api/chat') {
      const b = await readBody(req);
      const reply = chatReply(b.text || '', game.mood);
      game.chat.push({ who: 'boss', text: b.text || '' });
      game.chat.push({ who: 'miku', text: reply.text, emotion: reply.emotion });
      return json(res, { ok: true, reply });
    }
    if (p === '/api/mood') {
      const b = await readBody(req);
      game.mood = b.mood || 'normal';
      return json(res, { ok: true, mood: game.mood });
    }
    if (p === '/api/undo') {
      if (game.snaps.length) {
        game.state = parseFEN(game.snaps.pop());
        game.history.pop();
        if (game.history.length && game.history[game.history.length - 1].color === userColor()) {
          game.state = parseFEN(game.snaps.pop());
          game.history.pop();
        }
        game.over = null;
      }
      return json(res, { ok: true, state: statePayload() });
    }
    if (p === '/api/resign') {
      game.over = { result: game.aiColor === 'w' ? '1-0' : '0-1', reason: 'resignation' };
      return json(res, { ok: true, state: statePayload() });
    }
    if (p === '/api/pgn') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(pgn()); return; }
    json(res, { ok: false, error: 'unknown endpoint' }, 404);
  } catch (e) {
    json(res, { ok: false, error: String(e && e.message || e) }, 500);
  }
});

server.listen(CONFIG.port, function () {
  console.log('==============================================');
  console.log('  MIKU CHESS chal raha hai:');
  console.log('  http://localhost:' + CONFIG.port);
  console.log('  Voice bank: ' + (Object.keys(BANK).map(k => k + '(' + BANK[k].length + ')').join(' ') || '(khali — TTS fallback active)'));
  console.log('==============================================');
});

})();
