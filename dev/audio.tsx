/**
 * Audio Lab — sandbox for src/audio (plain DOM, no canvas).
 *
 *  - unlock / mix / scene controls, live master meter (peak, RMS, spectrum)
 *  - synthetic RenderFrame driver: manual sliders, or the scripted MockSim stepped without a canvas
 *  - a button for every one-shot and UI sound
 *  - window.__audioSelfTest(): offline-rendered measurements of every sound (also via the button)
 */
import '@/styles/base.css';
import { Vector3 } from 'three';
import { audio, DEFAULT_MIX, type AudioMix, type AudioScene, type UiSound } from '@/audio/AudioEngine';
import { runAudioSelfTest, type SelfTestReport } from '@/audio/test/selfTest';
import { createRenderFrame } from '@/game/runtime';
import { MockSim } from '@/dev/mockRuntime';
import type { GameEvent, LandingQuality, LandingResult, LevelResult, VacuumMode } from '@/game/types';

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.append(c);
  return n;
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { class: cls, text: label });
  b.addEventListener('click', () => {
    void audio.unlock();
    onClick();
  });
  return b;
}

interface Slider {
  row: HTMLElement;
  get: () => number;
  set: (v: number) => void;
}

function slider(label: string, min: number, max: number, step: number, value: number, onInput?: (v: number) => void, fmt = (v: number) => v.toFixed(2)): Slider {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el('output', { text: fmt(value) });
  const sync = () => {
    out.textContent = fmt(Number(input.value));
    onInput?.(Number(input.value));
  };
  input.addEventListener('input', sync);
  return {
    row: el('div', { class: 'row' }, [el('label', { text: label }), input, out]),
    get: () => Number(input.value),
    set: (v) => {
      input.value = String(v);
      sync();
    },
  };
}

function checkbox(label: string, checked: boolean, onChange?: (v: boolean) => void): { row: HTMLElement; get: () => boolean } {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange?.(input.checked));
  return { row: el('label', { class: 'check' }, [input, label]), get: () => input.checked };
}

/* ------------------------------------------------------------------ */
/* Event payloads                                                      */
/* ------------------------------------------------------------------ */

const P = new Vector3(0, 0.36, -50);
const N = new Vector3(0, 1, 0);

function landing(quality: LandingQuality, impactSpeed: number): LandingResult {
  return {
    quality,
    angleDeg: 5,
    impactSpeed,
    driftDeg: 3,
    wheelsDown: 4,
    airTime: 3,
    distance: 130,
    maxHeight: 15,
    tricks: [],
    basePoints: 1200,
    multiplier: 1.5,
    points: 1800,
    inTarget: true,
    position: P.clone(),
  };
}

const levelResult = (): LevelResult => ({
  levelId: 1,
  score: 15400,
  time: 58,
  medal: 'gold',
  finalLanding: landing('perfect', 5),
  bestLanding: null,
  breakdown: [],
  stats: { maxSpeedKmh: 262, maxAirTime: 4.1, longestJump: 170, tricks: 4, invertedDistance: 0 },
});

const trick = (count = 1): GameEvent => ({ type: 'trick', trick: { kind: 'backflip', label: count > 1 ? 'DOUBLE BACKFLIP' : 'BACKFLIP', count, points: 600 } });
const impact = (strength: number): GameEvent => ({ type: 'impact', position: P, normal: N, strength });

/**
 * Event sequences timed like the real sim (src/game/sim): the landing verdict arrives 0.15 s after the
 * touchdown's wheel slams, a sliding chassis reports an impact every 0.1 s, and each completed rotation
 * is its own trick event (a DOUBLE is a second event with count 2).
 */
const SEQUENCES: Array<[label: string, steps: Array<[ms: number, make: () => GameEvent]>, needsFrames?: boolean]> = [
  ['touchdown → CLEAN', [[0, () => ({ type: 'wheelSlam', position: P, strength: 0.55 })], [150, () => ({ type: 'landing', result: landing('clean', 11) })]]],
  ['touchdown → PERFECT', [[0, () => ({ type: 'wheelSlam', position: P, strength: 0.2 })], [150, () => ({ type: 'landing', result: landing('perfect', 5) })]]],
  ['touchdown → HARD', [[0, () => ({ type: 'wheelSlam', position: P, strength: 0.9 })], [150, () => ({ type: 'landing', result: landing('hard', 20) })]]],
  ['flip, DOUBLE, spin, bonus', [[0, () => trick(1)], [500, () => trick(2)], [1000, () => ({ type: 'trick', trick: { kind: 'spin', label: '360 SPIN', count: 1, points: 400 } })], [1500, () => ({ type: 'trick', trick: { kind: 'hangTime', label: 'HANG TIME', count: 1, points: 400 } })]]],
  ['scrape 2 s', [[0, () => impact(0.6)], ...Array.from({ length: 19 }, (_, i): [number, () => GameEvent] => [100 * (i + 1), () => impact(0.3)])], true],
];

