// Checks the algorithm on simulated people whose true resonance rate is known.
// Run: node simulate.test.mjs
//
// Each simulated person has a heart-rate swing that peaks at their RF and
// falls off on either side, plus beat-to-beat noise and slow drift. We then
// view the same heartbeat two ways:
//   strap: exact RR intervals
//   wrist: 1 Hz whole-bpm heart rate smoothed over a few seconds, which is
//          roughly what a Whoop or Garmin heart-rate broadcast provides.
import { PROTOCOL, cleanRR, hrFromRR, hrFromSamples, resample, rankCalibration, timeDomain } from './resonance.js';

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

function simulateStep(rf, rate, seconds) {
  const f = rate / 60;
  const swing = 3 + 9 / (1 + ((rate - rf) / 0.5) ** 2);    // half-swing in bpm
  const base = 64 + 2 * gauss();
  const rr = [];
  let t = 0, drift = 0;
  while (t < seconds) {
    drift += 0.02 * gauss();
    const hr = base + drift + swing * Math.sin(2 * Math.PI * f * t) + 1.2 * gauss();
    const x = 60000 / hr;
    rr.push(x);
    t += x / 1000;
  }
  return rr;
}

function wristView(rr, smoothSeconds) {
  const beats = hrFromRR(rr), out = [];
  for (let s = 1; s <= beats.t[beats.t.length - 1]; s++) {
    const win = beats.hr.filter((_, i) => beats.t[i] > s - smoothSeconds && beats.t[i] <= s);
    if (win.length) out.push({ t: s, bpm: Math.round(win.reduce((a, b) => a + b, 0) / win.length) });
  }
  return out;
}

function run(label, view, trials = 60) {
  let exact = 0, within = 0;
  for (let n = 0; n < trials; n++) {
    const rf = PROTOCOL.rates[Math.floor(rand() * 5)];   // 7.0..5.0
    const steps = PROTOCOL.rates.map(rate => {
      const rr = simulateStep(rf, rate, PROTOCOL.stepSeconds);
      return { rate, wave: resample(view(rr)) };
    });
    const r = rankCalibration(steps);
    if (r.resonanceRate === rf) exact++;
    if (Math.abs(r.resonanceRate - rf) <= 0.5) within++;
  }
  console.log(`${label.padEnd(26)} exact ${String(Math.round(100 * exact / trials)).padStart(3)}%   within 0.5 ${String(Math.round(100 * within / trials)).padStart(3)}%`);
  return exact / trials;
}

const strap = run('strap (RR intervals)', rr => hrFromRR(cleanRR(rr).rr));
const w3 = run('wrist, 3 s smoothing', rr => hrFromSamples(wristView(rr, 3)));
const w5 = run('wrist, 5 s smoothing', rr => hrFromSamples(wristView(rr, 5)));
const w8 = run('wrist, 8 s smoothing', rr => hrFromSamples(wristView(rr, 8)));

// Sanity checks on cleaning and time-domain metrics.
const dirty = [1000, 1010, 990, 1005, 2500, 995, 400, 1000, 1500, 1002];
const c = cleanRR(dirty);
console.assert(c.rr.length === 7, 'cleanRR should drop 3 bad beats', c);
// A real 15 bpm swing at resonance must survive cleaning untouched.
const swing = []; for (let t = 0; t < 120; ) { const x = 60000 / (64 + 15 * Math.sin(2 * Math.PI * (5.5 / 60) * t)); swing.push(x); t += x / 1000; }
console.assert(cleanRR(swing).rejectedFraction === 0, 'cleanRR must keep resonance swings');
const td = timeDomain([1000, 1060, 1000, 1060, 1000]);
console.assert(Math.abs(td.rmssd - 60) < 1e-9 && td.pnn50 === 100, 'timeDomain', td);

if (strap < 0.8) { console.error('FAIL: strap accuracy below 80%'); process.exit(1); }
console.log('ok');
