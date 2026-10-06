import { PROTOCOL, cleanRR, hrFromRR, hrFromSamples, resample, analyzeWindow, peakToTrough, rankCalibration, timeDomain } from './algorithm/resonance.js';
import { bluetoothAvailable, connectBluetooth, connectDemo } from './ble.js';
import { breath, makeTone } from './pacer.js';

const $ = id => document.getElementById(id);
const now = () => performance.now() / 1000;
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- storage (this phone only) ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- state ----------
const prefs = Object.assign({ rate: 5.5, ratio: 0.4, minutes: 15, sound: true, buzz: true, rf: null }, store.get('rp-prefs', {}));
const savePrefs = () => store.set('rp-prefs', prefs);

let sensor = null;
const samples = [];   // {t, bpm}
const beats = [];     // {t, rr}  one entry per notification, rr = list of ms

// mode: idle | session | cal
const run = { mode: 'idle', origin: now(), paused: false, pausedAt: 0, pausedTotal: 0, lastPhase: null, steps: [], stepIndex: 0 };
const tone = makeTone();
let wake = null;

// ---------- heart data ----------
function onData(d) {
  samples.push({ t: d.t, bpm: d.bpm });
  if (d.rr.length) beats.push({ t: d.t, rr: d.rr });
  const cutoff = d.t - 30 * 60;
  while (samples.length && samples[0].t < cutoff) samples.shift();
  while (beats.length && beats[0].t < cutoff) beats.shift();
  $('sHR').textContent = d.bpm ? `${d.bpm}` : '--';
}

function onStatus(s) {
  const chip = $('chip');
  chip.dataset.state = s.state;
  $('chipText').textContent = {
    connecting: `Connecting to ${s.name}…`,
    connected: s.name,
    reconnecting: `${s.name}: reconnecting…`,
    lost: `${s.name} disconnected`,
    off: 'No heart sensor',
  }[s.state];
  $('connect').textContent = s.state === 'connected' ? 'Disconnect' : 'Connect';
  if (s.state === 'lost') sensor = null;
  updateCalAvailability();
}

// Heart-rate waveform between two clock times. Uses beat intervals when the
// device sent them for most of the window, otherwise the per-second rate.
function waveBetween(a, b) {
  const rrs = beats.filter(x => x.t >= a && x.t < b).flatMap(x => x.rr);
  const covered = rrs.reduce((s, x) => s + x, 0) / 1000;
  if (rrs.length > 10 && covered >= 0.8 * (b - a)) {
    const clean = cleanRR(rrs);
    return { wave: resample(hrFromRR(clean.rr)), rr: clean.rr, rejected: clean.rejectedFraction };
  }
  const s = samples.filter(x => x.t >= a && x.t < b).map(x => ({ t: x.t - a, bpm: x.bpm }));
  if (s.length < 10) return null;
  return { wave: resample(hrFromSamples(s)), rr: null, rejected: 0 };
}

// ---------- pacer clock ----------
const elapsed = () => ((run.paused ? run.pausedAt : now()) - run.origin - run.pausedTotal);
function currentRate() {
  if (run.mode === 'cal') return run.steps[run.stepIndex]?.rate ?? prefs.rate;
  return prefs.rate;
}