const EVENT_GROUPS: Array<{ title: string; items: Array<[string, () => GameEvent, string?]> }> = [
  {
    title: 'Rocket',
    items: [
      ['boost ignition', () => ({ type: 'boostStart' }), 'warn'],
      ['boost cut-off', () => ({ type: 'boostEnd' })],
      ['fuel empty', () => ({ type: 'fuelEmpty' })],
    ],
  },
  {
    title: 'Vacuum',
    items: [
      ['vacuum on', () => ({ type: 'vacuumOn' })],
      ['engaged (lock)', () => ({ type: 'vacuumEngaged', position: P, normal: N })],
      ['released (hiss)', () => ({ type: 'vacuumReleased', position: P })],
      ['vacuum off', () => ({ type: 'vacuumOff' })],
    ],
  },
  {
    title: 'Air & landing',
    items: [
      ['takeoff', () => ({ type: 'takeoff', position: P, speed: 45 })],
      ['trick (climbs)', () => trick()],
      ['land PERFECT', () => ({ type: 'landing', result: landing('perfect', 5) }), 'primary'],
      ['land CLEAN', () => ({ type: 'landing', result: landing('clean', 11) })],
      ['land HARD', () => ({ type: 'landing', result: landing('hard', 20) })],
      ['land CRASH', () => ({ type: 'landing', result: landing('crash', 28) })],
    ],
  },
  {
    title: 'Impacts',
    items: [
      ['wheel slam', () => ({ type: 'wheelSlam', position: P, strength: 0.8 })],
      ['impact light', () => ({ type: 'impact', position: P, normal: N, strength: 0.3 })],
      ['impact heavy', () => ({ type: 'impact', position: P, normal: N, strength: 1 })],
      ['CRASH', () => ({ type: 'crash', reason: 'rollover', position: P, impactSpeed: 24 }), 'danger'],
    ],
  },
  {
    title: 'Progress',
    items: [
      ['objective tick', () => ({ type: 'objectiveComplete', index: 0, id: 'o' })],
      ['checkpoint', () => ({ type: 'checkpoint', id: 'c' })],
      ['prompt', () => ({ type: 'prompt', prompt: { id: 'p', text: 'HOLD SPACE', hint: null, tone: 'action' } })],
      ['level complete', () => ({ type: 'levelComplete', result: levelResult() }), 'primary'],
      ['reset', () => ({ type: 'reset' })],
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const root = document.getElementById('root')!;
const lab = el('div', { class: 'lab' });
root.append(lab);

// --- header -----------------------------------------------------------
const pill = el('span', { class: 'pill', text: 'locked' });
const meter = el('canvas', { class: 'meter' });
lab.append(
  el('div', { class: 'top' }, [
    el('div', { class: 'brand' }, ['AUDIO LAB', el('small', { text: 'ROADSTER FLIGHT · PROCEDURAL WEB AUDIO' })]),
    button('Unlock audio', () => undefined, 'primary'),
    pill,
    meter,
  ]),
);

// --- mix & scene ---------------------------------------------------------
const mix: AudioMix = { ...DEFAULT_MIX };
const applyMix = () => audio.setMix(mix);
const masterS = slider('Master', 0, 1, 0.01, mix.master, (v) => ((mix.master = v), applyMix()));
const musicS = slider('Music', 0, 1, 0.01, mix.music, (v) => ((mix.music = v), applyMix()));
const sfxS = slider('SFX', 0, 1, 0.01, mix.sfx, (v) => ((mix.sfx = v), applyMix()));
const muteC = checkbox('Mute', false, (v) => ((mix.muted = v), applyMix()));
const sceneBtns: HTMLButtonElement[] = [];
let scene: AudioScene = 'title';
const setScene = (s: AudioScene) => {
  scene = s;
  audio.setScene(s);
  for (const b of sceneBtns) b.classList.toggle('sel', b.textContent === s);
};
for (const s of ['title', 'game', 'paused', 'complete'] as const) sceneBtns.push(button(s, () => setScene(s)));
const debugBox = el('div', { class: 'debug' });
const uiBtns = (['hover', 'click', 'back', 'toggle', 'start', 'unlock'] as const).map((k: UiSound) => {
  const b = button(k, () => audio.ui(k));
  if (k === 'hover') b.addEventListener('pointerenter', () => audio.ui('hover'));
  return b;
});
const mixPanel = el('div', { class: 'panel' }, [
  el('h2', { text: 'MIX' }),
  masterS.row,
  musicS.row,
  sfxS.row,
  muteC.row,
  el('h3', { text: 'Scene' }),
  el('div', { class: 'btns' }, sceneBtns),
  el('h3', { text: 'UI sounds' }),
  el('div', { class: 'btns' }, uiBtns),
  el('h3', { text: 'Engine state' }),
  debugBox,
]);

// --- vehicle driver ---------------------------------------------------------
type Source = 'off' | 'manual' | 'mock';
let source: Source = 'off';
const srcBtns: HTMLButtonElement[] = [];
const setSource = (s: Source) => {
  source = s;
  if (s !== 'off' && scene !== 'game') setScene('game');
  for (const b of srcBtns) b.classList.toggle('sel', b.dataset.src === s);
};
for (const [s, label] of [
  ['off', 'off'],
  ['manual', 'manual frames'],
  ['mock', 'MockSim'],
] as const) {
  const b = button(label, () => setSource(s));
  b.dataset.src = s;
  srcBtns.push(b);
}
const speedS = slider('Speed m/s', 0, 80, 0.5, 30, undefined, (v) => v.toFixed(1));
const throttleS = slider('Throttle', -1, 1, 0.01, 0.6);
const slipS = slider('Slip', 0, 1, 0.01, 0);
const boostS = slider('Boost', 0, 1, 0.01, 0);
const vacSel = el('select', {}, (['off', 'armed', 'engaged'] as const).map((m) => el('option', { value: m, text: m })));
const vacS = slider('Vac strength', 0, 1, 0.01, 0);
const airC = checkbox('Airborne', false);
const spinS = slider('Spin rad/s', 0, 8, 0.1, 0, undefined, (v) => v.toFixed(1));
const rcsP = slider('RCS pitch', -1, 1, 0.01, 0);
const rcsY = slider('RCS yaw', -1, 1, 0.01, 0);
const rcsR = slider('RCS roll', -1, 1, 0.01, 0);
const tsS = slider('Time scale', 0.2, 1, 0.01, 1);
const pausedC = checkbox('frame.paused', false);
const mockInfo = el('div', { class: 'debug', text: '' });
const vehPanel = el('div', { class: 'panel' }, [
  el('h2', { text: 'VEHICLE → update(frame)' }),
  el('div', { class: 'btns' }, srcBtns),
  el('h3', { text: 'Manual frame' }),
  speedS.row,
  throttleS.row,
  slipS.row,
  boostS.row,
  el('div', { class: 'row' }, [el('label', { text: 'Vacuum' }), vacSel, el('span')]),
  vacS.row,
  airC.row,
  spinS.row,
  rcsP.row,
  rcsY.row,
  rcsR.row,
  tsS.row,
  pausedC.row,
  el('h3', { text: 'MockSim' }),
  mockInfo,
]);

// --- one-shots + self-test ------------------------------------------------------
const shotPanel = el('div', { class: 'panel' }, [el('h2', { text: 'ONE-SHOTS → handleEvent(e)' })]);
for (const g of EVENT_GROUPS) {
  shotPanel.append(
    el('h3', { text: g.title }),
    el(
      'div',
      { class: 'btns' },
      g.items.map(([label, make, cls]) =>
        button(
          label,
          () => {
            // Gameplay events are ignored on the title scene (by design) — switch to the game scene.
            if (scene === 'title') setScene('game');
            audio.handleEvent(make());
          },
          cls ?? '',
        ),
      ),
    ),
  );
}
shotPanel.append(
  el('h3', { text: 'Sim-timed sequences' }),
  el(
    'div',
    { class: 'btns' },
    SEQUENCES.map(([label, steps, needsFrames]) =>
      button(label, () => {
        if (scene !== 'game') setScene('game');
        // The scrape layer is continuous: it only sounds while update() runs.
        if (needsFrames && source === 'off') setSource('manual');
        for (const [ms, make] of steps) setTimeout(() => audio.handleEvent(make()), ms);
      }),
    ),
  ),
);
const testSummary = el('div', { class: 'summary', text: 'Self-test not run yet — renders every sound offline through the real graph.' });
const testOut = el('div', { class: 'results' });
const runBtn = button('Run self-test', () => void runTest(), 'primary');
const testPanel = el('div', { class: 'panel', style: 'margin-top:14px' }, [
  el('h2', { text: 'VERIFICATION — OFFLINE RENDER OF EVERY SOUND' }),
  el('div', { class: 'btns' }, [runBtn]),
  testSummary,
  testOut,
  el('div', {
    class: 'note',
    text: 'Pass = no exception, non-silent, peak < 0.98 after the master limiter (measured at full master/music/sfx after a 0.38 s compressor pre-roll). Loudness per ITU-R BS.1770 (LUFS-M = 400 ms momentary max, transient = 100 ms, laptop = transient through a 4th-order 200 Hz high-pass speaker model, with the drop in brackets). Layer rows sweep one parameter with the layer soloed. Band split: sub <80 · low <300 · mid <2k · high <6k · air.',
  }),
]);

lab.append(el('div', { class: 'grid' }, [mixPanel, vehPanel, shotPanel]), testPanel);

/* ------------------------------------------------------------------ */
/* Frame driving                                                       */
/* ------------------------------------------------------------------ */

const frame = createRenderFrame();
frame.snapshot.phase = 'running';
frame.snapshot.vehicle.vacuum.available = true;
const manualSnapshot = frame.snapshot;
let mock: MockSim | null = null;

function fillManual(): void {
  const s = manualSnapshot;
  const v = s.vehicle;
  const speed = speedS.get();
  const air = airC.get();
  v.speed = speed;
  v.forwardSpeed = speed;
  v.velocity.set(0, 0, -speed);
  for (const w of v.wheels) {
    w.grounded = !air;
    w.spinRate = speed / 0.36;
    w.slip = air ? 0 : slipS.get();
    w.surface = air ? null : 'asphalt';
  }
  v.groundedWheels = air ? 0 : 4;
  v.airborne = air;
  v.throttle = air ? 0 : throttleS.get();
  v.boostLevel = boostS.get();
  v.boosting = v.boostLevel > 0.05;
  v.angularVelocity.set(spinS.get(), 0, 0);
  v.rcs.pitch = rcsP.get();
  v.rcs.yaw = rcsY.get();
  v.rcs.roll = rcsR.get();
  v.vacuum.mode = vacSel.value as VacuumMode;
  v.vacuum.strength = vacS.get();
  s.timeScale = tsS.get();
  s.air.airborne = air;
  s.air.airTime = air ? s.air.airTime + frame.dt : 0;
  frame.snapshot = s;
  frame.paused = pausedC.get();
}

let last = performance.now();
let frames = 0;
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame.dt = dt;
  frame.time += dt;
  if (source === 'manual') {
    fillManual();
    frame.simDt = dt * frame.snapshot.timeScale;
    audio.update(frame);
  } else if (source === 'mock') {
    mock ??= new MockSim();
    const events = mock.update(dt);
    frame.snapshot = mock.snapshot;
    frame.simDt = dt;
    frame.paused = pausedC.get();
    audio.update(frame);
    for (const e of events) audio.handleEvent(e);
    const v = mock.snapshot.vehicle;
    mockInfo.textContent = `t ${mock.snapshot.time.toFixed(2)} s   phase ${mock.snapshot.phase}\nspeed ${v.speed.toFixed(1)} m/s   boost ${v.boostLevel.toFixed(2)}\nairborne ${v.airborne}   vacuum ${v.vacuum.mode}`;
  }
  if (++frames % 6 === 0) renderDebug();
  drawMeter();
  requestAnimationFrame(loop);
}

function renderDebug(): void {
  pill.textContent = audio.state;
  pill.classList.toggle('on', audio.state === 'running');
  const d = audio.debug;
  if (!d) {
    debugBox.textContent = 'locked — click any button to unlock';
    return;
  }
  const m = d.music;
  debugBox.textContent = [
    `scene       ${d.scene}`,
    `intensity   ${d.intensity.toFixed(2)}   air ${d.air.toFixed(2)}`,
    `vehicle bus ${d.vehicleOpen ? 'open' : 'closed'}   slowmo ${d.slowmo}`,
    `voices      sfx ${d.sfxVoices}  ui ${d.uiVoices}  music ${m?.voices ?? 0}`,
    m ? `music       ${m.arrangement} bar ${m.bar} step ${m.step}` : 'music       —',
    m ? `chord       ${m.chord}${m.flight ? '  (flight)' : ''}` : '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Meter                                                               */
/* ------------------------------------------------------------------ */

let analyser: AnalyserNode | null = null;
let timeData: Float32Array<ArrayBuffer> | null = null;
let freqData: Float32Array<ArrayBuffer> | null = null;
let peakHold = 0;
const mctx = meter.getContext('2d')!;

function drawMeter(): void {
  const w = (meter.width = meter.clientWidth * devicePixelRatio);
  const h = (meter.height = meter.clientHeight * devicePixelRatio);
  mctx.clearRect(0, 0, w, h);
  if (!analyser && audio.unlocked) {
    analyser = audio.createAnalyser(4096);
    if (analyser) {
      timeData = new Float32Array(analyser.fftSize);
      freqData = new Float32Array(analyser.frequencyBinCount);
    }
  }
  if (!analyser || !timeData || !freqData) return;
  analyser.getFloatTimeDomainData(timeData);
  analyser.getFloatFrequencyData(freqData);
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < timeData.length; i++) {
    const a = Math.abs(timeData[i]);
    if (a > peak) peak = a;
    sq += a * a;
  }
  peakHold = Math.max(peak, peakHold * 0.97);
  const rms = Math.sqrt(sq / timeData.length);
  const db = (x: number) => (x > 1e-6 ? 20 * Math.log10(x) : -120);
  const norm = (d: number) => Math.max(0, Math.min(1, (d + 60) / 60));
  // level bars (left 30 %)
  const bw = w * 0.3;
  mctx.fillStyle = '#24282d';
  mctx.fillRect(0, h * 0.25, bw, h * 0.18);
  mctx.fillRect(0, h * 0.57, bw, h * 0.18);
  mctx.fillStyle = '#38e8ff';
  mctx.fillRect(0, h * 0.25, bw * norm(db(rms)), h * 0.18);
  mctx.fillStyle = peakHold > 0.9 ? '#ff7a1c' : '#7ff3ff';
  mctx.fillRect(0, h * 0.57, bw * norm(db(peak)), h * 0.18);
  mctx.fillStyle = '#f1ede6';
  mctx.fillRect(bw * norm(db(peakHold)) - 2, h * 0.55, 2 * devicePixelRatio, h * 0.22);
  mctx.font = `${10 * devicePixelRatio}px JetBrains Mono, monospace`;
  mctx.fillStyle = '#a3aab2';
  mctx.fillText(`RMS ${db(rms).toFixed(1)}  PEAK ${db(peakHold).toFixed(1)} dBFS`, 0, h * 0.2);
  // spectrum (log frequency, right side)
  const x0 = bw + 20 * devicePixelRatio;
  const sw = w - x0;
  const sr = audio.currentTime >= 0 ? analyser.context.sampleRate : 48000;
  mctx.strokeStyle = 'rgba(56,232,255,0.85)';
  mctx.lineWidth = 1.2 * devicePixelRatio;
  mctx.beginPath();
  for (let i = 0; i <= 200; i++) {
    const f = 20 * Math.pow(1000, i / 200);
    const bin = Math.min(freqData.length - 1, Math.round((f / (sr / 2)) * freqData.length));
    const y = h - norm((freqData[bin] + 30) * 0.8) * h;
    const x = x0 + (i / 200) * sw;
    if (i === 0) mctx.moveTo(x, y);
    else mctx.lineTo(x, y);
  }
  mctx.stroke();
}

/* ------------------------------------------------------------------ */
/* Self-test                                                           */
/* ------------------------------------------------------------------ */

const BAND_COLORS = ['#ff7a1c', '#ffb36b', '#c6cbd1', '#38e8ff', '#7ff3ff'];

function bandsBar(b: { sub: number; low: number; mid: number; high: number; air: number }): HTMLElement {
  const wrap = el('span', { class: 'bands' });
  [b.sub, b.low, b.mid, b.high, b.air].forEach((v, i) => wrap.append(el('span', { style: `width:${(v * 100).toFixed(1)}%;background:${BAND_COLORS[i]}` })));
  return wrap;
}

function renderReport(r: SelfTestReport): void {
  testSummary.className = `summary ${r.ok ? 'ok' : 'bad'}`;
  const nPass = r.sounds.filter((s) => s.pass).length + r.layers.filter((l) => l.pass).length;
  const nAll = r.sounds.length + r.layers.length;
  const maxPeak = Math.max(...r.sounds.map((s) => s.peak), ...r.layers.map((l) => l.peak));
  testSummary.textContent = `${r.ok ? 'ALL PASS' : 'FAILURES'} — ${nPass}/${nAll} checks · max peak ${maxPeak.toFixed(3)} · ${r.sampleRate} Hz · ${(r.elapsedMs / 1000).toFixed(1)} s${
    r.live ? ` · live ${r.live.state} peak ${r.live.analyserPeak} · hidden→${r.live.hiddenState} visible→${r.live.visibleState} · lifecycle ${r.live.lifecycle} · ${r.live.mute}` : ''
  }`;
  testOut.replaceChildren();
  const legend = el('div', { class: 'legend' }, ['bands:']);
  ['sub', 'low', 'mid', 'high', 'air'].forEach((n, i) => legend.append(el('i', { style: `background:${BAND_COLORS[i]}` }), n));
  const st = el('table');
  st.append(el('tr', {}, ['sound', 'peak', 'LUFS-M', 'transient', 'laptop', 'LUFS-I', 'active', 'centroid', 'bands', ''].map((h) => el('th', { text: h }))));
  for (const s of r.sounds) {
    st.append(
      el('tr', {}, [
        el('td', { class: 'name', text: s.name }),
        el('td', {}, [el('span', { class: 'bar', style: `width:${Math.round(s.peak * 60)}px` }), ` ${s.peak.toFixed(3)}`]),
        el('td', { text: s.lufsM.toFixed(1) }),
        el('td', { text: s.lufsT.toFixed(1) }),
        el('td', { text: `${s.lufsSmall.toFixed(1)} (${(s.lufsSmall - s.lufsT).toFixed(1)})` }),
        el('td', { text: s.lufsI.toFixed(1) }),
        el('td', { text: `${s.activeMs} ms` }),
        el('td', { text: `${s.centroidHz} Hz` }),
        el('td', {}, [bandsBar(s.bands)]),
        el('td', { class: s.pass ? 'pass' : 'fail', text: s.pass ? 'PASS' : s.issues.join(', ') }),
      ]),
    );
  }
  const lt = el('table', { class: 'layers', style: 'margin-top:14px' });
  lt.append(el('tr', {}, ['continuous layer response', 'points (rms dB / centroid Hz / presence dB)', ''].map((h) => el('th', { text: h }))));
  for (const l of r.layers) {
    lt.append(
      el('tr', {}, [
        el('td', { class: 'name', text: l.name }),
        el('td', {
          class: 'points',
          text: l.points
            // Rows with no measurement (rms 0 / centroid 0) are notes: print the label only.
            .map((p) => (p.rmsDb === 0 && p.centroidHz === 0 ? p.label : `${p.label}: ${p.rmsDb} / ${p.centroidHz}${p.presenceDb !== undefined ? ` / ${p.presenceDb}` : ''}`))
            .join('   ·   '),
        }),
        el('td', { class: l.pass ? 'pass' : 'fail', text: l.pass ? 'PASS' : l.detail }),
      ]),
    );
  }
  testOut.append(legend, st, lt);
  if (r.failures.length) testOut.append(el('div', { class: 'note', style: 'color:#ff9a9a', text: r.failures.join(' | ') }));
}

let testing = false;
async function runTest(): Promise<SelfTestReport | null> {
  if (testing) return null;
  testing = true;
  runBtn.disabled = true;
  testSummary.className = 'summary';
  try {
    const report = await runAudioSelfTest({ analyser, onProgress: (label) => (testSummary.textContent = `rendering… ${label}`) });
    renderReport(report);
    renderDebug();
    return report;
  } finally {
    testing = false;
    runBtn.disabled = false;
  }
}

const w = window as unknown as { __audioSelfTest?: () => Promise<SelfTestReport | null>; __shotReady?: boolean; __audio?: typeof audio };
w.__audioSelfTest = runTest;
w.__audio = audio; // the page's singleton, for scripted inspection

setScene('title');
requestAnimationFrame(loop);
w.__shotReady = true;
