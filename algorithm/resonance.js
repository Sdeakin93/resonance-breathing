// Resonance breathing algorithm.
//
// Pure functions, no dependencies, so the same logic runs in the browser,
// in Node tests, and can be ported line for line to Monkey C for Garmin.
//
// Grounded in the two papers in this project:
//  - Steffen et al. 2017, Front. Public Health 5:222 (doi:10.3389/fpubh.2017.00222)
//    RF is personal, typically 4.5–7.0 breaths/min, most often 5.5. Breathing
//    1 breath/min above RF lost most of the benefit, so the search needs 0.5
//    breath/min resolution. Sessions of 15 min. Rates tested for 2 min each.
//  - Chaitanya et al. 2022, Cureus 14(2):e22187 (doi:10.7759/cureus.22187)
//    RF found by pacing 4.5 to 7.0 in 0.5 steps, 2 min each, keeping depth
//    constant, and picking the rate with maximum HRV total power. Practice was
//    20 min every morning for 4 weeks; SDNN, pNN50 and total power rose and
//    perceived stress fell. Participants were told to keep breaths shallow and
//    natural to avoid hyperventilating.
//
// Inputs come in two shapes:
//  - beats: RR intervals in ms from a chest strap (Polar H10, Garmin HRM).
//  - samples: [{t, bpm}] heart-rate samples about once a second from a device
//    that only broadcasts heart rate (Whoop broadcast, Garmin wrist broadcast).
// Both are turned into an evenly sampled heart-rate waveform before analysis.

export const PROTOCOL = {
  // Chaitanya 2022 range and step. Steffen 2017 dropped 4.5 because students
  // found it hard to sustain, so it is last and may be skipped.
  rates: [7.0, 6.5, 6.0, 5.5, 5.0, 4.5],
  stepSeconds: 120,
  settleSeconds: 20,          // ignored at the start of each step
  inhaleFraction: 0.4,
  sessionMinutes: [15, 20],   // Steffen 15, Chaitanya 20
  fs: 4,                      // resample rate for the waveform, Hz
  lf: [0.04, 0.15],           // Hz
  total: [0.0033, 0.4],       // Hz
  lockInHalfWidth: 0.015,     // Hz around the pacer frequency
};

// ---------- cleaning ----------

// Drop physiologically impossible intervals and ectopic or missed beats:
// outside 300–2000 ms, or more than 25% away from the previous kept beat.
// Compare against the previous beat, not a median of several: at resonance
// the heart rate swings 15+ bpm every breath, and a lagging median flags
// those real beats as artifacts. After 3 rejections in a row the signal has
// genuinely moved, so the next beat is accepted to re-anchor.
export function cleanRR(rr) {
  const clean = [];
  let rejected = 0, streak = 0;
  for (const x of rr) {
    if (x < 300 || x > 2000) { rejected++; continue; }
    const prev = clean[clean.length - 1];
    if (prev !== undefined && Math.abs(x - prev) > 0.25 * prev && streak < 3) {
      rejected++; streak++; continue;
    }
    streak = 0;
    clean.push(x);
  }
  return { rr: clean, rejectedFraction: rr.length ? rejected / rr.length : 0 };
}

// ---------- waveform ----------

// RR intervals (ms) -> instantaneous HR at each beat time (s).
export function hrFromRR(rr) {
  const t = [], hr = [];
  let clock = 0;
  for (const x of rr) {
    clock += x / 1000;
    t.push(clock);
    hr.push(60000 / x);
  }
  return { t, hr };
}

// [{t, bpm}] samples -> same shape, dropping implausible values.
export function hrFromSamples(samples) {
  const ok = samples.filter(s => s.bpm >= 30 && s.bpm <= 220);
  return { t: ok.map(s => s.t), hr: ok.map(s => s.bpm) };
}

// Linear interpolation onto an even grid from t0 to t1 at fs Hz.
export function resample({ t, hr }, fs = PROTOCOL.fs, t0 = t[0], t1 = t[t.length - 1]) {
  const out = [];
  let j = 0;
  for (let x = t0; x <= t1; x += 1 / fs) {
    while (j < t.length - 2 && t[j + 1] < x) j++;
    const a = t[j], b = t[j + 1];
    const w = b > a ? Math.min(1, Math.max(0, (x - a) / (b - a))) : 0;
    out.push(hr[j] + w * (hr[j + 1] - hr[j]));
  }
  return { fs, t0, hr: out };
}

// Slice a resampled waveform to [from, to) seconds after its start.
export function slice(wave, from, to) {
  const i = Math.max(0, Math.round(from * wave.fs));
  const k = Math.min(wave.hr.length, Math.round(to * wave.fs));
  return { fs: wave.fs, t0: wave.t0 + i / wave.fs, hr: wave.hr.slice(i, k) };
}

// ---------- spectrum ----------

