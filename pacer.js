// Breath shape for the pacer: lung "volume" 0..1 at time t (seconds) for a
// given rate (breaths/min) and inhale fraction, with cosine easing so the
// turn at the top and bottom of each breath is gentle.
export function breath(t, rate, inhale = 0.4) {
  const T = 60 / rate, ti = T * inhale;
  const c = ((t % T) + T) % T;
  if (c < ti) return { v: (1 - Math.cos((Math.PI * c) / ti)) / 2, phase: 'in', left: ti - c };
  return { v: (1 + Math.cos((Math.PI * (c - ti)) / (T - ti))) / 2, phase: 'out', left: T - c };
}

// Soft tone that rises with the in-breath and falls with the out-breath.
export function makeTone() {
  let ctx = null, osc = null, gain = null;
  return {
    start() {
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        ctx.resume();
        osc = ctx.createOscillator(); gain = ctx.createGain();
        osc.type = 'sine'; gain.gain.value = 0;
        osc.connect(gain).connect(ctx.destination); osc.start();
      } catch { osc = gain = null; }
    },
    follow(v) {
      if (!gain) return;
      gain.gain.setTargetAtTime(0.035 + v * 0.03, ctx.currentTime, 0.1);
      osc.frequency.setTargetAtTime(196 + v * 98, ctx.currentTime, 0.1);
    },
    stop() {
      if (!gain) return;
      try { gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15); const o = osc; setTimeout(() => o.stop(), 600); } catch {}
      osc = gain = null;
    },
  };
}
