// Heart-rate sources. Each source calls onData({t, bpm, rr}) about once a
// second, where t is seconds (performance clock), bpm is the device's heart
// rate and rr is a list of beat-to-beat intervals in ms (empty when the
// device does not send them, e.g. a Whoop broadcast).

// Standard Bluetooth Heart Rate Measurement (0x2A37), as sent by chest
// straps, Whoop's Heart Rate Broadcast and Garmin's broadcast mode.
export function parseHeartRate(view) {
  const flags = view.getUint8(0);
  let i = 1;
  const bpm = flags & 0x01 ? view.getUint16(i, true) : view.getUint8(i);
  i += flags & 0x01 ? 2 : 1;
  if (flags & 0x08) i += 2;                 // energy expended, unused
  const rr = [];
  if (flags & 0x10) {
    for (; i + 1 < view.byteLength; i += 2) rr.push((view.getUint16(i, true) * 1000) / 1024);
  }
  return { bpm, rr };
}

export const bluetoothAvailable = () => !!(navigator.bluetooth && navigator.bluetooth.requestDevice);

export async function connectBluetooth(onData, onStatus) {
  const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
  let stopped = false;

  async function attach() {
    onStatus({ state: 'connecting', name: device.name || 'Heart rate sensor' });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const ch = await service.getCharacteristic('heart_rate_measurement');
    ch.addEventListener('characteristicvaluechanged', e => {
      const { bpm, rr } = parseHeartRate(e.target.value);
      onData({ t: performance.now() / 1000, bpm, rr });
    });
    await ch.startNotifications();
    onStatus({ state: 'connected', name: device.name || 'Heart rate sensor' });
  }

  device.addEventListener('gattserverdisconnected', async () => {
    if (stopped) return;
    onStatus({ state: 'reconnecting', name: device.name });
    for (let n = 0; n < 5 && !stopped; n++) {
      await new Promise(r => setTimeout(r, 1000 * 2 ** n));
      try { await attach(); return; } catch {}
    }
    onStatus({ state: 'lost', name: device.name });
  });

  await attach();
  return { name: device.name, stop() { stopped = true; try { device.gatt.disconnect(); } catch {} } };
}

// A simulated heart for trying the app without a device. Its resonance rate
// is 5.5 breaths/min; it breathes at whatever rate the pacer is showing.
// mode 'strap' sends beat intervals; mode 'wrist' sends only a heart rate
// smoothed over 4 s, like a Whoop broadcast.
export function connectDemo(onData, onStatus, getBreathRate, mode = 'strap') {
  const rf = 5.5;
  let phase = 0, t = 0, drift = 0, last = performance.now() / 1000, recent = [];
  const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());
  onStatus({ state: 'connected', name: mode === 'strap' ? 'Demo strap' : 'Demo wrist (Whoop-like)' });
  const timer = setInterval(() => {
    const now = performance.now() / 1000, rr = [];
    while (t < now - last) {
      const rate = getBreathRate() || 12;
      const swing = 3 + 9 / (1 + ((rate - rf) / 0.5) ** 2);
      drift = 0.98 * drift + 0.1 * gauss();
      const hr = 66 + drift + swing * Math.sin(phase) + 1.2 * gauss();
      const x = 60000 / hr;
      rr.push(x);
      t += x / 1000;
      phase += (2 * Math.PI * rate / 60) * (x / 1000);
      recent.push({ at: last + t, hr });
    }
    recent = recent.filter(b => b.at > now - 4);
    const avg = recent.reduce((s, b) => s + b.hr, 0) / (recent.length || 1);
    onData({ t: now, bpm: Math.round(avg), rr: mode === 'strap' ? rr : [] });
  }, 1000);
  return { name: 'Demo', stop() { clearInterval(timer); } };
}
