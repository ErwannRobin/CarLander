/**
 * LEVEL 3 — THE INVERTED RAMP: headless proof (vitest, node).
 * The road is one straight line from the start: no jump before the crescent, no turn on the beam.
 *
 *  (a) the reference pilot completes the level, deterministically, also through asFunction()
 *  (b) a keyboard-like variant (axes quantized to −1/0/+1 with a 0.1 s minimum hold, ±0.15 s jitter on
 *      discrete actions) completes it
 *  (c) sweeps mirroring real players: road speed (incl. W held the whole time), climb / beam speed,
 *      ENTER timing, release position, recovery style, thrust start/duration — success windows are
 *      printed and asserted against human-sized minimums
 *  (d) failures behave sensibly (no vacuum, early release, landing inverted, steering off)
 * Plus first-attempt bullet-time prompts and the medal calibration.
 */
import { describe, expect, it } from 'vitest';
import { LEVEL_3, level3Pilot } from '@/game/levels/level3';
import { L3_IDS } from '@/game/levels/level3/def';
import { L3_GEO } from '@/game/levels/level3/geometry';
import { createL3Pilot, type L3PilotOptions } from '@/game/levels/level3/pilot';
import { initPhysics } from '@/game/physics/initPhysics';
import { runAutopilot, TrackTracker, type Autopilot } from '@/game/sim/autopilot';
import { GameSim } from '@/game/sim/GameSim';
import { THEMES } from '@/render/env/themes';
import type { CrashReason, GameEvent, InputState, LandingResult, LevelResult } from '@/game/types';
import { createSim, ofType } from '../physics/helpers';

const G = L3_GEO;
const DECK_LEN = G.deck[G.deck.length - 1].s;

interface Run {
  phase: string;
  crash: CrashReason | null;
  crashY: number;
  final: LandingResult | null;
  releaseSpeed: number;
  /** Distance before the beam end where ENTER was released (m), NaN if never. */
  releasedAt: number;
  maxProgress: number;
  result: LevelResult | null;
  events: GameEvent[];
  minPromptScale: number;
  promptIds: Set<string>;
  climbImpactMax: number;
}

type Wrap = (inp: InputState, sim: GameSim) => InputState;

async function play(pilot: Autopilot, opts: { firstAttempt?: boolean; flightAssist?: boolean; maxTime?: number } = {}): Promise<Run> {
  const sim = await createSim(LEVEL_3, { firstAttempt: opts.firstAttempt ?? false, flightAssist: opts.flightAssist ?? false });
  const main = new TrackTracker([G.deck, G.crescent]);
  const r: Run = {
    phase: '',
    crash: null,
    crashY: NaN,
    final: null,
    releaseSpeed: 0,
    releasedAt: NaN,
    maxProgress: 0,
    result: null,
    events: [],
    minPromptScale: 1,
    promptIds: new Set(),
    climbImpactMax: 0,
  };
  let prevVacuum = false;
  runAutopilot(sim, pilot, {
    maxTime: opts.maxTime ?? 45,
    stopOnCrash: true,
    onTick: (s, input, events) => {
      const v = s.snapshot.vehicle;
      for (const e of events) {
        r.events.push(e);
        if (e.type === 'landing') r.final = e.result;
        if (e.type === 'crash') {
          r.crash = e.reason;
          r.crashY = e.position.y;
        }
      }
      {
        const p = main.update(v.position).s;
        r.maxProgress = Math.max(r.maxProgress, p);
        if (p > DECK_LEN && p < DECK_LEN + G.invertedStart)
          for (const e of events) if (e.type === 'impact') r.climbImpactMax = Math.max(r.climbImpactMax, e.strength);
        if (prevVacuum && !input.vacuum && Number.isNaN(r.releasedAt)) {
          r.releasedAt = DECK_LEN + G.crescentLength - p;
          r.releaseSpeed = v.speed;
        }
      }
      prevVacuum = input.vacuum;
      if (s.snapshot.prompt) {
        r.promptIds.add(s.snapshot.prompt.id);
        r.minPromptScale = Math.min(r.minPromptScale, s.snapshot.timeScale);
      }
    },
  });
  r.phase = sim.snapshot.phase;
  r.result = sim.snapshot.result;
  sim.dispose();
  return r;
}