// ---------- drawing ----------
const orb = $('orb'), cue = $('cue'), count = $('count'), cv = $('trace'), ctx = cv.getContext('2d');
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawTrace(tNow) {
  const w = cv.clientWidth, h = cv.clientHeight, d = devicePixelRatio || 1;
  if (cv.width !== Math.round(w * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const span = 60, pad = 8, rate = currentRate(), pt = elapsed();
  // breath guide: past minute, ending at the current moment on the right edge
  ctx.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const v = breath(pt - span + (x / w) * span, rate, prefs.ratio).v;
    const y = h - pad - v * (h - 2 * pad);
    x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = css('--line'); ctx.lineWidth = 6; ctx.lineJoin = 'round'; ctx.stroke();

  // heart rate over the same minute: beat-by-beat when available
  const pts = [];
  for (const b of beats) {
    if (b.t < tNow - span - 5) continue;
    let tb = b.t;
    for (let i = b.rr.length - 1; i >= 0; i--) { pts.unshift({ t: tb, hr: 60000 / b.rr[i] }); tb -= b.rr[i] / 1000; }
  }
  pts.sort((a, b) => a.t - b.t);
  const series = pts.length > 20 ? pts : samples.filter(s => s.t > tNow - span - 2).map(s => ({ t: s.t, hr: s.bpm }));
  if (series.length > 2) {
    let lo = Math.min(...series.map(p => p.hr)), hi = Math.max(...series.map(p => p.hr));
    if (hi - lo < 10) { const m = (hi + lo) / 2; lo = m - 5; hi = m + 5; }
    ctx.beginPath();
    series.forEach((p, i) => {
      const x = w - ((tNow - p.t) / span) * w, y = h - pad - ((p.hr - lo) / (hi - lo)) * (h - 2 * pad);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = css('--hr'); ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = css('--muted'); ctx.font = '11px ' + css('--mono');
    ctx.fillText(`${Math.round(hi)}`, 2, 12); ctx.fillText(`${Math.round(lo)}`, 2, h - 2);
  }
}

function renderPacer() {
  const active = run.mode !== 'idle' && !run.paused;
  const t = run.mode === 'idle' ? now() : elapsed();
  const rate = currentRate(), b = breath(t, rate, prefs.ratio);
  orb.style.width = orb.style.height = (reduceMotion || run.mode === 'idle' ? 70 : 40 + b.v * 58) + '%';
  orb.style.borderColor = `var(--${b.phase})`;
  if (active) {
    cue.textContent = b.phase === 'in' ? 'Breathe in' : 'Breathe out';
    count.textContent = String(Math.ceil(b.left));
    if (run.lastPhase && b.phase !== run.lastPhase && prefs.buzz && navigator.vibrate) {
      try { navigator.vibrate(b.phase === 'in' ? 40 : [30, 60, 30]); } catch {}
    }
    run.lastPhase = b.phase;
    tone.follow(b.v);
  }
  drawTrace(now());
}

// ---------- live metrics ----------
function updateLive() {
  if (run.mode === 'idle' || run.paused) return;
  const t1 = now(), stepStart = run.mode === 'cal' ? run.steps[run.stepIndex].start : run.start;
  const win = Math.min(64, t1 - stepStart - 10);
  if (win < 24) { $('sSwing').textContent = 'settling'; $('sLock').textContent = '--'; return; }
  const w = waveBetween(t1 - win, t1);
  if (!w) return;
  const m = analyzeWindow(w.wave, currentRate());
  $('sSwing').textContent = `${m.peakToTrough.toFixed(1)} bpm`;
  $('sLock').textContent = `${Math.round(m.lockIn * 100)}`;
}

function frame() {
  if (run.mode === 'session' && !run.paused) {
    const e = elapsed();
    $('timer').textContent = `${fmt(e)} / ${fmt(prefs.minutes * 60)}`;
    if (e >= prefs.minutes * 60) endSession(true);
  }
  if (run.mode === 'cal' && !run.paused) calTick();
  renderPacer();
  requestAnimationFrame(frame);
}

// ---------- shared start/stop ----------
async function lockScreen() { try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; } }
function beginActivity() {
  run.origin = now(); run.pausedTotal = 0; run.paused = false; run.lastPhase = null; run.start = now();
  if (prefs.sound) tone.start();
  lockScreen();
}
function endActivity() {
  run.mode = 'idle'; run.paused = false; tone.stop();
  try { wake?.release(); } catch {}
  $('sSwing').textContent = '--'; $('sLock').textContent = '--';
  setUI();
}

// ---------- breathe session ----------
function startSession() { run.mode = 'session'; beginActivity(); setUI(); }
function pauseSession() {
  if (!run.paused) { run.paused = true; run.pausedAt = now(); tone.stop(); cue.textContent = 'Paused'; }
  else { run.pausedTotal += now() - run.pausedAt; run.paused = false; if (prefs.sound) tone.start(); }
  setUI();
}
function endSession(completed) {
  const secs = elapsed(), a = run.start + 30, b = now();
  let summary = {};
  if (secs >= 90) {
    const w = waveBetween(a, b);
    if (w) {
      summary.avgSwing = +peakToTrough(w.wave, prefs.rate).toFixed(1);
      if (w.rr) summary.rmssd = +timeDomain(w.rr).rmssd.toFixed(0);
    }
  }
  if (secs >= 60) {
    const list = store.get('rp-sessions', []);
    list.unshift({ at: Date.now(), rate: prefs.rate, ratio: prefs.ratio, secs: Math.round(secs), done: completed, ...summary });
    store.set('rp-sessions', list.slice(0, 200));
  }
  cue.textContent = completed ? 'Session complete' : 'Ready';
  endActivity(); renderHistory();
}

// ---------- calibration ----------
function startCal() {
  const rates = PROTOCOL.rates.filter(r => !($('skip45').checked && r === 4.5));
  run.steps = rates.map(rate => ({ rate, start: 0, end: 0 }));
  run.stepIndex = 0; run.mode = 'cal';
  beginActivity();
  run.steps[0].start = now();
  $('calResult').hidden = true;
  setUI();
}
function calTick() {
  const step = run.steps[run.stepIndex], left = PROTOCOL.stepSeconds - (now() - step.start);
  $('timer').textContent = `Step ${run.stepIndex + 1} of ${run.steps.length} · ${step.rate} / min · ${fmt(Math.max(0, left))} left`;
  if (left > 0) return;
  step.end = now();
  if (run.stepIndex + 1 < run.steps.length) {
    run.stepIndex++;
    run.steps[run.stepIndex].start = now();
    run.origin = now(); run.pausedTotal = 0;   // each step's pacer starts on a fresh in-breath
    return;
  }
  finishCal();
}
function finishCal() {
  const data = run.steps.map(s => ({ rate: s.rate, w: waveBetween(s.start, s.end) }));
  endActivity();
  cue.textContent = 'Ready';
  if (data.some(d => !d.w)) {
    $('calSummary').textContent = 'Some steps had no heart data, so the check could not finish. Make sure the sensor stays connected and try again.';
    $('calResult').hidden = false; $('rfBig').textContent = '?'; $('calRows').replaceChildren(); $('useRf').hidden = true;
    return;
  }
  const r = rankCalibration(data.map(d => ({ rate: d.rate, wave: d.w.wave })));
  const usedRR = data.every(d => d.w.rr);
  const rec = {
    at: Date.now(), rf: r.resonanceRate, byTotalPower: r.byTotalPower, suggestCheckAt: r.suggestCheckAt,
    source: usedRR ? 'beat-to-beat' : 'heart-rate-only',
    steps: r.steps.map(s => ({ rate: s.rate, swing: +s.peakToTrough.toFixed(1), lf: +s.lfPower.toFixed(1), lockIn: +s.lockIn.toFixed(2) })),
  };
  const cals = store.get('rp-cals', []); cals.unshift(rec); store.set('rp-cals', cals.slice(0, 50));
  showCal(rec); renderHistory();
}
function showCal(rec) {
  $('calResult').hidden = false; $('useRf').hidden = false;
  $('rfBig').textContent = rec.rf;
  const notes = [`Based on ${rec.source} data.`];
  if (rec.byTotalPower !== rec.rf) notes.push(`The total-power rule from the Chaitanya study would pick ${rec.byTotalPower}.`);
  if (rec.suggestCheckAt) notes.push(`It was close, so a later check at ${rec.suggestCheckAt} is worth doing.`);
  $('calSummary').textContent = notes.join(' ');
  const rows = [...rec.steps].sort((a, b) => b.rate - a.rate).map(s => {
    const tr = document.createElement('tr');
    if (s.rate === rec.rf) tr.className = 'best';
    for (const v of [s.rate, s.swing, s.lf, `${Math.round(s.lockIn * 100)}`]) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    return tr;
  });
  $('calRows').replaceChildren(...rows);
  $('useRf').onclick = () => { prefs.rf = rec.rf; prefs.rate = rec.rf; savePrefs(); syncControls(); show('breathe'); };
}

// ---------- history ----------
function renderHistory() {
  const list = store.get('rp-sessions', []);
  $('histEmpty').hidden = list.length > 0;
  $('histRows').replaceChildren(...list.slice(0, 50).map(s => {
    const tr = document.createElement('tr'), d = new Date(s.at);
    const when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    for (const v of [when, s.rate, fmt(s.secs), s.avgSwing != null ? `${s.avgSwing}` : '--', s.rmssd != null ? `${s.rmssd} ms` : '--']) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    return tr;
  }));
  const cals = store.get('rp-cals', []);
  $('calEmpty').hidden = cals.length > 0;
  $('calHist').replaceChildren(...cals.map(c => {
    const li = document.createElement('li');
    li.textContent = `${new Date(c.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}: ${c.rf} breaths/min (${c.source})`;
    return li;
  }));
}

// ---------- UI wiring ----------
function syncControls() {
  const T = 60 / prefs.rate, ti = T * prefs.ratio;
  $('rate').value = prefs.rate; $('ratio').value = Math.round(prefs.ratio * 100);
  $('rateOut').textContent = String(prefs.rate);
  $('ratioOut').textContent = `${Math.round(prefs.ratio * 100)} : ${Math.round((1 - prefs.ratio) * 100)}`;
  $('split').textContent = `${ti.toFixed(1)} s in · ${(T - ti).toFixed(1)} s out`;
  $('sound').checked = prefs.sound; $('buzz').checked = prefs.buzz;
  document.querySelectorAll('#mins button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.m === prefs.minutes)));
  $('rfNote').textContent = prefs.rf
    ? (prefs.rate === prefs.rf ? `Your measured resonance rate is ${prefs.rf}.` : `Your measured resonance rate is ${prefs.rf}; you're set to ${prefs.rate}.`)
    : '5.5 is the most common resonance rate. Use Find my rate to get yours.';
  if (run.mode === 'idle') { count.textContent = `${prefs.rate} / min`; $('timer').textContent = `00:00 / ${fmt(prefs.minutes * 60)}`; }
}

function setUI() {
  const busy = run.mode !== 'idle';
  $('go').textContent = run.mode !== 'session' ? 'Start' : run.paused ? 'Resume' : 'Pause';
  $('go').disabled = run.mode === 'cal';
  $('stop').hidden = run.mode !== 'session';
  $('calGo').hidden = run.mode === 'cal'; $('calStop').hidden = run.mode !== 'cal';
  ['rate', 'ratio'].forEach(id => $(id).disabled = busy);
  document.querySelectorAll('#mins button').forEach(b => b.disabled = busy);
  updateCalAvailability();
  syncControls();
}

function updateCalAvailability() {
  const ready = $('chip').dataset.state === 'connected';
  $('calGo').disabled = !ready || run.mode !== 'idle';
  $('calNeed').hidden = ready;
}

function show(view) {
  for (const v of ['breathe', 'find', 'history']) {
    $(`view-${v}`).hidden = v !== view;
    $(`tab-${v}`).setAttribute('aria-selected', String(v === view));
  }
}

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
$('connect').addEventListener('click', () => {
  if (sensor) { sensor.stop(); sensor = null; onStatus({ state: 'off' }); return; }
  $('connectPanel').hidden = !$('connectPanel').hidden;
});
if (!bluetoothAvailable()) {
  $('btHelp').textContent = 'This browser can’t use Bluetooth. Open this page in Chrome on Android, Windows or a Mac.';
  $('connectBt').disabled = true;
}
$('connectBt').addEventListener('click', async () => {
  try {
    sensor = await connectBluetooth(onData, onStatus);
    $('connectPanel').hidden = true;
  } catch (e) {
    if (e.name !== 'NotFoundError') $('btHelp').textContent = `Couldn’t connect: ${e.message}. Check the broadcast is on and try again.`;
  }
});
const demo = mode => () => {
  sensor?.stop();
  sensor = connectDemo(onData, onStatus, () => (run.mode === 'idle' || run.paused ? 12 : currentRate()), mode);
  $('connectPanel').hidden = true;
};
$('demoStrap').addEventListener('click', demo('strap'));
$('demoWrist').addEventListener('click', demo('wrist'));

$('go').addEventListener('click', () => (run.mode === 'idle' ? startSession() : pauseSession()));
$('stop').addEventListener('click', () => endSession(false));
$('calGo').addEventListener('click', startCal);
$('calStop').addEventListener('click', () => { endActivity(); cue.textContent = 'Ready'; });
$('rate').addEventListener('input', e => { prefs.rate = +e.target.value; savePrefs(); syncControls(); });
$('ratio').addEventListener('input', e => { prefs.ratio = +e.target.value / 100; savePrefs(); syncControls(); });
$('mins').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || run.mode !== 'idle') return;
  prefs.minutes = +b.dataset.m; savePrefs(); syncControls();
});
$('sound').addEventListener('change', e => { prefs.sound = e.target.checked; savePrefs(); if (run.mode !== 'idle' && !run.paused) prefs.sound ? tone.start() : tone.stop(); });
$('buzz').addEventListener('change', e => { prefs.buzz = e.target.checked; savePrefs(); });
$('export').addEventListener('click', async () => {
  const text = JSON.stringify({ prefs, sessions: store.get('rp-sessions', []), rateChecks: store.get('rp-cals', []) }, null, 2);
  try { await navigator.clipboard.writeText(text); $('export').textContent = 'Copied'; }
  catch { $('export').textContent = 'Copy failed'; }
  setTimeout(() => ($('export').textContent = 'Copy all data as JSON'), 2000);
});
document.addEventListener('visibilitychange', () => { if (run.mode !== 'idle' && document.visibilityState === 'visible') lockScreen(); });

syncControls(); setUI(); renderHistory();
const lastCal = store.get('rp-cals', [])[0];
if (lastCal) showCal(lastCal);
setInterval(updateLive, 2000);
requestAnimationFrame(frame);
