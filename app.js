/* ============================================================
   Kuzhal — bamboo flute learning companion
   Vanilla JS. No dependencies. Sections:
   1. Music engine (notes, swaras, parsing)
   2. Flute synth + sequencer (Web Audio)
   3. Reference data
   4. UI builders
   5. Canvas wave visuals
   6. Tuner + transcription (mic, autocorrelation)
   7. Router + notebook
============================================================ */
(function(){
'use strict';

// UI state shared across sections
let fluteType = 'bansuri';   // 'bansuri' (6-hole) | 'venu' (8-hole Carnatic)
let swaraSystem = 'carnatic'; // 'carnatic' | 'hindustani'

/* ---------- 1. MUSIC ENGINE ---------- */
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const A4 = 440;

// sub = Carnatic label, hind = Hindustani label
const SWARAS = [
  {tok:'S', sub:'Sa',   hind:'Sa',   alt:false},
  {tok:'r', sub:'ri₁',  hind:'Re♭',  alt:true},
  {tok:'R', sub:'Ri',   hind:'Re',   alt:false},
  {tok:'g', sub:'ga₂',  hind:'Ga♭',  alt:true},
  {tok:'G', sub:'Ga',   hind:'Ga',   alt:false},
  {tok:'m', sub:'Ma',   hind:'Ma',   alt:false},
  {tok:'M', sub:'Má',   hind:'Ma♯',  alt:true},
  {tok:'P', sub:'Pa',   hind:'Pa',   alt:false},
  {tok:'d', sub:'da₁',  hind:'Dha♭', alt:true},
  {tok:'D', sub:'Da',   hind:'Dha',  alt:false},
  {tok:'n', sub:'ni₁',  hind:'Ni♭',  alt:true},
  {tok:'N', sub:'Ni',   hind:'Ni',   alt:false},
];
const TOK2SEMI = {S:0,r:1,R:2,g:3,G:4,m:5,M:6,P:7,d:8,D:9,n:10,N:11};

function freqFromMidi(m){ return A4 * Math.pow(2, (m - 69) / 12); }
function freqFromNote(pc, oct){ return freqFromMidi((oct + 1) * 12 + pc); }
function midiFromFreq(f){ return Math.round(69 + 12 * Math.log2(f / A4)); }
function noteName(midi){ return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }

// "S'" -> 12, "g," -> -9, "P" -> 7, rests/unknown -> null
function tokenToSemi(tok){
  if(!tok) return null;
  const base = tok[0];
  if(!(base in TOK2SEMI)) return null;
  let semi = TOK2SEMI[base];
  for(const ch of tok.slice(1)){
    if(ch === "'") semi += 12;
    else if(ch === ',') semi -= 12;
  }
  return semi;
}
function parseTokens(str){ return str.trim().split(/\s+/).filter(Boolean); }
function toEvents(tokens){
  const ev = [];
  tokens.forEach(t => {
    if(t === '-' && ev.length) ev[ev.length - 1].beats++;
    else ev.push({tok:t, beats:1});
  });
  return ev;
}

/* ---------- 2. FLUTE SYNTH + SEQUENCER ---------- */
let AC = null, master = null, active = [], playId = 0;
function ac(){
  if(!AC){
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain(); master.gain.value = 0.9; master.connect(AC.destination);
  }
  if(AC.state === 'suspended') AC.resume();
  return AC;
}
// cached white-noise buffer for the breath component
let noiseBuf = null;
function noiseBuffer(c){
  if(noiseBuf) return noiseBuf;
  const n = Math.floor(c.sampleRate * 1.2);
  noiseBuf = c.createBuffer(1, n, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for(let i=0;i<n;i++) d[i] = Math.random()*2 - 1;
  return noiseBuf;
}
// A bamboo flute is close to a sine fundamental with a little 2nd/3rd harmonic
// and an audible breath (filtered noise), softer at higher pitch. Gentle attack,
// vibrato that fades in, and a mellow low-pass.
function blow(freq, start, dur){
  const c = ac();
  const fund = c.createOscillator(); fund.type='sine'; fund.frequency.value = freq;
  const h2   = c.createOscillator(); h2.type='sine';   h2.frequency.value = freq*2;
  const h3   = c.createOscillator(); h3.type='sine';   h3.frequency.value = freq*3;
  const gh2 = c.createGain(); gh2.gain.value = 0.14;
  const gh3 = c.createGain(); gh3.gain.value = 0.05;

  // breath noise band-passed around the note
  const noise = c.createBufferSource(); noise.buffer = noiseBuffer(c); noise.loop = true;
  const bp = c.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value = freq*2.0; bp.Q.value = 0.7;
  const gn = c.createGain();

  // shared envelope + mellow low-pass
  const env = c.createGain();
  const lp = c.createBiquadFilter(); lp.type='lowpass';
  lp.frequency.value = Math.min(freq*3.5 + 700, 7500); lp.Q.value = 0.4;

  // vibrato (~5 Hz) that eases in
  const vib = c.createOscillator(); vib.frequency.value = 5;
  const vg = c.createGain();
  vg.gain.setValueAtTime(0, start);
  vg.gain.linearRampToValueAtTime(6, start + Math.min(0.3, dur*0.5)); // cents
  vib.connect(vg); vg.connect(fund.detune); vg.connect(h2.detune); vg.connect(h3.detune);

  const peak = 0.32, atk = Math.min(0.055, dur*0.4), rel = Math.min(0.16, dur*0.5);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + atk);
  env.gain.setValueAtTime(peak, Math.max(start+atk, start + dur - rel));
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  // breath: a soft chiff at onset, faint sustain after
  gn.gain.setValueAtTime(0, start);
  gn.gain.linearRampToValueAtTime(0.05, start + 0.025);
  gn.gain.linearRampToValueAtTime(0.010, start + Math.min(0.16, dur));
  gn.gain.linearRampToValueAtTime(0, start + dur);

  fund.connect(env); h2.connect(gh2); gh2.connect(env); h3.connect(gh3); gh3.connect(env);
  noise.connect(bp); bp.connect(gn); gn.connect(env);
  env.connect(lp); lp.connect(master);

  const nodes = [fund,h2,h3,vib,noise];
  nodes.forEach(o => o.start(start));
  const stopT = start + dur + 0.06;
  nodes.forEach(o => { try{ o.stop(stopT); }catch(e){} });
  active.push({nodes, g:env});
}
function stopAll(){
  playId++;
  const c = ac();
  active.forEach(n => { try {
    n.g.gain.cancelScheduledValues(c.currentTime);
    n.g.gain.setTargetAtTime(0.0001, c.currentTime, 0.03);
    n.nodes.forEach(s => { try{ s.stop(c.currentTime + 0.16); }catch(e){} });
  } catch(e){} });
  active = [];
}
function playSwara(semi, saHz){ blow(saHz * Math.pow(2, semi / 12), ac().currentTime + 0.02, 0.7); }
function playSequence(str, saHz, beatMs){
  stopAll();
  const c = ac(); const beat = beatMs / 1000;
  const events = toEvents(parseTokens(str));
  let t = c.currentTime + 0.06;
  events.forEach(ev => {
    const semi = tokenToSemi(ev.tok);
    const dur = beat * ev.beats;
    if(semi !== null) blow(saHz * Math.pow(2, semi / 12), t, dur * 0.94);
    t += dur;
  });
}

/* ---------- 3. REFERENCE DATA ---------- */
const CARNATIC = [
  ['Sa',0],['Suddha Ri (R1)',1],['Chatusruti Ri (R2)',2],['Shatsruti Ri (R3)',3],
  ['Suddha Ga (G1)',2],['Sadharana Ga (G2)',3],['Antara Ga (G3)',4],
  ['Suddha Ma (M1)',5],['Prati Ma (M2)',6],['Pa',7],
  ['Suddha Da (D1)',8],['Chatusruti Da (D2)',9],['Shatsruti Da (D3)',10],
  ['Suddha Ni (N1)',9],['Kaisiki Ni (N2)',10],['Kakali Ni (N3)',11],
];
const HIND = [
  ['Sa','shuddha',0],['Re','komal',1],['Re','shuddha',2],['Ga','komal',3],['Ga','shuddha',4],
  ['Ma','shuddha',5],['Ma','tivra',6],['Pa','shuddha',7],['Dha','komal',8],['Dha','shuddha',9],
  ['Ni','komal',10],['Ni','shuddha',11],
];
// 6-hole Hindustani bansuri — standard middle-octave (madhya saptak) fingering.
// H1=nearest blow hole, H6=farthest (near open end).
// Lower half (Sa→tivra Ma): open holes from H3 toward H1 as pitch rises.
//   Sa = H1-H3 closed, H4-H6 open. Tivra Ma = all open.
// Upper half (Pa→Ni) + Taar Sa: all require overblow. Pa = all 6 closed + strong blow;
//   then open H6 toward H4 for Dha/Ni. Taar Sa = same as Sa fingering + overblow.
const FINGER = [
  ['S',  ['c','c','c','o','o','o'], false, 'Sa — H1,H2,H3 closed'],
  ['r',  ['c','c','h','o','o','o'], false, 'komal Re — H3 half-open'],
  ['R',  ['c','c','o','o','o','o'], false, 'shuddha Re — H3 open'],
  ['g',  ['c','h','o','o','o','o'], false, 'komal Ga — H2 half-open'],
  ['G',  ['c','o','o','o','o','o'], false, 'shuddha Ga — H2 open'],
  ['m',  ['h','o','o','o','o','o'], false, 'shuddha Ma — H1 half-open'],
  ['M',  ['o','o','o','o','o','o'], false, 'tivra Ma — all open'],
  ['P',  ['c','c','c','c','c','c'], true,  'Pa — all closed + overblow'],
  ['d',  ['c','c','c','c','c','h'], true,  'komal Dha — H6 half + overblow'],
  ['D',  ['c','c','c','c','c','o'], true,  'shuddha Dha — H6 open + overblow'],
  ['n',  ['c','c','c','c','h','o'], true,  'komal Ni — H5 half + overblow'],
  ['N',  ['c','c','c','c','o','o'], true,  'shuddha Ni — H5,H6 open + overblow'],
  ["S'", ['c','c','c','o','o','o'], true,  'upper Sa — same as Sa + overblow'],
];
// Carnatic venu (Pullanguzhal) — 8-hole Mali-style fingering, middle octave.
// H1=nearest blow hole, H8=farthest (near open end).
// Lower half (Sa→antara Ga): H1,H2 are the working holes; open from H2 toward H1.
//   Sa = H1,H2 closed. G3 (antara Ga) = all open.
// Upper half (suddha Ma→kakali Ni) + Taar Sa: all require overblow.
//   M1 = H1-H7 closed, H8 open; progressively open from H7 toward H3.
//   Taar Sa = H1,H2 closed + overblow (same fingering as Sa).
const FINGER_VENU = [
  ['S',  ['c','c','o','o','o','o','o','o'], false, 'Sa — H1,H2 closed'],
  ['r',  ['c','h','o','o','o','o','o','o'], false, 'suddha Ri — H2 half-open'],
  ['R',  ['c','o','o','o','o','o','o','o'], false, 'chatusruthi Ri — H2 open'],
  ['g',  ['h','o','o','o','o','o','o','o'], false, 'sadharana Ga — H1 half-open'],
  ['G',  ['o','o','o','o','o','o','o','o'], false, 'antara Ga — all open'],
  ['m',  ['c','c','c','c','c','c','c','o'], true,  'suddha Ma — H7 open + overblow'],
  ['M',  ['c','c','c','c','c','c','o','o'], true,  'prati Ma — H6,H7 open + overblow'],
  ['P',  ['c','c','c','c','c','o','o','o'], true,  'Pa — H5,H6,H7 open + overblow'],
  ['d',  ['c','c','c','c','h','o','o','o'], true,  'suddha Da — H5 half + overblow'],
  ['D',  ['c','c','c','c','o','o','o','o'], true,  'chatusruthi Da — H4-H7 open + overblow'],
  ['n',  ['c','c','c','h','o','o','o','o'], true,  'kaisika Ni — H4 half + overblow'],
  ['N',  ['c','c','c','o','o','o','o','o'], true,  'kakali Ni — H3-H7 open + overblow'],
  ["S'", ['c','c','o','o','o','o','o','o'], true,  'upper Sa — H1,H2 closed + overblow'],
];
// which charted token each pitch-class maps to for tuner fingering display
// idx: 0 S, 1 r, 2 R, 3 g, 4 G, 5 m, 6 M, 7 P, 8 d, 9 D, 10 n, 11 N
const FING_BASE = ['S','r','R','g','G','m','M','P','d','D','n','N'];
const FING_ALT  = [null,'half-hole 3',null,'half-hole 2',null,'half-hole 1',null,null,'half-hole 6',null,'half-hole 5',null];
function fingerChart(){ return fluteType === 'venu' ? FINGER_VENU : FINGER; }
// fingering for a charted token (e.g. "S", "P", "S'")
function fingeringFor(tok){
  const rows = fingerChart();
  const row = rows.find(r => r[0] === tok) || rows.find(r => r[0] === tok.replace(/['",]/g,''));
  return row ? {holes: row[1], ob: row[2], label: row[3]} : null;
}
// fingering for a detected pitch-class index 0..11 (middle octave), with hint
function fingeringForIdx(idx){
  const i = ((idx%12)+12)%12;
  const tok = FING_BASE[i];
  const f = fingeringFor(tok);
  return f ? {...f, baseTok: tok, alt: FING_ALT[i]} : null;
}
const KEY_GUIDE = [
  ['C','Bright, compact (high)','Beginners, bhajans'],
  ['D','Light and clear','Light classical, fusion'],
  ['E','High, cutting','Solos that must carry'],
  ['F','High-medium','Folk, faster pieces'],
  ['G','Warm, balanced','All-round favourite'],
  ['A','Full, mellow','Hindustani classical, alap'],
  ['B','Deep, rich','Slow, expressive playing'],
];
const RAGAS = [
  {c:'Mohanam', h:'Bhoopali', mood:'Serene, devotional', a:"S R G P D S'", v:"S' D P G R S"},
  {c:'Hamsadhwani', h:'Hansadhwani', mood:'Bright, auspicious', a:"S R G P N S'", v:"S' N P G R S"},
  {c:'Shankarabharanam', h:'Bilawal (major)', mood:'Calm, complete', a:"S R G m P D N S'", v:"S' N D P m G R S"},
  {c:'Kalyani', h:'Yaman / Kalyan', mood:'Evening grandeur', a:"S R G M P D N S'", v:"S' N D P M G R S"},
  {c:'Kharaharapriya', h:'Kafi', mood:'Tender, romantic', a:"S R g m P D n S'", v:"S' n D P m g R S"},
  {c:'Hindolam', h:'Malkauns', mood:'Deep, meditative (night)', a:"S g m d n S'", v:"S' n d m g S"},
  {c:'Mayamalavagowla', h:'Bhairav', mood:'Foundational, dawn', a:"S r G m P d N S'", v:"S' N d P m G r S"},
  {c:'Abhogi', h:'Abhogi', mood:'Sweet, compact', a:"S R g m D S'", v:"S' D m g R S"},
  {c:'Shivaranjani', h:'Shivaranjani', mood:'Longing, pathos', a:"S R g P D S'", v:"S' D P g R S"},
  {c:'Madhyamavati', h:'Madhmad Sarang', mood:'Uplifting, a closing raga', a:"S R m P n S'", v:"S' n P m R S"},
  {c:'Natabhairavi', h:'Asavari', mood:'Sober, contemplative', a:"S R g m P d n S'", v:"S' n d P m g R S"},
];
const PRACTICE = [
  {t:'Sarali Varisai 1', m:'Mayamalavagowla · the very first lesson', n:"S r G m P d N S' - S' N d P m G r S -"},
  {t:'Janta Varisai (doubles)', m:'Two on each swara — for finger control', n:"S S r r G G m m P P d d N N S' S' S' S' N N d d P P m m G G r r S S"},
  {t:'Plain octave run', m:'Up and down, any raga — for tone', n:"S R G m P D N S' N D P m G R S"},
  {t:'Datu Varisai (skips)', m:'Leaping patterns — for clean intervals', n:"S G R G S - R m G m R - G P m P G - m D P D m - P N D N P - D S' N S' D -"},
  {t:'Mandra sthayi reach', m:'Into the lower octave — for steady breath', n:"P, D, N, S R G m P - P m G R S N, D, P, -"},
  {t:'Alankara (groups of three)', m:'Mayamalavagowla · ascending then descending', n:"S r G - r G m - G m P - m P d - P d N - d N S' - S' N d - N d P - d P m - P m G - m G r - G r S -"},
];
const PD_SONGS = [
  {t:'Twinkle, Twinkle, Little Star', m:'Public domain · key of Sa = major', n:"S S P P D D P - m m G G R R S - P P m m G G R - P P m m G G R - S S P P D D P - m m G G R R S -"},
  {t:'Mary Had a Little Lamb', m:'Public domain', n:"G R S R G G G - R R R - G P P - G R S R G G G G R R G R S -"},
  {t:'Row, Row, Row Your Boat', m:'Public domain · a gentle round', n:"S S S R G - G R G m P - S' S' S' P P P G G G S S S - P m G R S -"},
  {t:'Frère Jacques', m:'Traditional · public domain', n:"S R G S - S R G S - G m P - - G m P - - P D P m G S - P D P m G S - S P, S - - S P, S - -"},
  {t:'Jingle Bells (chorus)', m:'Public domain', n:"G G G - G G G - G P S R G - - - m m m m m G G G G P P m R S -"},
  {t:'Happy Birthday', m:'Public domain (US, 2016)', n:"P P D P S' N - P P D P R' S' - P P P' G' S' N D - m' m' G' S' R' S' -"},
  {t:'Ode to Joy (Beethoven)', m:'Public domain · main theme', n:"G G m P P m G R S S R G G - R - G G m P P m G R S S R G R - S -"},
];

/* ---------- 4. UI HELPERS ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function el(tag, cls, html){ const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; return e; }
function fillNoteSelect(sel, def){
  sel.innerHTML = '';
  NOTE_NAMES.forEach((n, i) => { const o = el('option'); o.value = i; o.textContent = n; sel.appendChild(o); });
  sel.value = def != null ? def : 9; // A
}
function saHzFrom(keySel, octSel){
  const pc = parseInt(keySel.value, 10);
  const oct = octSel ? parseInt(octSel.value, 10) : 4;
  return freqFromNote(pc, oct);
}
function prettySwara(str){
  return str.replace(/'/g,'<sup>·</sup>').replace(/,/g,'<sub>.</sub>');
}

/* ----- HOME cards ----- */
const HOME = [
  ['01','Flute basics','#basics','Posture, breath, your first clear tone, and choosing a flute.'],
  ['02','Sound & waves','#sound','How a column of air becomes a pitch — and where each note "travels."'],
  ['03','Notation & fingering','#notation','The twelve swaras in both traditions, with a 6-hole fingering chart.'],
  ['04','Scales & keys','#scales','What a flute\u2019s key means and the exact frequency of every swara.'],
  ['05','Ragas','#ragas','Ascent, descent, and mood — eleven ragas you can hear.'],
  ['06','Songs & practice','#songs','Sarali varisai, beginner tunes, and your own notebook.'],
];
function buildHome(){
  const wrap = $('#homeCards');
  HOME.forEach(([n,t,href,desc]) => {
    const a = el('a','home-card');
    a.href = href;
    a.innerHTML = `<div class="n">${n}</div><h4>${t}</h4><p>${desc}</p>`;
    wrap.appendChild(a);
  });
}

/* ----- NOTATION ----- */
function buildSwaraBoard(){
  const board = $('#swaraBoard'); board.innerHTML = '';
  SWARAS.forEach((s, i) => {
    const b = el('button', 'swara' + (s.alt ? ' komal' : ''));
    const label = swaraSystem === 'hindustani' ? s.hind : s.sub;
    b.innerHTML = `${s.tok}<span class="nm">${label}</span>`;
    b.addEventListener('click', () => {
      const saHz = saHzFrom($('#saSelect'), $('#saOct'));
      playSwara(i, saHz);
      b.classList.add('lit'); setTimeout(() => b.classList.remove('lit'), 380);
    });
    board.appendChild(b);
  });
}
function buildNotationTables(){
  const ct = $('#carnaticTbl'); ct.innerHTML = '';
  CARNATIC.forEach(([name, semi]) => {
    ct.appendChild(el('tr', null, `<td>${name}</td><td class="sw">${SWARAS[semi].tok}</td><td class="muted">+${semi} st</td>`));
  });
  const ht = $('#hindTbl'); ht.innerHTML = '';
  HIND.forEach(([name, q, semi]) => {
    ht.appendChild(el('tr', null, `<td>${name} <span class="muted">(${q})</span></td><td class="sw">${SWARAS[semi].tok}</td><td class="muted">+${semi} st</td>`));
  });
  const ft = $('#fingerTbl'); ft.innerHTML = '';
  const chart = fingerChart();
  const head = $('#fingerHead'); if(head) head.textContent = `Holes (1 → ${chart[0][1].length})`;
  chart.forEach(([tok, holes, ob, label]) => {
    const dots = holes.map(h => `<span class="hole ${h==='c'?'closed':h==='h'?'half':''}"></span>`).join('');
    ft.appendChild(el('tr', null,
      `<td class="sw">${prettySwara(tok)}</td>
       <td><div class="holes"><span class="mouth"></span>${dots}${ob?'<span class="ob">↟ overblow</span>':''}</div></td>
       <td class="muted">${label}</td>`));
  });
}

/* ----- FINGERING + WAVE EXPLORER ----- */
const explorer = { tok: 'S' };
function fluteFigHTML(holes, ob){
  const dots = holes.map((h,i) => `<div class="fhole ${h==='c'?'closed':h==='h'?'half':''}">${i+1}</div>`).join('');
  return `<div class="fbody"><div class="fmouth" title="blow hole"></div>${dots}</div>` + (ob ? `<div class="fob">↟ overblow — faster, narrower air</div>` : '');
}
function buildExplorer(){
  const wrap = $('#exSwaras'); if(!wrap) return;
  wrap.innerHTML = '';
  ['S','r','R','g','G','m','M','P','d','D','n','N',"S'"].forEach(tok => {
    const isKomal = ['r','g','d','n'].includes(tok);
    const b = el('button', 'swara' + (isKomal ? ' komal' : ''));
    b.innerHTML = prettySwara(tok);
    b.addEventListener('click', () => { explorer.tok = tok; renderExplorer(); playExplorer(); });
    wrap.appendChild(b);
  });
  const pb = $('#exPlay'); if(pb) pb.addEventListener('click', playExplorer);
  $$('.seg[id^="fluteToggle"] .seg-btn').forEach(btn =>
    btn.addEventListener('click', () => setFluteType(btn.dataset.flute)));
  renderExplorer();
  swaraWaveAnim();
}
function playExplorer(){
  const semi = tokenToSemi(explorer.tok);
  playSwara(semi, saHzFrom($('#saSelect'), $('#saOct')));
}
function renderExplorer(){
  const f = fingeringFor(explorer.tok);
  // update finger note text (flute is now drawn in canvas)
  $('#exFingerNote').innerHTML = f
    ? `<b>${prettySwara(explorer.tok)}</b> = ${f.label} · ${fluteType==='venu'?'Carnatic venu (8-hole)':'Hindustani (6-hole)'}`
    : '';
  // highlight active swara button
  const wrap = $('#exSwaras');
  if(wrap){ Array.from(wrap.children).forEach((b,i) => b.classList.toggle('sel', ['S','r','R','g','G','m','M','P','d','D','n','N',"S'"][i] === explorer.tok)); }
  const semi = tokenToSemi(explorer.tok);
  const saHz = saHzFrom($('#saSelect'), $('#saOct'));
  const f0 = saHz * Math.pow(2, semi/12);
  $('#exReadout').textContent = `${f0.toFixed(1)} Hz · ${noteName(midiFromFreq(f0))} · wavelength ${(343/f0*100).toFixed(0)} cm`;
}
function swaraWaveAnim(){
  const cv = $('#exWave'); if(!cv) return;
  let t = 0;
  function frame(){
    const {ctx,w,h} = fitCanvas(cv);
    ctx.clearRect(0,0,w,h);
    const cs = getComputedStyle(document.documentElement);
    const cPanel  = cs.getPropertyValue('--panel').trim();
    const cPanel2 = cs.getPropertyValue('--panel-2').trim();
    const cLine   = cs.getPropertyValue('--line').trim();
    const cAmber  = cs.getPropertyValue('--amber').trim();
    const cJade   = cs.getPropertyValue('--jade').trim();
    const cInkMut = cs.getPropertyValue('--ink-mute').trim();

    const semi = tokenToSemi(explorer.tok) || 0;
    const f = fingeringFor(explorer.tok);
    const holes = f ? f.holes : [];
    const ob    = f ? f.ob : false;
    const nHoles = holes.length; // 6 or 8
    const harmonic = ob ? 2 : 1; // overblow = 2nd harmonic inside tube

    // Layout: flute occupies left ~40%, wave flows right from its open end
    const cy = h * 0.5;
    const fluteH = Math.min(h * 0.32, 52);
    const fluteX0 = w * 0.02;
    const fluteX1 = w * 0.42;
    const fluteLen = fluteX1 - fluteX0;
    const waveX0 = fluteX1;
    const waveX1 = w * 0.98;

    // ---- Draw flute body ----
    const grad = ctx.createLinearGradient(0, cy - fluteH/2, 0, cy + fluteH/2);
    grad.addColorStop(0, cPanel2); grad.addColorStop(1, cPanel);
    ctx.fillStyle = grad; ctx.strokeStyle = cLine; ctx.lineWidth = 1.5;
    roundRect(ctx, fluteX0, cy - fluteH/2, fluteLen, fluteH, fluteH/2);
    ctx.fill(); ctx.stroke();

    // blow hole (cork end, left side)
    const blowR = fluteH * 0.22;
    ctx.fillStyle = cAmber; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.ellipse(fluteX0 + fluteLen*0.10, cy, blowR*0.7, blowR, 0, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;

    // breath particles entering blow hole
    for(let i = 0; i < 5; i++){
      const p = ((t * 0.06 + i / 5) % 1);
      const px = fluteX0 + fluteLen*0.10 - 28 + p * 34;
      const py = cy + Math.sin(t * 1.8 + i * 1.2) * 4;
      ctx.globalAlpha = (1 - p) * 0.7;
      ctx.fillStyle = cJade;
      ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Find the first open hole — that's where the air column effectively ends
    // Closed holes from the left extend the resonating column; first open hole cuts it short
    let firstOpenIdx = holes.length; // default: all closed = full length
    for(let i = 0; i < holes.length; i++){
      if(holes[i] !== 'c'){ firstOpenIdx = i; break; }
    }
    const holeStart = fluteX0 + fluteLen * 0.26;
    const holeEnd   = fluteX0 + fluteLen * 0.88;
    const holeSpacingX = (holeEnd - holeStart) / Math.max(holes.length - 1, 1);
    // Effective resonating length ends at the first open hole position (or full tube if all closed)
    const effEnd = firstOpenIdx >= holes.length
      ? fluteX1 - 4                                    // all closed → full tube
      : holeStart + firstOpenIdx * holeSpacingX;       // ends at first open hole
    const effRatio = (effEnd - (fluteX0 + fluteLen*0.14)) / (fluteX1 - 4 - (fluteX0 + fluteLen*0.14));

    // Standing wave inside — only drawn up to effEnd; amplitude = 0 at ends, peak at middle
    const stAmp = fluteH * 0.28;
    ctx.strokeStyle = cJade; ctx.lineWidth = 1.8; ctx.globalAlpha = 0.45;
    ctx.beginPath();
    const bx0 = fluteX0 + fluteLen*0.14;
    for(let x = bx0; x <= effEnd; x++){
      const u = (x - bx0) / (effEnd - bx0);
      const env = Math.sin(Math.PI * u * harmonic);
      const y = cy - stAmp * env * Math.cos(t * 2.2 * harmonic);
      x === bx0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    }
    ctx.stroke(); ctx.globalAlpha = 1;

    // Dashed "dead air" from effEnd to tube end (air beyond first open hole doesn't vibrate)
    if(effEnd < fluteX1 - 6){
      ctx.strokeStyle = cInkMut; ctx.lineWidth = 1; ctx.globalAlpha = 0.3;
      ctx.setLineDash([4, 5]);
      ctx.beginPath(); ctx.moveTo(effEnd, cy); ctx.lineTo(fluteX1 - 4, cy); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }

    // Label: effective length % of full tube
    const pct = Math.round(effRatio * 100);
    ctx.fillStyle = cAmber; ctx.font = `500 ${Math.max(9, h*0.085)}px var(--mono,monospace)`;
    ctx.textAlign = 'center';
    ctx.fillText(`↔ ${pct}% of tube resonates`, bx0 + (effEnd - bx0)/2, cy - fluteH/2 - 8);
    ctx.textAlign = 'left';

    // finger holes
    const holeSpacing = holeSpacingX;
    const holeR = Math.min(fluteH * 0.19, 7);
    holes.forEach((state, i) => {
      const hx = holeStart + i * holeSpacing;
      const isFirstOpen = (i === firstOpenIdx);
      ctx.beginPath(); ctx.arc(hx, cy, holeR, 0, Math.PI*2);
      if(state === 'c'){
        ctx.fillStyle = cAmber; ctx.fill();
        ctx.strokeStyle = cAmber; ctx.lineWidth = 1; ctx.stroke();
      } else if(state === 'h'){
        ctx.fillStyle = cPanel; ctx.fill();
        ctx.beginPath(); ctx.arc(hx, cy, holeR, -Math.PI/2, Math.PI/2); ctx.lineTo(hx, cy); ctx.closePath();
        ctx.fillStyle = cAmber; ctx.fill();
        ctx.beginPath(); ctx.arc(hx, cy, holeR, 0, Math.PI*2);
        ctx.strokeStyle = cAmber; ctx.lineWidth = 1.2; ctx.stroke();
      } else {
        ctx.fillStyle = cPanel; ctx.fill();
        ctx.strokeStyle = cInkMut; ctx.lineWidth = 1.2; ctx.stroke();
      }
      // Glow ring around the first open hole — marks where resonance ends
      if(isFirstOpen){
        ctx.globalAlpha = 0.55 + 0.3 * Math.sin(t * 3);
        ctx.strokeStyle = cJade; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(hx, cy, holeR + 4, 0, Math.PI*2); ctx.stroke();
        ctx.globalAlpha = 1;
        // small downward arrow below
        ctx.fillStyle = cJade; ctx.font = `600 ${Math.max(8,h*0.075)}px var(--mono,monospace)`;
        ctx.textAlign = 'center';
        ctx.fillText('▼ sound exits', hx, cy + fluteH/2 + 13);
        ctx.textAlign = 'left';
      }
    });

    // overblow label (shown below the tube so it doesn't clash with effLength label)
    if(ob){
      ctx.fillStyle = cJade; ctx.font = `500 ${Math.max(9,h*0.09)}px var(--mono,monospace)`;
      ctx.textAlign = 'left';
      ctx.fillText('↟ overblow → 2nd harmonic', fluteX0 + fluteLen*0.3, cy + fluteH/2 + 14);
    }

    // ---- Connector: wave flows from open end of flute ----
    // faint centre guide
    ctx.strokeStyle = `rgba(255,255,255,0.04)`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(waveX0, cy); ctx.lineTo(waveX1, cy); ctx.stroke();

    // travelling wave — cycle count and speed scale clearly with pitch
    // semi 0 (Sa) → ~1.5 cycles; semi 11 (Ni) → ~3.5; overblow adds another octave
    const baseCycles = 1.5 + (semi / 11) * 2.0;
    const cycles = baseCycles * harmonic;
    const speed  = 0.06 + (semi / 11) * 0.06 + (harmonic - 1) * 0.08; // visibly faster for higher notes
    const amp = h * 0.32;
    ctx.strokeStyle = cJade; ctx.lineWidth = 2.6; ctx.beginPath();
    for(let x = waveX0; x <= waveX1; x++){
      const u = (x - waveX0) / (waveX1 - waveX0);
      const env = Math.min(u * 6, 1) * (1 - u * 0.25);
      const y = cy - amp * env * Math.sin(2 * Math.PI * cycles * u - t);
      x === waveX0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    t += reduceMotion ? 0 : speed;
    raf.ex = requestAnimationFrame(frame);
  }
  frame();
}
function setFluteType(t){
  fluteType = t;
  $$('.seg[id^="fluteToggle"] .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.flute === t));
  if($('#tunerFlute')) $('#tunerFlute').value = t;
  buildNotationTables();
  renderExplorer();
  if(tuner.lastIdx != null) renderTunerFinger(tuner.lastIdx);
}

function setTradition(tradition){
  swaraSystem = tradition;
  // Carnatic → venu (8-hole); Hindustani → bansuri (6-hole)
  setFluteType(tradition === 'carnatic' ? 'venu' : 'bansuri');
  // sync both global toggle instances
  $$('#globalToggleSide .seg-btn, #globalToggleTop .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tradition === tradition));
  // sync tuner selects
  const sysSel = $('#tunerSystem'); if(sysSel) sysSel.value = tradition;
  const ftSel  = $('#tunerFlute');  if(ftSel)  ftSel.value  = fluteType;
  // rebuild all label-dependent UI
  buildSwaraBoard();
  buildRagas();   // raga names differ (Carnatic vs Hindustani column)
  localStorage.setItem('kuzhal_tradition', tradition);
}

/* ----- SOUND / travel table ----- */
function buildTravelTable(){
  const v = 343; const tb = $('#travelTable'); tb.innerHTML = '';
  ['S','R','G','m','P','D','N',"S'"].forEach(tok => {
    const semi = tokenToSemi(tok);
    const f = A4 * Math.pow(2, semi / 12);
    const L = (v / (2 * f)) * 100;        // cm
    const wl = (v / f) * 100;             // cm
    tb.appendChild(el('tr', null,
      `<td class="sw">${prettySwara(tok)}</td><td>${f.toFixed(1)}</td><td class="muted">${L.toFixed(1)} cm</td><td class="muted">${wl.toFixed(1)} cm</td>`));
  });
}

/* ----- SCALES ----- */
function renderKeyTables(){
  const saHz = saHzFrom($('#keySelect'), $('#keyOct'));
  const pc = parseInt($('#keySelect').value, 10);
  $('#keyInfo').textContent = `Sa = ${NOTE_NAMES[pc]}${$('#keyOct').value} · ${saHz.toFixed(1)} Hz`;
  const tb = $('#keyFreqTbl'); tb.innerHTML = '';
  SWARAS.forEach((s, i) => {
    const f = saHz * Math.pow(2, i / 12);
    const midi = midiFromFreq(f);
    tb.appendChild(el('tr', null,
      `<td class="sw ${s.alt?'':''}">${s.tok}</td><td class="muted">${noteName(midi)}</td><td>${f.toFixed(1)} Hz</td>`));
  });
}
function buildKeyGuide(){
  const tb = $('#keyGuideTbl'); tb.innerHTML = '';
  KEY_GUIDE.forEach(([k,ch,use]) => tb.appendChild(el('tr', null, `<td class="sw">${k}</td><td>${ch}</td><td class="muted">${use}</td>`)));
}

/* ----- RAGAS ----- */
function buildRagas(){
  const grid = $('#ragaGrid'); grid.innerHTML = '';
  RAGAS.forEach(r => {
    const card = el('div', 'card');
    card.innerHTML = `
      <div class="lead-row" style="justify-content:space-between;align-items:flex-start">
        <div><h3 style="font-size:1.15rem;margin:0">${r.c}</h3>
        <div class="muted" style="font-size:.82rem;margin-top:2px">${r.h} · ${r.mood}</div></div>
      </div>
      <dl class="kv" style="margin-top:14px">
        <dt>Aroha</dt><dd class="sw" style="font-family:var(--mono);color:var(--amber)">${prettySwara(r.a)}</dd>
        <dt>Avaroha</dt><dd class="sw" style="font-family:var(--mono);color:var(--amber)">${prettySwara(r.v)}</dd>
      </dl>
      <div class="lead-row" style="margin-top:12px;gap:9px">
        <button class="btn jade sm play-aroh">▶ Ascend</button>
        <button class="btn sm play-both">▶ Both ways</button>
      </div>`;
    const saHz = () => saHzFrom($('#ragaKey'), null);
    const tempo = () => parseInt($('#ragaTempo').value, 10);
    card.querySelector('.play-aroh').addEventListener('click', () => playSequence(r.a, saHz(), tempo()));
    card.querySelector('.play-both').addEventListener('click', () => playSequence(r.a + ' ' + r.v, saHz(), tempo()));
    grid.appendChild(card);
  });
}

/* ----- SONGS ----- */
function songItem(s, listEl){
  const item = el('div', 'song-item');
  item.style.flexWrap = 'wrap';
  item.innerHTML = `
    <div style="flex:1;min-width:200px">
      <div style="font-weight:600">${s.t}</div>
      <div class="meta">${s.m}</div>
    </div>
    <div class="lead-row" style="gap:8px">
      <button class="btn jade sm play">▶ Play</button>
      <button class="btn sm show">Notes</button>
    </div>
    <div class="song-notes" style="flex-basis:100%">${prettySwara(s.n)}</div>`;
  item.querySelector('.play').addEventListener('click', () =>
    playSequence(s.n, saHzFrom($('#songKey'), null), parseInt($('#songTempo').value, 10)));
  const notes = item.querySelector('.song-notes');
  item.querySelector('.show').addEventListener('click', () => notes.classList.toggle('open'));
  listEl.appendChild(item);
}
function buildSongs(){
  const pl = $('#practiceList'); pl.innerHTML = '';
  PRACTICE.forEach(s => songItem(s, pl));
  const pd = $('#pdList'); pd.innerHTML = '';
  PD_SONGS.forEach(s => songItem(s, pd));
}

/* ----- NOTEBOOK (localStorage) ----- */
const NB_KEY = 'kuzhal_notebook_v1';
function nbLoad(){ try { return JSON.parse(localStorage.getItem(NB_KEY)) || []; } catch(e){ return []; } }
function nbSaveAll(arr){ try { localStorage.setItem(NB_KEY, JSON.stringify(arr)); } catch(e){} }
function renderNotebook(){
  const list = $('#nbList'); list.innerHTML = '';
  const items = nbLoad();
  if(!items.length){ list.innerHTML = '<p class="muted" style="font-size:.86rem;margin:0">Nothing saved yet. Enter swaras above and tap Save.</p>'; return; }
  items.forEach((s, idx) => {
    const item = el('div', 'song-item'); item.style.flexWrap = 'wrap';
    item.innerHTML = `
      <div style="flex:1;min-width:200px"><div style="font-weight:600">${s.title || 'Untitled'}</div>
      <div class="meta" style="color:var(--amber)">${prettySwara(s.notes)}</div></div>
      <div class="lead-row" style="gap:8px">
        <button class="btn jade sm play">▶</button>
        <button class="btn sm edit">Edit</button>
        <button class="btn sm del">Delete</button>
      </div>`;
    item.querySelector('.play').addEventListener('click', () =>
      playSequence(s.notes, saHzFrom($('#songKey'), null), parseInt($('#songTempo').value, 10)));
    item.querySelector('.edit').addEventListener('click', () => { $('#nbTitle').value = s.title; $('#nbNotes').value = s.notes; window.scrollTo({top:0}); });
    item.querySelector('.del').addEventListener('click', () => { const a = nbLoad(); a.splice(idx,1); nbSaveAll(a); renderNotebook(); });
    list.appendChild(item);
  });
}
function wireNotebook(){
  $('#nbPlay').addEventListener('click', () => {
    const n = $('#nbNotes').value.trim(); if(!n) return;
    playSequence(n, saHzFrom($('#songKey'), null), parseInt($('#songTempo').value, 10));
  });
  $('#nbStop').addEventListener('click', stopAll);
  $('#nbSave').addEventListener('click', () => {
    const notes = $('#nbNotes').value.trim(); if(!notes) return;
    const arr = nbLoad(); arr.push({title: $('#nbTitle').value.trim() || 'Untitled', notes});
    nbSaveAll(arr); $('#nbTitle').value=''; $('#nbNotes').value=''; renderNotebook();
  });
}

/* ---------- 5. CANVAS WAVE VISUALS ---------- */
function fitCanvas(cv){
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.max(2, r.width * dpr); cv.height = Math.max(2, r.height * dpr);
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  return {ctx, w:r.width, h:r.height};
}
let reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function heroAnim(){
  const cv = $('#heroWave'); if(!cv) return;
  let t = 0;
  function frame(){
    const {ctx, w, h} = fitCanvas(cv);
    ctx.clearRect(0,0,w,h);
    const cy = h * 0.5, bodyH = Math.min(h*0.34, 120), x0 = w*0.08, x1 = w*0.92, L = x1 - x0;
    // flute body — use CSS variable colours resolved at draw time
    const style = getComputedStyle(document.documentElement);
    const cPanel  = style.getPropertyValue('--panel').trim()  || '#1a1e2e';
    const cLine   = style.getPropertyValue('--line').trim()   || '#2a3050';
    const cAmber  = style.getPropertyValue('--amber').trim()  || '#f0b429';
    const cAmberD = style.getPropertyValue('--amber-deep').trim() || '#c48a0a';
    ctx.fillStyle = cPanel; ctx.strokeStyle = cLine; ctx.lineWidth = 1.4;
    roundRect(ctx, x0, cy - bodyH/2, L, bodyH, bodyH/2); ctx.fill(); ctx.stroke();
    // finger holes
    ctx.fillStyle = cAmber;
    for(let i=0;i<6;i++){ const hx = x0 + L*(0.42 + i*0.085); ctx.beginPath(); ctx.arc(hx, cy, 3.4, 0, 7); ctx.fill(); }
    ctx.fillStyle = cAmberD; ctx.beginPath(); ctx.arc(x0 + L*0.16, cy, 4.4, 0, 7); ctx.fill();
    // standing wave inside
    const amp = bodyH*0.34;
    ctx.lineWidth = 2.2; ctx.strokeStyle = '#5cc7a6';
    drawWave(ctx, x0, x1, cy, amp, 1, t, 1);
    ctx.globalAlpha = .4; ctx.strokeStyle = '#e3a948';
    drawWave(ctx, x0, x1, cy, amp*0.6, 2, t*1.4, -1); ctx.globalAlpha = 1;
    // breath particles
    ctx.fillStyle = 'rgba(92,199,166,.55)';
    for(let i=0;i<14;i++){ const p=((t*0.12 + i/14)%1); const px=x0 - 26 + p*40; const py=cy + Math.sin(t*2+i)*6; ctx.globalAlpha=(1-p)*0.7; ctx.beginPath(); ctx.arc(px,py,2,0,7); ctx.fill(); }
    ctx.globalAlpha = 1;
    t += reduceMotion ? 0 : 0.03;
    raf.hero = requestAnimationFrame(frame);
  }
  frame();
}
function drawWave(ctx, x0, x1, cy, amp, harm, phase, dir){
  ctx.beginPath();
  for(let x=x0; x<=x1; x++){
    const u = (x-x0)/(x1-x0);
    const env = Math.sin(Math.PI*harm*u);          // standing-wave envelope
    const y = cy + dir*amp*env*Math.cos(phase);
    if(x===x0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
}
function roundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

function pipeAnim(){
  const cv = $('#pipeWave'); if(!cv) return;
  let t = 0;
  function frame(){
    const {ctx,w,h} = fitCanvas(cv);
    ctx.clearRect(0,0,w,h);
    const ps = getComputedStyle(document.documentElement);
    const cLine   = ps.getPropertyValue('--line').trim();
    const cPanel  = ps.getPropertyValue('--panel').trim();
    const cPanel2 = ps.getPropertyValue('--panel-2').trim();
    const cJade   = ps.getPropertyValue('--jade').trim();
    const cAmber  = ps.getPropertyValue('--amber').trim();
    const cInkD   = ps.getPropertyValue('--ink-dim').trim();
    const cInkMut = ps.getPropertyValue('--ink-mute').trim();

    const len  = parseFloat($('#pipeLen').value);
    const harm = parseInt($('#pipeHarm').value, 10);
    const f    = (343 / (2 * len)) * harm;
    const midi = midiFromFreq(f);

    // Layout: figure on left ~18%, flute body center, wave radiates right
    const figX = w * 0.05, figCy = h * 0.5;
    const fluteH = Math.min(h * 0.28, 38);
    const fluteX0 = w * 0.16;
    const fluteX1 = fluteX0 + (w * 0.60) * (len / 0.66);
    const waveX0  = fluteX1;
    const waveX1  = w * 0.98;

    // ---- Stick figure ----
    const figR = Math.min(h * 0.10, 18);
    const figTop = figCy - figR * 3.5;
    // head
    ctx.strokeStyle = cInkD; ctx.lineWidth = 1.8; ctx.fillStyle = cPanel2;
    ctx.beginPath(); ctx.arc(figX, figTop, figR, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    // body
    const torsoBot = figTop + figR * 4.5;
    ctx.beginPath(); ctx.moveTo(figX, figTop + figR); ctx.lineTo(figX, torsoBot); ctx.stroke();
    // legs
    ctx.beginPath(); ctx.moveTo(figX, torsoBot); ctx.lineTo(figX - figR*1.1, torsoBot + figR*2.2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(figX, torsoBot); ctx.lineTo(figX + figR*0.6, torsoBot + figR*2.2); ctx.stroke();
    // arm holding flute (right arm → flute start)
    const armY = figTop + figR * 2.2;
    ctx.beginPath(); ctx.moveTo(figX, armY); ctx.lineTo(fluteX0, h * 0.5); ctx.stroke();
    // left arm (supports flute further along)
    ctx.beginPath(); ctx.moveTo(figX, armY + figR*0.6); ctx.lineTo(fluteX0 + (fluteX1-fluteX0)*0.35, h * 0.5); ctx.stroke();
    // lips → blow hole breath particle direction
    const lipsX = figX + figR * 0.8, lipsY = figTop + figR * 0.1;
    ctx.fillStyle = cAmber; ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.ellipse(lipsX, lipsY, figR*0.5, figR*0.3, 0, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;

    // Breath particles: lips → blow hole
    const bhX = fluteX0 + 8, bhY = h * 0.5;
    for(let i = 0; i < 6; i++){
      const p = ((t * 0.07 + i / 6) % 1);
      const px = lipsX + (bhX - lipsX) * p + (Math.random()-0.5)*3;
      const py = lipsY + (bhY - lipsY) * p;
      ctx.globalAlpha = (1 - p) * 0.8;
      ctx.fillStyle = cJade;
      ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ---- Flute body ----
    const grad = ctx.createLinearGradient(0, h*0.5 - fluteH/2, 0, h*0.5 + fluteH/2);
    grad.addColorStop(0, cPanel2); grad.addColorStop(1, cPanel);
    ctx.fillStyle = grad; ctx.strokeStyle = cLine; ctx.lineWidth = 1.4;
    roundRect(ctx, fluteX0, h*0.5 - fluteH/2, fluteX1 - fluteX0, fluteH, fluteH/2);
    ctx.fill(); ctx.stroke();

    // blow hole on flute
    ctx.fillStyle = cAmber; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.ellipse(fluteX0 + 12, h*0.5, fluteH*0.25, fluteH*0.18, 0, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;

    // standing wave inside flute
    const stAmp = fluteH * 0.30;
    ctx.strokeStyle = cJade; ctx.lineWidth = 1.8; ctx.globalAlpha = 0.5;
    drawWave(ctx, fluteX0 + 18, fluteX1 - 4, h*0.5, stAmp, harm, t * 2.2, 1);
    ctx.globalAlpha = 1;

    // node dots inside
    ctx.fillStyle = cAmber;
    for(let k = 1; k < harm; k++){
      const nx = fluteX0 + 18 + (fluteX1 - fluteX0 - 22) * (k / harm);
      ctx.beginPath(); ctx.arc(nx, h*0.5, 3, 0, Math.PI*2); ctx.fill();
    }

    // ---- Radiating wave from open end ----
    // faint centre line
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(waveX0, h*0.5); ctx.lineTo(waveX1, h*0.5); ctx.stroke();

    const wAmp = h * 0.35;
    ctx.strokeStyle = cJade; ctx.lineWidth = 2.6; ctx.beginPath();
    const wCycles = 1.5 * Math.pow(2, Math.log2(len/0.45) * -1); // more cycles for shorter tube
    for(let x = waveX0; x <= waveX1; x++){
      const u = (x - waveX0) / (waveX1 - waveX0);
      const env = Math.min(u * 5, 1) * (1 - u * 0.3);
      const y = h*0.5 - wAmp * env * Math.sin(2 * Math.PI * wCycles * u - t);
      x === waveX0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // frequency label at wave end
    ctx.fillStyle = cAmber; ctx.font = `600 ${Math.max(11, h*0.09)}px var(--mono,monospace)`;
    ctx.textAlign = 'right';
    ctx.fillText(`${f.toFixed(0)} Hz · ${noteName(midi)}`, waveX1 - 4, h*0.5 - wAmp * 0.4 - 8);
    ctx.textAlign = 'left';

    $('#pipeReadout').textContent = `${f.toFixed(0)} Hz ≈ ${noteName(midi)}  ·  tube ${(len*100).toFixed(0)} cm`;
    t += reduceMotion ? 0 : 0.055;
    raf.pipe = requestAnimationFrame(frame);
  }
  frame();
}

const raf = {};

/* ---------- 6. TUNER + TRANSCRIPTION ---------- */
const tuner = {
  ctx:null, analyser:null, stream:null, buf:null, raf:null, running:false,
  transcript:[], cand:null, candCount:0, silence:0, lastLogged:null, lastIdx:null
};
function autoCorrelate(buf, sr){
  const SIZE = buf.length; let rms = 0;
  for(let i=0;i<SIZE;i++){ rms += buf[i]*buf[i]; }
  rms = Math.sqrt(rms/SIZE);
  if(rms < 0.012) return -1;
  let r1=0, r2=SIZE-1; const thres=0.2;
  for(let i=0;i<SIZE/2;i++){ if(Math.abs(buf[i])<thres){ r1=i; break; } }
  for(let i=1;i<SIZE/2;i++){ if(Math.abs(buf[SIZE-i])<thres){ r2=SIZE-i; break; } }
  const b = buf.slice(r1, r2); const nb = b.length;
  if(nb < 16) return -1;
  const c = new Float32Array(nb);
  for(let i=0;i<nb;i++){ let s=0; for(let j=0;j<nb-i;j++){ s += b[j]*b[j+i]; } c[i]=s; }
  let d=0; while(d < nb-1 && c[d] > c[d+1]) d++;
  let maxval=-1, maxpos=-1;
  for(let i=d;i<nb;i++){ if(c[i] > maxval){ maxval=c[i]; maxpos=i; } }
  if(maxpos <= 0) return -1;
  let T0 = maxpos;
  const x1=c[T0-1]||0, x2=c[T0], x3=c[T0+1]||0;
  const a=(x1+x3-2*x2)/2, bb=(x3-x1)/2;
  if(a) T0 = T0 - bb/(2*a);
  const f = sr/T0;
  return (f > 60 && f < 2200) ? f : -1;
}
function swaraForFreq(f, saHz){
  const semis = 12 * Math.log2(f / saHz);
  const nearest = Math.round(semis);
  const ideal = saHz * Math.pow(2, nearest/12);
  const cents = 1200 * Math.log2(f / ideal);
  let idx = ((nearest % 12) + 12) % 12;
  const oct = Math.floor(nearest / 12);
  let tok = SWARAS[idx].tok;
  if(oct > 0) tok += "'".repeat(oct);
  else if(oct < 0) tok += ",".repeat(-oct);
  return {tok, cents, idx, oct};
}
// Hindustani sargam naming (shared syllables, komal ♭ / tivra ♯ markers)
const HIND_LABEL = ['Sa','Re','Re','Ga','Ga','Ma','Ma','Pa','Dha','Dha','Ni','Ni'];
const HIND_QUAL  = ['','♭','','♭','','','♯','','♭','','♭',''];
function swaraLabel(idx, oct){
  let s = swaraSystem === 'hindustani' ? (HIND_LABEL[idx] + (HIND_QUAL[idx] || '')) : SWARAS[idx].tok;
  if(oct > 0) s += "'".repeat(oct); else if(oct < 0) s += ",".repeat(-oct);
  return s;
}
function renderTunerFinger(idx){
  const fig = $('#tFlute'); if(!fig) return;
  const f = fingeringForIdx(idx);
  if(!f){ fig.innerHTML = ''; $('#tFingerNote').textContent = ''; return; }
  fig.innerHTML = fluteFigHTML(f.holes, f.ob);
  const which = fluteType === 'venu' ? 'venu' : 'bansuri';
  $('#tFingerNote').innerHTML = `${prettySwara(f.baseTok)} fingering · ${which}` + (f.alt ? ` · <span style="color:var(--rose)">${f.alt}</span>` : '');
}
function setNeedle(cents){
  const pct = Math.max(0, Math.min(100, (cents + 50)));
  const n = $('#tNeedle'); n.style.left = pct + '%';
  n.style.background = Math.abs(cents) < 6 ? 'var(--jade)' : 'var(--amber)';
}
function tunerStatus(txt, live){ $('#tunerStatus').textContent = txt; $('#liveDot').classList.toggle('on', !!live); }

async function startTuner(){
  if(tuner.running) return;
  if(!window.isSecureContext && location.protocol !== 'file:'){
    showMicBanner('This page isn\u2019t on a secure (https) origin, so the browser may block the mic.');
  }
  try{
    tuner.stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
  }catch(e){
    showMicBanner('Couldn\u2019t open the microphone: ' + e.message + '. If you opened the file directly, run a local server (see note below) and allow mic access.');
    return;
  }
  hideMicBanner();
  tuner.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if(tuner.ctx.state === 'suspended') await tuner.ctx.resume();
  const src = tuner.ctx.createMediaStreamSource(tuner.stream);
  tuner.analyser = tuner.ctx.createAnalyser();
  tuner.analyser.fftSize = 2048;
  src.connect(tuner.analyser);
  tuner.buf = new Float32Array(tuner.analyser.fftSize);
  tuner.running = true;
  $('#tunerStart').disabled = true; $('#tunerStop').disabled = false;
  tunerStatus('Listening', true);
  tuner.lastLogged = null; tuner.cand = null; tuner.candCount = 0; tuner.silence = 0;
  loopTuner();
}
function stopTuner(){
  tuner.running = false;
  if(tuner.raf) cancelAnimationFrame(tuner.raf);
  if(tuner.stream) tuner.stream.getTracks().forEach(t => t.stop());
  if(tuner.ctx) tuner.ctx.close();
  tuner.ctx = null;
  $('#tunerStart').disabled = false; $('#tunerStop').disabled = true;
  tunerStatus('Idle', false);
}
function loopTuner(){
  if(!tuner.running) return;
  tuner.analyser.getFloatTimeDomainData(tuner.buf);
  drawScope(tuner.buf);
  const f = autoCorrelate(tuner.buf, tuner.ctx.sampleRate);
  const saHz = saHzFrom($('#tunerKey'), $('#tunerOct'));
  if(f > 0){
    tuner.silence = 0;
    const midi = midiFromFreq(f);
    const sw = swaraForFreq(f, saHz);
    tuner.lastIdx = sw.idx;
    $('#tNote').innerHTML = prettySwara(swaraLabel(sw.idx, sw.oct));
    $('#tSwara').textContent = noteName(midi) + ' · ' + (sw.cents>=0?'+':'') + sw.cents.toFixed(0) + '¢';
    $('#tHz').textContent = f.toFixed(1) + ' Hz';
    setNeedle(sw.cents);
    renderTunerFinger(sw.idx);
    // transcription: log a stable, reasonably in-tune note once
    if($('#transToggle').checked){
      const speed = $('#transSpeed') ? $('#transSpeed').value : 'normal';
      const threshold = speed === 'fast' ? 3 : speed === 'vfast' ? 2 : 6;
      const centsTol  = speed === 'vfast' ? 30 : 38;
      if(Math.abs(sw.cents) < centsTol){
        if(tuner.cand === sw.tok){ tuner.candCount++; }
        else { tuner.cand = sw.tok; tuner.candCount = 1; }
        if(tuner.candCount === threshold && sw.tok !== tuner.lastLogged){
          tuner.transcript.push({tok: sw.tok, t: performance.now()});
          tuner.lastLogged = sw.tok; renderTranscript();
        }
      }
    }
  } else {
    const speed = $('#transSpeed') ? $('#transSpeed').value : 'normal';
    const silenceThresh = speed === 'vfast' ? 4 : speed === 'fast' ? 7 : 14;
    if(++tuner.silence > silenceThresh){ tuner.lastLogged = null; tuner.cand = null; tuner.candCount = 0; }
    setNeedle(0);
  }
  tuner.raf = requestAnimationFrame(loopTuner);
}
function transcriptToks(){ return tuner.transcript.map(e => e.tok || e); }
function renderTranscript(){
  const t = $('#transcript');
  if(!tuner.transcript.length){ t.innerHTML = '<span class="muted">Swaras will appear here as you play clear, steady notes…</span>'; return; }
  t.innerHTML = transcriptToks().map(prettySwara).join('&nbsp; ');
}
function playTranscript(){
  if(!tuner.transcript.length) return;
  stopAll();
  const c = ac();
  const saHz = saHzFrom($('#tunerKey'), $('#tunerOct'));
  const entries = tuner.transcript;
  if(entries.length === 1 || typeof entries[0] === 'string'){
    // no timing info — fall back to fixed tempo
    playSequence(transcriptToks().join(' '), saHz, 500);
    return;
  }
  // use recorded inter-onset intervals, clamped to 120ms–2000ms per note
  let t = c.currentTime + 0.06;
  entries.forEach((e, i) => {
    const semi = tokenToSemi(e.tok);
    const next = entries[i + 1];
    const dur = next ? Math.min(2.0, Math.max(0.12, (next.t - e.t) / 1000)) : 0.5;
    if(semi !== null) blow(saHz * Math.pow(2, semi / 12), t, dur * 0.92);
    t += dur;
  });
}
function drawScope(buf){
  const cv = $('#tunerScope'); if(!cv) return;
  const {ctx,w,h} = fitCanvas(cv);
  ctx.clearRect(0,0,w,h);
  ctx.lineWidth = 2; ctx.strokeStyle = '#5cc7a6'; ctx.beginPath();
  const step = Math.max(1, Math.floor(buf.length / w));
  for(let i=0,x=0; i<buf.length; i+=step, x++){
    const y = h/2 + buf[i]*h*0.42;
    if(x===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
}
function showMicBanner(msg){ const b = $('#micBanner'); b.style.display = 'block'; b.textContent = msg; }
function hideMicBanner(){ $('#micBanner').style.display = 'none'; }

function wireTuner(){
  $('#tunerStart').addEventListener('click', startTuner);
  $('#tunerStop').addEventListener('click', stopTuner);
  const sysSel = $('#tunerSystem');
  if(sysSel) sysSel.addEventListener('change', e => {
    swaraSystem = e.target.value;
    if(tuner.lastIdx != null){ $('#tNote').innerHTML = prettySwara(swaraLabel(tuner.lastIdx, 0)); }
  });
  const flSel = $('#tunerFlute');
  if(flSel) flSel.addEventListener('change', e => setFluteType(e.target.value));
  $('#transClear').addEventListener('click', () => { tuner.transcript = []; tuner.lastLogged = null; renderTranscript(); });
  $('#transPlay').addEventListener('click', playTranscript);
  $('#transCopy').addEventListener('click', () => {
    const txt = transcriptToks().join(' ');
    navigator.clipboard && navigator.clipboard.writeText(txt);
    const btn = $('#transCopy'); const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(()=>btn.textContent=o,1200);
  });
  $('#transToNb').addEventListener('click', () => {
    $('#nbNotes').value = transcriptToks().join(' ');
    $('#nbTitle').value = 'Transcribed ' + new Date().toLocaleDateString();
    location.hash = '#songs';
  });
}

/* ---------- 7. ROUTER + INIT ---------- */
const VIEWS = ['home','basics','sound','notation','scales','ragas','songs','tuner'];
function route(){
  let id = (location.hash || '#home').slice(1);
  if(!VIEWS.includes(id)) id = 'home';
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === id));
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === id));
  // sync chip nav
  $$('#chipNav .chip').forEach(c => {
    const active = c.dataset.chip === id;
    c.classList.toggle('active', active);
    if(active) c.scrollIntoView({block:'nearest',inline:'center',behavior:'smooth'});
  });
  if(id !== 'tuner' && tuner.running) stopTuner();
  closeMenu();
  window.scrollTo({top:0});
}
function openMenu(){ $('#side').classList.add('open'); $('#scrim').classList.add('show'); }
function closeMenu(){ $('#side').classList.remove('open'); $('#scrim').classList.remove('show'); }

function syncKeySelects(srcSel){
  // keep the various key pickers loosely in step for convenience
  const v = srcSel.value;
  ['#saSelect','#keySelect','#ragaKey','#songKey','#tunerKey'].forEach(id => { const s=$(id); if(s && s!==srcSel) s.value=v; });
  renderKeyTables();
}

function init(){
  // populate selects (default A)
  ['#saSelect','#keySelect','#ragaKey','#songKey','#tunerKey'].forEach(id => fillNoteSelect($(id), 9));
  // builders
  buildHome();
  buildSwaraBoard();
  buildNotationTables();
  buildExplorer();
  buildTravelTable();
  buildKeyGuide();
  renderKeyTables();
  buildRagas();
  buildSongs();
  renderNotebook();
  wireNotebook();
  wireTuner();

  // notation/scales updates
  $('#saSelect').addEventListener('change', e => { syncKeySelects(e.target); renderExplorer(); });
  $('#saOct').addEventListener('change', renderExplorer);
  $('#keySelect').addEventListener('change', e => syncKeySelects(e.target));
  $('#keyOct').addEventListener('change', renderKeyTables);
  $('#ragaKey').addEventListener('change', e => syncKeySelects(e.target));
  $('#songKey').addEventListener('change', e => syncKeySelects(e.target));
  $('#tunerKey').addEventListener('change', e => syncKeySelects(e.target));
  $('#playScaleBtn').addEventListener('click', () =>
    playSequence("S R G m P D N S'", saHzFrom($('#saSelect'), $('#saOct')), 360));

  // theme toggle
  function applyTheme(light){
    document.documentElement.classList.toggle('light', light);
    localStorage.setItem('kuzhal_theme', light ? 'light' : 'dark');
    const label = light ? 'Dark mode' : 'Light mode';
    const t1 = $('#themeToggleSide'); if(t1) t1.textContent = label;
    const t2 = $('#themeToggleTop');  if(t2) t2.textContent = light ? '🌙' : '☀';
  }
  const savedTheme = localStorage.getItem('kuzhal_theme');
  const preferLight = savedTheme ? savedTheme === 'light' : window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(preferLight);
  $$('#themeToggleSide, #themeToggleTop').forEach(btn =>
    btn.addEventListener('click', () => applyTheme(!document.documentElement.classList.contains('light'))));

  // global tradition toggle — restore saved preference, then wire clicks
  const savedTradition = localStorage.getItem('kuzhal_tradition') || 'carnatic';
  setTradition(savedTradition);
  $$('#globalToggleSide .seg-btn, #globalToggleTop .seg-btn').forEach(btn =>
    btn.addEventListener('click', () => setTradition(btn.dataset.tradition)));

  // mobile menu
  $('#hamb').addEventListener('click', openMenu);
  $('#scrim').addEventListener('click', closeMenu);
  $$('#nav a').forEach(a => a.addEventListener('click', closeMenu));

  // Build-the-Note game (sound page)
  const GAME_SWARAS = ['S','R','G','m','P','D','N'];
  const GAME_SEMIS  = [0,2,4,5,7,9,11];
  const GAME_LENGTHS= [0.66,0.58,0.52,0.49,0.44,0.39,0.35]; // approx effective lengths
  let gameHoles = [false,false,false,false,false,false]; // false=open, true=closed
  let gameTarget = 0; // index into GAME_SWARAS
  function newGameTarget(){ gameTarget = Math.floor(Math.random() * GAME_SWARAS.length); updateGameTarget(); }
  function updateGameTarget(){
    const el = $('#sgameTarget'); if(el) el.textContent = `Target: ${GAME_SWARAS[gameTarget]}`;
  }
  function renderGameHoles(){
    const wrap = $('#sgameHoles'); if(!wrap) return;
    wrap.innerHTML = '';
    gameHoles.forEach((closed, i) => {
      const btn = el('button', 'sgame-hole' + (closed ? ' closed' : ''));
      btn.textContent = i + 1;
      btn.title = closed ? 'closed — tap to open' : 'open — tap to close';
      btn.addEventListener('click', () => { gameHoles[i] = !gameHoles[i]; renderGameHoles(); checkGame(); });
      wrap.appendChild(btn);
    });
  }
  function checkGame(){
    // count open holes from right = which note we're playing
    let firstOpen = -1;
    for(let i = gameHoles.length - 1; i >= 0; i--){ if(!gameHoles[i]){ firstOpen = i; break; } }
    // all closed = Sa (lowest)
    const noteIdx = firstOpen === -1 ? 0 : Math.min(firstOpen + 1, GAME_SWARAS.length - 1);
    const el = $('#sgameHz'); if(el) el.textContent = GAME_SWARAS[noteIdx];
    const res = $('#sgameResult'); if(!res) return;
    if(noteIdx === gameTarget){
      res.textContent = '✓ Correct!'; res.className = 'sgame-result win';
      setTimeout(newGameTarget, 1200);
    } else {
      const diff = GAME_SEMIS[noteIdx] - GAME_SEMIS[gameTarget];
      res.textContent = diff < 0 ? '↑ Too low — open more holes' : '↓ Too high — close more holes';
      res.className = 'sgame-result ' + (Math.abs(diff) <= 2 ? 'close' : 'off');
    }
  }
  if($('#sgameHoles')){
    renderGameHoles(); newGameTarget();
    $('#soundGameReset').addEventListener('click', () => { gameHoles = [false,false,false,false,false,false]; renderGameHoles(); newGameTarget(); });
  }

  // lesson stepper (basics page)
  let lessonStep = 0;
  const totalSteps = 5;
  function goToStep(n){
    lessonStep = Math.max(0, Math.min(totalSteps - 1, n));
    $$('#lessonCards .lesson-card').forEach((c,i) => c.classList.toggle('active', i === lessonStep));
    $$('#lessonDots .ldot').forEach((d,i) => d.classList.toggle('active', i === lessonStep));
    $('#lessonProgress').textContent = `${lessonStep + 1} / ${totalSteps}`;
    $('#lessonPrev').disabled = lessonStep === 0;
    $('#lessonNext').textContent = lessonStep === totalSteps - 1 ? '→ Start playing' : 'Next →';
    if(lessonStep === totalSteps - 1) $('#lessonNext').onclick = () => { location.hash = '#notation'; };
    else $('#lessonNext').onclick = () => goToStep(lessonStep + 1);
  }
  if($('#lessonNext')){
    $('#lessonNext').addEventListener('click', () => goToStep(lessonStep + 1));
    $('#lessonPrev').addEventListener('click', () => goToStep(lessonStep - 1));
    $$('#lessonDots .ldot').forEach(d => d.addEventListener('click', () => goToStep(+d.dataset.step)));
  }

  // ---- FEATURE 2: Build-the-note game — play pitch on hole click ----
  // Patch hole click to also play a sound
  const origRender = renderGameHoles;
  // Override hole click to play audio
  function renderGameHolesWithAudio(){
    const wrap = $('#sgameHoles'); if(!wrap) return;
    wrap.innerHTML = '';
    gameHoles.forEach((closed, i) => {
      const btn = el('button', 'sgame-hole' + (closed ? ' closed' : ''));
      btn.textContent = i + 1;
      btn.title = closed ? 'closed — tap to open' : 'open — tap to close';
      btn.addEventListener('click', () => {
        gameHoles[i] = !gameHoles[i];
        renderGameHolesWithAudio();
        checkGame();
        // play the current resulting pitch
        const firstOpen = gameHoles.reduceRight((acc, v, idx) => (!v && acc === -1 ? idx : acc), -1);
        const noteIdx = firstOpen === -1 ? 0 : Math.min(firstOpen + 1, GAME_SWARAS.length - 1);
        const saHz = saHzFrom($('#saSelect'), $('#saOct'));
        playSwara(GAME_SEMIS[noteIdx], saHz);
      });
      wrap.appendChild(btn);
    });
  }
  if($('#sgameHoles')) renderGameHolesWithAudio();

  // ---- FEATURE 3: Notation table tradition highlight ----
  function updateTradCards(){
    const carnatic = swaraSystem === 'carnatic';
    const cc = $('#carnaticCard'), hc = $('#hindCard');
    if(!cc || !hc) return;
    cc.classList.toggle('active-trad', carnatic);
    cc.classList.toggle('dim', !carnatic);
    hc.classList.toggle('active-trad', !carnatic);
    hc.classList.toggle('dim', carnatic);
  }
  updateTradCards();
  // patch setTradition to also update cards
  const _origSetTrad = setTradition;
  setTradition = function(t){ _origSetTrad(t); updateTradCards(); };
  $$('#globalToggleSide .seg-btn, #globalToggleTop .seg-btn').forEach(b =>
    b.addEventListener('click', () => updateTradCards()));

  // ---- FEATURE 4: Breath pressure guide (embouchure canvas) ----
  (function embouchureGuide(){
    const cv = $('#embouchureCanvas'); if(!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    let emAngleVal = 45, emSpeedVal = 3;
    function drawEmbouchure(){
      ctx.clearRect(0,0,W,H);
      const ps = getComputedStyle(document.documentElement);
      const cPanel  = ps.getPropertyValue('--panel').trim();
      const cPanel2 = ps.getPropertyValue('--panel-2').trim();
      const cAmber  = ps.getPropertyValue('--amber').trim();
      const cJade   = ps.getPropertyValue('--jade').trim();
      const cLine   = ps.getPropertyValue('--line').trim();
      const cInkMut = ps.getPropertyValue('--ink-mute').trim();

      // Draw flute cross-section (top edge of blow hole)
      const fluteY = H * 0.55;
      ctx.fillStyle = cPanel2; ctx.strokeStyle = cLine; ctx.lineWidth = 2;
      ctx.fillRect(0, fluteY, W, H - fluteY); ctx.strokeRect(0, fluteY, W, H - fluteY);

      // Blow hole opening (oval cutout in top of flute)
      const bhCx = W/2, bhW = 54, bhH = 14;
      ctx.clearRect(bhCx - bhW/2, fluteY - 4, bhW, bhH + 4);
      ctx.strokeStyle = cAmber; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(bhCx, fluteY, bhW/2, bhH/2, 0, 0, Math.PI*2); ctx.stroke();

      // Edge of blow hole (the sharp edge where air splits)
      const edgeX = bhCx + bhW/2 - 8;
      ctx.fillStyle = cAmber;
      ctx.beginPath(); ctx.moveTo(edgeX, fluteY - 6); ctx.lineTo(edgeX + 6, fluteY); ctx.lineTo(edgeX, fluteY + 4); ctx.closePath(); ctx.fill();

      // Lips (top-left area)
      const lipsX = W * 0.22, lipsY = fluteY - 60;
      ctx.fillStyle = ps.getPropertyValue('--rose').trim(); ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.ellipse(lipsX, lipsY, 20, 8, 0, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = ps.getPropertyValue('--ink').trim(); ctx.font = '500 10px var(--mono,monospace)';
      ctx.textAlign = 'center'; ctx.fillText('lips', lipsX, lipsY + 20);

      // Air jet direction
      const angleRad = (emAngleVal * Math.PI) / 180;
      const jLen = 60 + emSpeedVal * 10;
      const jDx = Math.cos(-angleRad + Math.PI*0.18) * jLen;
      const jDy = Math.sin(-angleRad + Math.PI*0.18) * jLen;
      ctx.strokeStyle = cJade; ctx.lineWidth = 2.5 + emSpeedVal * 0.4; ctx.globalAlpha = 0.85;
      ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(lipsX, lipsY); ctx.lineTo(lipsX + jDx, lipsY + jDy); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;

      // Arrowhead at jet end
      const jEndX = lipsX + jDx, jEndY = lipsY + jDy;
      ctx.fillStyle = cJade;
      ctx.beginPath(); ctx.arc(jEndX, jEndY, 4, 0, Math.PI*2); ctx.fill();

      // Result label inside canvas
      const result = getEmResult(emAngleVal, emSpeedVal);
      ctx.fillStyle = result.color; ctx.font = '600 11px var(--mono,monospace)';
      ctx.textAlign = 'center'; ctx.fillText(result.label, W/2, H - 12);
      ctx.textAlign = 'left';
    }
    function getEmResult(angle, speed){
      // Sweet spot: angle 35-55°, speed 2-4
      if(angle < 20) return { label:'Too steep — misses edge', color:'#f87171', q:'bad' };
      if(angle > 65) return { label:'Too shallow — no resonance', color:'#f87171', q:'bad' };
      if(speed === 1) return { label:'Too soft — airy, weak tone', color:'#f0b429', q:'soft' };
      if(speed === 5) return { label:'Too hard — squeaks, overblow', color:'#f0b429', q:'hard' };
      if(angle >= 30 && angle <= 60 && speed >= 2 && speed <= 4)
        return { label:'✓ Sweet spot — clear tone', color:'#34d399', q:'good' };
      return { label:'Adjust slightly…', color:'#a0a8c8', q:'ok' };
    }
    function updateEmGuide(){
      emAngleVal = parseInt($('#emAngle').value, 10);
      emSpeedVal = parseInt($('#emSpeed').value, 10);
      const speedNames = ['','very soft','soft','medium','firm','hard'];
      $('#angleVal').textContent = emAngleVal + '°';
      $('#speedVal').textContent = speedNames[emSpeedVal] || emSpeedVal;
      const r = getEmResult(emAngleVal, emSpeedVal);
      $('#emResult').textContent = r.label;
      $('#emResult').style.color = r.color;
      drawEmbouchure();
    }
    $('#emAngle').addEventListener('input', updateEmGuide);
    $('#emSpeed').addEventListener('input', updateEmGuide);
    $('#emPlay').addEventListener('click', () => {
      const r = getEmResult(emAngleVal, emSpeedVal);
      const saHz = saHzFrom($('#saSelect'), $('#saOct'));
      const c = ac();
      if(r.q === 'bad'){
        // no sound / faint noise — just white noise burst
        const buf = noiseBuffer(c);
        const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
        const g = c.createGain(); g.gain.setValueAtTime(0.04, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.5);
        src.connect(g); g.connect(master); src.start(); src.stop(c.currentTime + 0.5);
      } else if(r.q === 'hard'){
        // overblow — plays octave up
        blow(saHz * 2, c.currentTime + 0.01, 0.6);
      } else if(r.q === 'soft'){
        // airy — faint with more noise
        blow(saHz, c.currentTime + 0.01, 0.7);
      } else {
        // clean tone
        blow(saHz, c.currentTime + 0.01, 1.0);
      }
    });
    updateEmGuide();
  })();

  // ---- FEATURE 5: Animated breath exercise ----
  (function breathExercise(){
    const cv = $('#breathCircle'); if(!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, CX = W/2, CY = H/2;
    const PHASES = [
      { name:'Breathe in',   beats:4, dir:1,  tip:'Fill your belly, not your chest. Let it expand like a balloon.',  color:'#34d399' },
      { name:'Hold',         beats:2, dir:0,  tip:'Keep the pressure steady — your diaphragm is locked.',           color:'#f0b429' },
      { name:'Breathe out',  beats:6, dir:-1, tip:'Steady, controlled exhale — imagine fogging a mirror slowly.',   color:'#60a5fa' },
      { name:'Rest',         beats:1, dir:0,  tip:'Relax everything before the next cycle.',                        color:'#a0a8c8' },
    ];
    let running = false, phase = 0, beat = 0, radius = 30, rafId = null, lastTime = 0, elapsed = 0;
    const MIN_R = 30, MAX_R = 68;
    function drawBreath(r, ph){
      ctx.clearRect(0, 0, W, H);
      const p = PHASES[ph];
      // outer ring
      ctx.strokeStyle = p.color; ctx.lineWidth = 3; ctx.globalAlpha = 0.25;
      ctx.beginPath(); ctx.arc(CX, CY, MAX_R + 6, 0, Math.PI*2); ctx.stroke();
      ctx.globalAlpha = 1;
      // main circle
      const grad = ctx.createRadialGradient(CX, CY, 2, CX, CY, r);
      grad.addColorStop(0, p.color + '55'); grad.addColorStop(1, p.color + '18');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(CX, CY, r, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = p.color; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.arc(CX, CY, r, 0, Math.PI*2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const BPS = 60 / 72; // beat duration in seconds (72 bpm)
    function tick(now){
      if(!running) return;
      const dt = Math.min((now - lastTime) / 1000, 0.1); lastTime = now;
      elapsed += dt;
      const p = PHASES[phase];
      const phaseDur = p.beats * BPS;
      const progress = Math.min(elapsed / phaseDur, 1);
      // update radius
      if(p.dir === 1) radius = MIN_R + (MAX_R - MIN_R) * progress;
      else if(p.dir === -1) radius = MAX_R - (MAX_R - MIN_R) * progress;
      // update beat label
      const currentBeat = Math.min(Math.floor(elapsed / BPS) + 1, p.beats);
      $('#breathBeatLabel').textContent = `Beat ${currentBeat} / ${p.beats}`;
      drawBreath(radius, phase);
      if(elapsed >= phaseDur){
        elapsed = 0; phase = (phase + 1) % PHASES.length;
        const np = PHASES[phase];
        $('#breathPhaseLabel').textContent = np.name;
        $('#breathTip').textContent = np.tip;
        $('#breathTip').style.color = np.color;
      }
      rafId = requestAnimationFrame(tick);
    }
    drawBreath(MIN_R, 0);
    $('#breathStart').addEventListener('click', () => {
      running = true; phase = 0; elapsed = 0; radius = MIN_R; lastTime = performance.now();
      const p = PHASES[0];
      $('#breathPhaseLabel').textContent = p.name;
      $('#breathBeatLabel').textContent  = `Beat 1 / ${p.beats}`;
      $('#breathTip').textContent = p.tip;
      $('#breathTip').style.color = p.color;
      $('#breathStart').disabled = true; $('#breathStop').disabled = false;
      rafId = requestAnimationFrame(tick);
    });
    $('#breathStop').addEventListener('click', () => {
      running = false; cancelAnimationFrame(rafId);
      $('#breathStart').disabled = false; $('#breathStop').disabled = true;
      $('#breathPhaseLabel').textContent = '—'; $('#breathBeatLabel').textContent = 'Press Start';
      radius = MIN_R; drawBreath(MIN_R, 0);
    });
  })();

  // ---- FEATURE 1: Drone / Tanpura ----
  (function droneSetup(){
    const btn = $('#droneToggle'); if(!btn) return;
    let droneNodes = null, droneRunning = false;
    function getDroneHz(){
      const saHz = saHzFrom($('#saSelect'), $('#saOct')) || 261.63;
      return saHz;
    }
    function buildTanpuraTone(saHz, tradition){
      const c = ac();
      // Carnatic tanpura: Sa Pa Sa' Sa'' / Hindustani: Sa Ma Pa Sa'
      const intervals = tradition === 'hindustani' ? [0, 5, 7, 12] : [0, 7, 12, 24];
      const freqs = intervals.map(s => saHz * Math.pow(2, s/12));
      const masterGain = c.createGain();
      masterGain.gain.setValueAtTime(0.0001, c.currentTime);
      masterGain.gain.linearRampToValueAtTime(parseFloat($('#droneVol').value), c.currentTime + 1.2);
      masterGain.connect(master);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 0.5;
      lp.connect(masterGain);
      const oscillators = freqs.map((f, i) => {
        const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        // Slight detuning for tanpura shimmer
        o.detune.value = [0, 3, -3, 5][i] || 0;
        const g = c.createGain(); g.gain.value = [0.38, 0.22, 0.28, 0.15][i] || 0.2;
        // Slow tremolo to simulate string pluck decay
        const trem = c.createOscillator(); trem.frequency.value = 0.6 + i*0.1;
        const tremG = c.createGain(); tremG.gain.value = 0.08;
        trem.connect(tremG); tremG.connect(g.gain);
        trem.start(); o.connect(g); g.connect(lp); o.start();
        return [o, g, trem, tremG];
      });
      return { oscillators, masterGain, lp };
    }
    function startDrone(){
      const saHz = getDroneHz();
      const trad = $('#droneTradition').value;
      droneNodes = buildTanpuraTone(saHz, trad);
      droneRunning = true;
      btn.textContent = '◼ Stop'; btn.classList.add('active');
      const midi = midiFromFreq(saHz);
      $('#droneNote').textContent = noteName(midi) + ' Sa';
    }
    function stopDrone(){
      if(!droneNodes) return;
      const c = ac();
      droneNodes.masterGain.gain.linearRampToValueAtTime(0.0001, c.currentTime + 0.8);
      const nodes = droneNodes;
      setTimeout(() => {
        nodes.oscillators.forEach(([o,,tr]) => { try{ o.stop(); tr.stop(); }catch(e){} });
      }, 900);
      droneNodes = null; droneRunning = false;
      btn.textContent = '▶ Sa'; btn.classList.remove('active');
      $('#droneNote').textContent = '—';
    }
    btn.addEventListener('click', () => droneRunning ? stopDrone() : startDrone());
    $('#droneVol').addEventListener('input', () => {
      if(droneNodes) droneNodes.masterGain.gain.setTargetAtTime(parseFloat($('#droneVol').value), ac().currentTime, 0.05);
    });
    // Restart drone when Sa changes
    $('#saSelect').addEventListener('change', () => { if(droneRunning){ stopDrone(); setTimeout(startDrone, 950); } });
    $('#saOct').addEventListener('change',    () => { if(droneRunning){ stopDrone(); setTimeout(startDrone, 950); } });
  })();

  // animations
  heroAnim(); pipeAnim();
  window.addEventListener('resize', () => {});

  // router
  window.addEventListener('hashchange', route);
  route();
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
