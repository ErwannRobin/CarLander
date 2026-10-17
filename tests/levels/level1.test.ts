/**
 * LEVEL 1 — LEARN TO FLY: headless proof that the level is completable, forgiving and teaches
 * through its objectives.
 *
 *  (a) the reference pilot completes (deterministic; also through asFunction(), the demo path)
 *  (b) keyboard-like variants (digital −1/0/+1 axes with ≥ 0.1 s holds, ±0.15 s jitter) complete
 *  (c) sweeps that mirror player variation: run-up speed (incl. W held all the way), burn start /
 *      duration, W released late, with / without stabilizer and flight assist → success windows
 *      (printed, and asserted to stay generous)
 *  (d) failure cases behave sensibly (no thrust → safe apron landing + retry advice, off the side →
 *      'fell' far above the cloud sea, upside down → crash, W held through the flight → no finish)
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { L1, LEVEL_1, level1Pilot, level1PilotWith } from '@/game/levels/level1';
import { L1_FLOW, L1_OBJECTIVE, L1_ZONE } from '@/game/levels/level1/flow';
import type { L1PilotOptions } from '@/game/levels/level1/pilot';
import { Autopilot, runAutopilot, type RunReport } from '@/game/sim/autopilot';
import { ZoneTester } from '@/game/track/zones';
import { NEUTRAL_INPUT, type GameEvent, type InputState, type LandingResult, type SimSnapshot } from '@/game/types';
import { createSim, DT, ofType } from '../physics/helpers';

/** Morning theme cloud-sea top (src/render/env/themes.ts). */
const CLOUD_SEA_TOP = -165;
const target = new ZoneTester(LEVEL_1.zones.find((z) => z.id === L1_ZONE.target)!);
const lipZ = L1.lip.position.z;
const distFromLip = (p: Vector3) => lipZ - p.z;

interface Outcome {
  report: RunReport;
  complete: boolean;
  landing: LandingResult | null;
  crash: Extract<GameEvent, { type: 'crash' }> | null;
  score: number;
  medal: string;
  prompts: string[];
}

function outcome(sim: Awaited<ReturnType<typeof createSim>>, report: RunReport): Outcome {
  const landing = ofType(report.events, 'landing')[0]?.result ?? null;
  const crash = ofType(report.events, 'crash')[0] ?? null;
  const prompts = ofType(report.events, 'prompt').flatMap((e) => (e.prompt ? [e.prompt.text] : []));
  return {
    report,
    complete: sim.snapshot.phase === 'complete',
    landing,
    crash,
    score: sim.snapshot.result?.score ?? 0,
    medal: sim.snapshot.result?.medal ?? 'none',
    prompts,
  };
}

/** One run with a pilot (game defaults: flight assist on). */
async function fly(pilot: Autopilot, opts: { flightAssist?: boolean; firstAttempt?: boolean; maxTime?: number } = {}): Promise<Outcome> {
  const sim = await createSim(LEVEL_1, { flightAssist: opts.flightAssist ?? true, firstAttempt: opts.firstAttempt ?? false });
  const report = runAutopilot(sim, pilot, { maxTime: opts.maxTime ?? 24, stopOnCrash: true });
  const out = outcome(sim, report);
  sim.dispose();
  return out;
}

const describeLanding = (o: Outcome) =>
  o.landing
    ? `${o.landing.quality} ${o.landing.impactSpeed.toFixed(1)} m/s @${distFromLip(o.landing.position).toFixed(0)} m${o.landing.inTarget ? ' T' : ''}`
    : o.crash
      ? `crash:${o.crash.reason}`
      : 'no landing';

/* ------------------------------------------------------------------ */
/* Keyboard-like wrapper                                               */
/* ------------------------------------------------------------------ */

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
 * Wraps a pilot like a keyboard player: throttle / steer / roll become −1 / 0 / +1 key states
 * (sigma-delta PWM, every key state held ≥ 0.1 s), booleans keep their meaning but every press /
 * release lands 0–0.3 s late (±0.15 s jitter around a 0.15 s reaction time).
 */
