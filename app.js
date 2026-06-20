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

const SWARAS = [
  {tok:'S', sub:'Sa',  alt:false},
  {tok:'r', sub:'re',  alt:true},
  {tok:'R', sub:'Re',  alt:false},
  {tok:'g', sub:'ga',  alt:true},
  {tok:'G', sub:'Ga',  alt:false},
  {tok:'m', sub:'ma',  alt:false},
  {tok:'M', sub:'Má',  alt:true},
  {tok:'P', sub:'Pa',  alt:false},
  {tok:'d', sub:'dha', alt:true},
  {tok:'D', sub:'Dha', alt:false},
  {tok:'n', sub:'ni',  alt:true},
  {tok:'N', sub:'Ni',  alt:false},
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
const FINGER = [ // h1..h6: c closed, o open, h half. ob = overblow
  ['S',  ['c','c','c','o','o','o'], false, 'Sa'],
  ['r',  ['c','c','h','o','o','o'], false, 'komal Re (half-hole 3)'],
  ['R',  ['c','c','o','o','o','o'], false, 'shuddha Re'],
  ['g',  ['c','h','o','o','o','o'], false, 'komal Ga (half-hole 2)'],
  ['G',  ['c','o','o','o','o','o'], false, 'shuddha Ga'],
  ['m',  ['o','o','o','o','o','o'], false, 'shuddha Ma'],
  ['M',  ['h','o','o','o','o','o'], false, 'tivra Ma (half-hole 1)'],
  ['P',  ['c','c','c','c','c','c'], true,  'Pa'],
  ['d',  ['c','c','c','c','c','h'], true,  'komal Dha (half-hole 6)'],
  ['D',  ['c','c','c','c','c','o'], true,  'shuddha Dha'],
  ['n',  ['c','c','c','c','h','o'], true,  'komal Ni (half-hole 5)'],
  ['N',  ['c','c','c','c','o','o'], true,  'shuddha Ni'],
  ["S'", ['c','c','c','o','o','o'], true,  'upper Sa'],
];
// Carnatic venu — standard 8-hole layout (Pullanguzhal).
// Holes 1-6 are the main finger holes; 7 is the lower Pa hole; 8 is thumb/lowest.
// For middle octave (madhya sthayi) holes 7 & 8 stay closed.
// Opening holes 7+8 with all 1-6 closed gives mandra sthayi Pa (no overblow).
const FINGER_VENU = [
  ['S',  ['c','c','c','o','o','o','c','c'], false, 'Sa (madhya)'],
  ['r',  ['c','c','h','o','o','o','c','c'], false, 'komal Ri — half-hole 3'],
  ['R',  ['c','c','o','o','o','o','c','c'], false, 'shuddha Ri'],
  ['g',  ['c','h','o','o','o','o','c','c'], false, 'sadharana Ga — half-hole 2'],
  ['G',  ['c','o','o','o','o','o','c','c'], false, 'antara Ga'],
  ['m',  ['o','o','o','o','o','o','c','c'], false, 'shuddha Ma'],
  ['M',  ['h','o','o','o','o','o','c','c'], false, 'prati Ma — half-hole 1'],
  ['P',  ['c','c','c','c','c','c','c','c'], true,  'Pa (overblow)'],
  ['d',  ['c','c','c','c','c','h','c','c'], true,  'komal Da — half-hole 6'],
  ['D',  ['c','c','c','c','c','o','c','c'], true,  'shuddha Da'],
  ['n',  ['c','c','c','c','h','o','c','c'], true,  'komal Ni — half-hole 5'],
  ['N',  ['c','c','c','c','o','o','c','c'], true,  'shuddha Ni'],
  ["S'", ['c','c','c','o','o','o','c','c'], true,  'upper Sa'],
];
// which charted token each pitch-class maps to for tuner fingering display
// idx: 0 S, 1 r, 2 R, 3 g, 4 G, 5 m, 6 M, 7 P, 8 d, 9 D, 10 n, 11 N
const FING_BASE = ['S','r','R','g','G','m','M','P','d','D','n','N'];
const FING_ALT  = [null,'half-hole 3',null,'half-hole 2',null,null,'half-hole 1',null,'half-hole 6',null,'half-hole 5',null];
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
    b.innerHTML = `${s.tok}<span class="nm">${s.sub}</span>`;
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
  const fig = $('#exFlute'); if(!fig) return;
  fig.innerHTML = f ? fluteFigHTML(f.holes, f.ob) : '';
  $('#exFingerNote').innerHTML = f
    ? `<b>${prettySwara(explorer.tok)}</b> = ${f.label} · ${fluteType==='venu'?'Carnatic venu (8-hole)':'bansuri (6-hole)'}`
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
    const semi = tokenToSemi(explorer.tok) || 0;
    const ratio = Math.pow(2, semi/12);          // higher swara → shorter wavelength
    const cycles = 1.15 * ratio;                  // visible cycles across the panel
    const cy = h/2, amp = h*0.34, x0 = w*0.04, x1 = w*0.96;
    // faint guide line
    ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0,cy); ctx.lineTo(x1,cy); ctx.stroke();
    // travelling sine whose wavelength reflects the pitch
    ctx.strokeStyle = '#5cc7a6'; ctx.lineWidth = 2.4; ctx.beginPath();
    for(let x=x0; x<=x1; x++){
      const u = (x-x0)/(x1-x0);
      const y = cy - amp * Math.sin(2*Math.PI*cycles*u - t);
      x===x0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    }
    ctx.stroke();
    t += reduceMotion ? 0 : 0.12;
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
  // carnatic → bansuri + carnatic naming; hindustani → bansuri + hindustani naming
  // (venu is still selectable per-page via the local toggles)
  swaraSystem = tradition;
  if(tradition === 'carnatic'){
    setFluteType('bansuri');
  } else {
    setFluteType('bansuri');
    swaraSystem = 'hindustani';
  }
  // sync both global toggle instances
  $$('#globalToggleSide .seg-btn, #globalToggleTop .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tradition === tradition));
  // sync tuner naming select if present
  const sysSel = $('#tunerSystem');
  if(sysSel) sysSel.value = tradition;
  // rebuild swara board labels (they use swaraSystem indirectly via tuner label)
  buildSwaraBoard();
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
    // flute body
    ctx.fillStyle = '#241c12'; ctx.strokeStyle = '#7a5a26'; ctx.lineWidth = 1.4;
    roundRect(ctx, x0, cy - bodyH/2, L, bodyH, bodyH/2); ctx.fill(); ctx.stroke();
    // finger holes
    ctx.fillStyle = '#e3a948';
    for(let i=0;i<6;i++){ const hx = x0 + L*(0.42 + i*0.085); ctx.beginPath(); ctx.arc(hx, cy, 3.4, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#b9842f'; ctx.beginPath(); ctx.arc(x0 + L*0.16, cy, 4.4, 0, 7); ctx.fill();
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
    const len = parseFloat($('#pipeLen').value);     // 0.18..0.66 m effective
    const harm = parseInt($('#pipeHarm').value,10);
    const f = (343/(2*len))*harm;
    const cy = h/2;
    const x0 = w*0.06, x1 = x0 + (w*0.88)*(len/0.66);
    // pipe walls
    ctx.strokeStyle = '#5a4424'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, cy - h*0.32); ctx.lineTo(x1, cy - h*0.32);
    ctx.moveTo(x0, cy + h*0.32); ctx.lineTo(x1, cy + h*0.32); ctx.stroke();
    // animated standing wave
    const amp = h*0.27;
    ctx.lineWidth = 2.4; ctx.strokeStyle = '#5cc7a6';
    drawWave(ctx, x0, x1, cy, amp, harm, t, 1);
    ctx.globalAlpha=.35; drawWave(ctx, x0, x1, cy, amp, harm, t+Math.PI, 1); ctx.globalAlpha=1;
    // nodes
    ctx.fillStyle = '#e3a948';
    for(let k=1;k<harm;k++){ const nx = x0 + (x1-x0)*(k/harm); ctx.beginPath(); ctx.arc(nx, cy, 3.5, 0, 7); ctx.fill(); }
    const midi = midiFromFreq(f);
    $('#pipeReadout').textContent = `${f.toFixed(0)} Hz ≈ ${noteName(midi)}  ·  L ${(len*100).toFixed(0)} cm`;
    t += reduceMotion ? 0 : 0.06;
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
          tuner.transcript.push(sw.tok); tuner.lastLogged = sw.tok; renderTranscript();
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
function renderTranscript(){
  const t = $('#transcript');
  if(!tuner.transcript.length){ t.innerHTML = '<span class="muted">Swaras will appear here as you play clear, steady notes…</span>'; return; }
  t.innerHTML = tuner.transcript.map(prettySwara).join('&nbsp; ');
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
  $('#transCopy').addEventListener('click', () => {
    const txt = tuner.transcript.join(' ');
    navigator.clipboard && navigator.clipboard.writeText(txt);
    const btn = $('#transCopy'); const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(()=>btn.textContent=o,1200);
  });
  $('#transToNb').addEventListener('click', () => {
    $('#nbNotes').value = tuner.transcript.join(' ');
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

  // global tradition toggle (sidebar + topbar)
  $$('#globalToggleSide .seg-btn, #globalToggleTop .seg-btn').forEach(btn =>
    btn.addEventListener('click', () => setTradition(btn.dataset.tradition)));

  // mobile menu
  $('#hamb').addEventListener('click', openMenu);
  $('#scrim').addEventListener('click', closeMenu);
  $$('#nav a').forEach(a => a.addEventListener('click', closeMenu));

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