/** Same as play() but every input goes through `wrap` (keyboard emulation, hesitant player...). */
async function playWrapped(pilot: Autopilot, wrap: Wrap, opts: { firstAttempt?: boolean; maxTime?: number } = {}): Promise<Run> {
  const wrapped = {
    next: (snap: Parameters<Autopilot['next']>[0], evs: readonly GameEvent[]) => pilot.next(snap, evs),
  };
  // drive manually so the wrapper sees the sim
  const sim = await createSim(LEVEL_3, { firstAttempt: opts.firstAttempt ?? false, flightAssist: false });
  const r: Run = {
    phase: '',
    crash: null,
    crashY: NaN,
    final: null,
    releaseSpeed: 0,
    releasedAt: NaN,
    maxProgress: 0,
    result: null,
    events: [],
    minPromptScale: 1,
    promptIds: new Set(),
    climbImpactMax: 0,
  };
  let recent: GameEvent[] = sim.drainEvents();
  let prevVacuum = false;
  for (let i = 0; i < 120 * (opts.maxTime ?? 45); i++) {
    const input = wrap({ ...wrapped.next(sim.snapshot, recent) }, sim);
    if (prevVacuum && !input.vacuum && r.releaseSpeed === 0 && sim.snapshot.vehicle.up.y < -0.5) r.releaseSpeed = sim.snapshot.vehicle.speed;
    prevVacuum = input.vacuum;
    sim.step(input);
    recent = sim.drainEvents();
    for (const e of recent) {
      r.events.push(e);
      if (e.type === 'landing') r.final = e.result;
      if (e.type === 'crash') r.crash = e.reason;
    }
    if (sim.snapshot.prompt) {
      r.promptIds.add(sim.snapshot.prompt.id);
      r.minPromptScale = Math.min(r.minPromptScale, sim.snapshot.timeScale);
    }
    if (sim.snapshot.phase === 'complete' || sim.snapshot.phase === 'crashed') break;
  }
  r.phase = sim.snapshot.phase;
  r.result = sim.snapshot.result;
  sim.dispose();
  return r;
}

const pilot = (o: L3PilotOptions = {}) => createL3Pilot(G, o);
const q = (r: Run) => (r.phase === 'complete' ? (r.final?.quality ?? '?') : `✗ ${r.crash ?? r.phase}`);
const fmtRun = (r: Run) =>
  `${q(r).padEnd(16)} rel ${r.releaseSpeed.toFixed(1)} m/s` +
  (r.final ? ` | land ${r.final.angleDeg.toFixed(0)}° ${r.final.impactSpeed.toFixed(1)} m/s air ${r.final.airTime.toFixed(2)} s` : '') +
  (r.result ? ` | ${r.result.score} ${r.result.medal}` : '');

/** Seeded PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Keyboard emulation: throttle / steer / roll quantized to −1/0/+1 by sigma-delta PWM with a 0.1 s
 * minimum hold; boolean edges (boost, vacuum, stabilize) delayed by a random 0..0.3 s. Paired with
 * pilot decisions moved 0.15 s earlier, discrete actions land within ±0.15 s of the nominal timing.
 */
