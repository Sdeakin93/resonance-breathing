# Resonance Pacer

A phone web app that guides resonance-frequency breathing, reads live heart rate over Bluetooth, and finds your personal resonance breathing rate.

Open it in **Chrome on Android** (or Chrome/Edge on a computer). Safari and iPhone can't use Web Bluetooth.

## What it does

- **Breathe:** a pacer with an adjustable rate (4.5 to 7 breaths/min) and in:out ratio, a soft tone and vibration cues. When a heart sensor is connected, it plots your heart rate over the breath guide and shows the heart-rate swing per breath and a lock-in score.
- **Find my rate:** paces you at 7.0, 6.5, 6.0, 5.5, 5.0 and (optionally) 4.5 breaths/min for 2 minutes each, then ranks the rates by heart-rate swing, LF power and lock-in.
- **History:** sessions and rate checks, kept in this browser only. "Copy all data as JSON" exports them.

## Heart-rate sources

| Device | How | Beat-to-beat data |
| --- | --- | --- |
| Whoop | Turn on Heart Rate Broadcast in the Whoop app, then Connect | No, about one heart-rate value per second |
| Chest strap (Polar H10, Garmin HRM) | Wear it, then Connect | Yes |
| Demo strap / demo Whoop | Built in, for trying the app | Simulated |

## Code

- `algorithm/resonance.js`: the signal processing and calibration logic (no dependencies). The method follows Steffen et al. 2017 (doi:10.3389/fpubh.2017.00222) and Chaitanya et al. 2022 (doi:10.7759/cureus.22187).
- `algorithm/simulate.test.mjs`: checks calibration against simulated people with a known resonance rate. Run `node algorithm/simulate.test.mjs`.
- `ble.js`: Bluetooth Heart Rate Measurement parsing and the demo devices.
- `pacer.js`: the breath shape and tone.
- `app.js`, `index.html`, `app.css`: the app.

No build step: it's static files, served by GitHub Pages.

This is a breathing guide, not medical advice.