// Power spectrum of the linearly detrended, Hann-windowed waveform,
// zero-padded to a power of two for 0.002 Hz-ish resolution. Units bpm^2/Hz.
export function spectrum(wave, minBins = 2048) {
  const x = detrend(wave.hr);
  const n = x.length;
  let N = 1;
  while (N < Math.max(n, minBins)) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = x[i] * w;
    wsum += w * w;
  }
  fft(re, im);
  const df = wave.fs / N, freqs = [], power = [];
  for (let k = 0; k <= N / 2; k++) {
    freqs.push(k * df);
    power.push((2 * (re[k] * re[k] + im[k] * im[k])) / (wave.fs * wsum));
  }
  return { freqs, power, df };
}

export function bandPower(spec, lo, hi) {
  let p = 0;
  for (let k = 0; k < spec.freqs.length; k++) {
    if (spec.freqs[k] >= lo && spec.freqs[k] < hi) p += spec.power[k] * spec.df;
  }
  return p;
}

export function peakFrequency(spec, lo, hi) {
  let best = -1, f = 0;
  for (let k = 0; k < spec.freqs.length; k++) {
    const x = spec.freqs[k];
    if (x >= lo && x < hi && spec.power[k] > best) { best = spec.power[k]; f = x; }
  }
  return f;
}

// ---------- metrics ----------

// Mean of (max HR − min HR) over each full pacer cycle in the window. This is
// the number the user sees: "your heart rate swings 14 bpm with each breath".
export function peakToTrough(wave, breathsPerMin) {
  const per = Math.round((60 / breathsPerMin) * wave.fs);
  const swings = [];
  for (let i = 0; i + per <= wave.hr.length; i += per) {
    const cyc = wave.hr.slice(i, i + per);
    swings.push(Math.max(...cyc) - Math.min(...cyc));
  }
  return swings.length ? mean(swings) : 0;
}

// Everything we need about one window paced at one rate.
export function analyzeWindow(wave, breathsPerMin, p = PROTOCOL) {
  const f = breathsPerMin / 60;
  const spec = spectrum(wave);
  const total = bandPower(spec, p.total[0], p.total[1]);
  const atPacer = bandPower(spec, f - p.lockInHalfWidth, f + p.lockInHalfWidth);
  return {
    rate: breathsPerMin,
    peakToTrough: peakToTrough(wave, breathsPerMin),
    lfPower: bandPower(spec, p.lf[0], p.lf[1]),
    totalPower: total,
    lockIn: total > 0 ? atPacer / total : 0,          // 0..1, shown as 0..100
    peakHz: peakFrequency(spec, p.total[0], p.total[1]),
  };
}

// ---------- calibration ----------

// steps: [{rate, wave}] where wave is the resampled HR for that whole step.
// Returns steps ranked best first plus the chosen RF.
//
// Score = 0.5 × peak-to-trough + 0.3 × LF power + 0.2 × lock-in, each scaled
// to the best step. Peak-to-trough leads because it is robust on 1 Hz
// heart-rate-only devices; LF/total power is the Chaitanya criterion and is
// reported alongside so the two can be compared on real data.
export function rankCalibration(steps, p = PROTOCOL) {
  const rows = steps.map(s => analyzeWindow(slice(s.wave, p.settleSeconds, p.stepSeconds), s.rate, p));
  const maxOf = k => Math.max(...rows.map(r => r[k])) || 1;
  const mPT = maxOf('peakToTrough'), mLF = maxOf('lfPower');
  for (const r of rows) {
    r.score = 0.5 * (r.peakToTrough / mPT) + 0.3 * (r.lfPower / mLF) + 0.2 * r.lockIn;
  }
  rows.sort((a, b) => b.score - a.score);
  const [best, second] = rows;
  const byTotalPower = [...rows].sort((a, b) => b.totalPower - a.totalPower)[0].rate;
  // Close call between neighbouring rates: suggest a 2-minute check between them.
  const closeCall = second && Math.abs(best.rate - second.rate) <= 0.5 && second.score >= 0.95 * best.score;
  return {
    resonanceRate: best.rate,
    byTotalPower,                     // what Chaitanya 2022 would have picked
    suggestCheckAt: closeCall ? (best.rate + second.rate) / 2 : null,
    steps: rows,
  };
}

// ---------- time-domain HRV (strap only) ----------

// The outcome measures the papers report, for before/after and weekly tests.
export function timeDomain(rr) {
  const d = [];
  for (let i = 1; i < rr.length; i++) d.push(rr[i] - rr[i - 1]);
  return {
    meanHR: 60000 / mean(rr),
    sdnn: sd(rr),
    rmssd: Math.sqrt(mean(d.map(x => x * x))),
    pnn50: d.length ? (100 * d.filter(x => Math.abs(x) > 50).length) / d.length : 0,
  };
}

// ---------- helpers ----------

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function sd(a) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }

function detrend(y) {
  const n = y.length, mx = (n - 1) / 2, my = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (y[i] - my); den += (i - mx) ** 2; }
  const b = den ? num / den : 0;
  return y.map((v, i) => v - (my + b * (i - mx)));
}

// In-place iterative radix-2 FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}