function keyboard(seed: number, minHold = 0.1, jitter = 0.15): Wrap {
  const rand = rng(seed);
  const axes = ['throttle', 'steer', 'roll'] as const;
  const bools = ['boost', 'vacuum', 'stabilize'] as const;
  const acc = { throttle: 0, steer: 0, roll: 0 };
  const out = { throttle: 0, steer: 0, roll: 0 };
  const next = { throttle: 0, steer: 0, roll: 0 };
  const cur = { boost: false, vacuum: false, stabilize: false };
  const pend: Record<string, { v: boolean; at: number } | null> = { boost: null, vacuum: null, stabilize: null };
  let last = -1;
  return (inp, sim) => {
    const t = sim.snapshot.time;
    const dt = last < 0 ? 1 / 120 : t - last;
    last = t;
    const res = { ...inp };
    for (const a of axes) {
      acc[a] += (inp[a] - out[a]) * dt;
      if (t >= next[a]) {
        const want = Math.max(-1, Math.min(1, Math.round(inp[a] + acc[a] / minHold)));
        if (want !== out[a]) {
          out[a] = want;
          next[a] = t + minHold;
        }
      }
      res[a] = out[a];
    }
    for (const b of bools) {
      if (inp[b] !== cur[b]) {
        if (!pend[b] || pend[b]!.v !== inp[b]) pend[b] = { v: inp[b], at: t + rand() * 2 * jitter };
        if (t >= pend[b]!.at) {
          cur[b] = inp[b];
          pend[b] = null;
        }
      } else pend[b] = null;
      res[b] = cur[b];
    }
    return res;
  };
}

/** Contiguous window [lo, hi] of sweep values whose runs pass `ok` (values sorted ascending). */
function window(values: number[], runs: Run[], ok: (r: Run) => boolean): [number, number] | null {
  let best: [number, number] | null = null;
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    const pass = i < values.length && ok(runs[i]);
    if (pass && start < 0) start = i;
    if (!pass && start >= 0) {
      const w: [number, number] = [values[start], values[i - 1]];
      if (!best || w[1] - w[0] > best[1] - best[0]) best = w;
      start = -1;
    }
  }
  return best;
}

const report: string[] = [];
const log = (s: string) => {
  report.push(s);
  console.log(s);
};