function keyboardize(pilot: Autopilot, seed: number, minHold = 0.1): Autopilot {
  const rand = rng(seed);
  const axes = ['throttle', 'steer', 'roll'] as const;
  const bools = ['boost', 'stabilize', 'vacuum'] as const;
  const st = {
    run: -1,
    out: { ...NEUTRAL_INPUT } as InputState,
    axis: Object.fromEntries(axes.map((k) => [k, { state: 0, holdUntil: -1, err: 0 }])) as Record<(typeof axes)[number], { state: number; holdUntil: number; err: number }>,
    pending: Object.fromEntries(bools.map((k) => [k, { value: false, at: Infinity }])) as Record<(typeof bools)[number], { value: boolean; at: number }>,
  };
  const wrapped = new Autopilot([
    {
      name: 'keyboard',
      controllers: [
        (snap: SimSnapshot, ctx) => {
          if (ctx.runId !== st.run) {
            st.run = ctx.runId;
            pilot.reset();
          }
          const want = pilot.next(snap, ctx.events);
          const t = snap.time;
          for (const k of axes) {
            const a = st.axis[k];
            const target = Math.max(-1, Math.min(1, want[k]));
            if (t >= a.holdUntil) {
              const q = Math.max(-1, Math.min(1, Math.round(target + a.err)));
              if (q !== a.state) {
                a.state = q;
                a.holdUntil = t + minHold;
              }
            }
            a.err = Math.max(-1.5, Math.min(1.5, a.err + (target - a.state)));
            st.out[k] = a.state;
          }
          for (const k of bools) {
            const p = st.pending[k];
            if (want[k] !== st.out[k] && want[k] !== p.value) {
              p.value = want[k];
              p.at = t + rand() * 0.3;
            } else if (want[k] === st.out[k]) {
              p.value = st.out[k];
              p.at = Infinity;
            }
            if (t >= p.at) {
              st.out[k] = p.value;
              p.at = Infinity;
            }
          }
          return { ...st.out };
        },
      ],
    },
  ]);
  return wrapped;
}

/* ------------------------------------------------------------------ */
/* (a) reference                                                       */
/* ------------------------------------------------------------------ */