describe('Level 3 — The Inverted Ramp', () => {
  it('level definition is coherent (pieces, zones, objectives, kill plane above the cloud sea)', async () => {
    await initPhysics();
    expect(LEVEL_3.id).toBe(3);
    expect(LEVEL_3.theme).toBe('night');
    expect(LEVEL_3.vacuumEnabled).toBe(true);
    expect(LEVEL_3.objectives.map((o) => o.id)).toEqual(['l3-run', 'l3-vacuum', 'l3-inverted', 'l3-release', 'l3-land']);
    for (const o of LEVEL_3.objectives) {
      expect(o.title).toBe(o.title.toUpperCase());
      for (const h of o.hints) expect(h.actions?.length).toBeGreaterThan(0);
    }
    // crescent ≈ 86 m, beam 80–140 m, release zone visible and on the beam's end
    expect(G.crescentHeight).toBeGreaterThanOrEqual(80);
    expect(G.beamLength).toBeGreaterThanOrEqual(80);
    expect(G.beamLength).toBeLessThanOrEqual(140);
    const release = LEVEL_3.zones.find((z) => z.id === L3_IDS.release)!;
    expect(release.purpose).toBe('trigger');
    expect(release.visible).toBe(true);
    expect(release.label).toBe('RELEASE');
    // kill plane well above the night cloud sea, below every drivable surface
    const cloudTop = THEMES.night.clouds.seaTop;
    expect(LEVEL_3.killY).toBeGreaterThan(cloudTop + 100);
    const lowest = Math.min(...[G.runway, G.deck, G.crescent, G.hill].flat().map((f) => f.position.y), G.arena.topY);
    expect(LEVEL_3.killY).toBeLessThan(lowest - 30);
    // the decor-free physics world builds quickly
    const t0 = performance.now();
    const sim = new GameSim(LEVEL_3, { firstAttempt: false });
    const buildMs = performance.now() - t0;
    sim.dispose();
    log(`[L3] physics world build ${buildMs.toFixed(1)} ms`);
    expect(buildMs).toBeLessThan(250);
  });

  it('(a) reference pilot completes deterministically: objectives in order, PERFECT release landing, gold', async () => {
    const a = await play(level3Pilot());
    const b = await play(level3Pilot());
    log(`[L3] reference: ${fmtRun(a)} | time ${a.result?.time.toFixed(2)} s`);
    expect(a.phase).toBe('complete');
    expect(ofType(a.events, 'objectiveComplete').map((e) => e.id)).toEqual(['l3-run', 'l3-vacuum', 'l3-inverted', 'l3-release', 'l3-land']);
    expect(a.final?.quality).toBe('perfect');
    expect(a.final?.tricks.some((t) => t.kind === 'inverted')).toBe(true);
    expect(a.result!.stats.invertedDistance).toBeGreaterThan(G.beamLength * 0.75);
    expect(a.result!.medal).toBe('gold');
    expect(a.climbImpactMax).toBeLessThan(0.3); // full throttle up the crescent: faint grazes at most
    // deterministic
    expect(b.result!.score).toBe(a.result!.score);
    expect(b.result!.time).toBe(a.result!.time);
  });

  it('(a) completes with the game defaults too (flight assist on, first attempt with bullet-time prompts)', async () => {
    const r = await play(level3Pilot(), { flightAssist: true, firstAttempt: true });
    log(`[L3] reference, flight assist + first attempt: ${fmtRun(r)}`);
    expect(r.phase).toBe('complete');
    expect(r.final?.quality).toMatch(/perfect|clean/);
  });

  it('(a) the ?autopilot=1 path: asFunction() (snapshot only) completes and survives a reset', async () => {
    const sim = await createSim(LEVEL_3);
    const fn = level3Pilot().asFunction();
    for (let i = 0; i < 120 * 40 && sim.snapshot.phase !== 'complete'; i++) {
      sim.step(fn(sim.snapshot));
      sim.drainEvents();
    }
    expect(sim.snapshot.phase).toBe('complete');
    sim.reset();
    for (let i = 0; i < 120 * 40 && sim.snapshot.phase !== 'complete'; i++) sim.step(fn(sim.snapshot));
    expect(sim.snapshot.phase).toBe('complete');
    sim.dispose();
  });

  it('(b) keyboard-like input completes (quantized axes, 0.1 s min hold, ±0.15 s jitter)', async () => {
    const runs: string[] = [];
    let complete = 0;
    let atLeastClean = 0;
    const variants: [string, L3PilotOptions][] = [
      ['W held', {}],
      ['W held, Q/E roll', { recovery: 'roll' }],
      ['beam 36 m/s', { beamSpeed: 36 }],
    ];
    for (const [label, o] of variants) {
      for (let seed = 1; seed <= 4; seed++) {
        const speed = o.beamSpeed === undefined ? 48 : (o.beamSpeed as number);
        // decisions 0.15 s early + random 0..0.3 s key latency ⇒ ±0.15 s around the nominal release
        const r = await playWrapped(pilot({ ...o, releaseBefore: G.params.releaseMargin + G.params.releaseLength / 2 + 0.15 * speed }), keyboard(seed * 7 + label.length));
        runs.push(`${label} #${seed}: ${fmtRun(r)}`);
        if (r.phase === 'complete') complete++;
        if (r.phase === 'complete' && r.final && r.final.quality !== 'hard') atLeastClean++;
      }
    }
    log(`[L3] keyboard variant:\n  ${runs.join('\n  ')}`);
    expect(complete).toBe(12);
    expect(atLeastClean).toBeGreaterThanOrEqual(10);
  });

  it('(c) road speed sweep — holding W the whole time works; so does a slow road speed (the crescent is climbed on the vacuum)', async () => {
    const speeds = [14, 18, 22, 26, 30, 38, 75]; // 75 = W held (full throttle)
    const runs: Run[] = [];
    for (const s of speeds) runs.push(await play(pilot({ runSpeed: s === 75 ? 'hold' : s })));
    log(`[L3] road speed sweep:\n  ${speeds.map((s, i) => `${s === 75 ? 'W held' : `${s} m/s`}: ${fmtRun(runs[i])}`).join('\n  ')}`);
    const w = window(speeds, runs, (r) => r.phase === 'complete');
    log(`[L3] road speed window (target speed): ${w?.[0]}..${w?.[1] === 75 ? 'W held' : w?.[1]}`);
    expect(runs[runs.length - 1].phase).toBe('complete'); // W held
    expect(w![1]).toBe(75);
    expect(w![0]).toBeLessThanOrEqual(26);
  });

  it('(c) thrust adjusts the release flight', async () => {
    const lines: string[] = [];
    // release flight: thrust after the car has flipped upright pushes it along the slope (softer)
    const grid: string[] = [];
    let ok = 0;
    for (const st of [0.2, 0.6, 1.0])
      for (const d of [0.3, 0.6, 1.0]) {
        const r = await play(pilot({ thrust: { start: st, duration: d } }));
        grid.push(`${st}+${d}s ${q(r)}`);
        if (r.phase === 'complete') ok++;
        if (st >= 0.6) expect(r.phase).toBe('complete');
      }
    lines.push(`release-flight thrust (start+duration): ${grid.join(', ')}`);
    log(`[L3] thrust:\n  ${lines.join('\n  ')}`);
    expect(ok).toBeGreaterThanOrEqual(7);
  });

  it('(c) climb and beam speed sweeps — the crescent works from 16 m/s to full throttle', async () => {
    const climb = [16, 24, 32, 40, 75];
    const beam = [24, 28, 32, 40, 75];
    const cr: Run[] = [];
    const br: Run[] = [];
    for (const s of climb) cr.push(await play(pilot({ climbSpeed: s === 75 ? 'hold' : s })));
    for (const s of beam) br.push(await play(pilot({ beamSpeed: s === 75 ? 'hold' : s })));
    log(`[L3] climb speed: ${climb.map((s, i) => `${s === 75 ? 'W' : s}:${q(cr[i])}`).join(' ')}`);
    log(`[L3] beam speed (release speed): ${beam.map((s, i) => `${s === 75 ? 'W' : s}(${br[i].releaseSpeed.toFixed(0)}):${q(br[i])}`).join(' ')}`);
    for (const r of [...cr, ...br]) expect(r.phase).toBe('complete');
    for (const r of br.slice(2)) expect(r.final?.quality).toMatch(/perfect|clean/); // ≥ 32 m/s on the beam
  });

  it('(c) ENTER timing — holding it from the spawn, or pressing anywhere up to 10 m into the quarter pipe, works', async () => {
    const leads = [-10, -5, 0, 5, 20, 60, 110, 1000];
    const runs: Run[] = [];
    for (const l of leads) runs.push(await play(pilot({ vacuumLead: l })));
    log(`[L3] vacuum lead (m before the pipe, 1000 = held from the spawn): ${leads.map((l, i) => `${l}:${q(runs[i])}`).join(' ')}`);
    for (const r of runs) expect(r.phase).toBe('complete');
    // ≥ 120 m of slack at ≈ 48 m/s ⇒ a window of ≈ 2.5 s, far above the 0.4 s minimum
  });

  it('(c) release timing — anywhere inside the RELEASE zone works (window ≥ 0.4 s), early/late releases degrade gracefully', async () => {
    const zone0 = G.params.releaseMargin; // zone end, m before the beam end
    const zone1 = zone0 + G.params.releaseLength; // zone start
    const at = [-5, 0, zone0, 7, 12, 17, 22, zone1, 32, 40, 46, 60];
    const runs: Run[] = [];
    for (const a of at) runs.push(await play(pilot({ releaseBefore: a })));
    log(`[L3] release position (m before the beam end, zone ${zone0}..${zone1}), W held:\n  ${at.map((a, i) => `${a}: ${fmtRun(runs[i])}`).join('\n  ')}`);
    const done = window(at, runs, (r) => r.phase === 'complete');
    const clean = window(at, runs, (r) => r.phase === 'complete' && r.final?.quality !== 'hard');
    const v = runs[at.indexOf(17)].releaseSpeed;
    log(`[L3] release windows @ ${v.toFixed(1)} m/s: complete ${done?.[0]}..${done?.[1]} m (${(((done![1] - done![0]) / v)).toFixed(2)} s), ≥ CLEAN ${clean?.[0]}..${clean?.[1]} m (${(((clean![1] - clean![0]) / v)).toFixed(2)} s)`);
    for (let i = 0; i < at.length; i++) if (at[i] >= zone0 && at[i] <= zone1) expect(runs[i].phase).toBe('complete');
    expect(clean![0]).toBeLessThanOrEqual(zone0);
    expect(clean![1]).toBeGreaterThanOrEqual(zone1);
    expect((clean![1] - clean![0]) / v).toBeGreaterThan(0.4);
    // slower beam: still completes across the zone
    const slow: Run[] = [];
    for (const a of [zone0, 10, 18, zone1]) slow.push(await play(pilot({ releaseBefore: a, beamSpeed: 32 })));
    log(`[L3] release at 32 m/s: ${slow.map((r) => q(r)).join(' / ')}`);
    for (const r of slow) expect(r.phase).toBe('complete');
  });

  it('(c) recovery — SHIFT or Q/E roll both land, even with a 0.6 s reaction time; flight assist alone does not', async () => {
    const cases: [string, L3PilotOptions, boolean?][] = [
      ['SHIFT', {}],
      ['SHIFT after 0.3 s', { recoveryDelay: 0.3 }],
      ['SHIFT after 0.6 s', { recoveryDelay: 0.6 }],
      ['Q/E roll', { recovery: 'roll' }],
      ['Q/E roll after 0.3 s', { recovery: 'roll', recoveryDelay: 0.3 }],
      ['SHIFT, beam 36 m/s', { beamSpeed: 36 }],
      ['Q/E roll, beam 36 m/s', { recovery: 'roll', beamSpeed: 36 }],
    ];
    const lines: string[] = [];
    for (const [label, o] of cases) {
      const r = await play(pilot(o));
      lines.push(`${label}: ${fmtRun(r)}`);
      expect(r.phase).toBe('complete');
    }
    const assist = await play(pilot({ recovery: 'assist' }), { flightAssist: true });
    lines.push(`no input (flight assist only): ${fmtRun(assist)}`);
    log(`[L3] recovery:\n  ${lines.join('\n  ')}`);
    expect(assist.phase).toBe('crashed');
  });

  it('(d) failures behave sensibly', async () => {
    const lines: string[] = [];
    // no vacuum: the car cannot stay on the wall (never reaches the beam) and crashes
    const noVac = await play(pilot({ vacuumLead: -10_000 }));
    lines.push(`no vacuum: ${fmtRun(noVac)}`);
    expect(noVac.phase).toBe('crashed');
    expect(ofType(noVac.events, 'vacuumEngaged').length).toBe(0);
    expect(ofType(noVac.events, 'trick').some((e) => e.trick.kind === 'inverted')).toBe(false);
    // letting go of ENTER on the vertical wall
    const wall = await play(pilot({ releaseBefore: G.crescentLength - G.params.pipeRadius * (Math.PI / 2) - 2 }));
    lines.push(`release on the wall: ${fmtRun(wall)}`);
    expect(wall.phase).toBe('crashed');
    // releasing over the arena, far before the zone
    const early = await play(pilot({ releaseBefore: 75 }));
    lines.push(`release 75 m early: ${fmtRun(early)}`);
    expect(early.phase).toBe('crashed');
    // no reorientation: lands upside down
    const inverted = await play(pilot({ recovery: 'none' }));
    lines.push(`no recovery: ${fmtRun(inverted)}`);
    expect(inverted.phase).toBe('crashed');
    expect(['roof', 'rollover', 'hard-impact', 'impact']).toContain(inverted.crash);
    // steering off the inverted beam
    const offBeam = await playWrapped(pilot(), (inp, sim) => {
      const v = sim.snapshot.vehicle;
      return v.up.y < -0.8 && v.groundedWheels > 0 ? { ...inp, steer: 1 } : inp;
    });
    lines.push(`steering off the beam: ${fmtRun(offBeam)}`);
    expect(offBeam.crash).toBe('fell');
    // holding ENTER past the end of the beam is a mistake, but survivable
    const late = await play(pilot({ releaseBefore: -20 }));
    lines.push(`ENTER held past the beam end: ${fmtRun(late)}`);
    expect(late.phase).toBe('complete');
    log(`[L3] failures:\n  ${lines.join('\n  ')}`);
  });

  it('first attempt: bullet-time prompts for ENTER (if not held), RELEASE and the flip — not on later attempts', async () => {
    // a hesitant player: no ENTER until 1.2 s inside the prompt zone, no SHIFT for 0.4 s after the release
    let inPipeSince = -1;
    let releasedAt = -1;
    const hesitant: Wrap = (inp, sim) => {
      const s = sim.snapshot;
      const res = { ...inp };
      const inPipe = s.objective.id === 'l3-vacuum' && s.prompt?.id === 'l3-vacuum';
      if (inPipe && inPipeSince < 0) inPipeSince = s.time;
      if (s.objective.id === 'l3-vacuum' && (inPipeSince < 0 || s.time - inPipeSince < 1.2)) res.vacuum = false;
      if (s.objective.id === 'l3-land' && releasedAt < 0) releasedAt = s.time;
      if (releasedAt >= 0 && s.time - releasedAt < 0.4) res.stabilize = false;
      return res;
    };
    const first = await playWrapped(pilot({ vacuumLead: 0 }), hesitant, { firstAttempt: true });
    log(`[L3] first attempt (hesitant): ${fmtRun(first)} prompts ${[...first.promptIds].join(', ')} min prompt time scale ${first.minPromptScale}`);
    expect(first.phase).toBe('complete');
    expect(first.promptIds).toEqual(new Set(['l3-vacuum', 'l3-release', 'l3-land']));
    expect(first.minPromptScale).toBe(0.5);
    // later attempts: same prompts, no slow motion
    inPipeSince = -1;
    releasedAt = -1;
    const again = await playWrapped(pilot({ vacuumLead: 0 }), hesitant, { firstAttempt: false });
    expect(again.phase).toBe('complete');
    expect(again.minPromptScale).toBe(1);
  });

  it('medals: completion → bronze, clean typical run → silver, PERFECT → gold', async () => {
    const hard = await play(pilot({ beamSpeed: 24 }));
    const clean = await play(pilot({ beamSpeed: 36 }));
    const slowClean = await play(pilot({ climbSpeed: 16, beamSpeed: 40 }));
    const perfect = await play(pilot());
    const m = LEVEL_3.medals;
    log(
      `[L3] medals ${m.bronze}/${m.silver}/${m.gold}: hard ${hard.result?.score} ${hard.result?.medal} (${q(hard)}), clean ${clean.result?.score} ${clean.result?.medal}, slow clean ${slowClean.result?.score} ${slowClean.result?.medal}, perfect ${perfect.result?.score} ${perfect.result?.medal}`,
    );
    expect(hard.result?.medal).toBe('bronze');
    expect(clean.result?.medal).toBe('silver');
    expect(slowClean.result?.medal).toBe('silver');
    expect(perfect.result?.medal).toBe('gold');
  });
});