describe('LEVEL 1 — reference pilot', () => {
  it('completes in order with a CLEAN bullseye landing, deterministically', async () => {
    const a = await fly(level1Pilot());
    const b = await fly(level1Pilot());
    expect(a.complete).toBe(true);
    expect(ofType(a.report.events, 'objectiveComplete').map((e) => e.id)).toEqual([
      L1_OBJECTIVE.throttle,
      L1_OBJECTIVE.lineUp,
      L1_OBJECTIVE.thrust,
      L1_OBJECTIVE.slope,
      L1_OBJECTIVE.land,
    ]);
    const land = a.landing!;
    expect(['perfect', 'clean']).toContain(land.quality);
    expect(land.inTarget).toBe(true);
    expect(target.radial(land.position)).toBeLessThanOrEqual(0.25); // bullseye
    expect(land.tricks.some((t) => t.kind === 'bullseye')).toBe(true);
    expect(a.report.time).toBeLessThan(16);
    expect(['silver', 'gold']).toContain(a.medal);
    // deterministic
    expect(b.score).toBe(a.score);
    expect(b.report.ticks).toBe(a.report.ticks);
    expect(b.landing!.position.toArray()).toEqual(land.position.toArray());
    console.log(`[L1] reference: ${describeLanding(a)} · score ${a.score} (${a.medal}) · ${a.report.time.toFixed(1)} s`);
  });

  it('completes through asFunction() (the ?autopilot=1 demo path) and again after a reset', async () => {
    const sim = await createSim(LEVEL_1, { flightAssist: true, firstAttempt: true });
    const fn = level1Pilot().asFunction();
    for (let i = 0; i < 120 * 22 && sim.snapshot.phase !== 'complete'; i++) sim.step(fn(sim.snapshot));
    expect(sim.snapshot.phase).toBe('complete');
    sim.reset();
    sim.setOptions({ firstAttempt: false });
    for (let i = 0; i < 120 * 22 && sim.snapshot.phase !== 'complete'; i++) sim.step(fn(sim.snapshot));
    expect(sim.snapshot.phase).toBe('complete');
    sim.dispose();
  });

  it('first attempt: bullet-time thrust prompt right after the lip until SPACE, none on later attempts', async () => {
    const sim = await createSim(LEVEL_1, { flightAssist: true, firstAttempt: true });
    const pilot = level1PilotWith({ burnDelay: 0.6 }); // a hesitant player
    let recent: GameEvent[] = [];
    const scales: number[] = [];
    let shownAtTakeoff = false;
    for (let i = 0; i < 120 * 22 && sim.snapshot.phase !== 'complete'; i++) {
      const inp = pilot.next(sim.snapshot, recent);
      sim.step(inp);
      recent = sim.drainEvents();
      const p = sim.snapshot.prompt;
      if (p?.id === L1_OBJECTIVE.thrust) {
        scales.push(sim.snapshot.timeScale);
        if (sim.snapshot.vehicle.airborne && sim.snapshot.air.airTime < 0.2) shownAtTakeoff = true;
        expect(p.text).toBe('HOLD SPACE — FIRE THRUSTERS');
        expect(p.hint?.actions).toEqual(['boost']);
      }
    }
    expect(shownAtTakeoff).toBe(true);
    expect(scales.length).toBeGreaterThan(30);
    expect(scales.every((s) => s === L1_FLOW.slowMo.thrust)).toBe(true);
    expect(sim.snapshot.phase).toBe('complete');
    sim.dispose();

    const again = await createSim(LEVEL_1, { flightAssist: true, firstAttempt: false });
    let minScale = 1;
    runAutopilot(again, level1PilotWith({ burnDelay: 0.6 }), {
      maxTime: 24,
      onTick: (s) => {
        if (s.snapshot.prompt) minScale = Math.min(minScale, s.snapshot.timeScale);
      },
    });
    expect(minScale).toBe(1);
    again.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* (b) keyboard-like                                                   */
/* ------------------------------------------------------------------ */

describe('LEVEL 1 — teaching the throttle release', () => {
  it('on the kicker: "LET GO AT THE LIP"; in the air with W still held: release + thrust prompt in bullet time', async () => {
    const sim = await createSim(LEVEL_1, { flightAssist: true, firstAttempt: true });
    const pilot = level1PilotWith({ holdW: 0.12, burnDelay: 0.2 }); // forgets to let go at first
    let recent: GameEvent[] = [];
    let kickerPrompt = false;
    const airTexts = new Set<string>();
    let releaseScale = 1;
    for (let i = 0; i < 120 * 24 && sim.snapshot.phase === 'running' || i === 0; i++) {
      sim.step(pilot.next(sim.snapshot, recent));
      recent = sim.drainEvents();
      const p = sim.snapshot.prompt;
      if (p?.id === L1_OBJECTIVE.lineUp && p.text === 'LET GO AT THE LIP') kickerPrompt = true;
      if (p?.id === L1_OBJECTIVE.thrust && sim.snapshot.vehicle.airborne) {
        airTexts.add(p.text);
        if (p.text.startsWith('LET GO OF THE THROTTLE')) releaseScale = Math.min(releaseScale, sim.snapshot.timeScale);
      }
    }
    expect(kickerPrompt).toBe(true);
    expect([...airTexts]).toContain('LET GO OF THE THROTTLE · HOLD SPACE');
    expect(releaseScale).toBe(L1_FLOW.slowMo.thrust);
    sim.dispose();
  });
});

describe('LEVEL 1 — keyboard-like player', () => {
  it('digital keys with ≥ 0.1 s holds and ±0.15 s timing jitter still finish (12 seeds)', async () => {
    const lines: string[] = [];
    let ok = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const o = await fly(keyboardize(level1Pilot(), seed));
      if (o.complete) ok++;
      lines.push(`seed ${seed} → ${o.complete ? 'complete' : 'FAIL'} ${describeLanding(o)} ${o.score}`);
    }
    console.log('[L1] keyboard variants\n  ' + lines.join('\n  '));
    expect(ok).toBe(12);
  });
});

/* ------------------------------------------------------------------ */
/* (c) sweeps                                                          */
/* ------------------------------------------------------------------ */

/** Longest contiguous run of `true` (in parameter units) in a sampled sweep. */
function successWindow(xs: number[], ok: boolean[]): { from: number; to: number; width: number } {
  let best = { from: NaN, to: NaN, width: 0 };
  let start = -1;
  for (let i = 0; i <= xs.length; i++) {
    if (i < xs.length && ok[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const w = xs[i - 1] - xs[start];
      if (w >= best.width) best = { from: xs[start], to: xs[i - 1], width: w };
      start = -1;
    }
  }
  return best;
}

describe('LEVEL 1 — player variation sweeps', () => {
  it('run-up speed: holding W all the way works; burns are forgiving from ≈ 50 m/s at the lip', async () => {
    const speeds = [46, 48, 50, 52, 54, 90];
    const rows: string[] = [];
    const ok: boolean[] = [];
    for (const speed of speeds) {
      const o = await fly(level1PilotWith({ speed }));
      ok.push(o.complete);
      rows.push(`${speed === 90 ? 'W held' : `${speed} m/s`} → ${o.complete ? 'complete' : 'miss'} ${describeLanding(o)}`);
      if (speed === 90) {
        expect(o.complete).toBe(true); // simply holding W the whole run-up
        expect(o.report.events.some((e) => e.type === 'takeoff' && e.speed > 53)).toBe(true);
      }
    }
    // with the whole tank, slower run-ups still reach the rings
    const tankRows: string[] = [];
    const tankOk: boolean[] = [];
    for (const speed of speeds) {
      const o = await fly(level1PilotWith({ speed, burnDuration: 2 }));
      tankOk.push(o.complete);
      tankRows.push(`${speed === 90 ? 'W held' : `${speed} m/s`} → ${o.complete ? 'complete' : 'miss'} ${describeLanding(o)}`);
    }
    console.log('[L1] run-up target speed, reference burn\n  ' + rows.join('\n  ') + '\n[L1] run-up target speed, whole tank\n  ' + tankRows.join('\n  '));
    expect(ok.slice(-3).every(Boolean)).toBe(true); // 52 m/s .. W held
    expect(tankOk.slice(-4).every(Boolean)).toBe(true); // 50 m/s .. W held
  });

  it('burn start × duration: wide success windows after the lip (stabilizer after the burn)', async () => {
    const delays = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2];
    const durs = [0.2, 0.3, 0.4, 0.5, 0.6, 0.75];
    const grid: string[] = [];
    const okByDur = new Map<number, boolean[]>();
    for (const d of durs) okByDur.set(d, []);
    for (const burnDelay of delays) {
      const cells: string[] = [];
      for (const burnDuration of durs) {
        const o = await fly(level1PilotWith({ burnDelay, burnDuration, matchSlope: false }));
        okByDur.get(burnDuration)!.push(o.complete);
        const l = o.landing;
        cells.push((o.complete ? (l?.quality === 'perfect' ? 'P' : l?.quality === 'clean' ? 'C' : 'h') : '·') + (l ? distFromLip(l.position).toFixed(0).padStart(4) : '   -'));
      }
      grid.push(`start ${burnDelay.toFixed(1)} s | ` + cells.join('  '));
    }
    const windows = durs.map((d) => ({ d, w: successWindow(delays, okByDur.get(d)!) }));
    console.log(
      '[L1] burn start (rows) × duration (cols ' + durs.join(' / ') + ' s); P/C/h = finished PERFECT/CLEAN/HARD, · = missed; number = distance from the lip (m)\n  ' +
        grid.join('\n  ') +
        '\n  start windows: ' +
        windows.map(({ d, w }) => `${d}s → [${w.from}, ${w.to}] (${w.width.toFixed(1)} s)`).join(' · '),
    );
    // ≥ 0.4 s burns work from the lip up to ≥ 0.6 s later; the whole tank up to 1.2 s later
    for (const d of [0.4, 0.5, 0.6]) expect(windows.find((x) => x.d === d)!.w.width).toBeGreaterThanOrEqual(0.6);
    expect(windows.find((x) => x.d === 0.75)!.w.width).toBeGreaterThanOrEqual(1.0);
    // a burn started at the lip works from 0.3 s up to the whole tank
    const atLip = durs.map((d) => okByDur.get(d)![0]);
    expect(successWindow(durs, atLip).width).toBeGreaterThanOrEqual(0.4);
  });

  it('stabilizer, flight assist and late W release', async () => {
    const rows: string[] = [];
    const cases: [string, L1PilotOptions, boolean][] = [
      ['stabilizer after the burn', { stabilize: 'after' }, true],
      ['stabilizer the whole flight', { stabilize: 'always' }, true],
      ['no stabilizer, no pitch', { stabilize: 'none', matchSlope: false }, true],
      ['no stabilizer, flight assist off', { stabilize: 'none', matchSlope: false }, false],
      ['W/S pitch only, flight assist off', { stabilize: 'none', matchSlope: true }, false],
    ];
    for (const [name, opts, assist] of cases) {
      const o = await fly(level1PilotWith(opts), { flightAssist: assist });
      rows.push(`${name}${assist ? '' : ' (assist off)'} → ${o.complete ? 'complete' : 'miss'} ${describeLanding(o)} ang ${o.landing?.angleDeg.toFixed(1)}°`);
      expect(o.complete).toBe(true);
    }
    // W kept down after the lip pitches the nose into the deck: tolerated briefly
    const holds = [0, 0.05, 0.1, 0.15, 0.2, 0.3];
    const holdOk: boolean[] = [];
    for (const holdW of holds) {
      const o = await fly(level1PilotWith({ holdW }));
      holdOk.push(o.complete);
      rows.push(`W held ${holdW.toFixed(2)} s into the air → ${o.complete ? 'complete' : 'miss'} ${describeLanding(o)}${o.prompts.length ? ` · "${o.prompts[o.prompts.length - 1]}"` : ''}`);
    }
    console.log('[L1] stabilizer / assist / W release\n  ' + rows.join('\n  '));
    expect(holdOk[0] && holdOk[1] && holdOk[2]).toBe(true);
  });

  it('burning before the lip lands deep in the (long) rings: HARD at worst, still finishes', async () => {
    // 0.75 s of a 1 s tank (holding the whole tank from before the lip flies past the far end: a crash)
    const o = await fly(level1PilotWith({ burnDelay: -0.3, burnDuration: 0.75 }));
    expect(o.crash).toBeNull();
    expect(o.landing).not.toBeNull();
    expect(o.landing!.quality).not.toBe('crash');
    expect(o.landing!.inTarget).toBe(true); // a 0.75 s burn cannot carry the car past the far end
    expect(o.complete).toBe(true);
    console.log(`[L1] burn before the lip → ${describeLanding(o)}`);
  });
});

describe('LEVEL 1 — medals', () => {
  it('bronze ≈ any completion, silver ≈ a clean typical run, gold ≈ a skilled run', async () => {
    const m = LEVEL_1.medals;
    const cases: [string, L1PilotOptions, { flightAssist?: boolean }, string[]][] = [
      ['whole tank, no stabilizer, assist off (HARD)', { burnDuration: 2, stabilize: 'none', matchSlope: false }, { flightAssist: false }, ['bronze', 'silver']],
      ['short burn 0.4 s (CLEAN, off-centre)', { burnDuration: 0.4 }, {}, ['silver']],
      ['reference (CLEAN bullseye)', {}, {}, ['gold']],
      ['apex burn (PERFECT)', { burnDelay: 1.0, burnDuration: 0.75, matchSlope: false }, {}, ['gold']],
      ['burn + backflip + stabilizer', { flip: 'back' }, {}, ['gold']],
    ];
    const rows: string[] = [];
    for (const [name, opts, sim, expected] of cases) {
      const o = await fly(level1PilotWith(opts), sim);
      rows.push(`${name} → ${o.complete ? `${describeLanding(o)} · tricks ${o.landing?.tricks.map((t) => t.label).join(' + ') || '-'} · ${o.score} ${o.medal}` : 'not completed'}`);
      expect(o.complete).toBe(true);
      expect(expected).toContain(o.medal);
    }
    console.log(`[L1] medals (bronze ${m.bronze} / silver ${m.silver} / gold ${m.gold})\n  ` + rows.join('\n  '));
  });
});

/* ------------------------------------------------------------------ */
/* (d) failure cases                                                   */
/* ------------------------------------------------------------------ */

describe('LEVEL 1 — failure cases', () => {
  it('no thrust: lands safely on the apron, short of the rings, and the retry advice appears', async () => {
    const o = await fly(level1PilotWith({ burnDuration: 0, matchSlope: false, stabilize: 'none' }), { maxTime: 16 });
    expect(o.complete).toBe(false);
    const l = o.landing!;
    expect(l.quality).not.toBe('crash');
    expect(l.inTarget).toBe(false);
    const d = distFromLip(l.position);
    expect(d).toBeGreaterThan(L1.params.gap); // on the deck (the apron) …
    expect(l.position.z).toBeGreaterThan(L1.deck.at(L1.targetS.start).position.z); // … before the target
    expect(o.prompts).toContain('PRESS R — FIRE THRUSTERS AFTER THE LIP');
    expect(o.crash).toBeNull(); // within the first 16 s nothing else happens
    console.log(`[L1] no thrust → ${describeLanding(o)}`);
  });

  it('off the side of the runway: "fell" crash far above the cloud sea', async () => {
    expect(LEVEL_1.killY).toBeGreaterThan(CLOUD_SEA_TOP + 60);
    expect(LEVEL_1.killY).toBeLessThan(L1.deck.end().position.y - 10);
    const pilot = new Autopilot([
      { name: 'swerve', input: { throttle: 1, steer: 1 }, until: 6 },
      { name: 'fall', input: {} },
    ]);
    const o = await fly(pilot, { maxTime: 12 });
    expect(o.crash?.reason).toBe('fell');
    expect(o.crash!.position.y).toBeLessThan(LEVEL_1.killY + 1);
    expect(o.crash!.position.y).toBeGreaterThan(CLOUD_SEA_TOP + 60);
  });

  it('coasting stops safely on the runway; too slow at the lip falls into the gap ("fell")', async () => {
    const o = await fly(new Autopilot([{ name: 'coast', input: {} }]), { maxTime: 60 });
    // 18 m/s spawn, regen braking: the car stops on the runway — nothing happens, no crash
    expect(o.crash).toBeNull();
    const slow = await fly(level1PilotWith({ speed: 30, burnDuration: 0, stabilize: 'none', matchSlope: false }), { maxTime: 30 });
    expect(slow.crash?.reason).toBe('fell');
    expect(slow.complete).toBe(false);
  });

  it('touching down upside down on the deck is a crash', async () => {
    const sim = await createSim(LEVEL_1, { flightAssist: false });
    const f = L1.deck.at(L1.targetS.center);
    const q = f.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI));
    sim.placeVehicle(f.position.clone().addScaledVector(f.up, 4), q, f.forward.clone().multiplyScalar(30));
    sim.drainEvents();
    const events: GameEvent[] = [];
    for (let i = 0; i < 120 * 3; i++) {
      sim.step(NEUTRAL_INPUT);
      events.push(...sim.drainEvents());
      if (sim.snapshot.phase === 'crashed') break;
    }
    expect(sim.snapshot.phase).toBe('crashed');
    expect(['roof', 'rollover', 'hard-impact', 'impact']).toContain(ofType(events, 'crash')[0].reason);
    sim.dispose();
  });

  it('holding W through the whole flight never finishes', async () => {
    const o = await fly(level1PilotWith({ holdW: 10, stabilize: 'none', matchSlope: false }), { maxTime: 16 });
    expect(o.complete).toBe(false);
    console.log(`[L1] W held through the flight → ${describeLanding(o)}${o.crash ? '' : ` · "${o.prompts[o.prompts.length - 1] ?? ''}"`}`);
  });

  it('time step sanity: the level fits the fixed 120 Hz tick', () => {
    expect(DT).toBeCloseTo(1 / 120, 9);
  });
});
