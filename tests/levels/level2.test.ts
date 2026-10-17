/**
 * LEVEL 2 — CLEAR THE GAP: headless proofs.
 *
 *  (a) the reference pilot completes the level (deterministic, also through asFunction / reset)
 *  (b) keyboard-like variants complete (axes quantized to −1/0/+1 in 0.1 s PWM slots, ±0.15 s jitter
 *      on discrete actions: boost start/stop, flip start/release, SHIFT press, W carry-over)
 *  (c) sweeps mirroring player variation — run-up speed, ramp boost, air-thrust start × duration,
 *      W carry-over, kicker flip hold time, stabilizer on/off — success windows are logged
 *  (d) failure cases behave sensibly (no thrust, falling off, upside down, overshoot, slow run-up)
 *  plus first-attempt bullet-time prompts, the ring-gate bonus and the medal calibration.
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { LEVEL_2, L2_RING_BONUS, level2Pilot } from '@/game/levels/level2';
import { L2_COURSE as C } from '@/game/levels/level2/course';
import { createLevel2Pilot, type L2PilotOptions } from '@/game/levels/level2/pilot';
import { frameAt } from '@/game/track/TrackPath';
import { Autopilot, runAutopilot } from '@/game/sim/autopilot';
import type { GameSim } from '@/game/sim/GameSim';
import type { GameEvent, InputState, LandingResult, LevelResult } from '@/game/types';
import { createSim, ofType } from '../physics/helpers';

/** Canyon theme cloud-sea top (src/render/env/themes.ts). */
const CLOUD_SEA_TOP = -195;
const NO_TRICKS: L2PilotOptions = { k1Trick: 'none', k2Trick: 'none', bigTrick: 'none' };
/** Simple taught line: W all the way, SPACE up the big ramp, SHIFT in the air. */
const SIMPLE: L2PilotOptions = { ...NO_TRICKS };
/** Air-thrust line (the L1 habit): no ramp boost, SPACE after the lip. */
const AIR = (thrustDelay: number, thrustTime = 0.6): L2PilotOptions => ({ ...NO_TRICKS, groundBoost: 0, thrustDelay, thrustTime });

interface Outcome {
  complete: boolean;
  result: LevelResult | null;
  events: GameEvent[];
  landings: LandingResult[];
  big: LandingResult | null;
  crash: Extract<GameEvent, { type: 'crash' }> | null;
  ring: boolean;
}

function outcome(sim: GameSim, events: GameEvent[]): Outcome {
  const landings = ofType(events, 'landing').map((e) => e.result);
  return {
    complete: sim.snapshot.phase === 'complete',
    result: sim.snapshot.result,
    events,
    landings,
    big: landings.find((l) => l.position.z < C.zKnuckle + 6) ?? null,
    crash: ofType(events, 'crash')[0] ?? null,
    ring: events.some((e) => e.type === 'checkpoint' && e.id === 'l2-ring'),
  };
}

/** Full run from the spawn. */
async function play(pilot: Autopilot, opts: { flightAssist?: boolean; firstAttempt?: boolean; maxTime?: number } = {}): Promise<Outcome> {
  const sim = await createSim(LEVEL_2, { flightAssist: opts.flightAssist ?? true, firstAttempt: opts.firstAttempt ?? false });
  const rep = runAutopilot(sim, pilot, { maxTime: opts.maxTime ?? 50, stopOnCrash: true });
  const o = outcome(sim, rep.events);
  sim.dispose();
  return o;
}

/**
 * Big jump only: the car is placed on the boost straight at its natural speed (62 m/s), the pilot
 * starts at its 'straight' phase. The optional kicker objectives skip themselves on the straight,
 * so the level can still complete.
 */
async function playStraight(o: L2PilotOptions, flightAssist = true): Promise<Outcome> {
  const sim = await createSim(LEVEL_2, { flightAssist, firstAttempt: false });
  const f = frameAt(C.layout.backbone, C.layout.sBoostStart + 10);
  sim.placeVehicle(f.position.clone().addScaledVector(f.up, 0.48), f.quaternion.clone(), f.forward.clone().multiplyScalar(62.4), new Vector3());
  sim.drainEvents();
  const rep = runAutopilot(sim, createLevel2Pilot({ ...o, startPhase: 'straight' }), { maxTime: 25, stopOnCrash: true });
  const out = outcome(sim, rep.events);
  sim.dispose();
  return out;
}

const cell = (o: Outcome) =>
  o.complete
    ? `${o.big ? o.big.quality[0].toUpperCase() + o.big.impactSpeed.toFixed(0) : '?'}${o.big?.inTarget ? 'T' : ''}${o.ring ? 'r' : ''}`
    : `X(${o.crash?.reason ?? 'none'})`;

/* ------------------------------------------------------------------ */
/* Keyboard-like wrapper                                                */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Digital-keyboard version of a pilot: throttle / steer / roll become −1/0/+1 held for whole 0.1 s
 * slots (sigma-delta PWM, so steering still averages correctly; corrections below 20 % are ignored
 * like a player would), SHIFT presses are delayed by 0–0.15 s, other booleans pass through (their
 * jitter comes from the randomized pilot timings).
 */
function keyboardize(inner: Autopilot, rnd: () => number): Autopilot {
  const SLOT = 0.1;
  let slot = -1;
  let last = -1;
  const acc = { throttle: 0, steer: 0, roll: 0 };
  const out = { throttle: 0, steer: 0, roll: 0 };
  let shift = false;
  let shiftAt = Infinity;
  return new Autopilot([
    {
      name: 'keyboard',
      controllers: [
        (snap, ctx) => {
          if (snap.time < last) {
            slot = -1;
            acc.throttle = acc.steer = acc.roll = 0;
            shift = false;
            shiftAt = Infinity;
          }
          last = snap.time;
          const i: InputState = inner.next(snap, ctx.events);
          const k = Math.floor(snap.time / SLOT + 1e-9);
          if (k !== slot) {
            slot = k;
            for (const ax of ['throttle', 'steer', 'roll'] as const) {
              // like a player, ignore tiny steering corrections (no key tapping for a 1 m drift)
              const x = ax === 'steer' && Math.abs(i[ax]) < 0.2 ? 0 : i[ax];
              acc[ax] += x;
              const q = Math.max(-1, Math.min(1, Math.round(acc[ax])));
              out[ax] = q;
              acc[ax] = Math.max(-2, Math.min(2, acc[ax] - q));
            }
          }
          if (i.stabilize && !shift && shiftAt === Infinity) shiftAt = snap.time + rnd() * 0.15;
          if (!i.stabilize) {
            shift = false;
            shiftAt = Infinity;
          } else if (snap.time >= shiftAt) shift = true;
          return { ...i, throttle: out.throttle, steer: out.steer, roll: out.roll, stabilize: shift };
        },
      ],
    },
  ]);
}

/** Pilot options with ±0.15 s timing jitter on every discrete action (seeded). */
function jittered(base: L2PilotOptions, rnd: () => number): L2PilotOptions {
  const j = () => (rnd() * 2 - 1) * 0.15;
  return {
    ...base,
    preW: rnd() * 0.15, // W released up to 0.15 s after the car leaves a lip
    trickDelay: 0.15 + j(),
    releaseLeadDeg: (base.releaseLeadDeg ?? 100) + j() * 300, // ±0.15 s of rotation at ≈ 300°/s
    thrustDelay: Math.max(0, (base.thrustDelay ?? 0.25) + j()),
    thrustTime: base.thrustTime === 0 ? 0 : Math.max(0.2, (base.thrustTime ?? 0.6) + j()),
    groundBoostAt: (base.groundBoostAt ?? 10) + j() * 60, // ±0.15 s at ≈ 60 m/s
    groundBoost: base.groundBoost === 0 ? 0 : Math.max(0.35, (base.groundBoost ?? 0.6) + j()),
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

describe('Level 2 — CLEAR THE GAP', () => {
  it('geometry: catch shelf, kill plane and landing hill sit well above the cloud sea', () => {
    expect(LEVEL_2.id).toBe(2);
    expect(LEVEL_2.theme).toBe('canyon');
    expect(LEVEL_2.killY).toBeGreaterThan(CLOUD_SEA_TOP + 40);
    expect(C.yFinish).toBeGreaterThan(LEVEL_2.killY + 40);
    // chasm: lip → knuckle top
    expect(C.zLip - C.zKnuckle).toBeGreaterThan(180);
    expect(C.zLip - C.zKnuckle).toBeLessThan(200);
    // the gate hangs mid-gap, the target sits on the hill
    expect(C.gate[2]).toBeLessThan(C.zLip - 80);
    expect(C.gate[2]).toBeGreaterThan(C.zKnuckle + 60);
    expect(C.target.position.z).toBeLessThan(C.zKnuckle);
  });

  it('(a) the reference pilot completes deterministically (tricks, ring, BULLSEYE, gold)', async () => {
    const a = await play(level2Pilot());
    const b = await play(level2Pilot());
    expect(a.complete).toBe(true);
    expect(b.complete).toBe(true);
    expect(b.result!.score).toBe(a.result!.score);
    expect(b.result!.time).toBe(a.result!.time);
    // objectives in order
    expect(ofType(a.events, 'objectiveComplete').map((e) => e.id)).toEqual(['l2-flip', 'l2-stick', 'l2-flip2', 'l2-boost', 'l2-thrust', 'l2-land']);
    // three scored jumps: backflip off K1, frontflip off K2, big jump with a backflip through the ring
    expect(a.landings.length).toBe(3);
    expect(a.landings.every((l) => l.quality === 'clean' || l.quality === 'perfect')).toBe(true);
    expect(a.landings[0].tricks.some((t) => t.kind === 'backflip')).toBe(true);
    expect(a.landings[1].tricks.some((t) => t.kind === 'frontflip')).toBe(true);
    expect(a.landings[0].airTime).toBeGreaterThan(2.2);
    expect(a.landings[0].airTime).toBeLessThan(2.9);
    expect(a.landings[1].airTime).toBeGreaterThan(2.2);
    expect(a.landings[1].airTime).toBeLessThan(2.9);
    const big = a.big!;
    expect(big.tricks.some((t) => t.kind === 'backflip')).toBe(true);
    expect(big.inTarget).toBe(true);
    expect(big.distance).toBeGreaterThan(240);
    expect(a.ring).toBe(true);
    expect(a.result!.medal).toBe('gold');
    console.log(`[L2 a] reference: ${a.result!.score} pts (${a.result!.medal}), ${a.result!.time.toFixed(1)} s · ` + a.landings.map((l) => `${l.quality} ${l.impactSpeed.toFixed(1)} m/s [${l.tricks.map((t) => t.label).join(' + ')}]`).join(' | '));
  });

  it('(a) …also through asFunction() (the ?autopilot=1 path) and after a sim reset', async () => {
    const sim = await createSim(LEVEL_2, { flightAssist: true });
    const fn = level2Pilot().asFunction();
    for (let i = 0; i < 120 * 45 && sim.snapshot.phase !== 'complete'; i++) sim.step(fn(sim.snapshot));
    expect(sim.snapshot.phase).toBe('complete');
    sim.reset();
    for (let i = 0; i < 120 * 45 && sim.snapshot.phase !== 'complete'; i++) sim.step(fn(sim.snapshot));
    expect(sim.snapshot.phase).toBe('complete');
    sim.dispose();
  });

  it('(b) keyboard-like variants complete: quantized axes, 0.1 s minimum holds, ±0.15 s jitter', async () => {
    const rows: string[] = [];
    for (const [name, base] of [
      ['simple', SIMPLE],
      ['skilled', {} as L2PilotOptions],
      ['air', AIR(0.3)],
    ] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        const rnd = mulberry32(seed * 7919 + name.length);
        const opts = jittered(base, rnd);
        // The air-thrust fallback needs W released within ≈ 0.1 s of leaving the lip (W pitches the
        // nose down before the burn; see the release-timing sweep) — the 0.1 s PWM slot already adds
        // up to that much. The taught ramp-boost lines take the full extra 0–0.15 s W carry-over.
        if (name === 'air') opts.preW = 0;
        const o = await play(keyboardize(createLevel2Pilot(opts), rnd));
        rows.push(`${name}#${seed}:${o.complete ? `${o.result!.score}` : `X(${o.crash?.reason})`}`);
        expect(o.complete, `${name} seed ${seed}: ${o.crash?.reason ?? 'not complete'}`).toBe(true);
      }
    }
    console.log(`[L2 b] keyboard runs: ${rows.join(' ')}`);
  });

  it('(c) run-up speed: holding W the whole time works; the gap needs ≳ 54 m/s (195 km/h) of run-up', async () => {
    const row: string[] = [];
    const ok: Record<string, boolean> = {};
    for (const speed of [40, 46, 50, 54, 56, Infinity]) {
      for (const [name, line] of [
        ['boost', SIMPLE],
        ['air', AIR(0.3)],
      ] as const) {
        const o = await play(createLevel2Pilot({ ...line, speed }));
        ok[`${name}@${speed}`] = o.complete;
        row.push(`${name}@${speed === Infinity ? 'W' : speed}:${cell(o)}`);
      }
    }
    console.log(`[L2 c] run-up cruise speed (m/s): ${row.join(' ')}`);
    expect(ok['boost@Infinity']).toBe(true);
    expect(ok['air@Infinity']).toBe(true);
    expect(ok['boost@54']).toBe(true);
    expect(ok['air@54']).toBe(true);
    expect(ok['boost@40']).toBe(false); // too slow: honest crash at the gap
  });

  it('(c) ramp boost: start position, tap length and W carried into the air', async () => {
    const where: string[] = [];
    const okWhere: number[] = [];
    for (const at of [200, 120, 60, 10, -20, -45]) {
      const o = await playStraight({ ...SIMPLE, groundBoostAt: at });
      where.push(`${at}m:${cell(o)}`);
      if (o.complete) okWhere.push(at);
    }
    const taps: string[] = [];
    const okTap: number[] = [];
    for (const t of [0.15, 0.2, 0.25, 0.35, 0.5, 2]) {
      const o = await playStraight({ ...SIMPLE, groundBoost: t });
      taps.push(`${t}s:${cell(o)}`);
      if (o.complete) okTap.push(t);
    }
    const carry: string[] = [];
    for (const preW of [0, 0.15, 0.3, 0.5]) {
      const o = await playStraight({ ...SIMPLE, preW });
      carry.push(`W+${preW}s:${cell(o)}`);
      expect(o.complete, `ramp boost with W held ${preW}s into the air`).toBe(true);
    }
    console.log(`[L2 c] ramp boost start (m before the ramp): ${where.join(' ')}`);
    console.log(`[L2 c] ramp boost tap length: ${taps.join(' ')}`);
    console.log(`[L2 c] ramp boost + W carried into the air: ${carry.join(' ')}`);
    // anywhere from 200 m before the ramp to halfway up it; ≥ 0.25 s (holding longer just empties the 0.5 s tank)
    expect(okWhere).toEqual(expect.arrayContaining([200, 120, 60, 10, -20]));
    expect(okTap).toEqual(expect.arrayContaining([0.25, 0.35, 0.5, 2]));
  });

  it('(c) air thrust start × duration windows (hold SPACE ≥ 0.5 s: any start in the first ≈ 1.5 s)', async () => {
    const starts = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5];
    const durations = [0.15, 0.2, 0.3, 0.4, 0.6, 1.5];
    const lines: string[] = [];
    const holdOk: number[] = [];
    for (const t0 of starts) {
      const row: string[] = [];
      for (const d of durations) {
        const o = await playStraight(AIR(t0, d));
        row.push(`${d}:${cell(o)}`);
        if (d === 1.5 && o.complete) holdOk.push(t0);
      }
      lines.push(`  t0=${t0}s  ${row.join(' ')}`);
    }
    console.log(`[L2 c] air thrust (rows: start after the lip, cols: SPACE held s)\n${lines.join('\n')}`);
    // holding SPACE (the 0.5 s tank empties) works for every start from the lip to 1.5 s later
    expect(holdOk).toEqual(starts);
    // a 0.3 s tap is enough when it comes within the first second
    for (const t0 of [0, 0.25, 0.5, 0.75, 1.0]) expect((await playStraight(AIR(t0, 0.3))).complete, `0.3 s tap at ${t0}s`).toBe(true);
  });

  it('(c) W carried into the air before thrusting, and SHIFT before / during the burn', async () => {
    const row: string[] = [];
    for (const preW of [0, 0.1]) {
      const o = await playStraight({ ...AIR(preW + 0.1), preW });
      row.push(`W+${preW}→space:${cell(o)}`);
      expect(o.complete).toBe(true);
    }
    for (const preW of [0.2, 0.35]) {
      // the habit the BOOST lesson removes: nose pitched down by W, then thrust → documented, not required
      const o = await playStraight({ ...AIR(preW + 0.1), preW });
      row.push(`W+${preW}→space:${cell(o)}`);
    }
    for (const t0 of [0.2, 0.6]) {
      const during = await playStraight({ ...AIR(t0), stabilizeDuringThrust: true });
      const before = await playStraight({ ...AIR(t0), stabilizeBeforeThrust: true });
      row.push(`shiftDuring@${t0}:${cell(during)} shiftBefore@${t0}:${cell(before)}`);
      expect(during.complete).toBe(true);
      expect(before.complete).toBe(true);
    }
    console.log(`[L2 c] release / stabilizer timing: ${row.join(' ')}`);
  });

  it('(c) kicker flips: hold S (backflip) or W (frontflip), then SHIFT — wide hold windows', async () => {
    const windows: string[] = [];
    for (const kicker of ['k1', 'k2'] as const) {
      for (const trick of ['backflip', 'frontflip'] as const) {
        const ok: number[] = [];
        const row: string[] = [];
        for (const lead of [180, 140, 100, 60, 20]) {
          const o = await play(
            createLevel2Pilot({
              k1Trick: kicker === 'k1' ? trick : 'none',
              k2Trick: kicker === 'k2' ? trick : 'none',
              bigTrick: 'none',
              releaseLeadDeg: lead,
            }),
          );
          const l = o.landings[kicker === 'k1' ? 0 : 1];
          const counted = !!l && l.quality !== 'crash' && l.tricks.some((t) => t.kind === trick);
          row.push(`${360 - lead}°:${l ? l.quality[0].toUpperCase() + l.impactSpeed.toFixed(0) : 'X'}${counted ? '✓' : ''}`);
          if (counted && o.complete) ok.push(360 - lead);
        }
        windows.push(`${kicker} ${trick}: ${row.join(' ')}`);
        // releasing anywhere from 220° to 300° lands it (≈ 0.25 s of hold time at ≈ 300°/s, SHIFT completes the turn)
        expect(ok.length, `${kicker} ${trick}`).toBeGreaterThanOrEqual(3);
      }
    }
    // without SHIFT (flight assist only) a released flip still lands on the kickers
    const fa = await play(createLevel2Pilot({ ...NO_TRICKS, k1Trick: 'backflip', stabilize: false }));
    windows.push(`k1 backflip no SHIFT: ${fa.landings[0]?.quality} ${fa.landings[0]?.angleDeg.toFixed(0)}°`);
    console.log(`[L2 c] kicker flips (release angle → landing, ✓ = trick counted)\n  ${windows.join('\n  ')}`);
    // natural W-held speeds: K1 ≈ 47 m/s, K2 ≈ 57 m/s → ≈ 2.5 s of air each
    const ref = await play(createLevel2Pilot(NO_TRICKS));
    const tk = ofType(ref.events, 'takeoff');
    expect(tk[0].speed).toBeGreaterThan(44);
    expect(tk[0].speed).toBeLessThan(50);
    expect(tk[1].speed).toBeGreaterThan(53);
    expect(tk[1].speed).toBeLessThan(60);
  });

  it('(c) stabilizer on/off: flight assist alone lands the simple lines, SHIFT is what makes tricks safe', async () => {
    const rows: string[] = [];
    for (const [name, o, fa, mustComplete] of [
      ['simple, no SHIFT, assist on', { ...SIMPLE, stabilize: false }, true, true],
      ['air, no SHIFT, assist on', { ...AIR(0.4), stabilize: false }, true, true],
      ['simple, SHIFT, assist off', SIMPLE, false, true],
      ['skilled, SHIFT, assist off', {}, false, true],
      ['skilled, no SHIFT, assist off', { stabilize: false }, false, false],
    ] as const) {
      const out = await play(createLevel2Pilot(o), { flightAssist: fa });
      rows.push(`${name}: ${cell(out)}`);
      if (mustComplete) expect(out.complete, name).toBe(true);
    }
    console.log(`[L2 c] stabilizer: ${rows.join(' · ')}`);
  });

  it('(d) failure cases crash sensibly, above the cloud sea', async () => {
    // no thrust at all: the W-only launch drops under the knuckle onto the catch shelf
    const noThrust = await play(createLevel2Pilot({ ...SIMPLE, groundBoost: 0, thrustTime: 0 }));
    expect(noThrust.complete).toBe(false);
    expect(noThrust.crash).not.toBeNull();
    expect(noThrust.crash!.position.z).toBeLessThan(C.zLip - 150);
    expect(noThrust.crash!.position.y).toBeGreaterThan(CLOUD_SEA_TOP + 100);

    // too slow a run-up: falls into the chasm or onto the shelf
    const slow = await play(createLevel2Pilot({ ...SIMPLE, speed: 40 }));
    expect(slow.complete).toBe(false);

    // boosting on the ground AND burning a refilled tank in the air overshoots onto the finish deck
    const over = await playStraight({ ...NO_TRICKS, groundBoost: 0.5, groundBoostAt: 200, thrustDelay: 0.2, thrustTime: 0.6 });
    expect(over.complete).toBe(false);
    expect(over.crash?.reason).toBe('hard-impact');

    // falling off the side of the landing hill → 'fell' at the kill plane, well above the clouds
    {
      const sim = await createSim(LEVEL_2, { flightAssist: true });
      const f = frameAt(C.layout.landing, 120);
      const side = f.right.clone();
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), side).multiply(new Quaternion());
      sim.placeVehicle(f.position.clone().addScaledVector(f.up, 0.6).addScaledVector(side, 12), q, side.clone().multiplyScalar(25), new Vector3());
      sim.drainEvents();
      const rep = runAutopilot(sim, new Autopilot([{ name: 'idle' }]), { maxTime: 12, stopOnCrash: true });
      const crash = ofType(rep.events, 'crash')[0];
      expect(crash?.reason).toBe('fell');
      expect(crash.position.y).toBeGreaterThan(CLOUD_SEA_TOP + 40);
      sim.dispose();
    }

    // landing upside down on the hill → crash
    {
      const sim = await createSim(LEVEL_2, { flightAssist: false });
      const f = frameAt(C.layout.landing, 100);
      const inverted = f.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI));
      sim.placeVehicle(f.position.clone().addScaledVector(f.up, 9), inverted, f.forward.clone().multiplyScalar(30).add(new Vector3(0, -6, 0)), new Vector3());
      sim.drainEvents();
      const rep = runAutopilot(sim, new Autopilot([{ name: 'idle' }]), { maxTime: 6, stopOnCrash: true });
      expect(ofType(rep.events, 'crash').length).toBe(1);
      expect(sim.snapshot.phase).toBe('crashed');
      sim.dispose();
    }

    // skipping every trick is fine: the optional kicker objectives skip themselves
    const plain = await play(createLevel2Pilot(SIMPLE));
    expect(plain.complete).toBe(true);
    expect(plain.landings.slice(0, 2).every((l) => l.tricks.length === 0)).toBe(true);
    console.log(`[L2 d] no thrust → ${noThrust.crash!.reason} at y=${noThrust.crash!.position.y.toFixed(0)} · slow run-up → ${slow.crash?.reason} · ground+air overshoot → ${over.crash?.reason} · killY ${LEVEL_2.killY} (cloud sea ${CLOUD_SEA_TOP})`);
  });

  it('first attempt: flip and boost prompts request bullet-time until the action, never on retries', async () => {
    const run = async (firstAttempt: boolean, pilot: Autopilot) => {
      const sim = await createSim(LEVEL_2, { firstAttempt, flightAssist: true });
      const seen = new Map<string, number>();
      runAutopilot(sim, pilot, {
        maxTime: 40,
        onTick: (s) => {
          const p = s.snapshot.prompt;
          if (p) seen.set(p.id, Math.min(seen.get(p.id) ?? 1, s.snapshot.timeScale));
        },
      });
      const phase = sim.snapshot.phase;
      sim.dispose();
      return { seen, phase };
    };
    // a hesitant player: tricks start 0.4 s late, SPACE comes 0.25 s late on the ramp
    const first = await run(true, createLevel2Pilot({ trickDelay: 0.4, groundBoostAt: -10 }));
    expect(first.phase).toBe('complete');
    expect(first.seen.get('l2-flip')).toBe(0.5);
    expect(first.seen.get('l2-boost')).toBe(0.6);
    const retry = await run(false, createLevel2Pilot({ trickDelay: 0.4, groundBoostAt: -10 }));
    expect(Math.min(...retry.seen.values())).toBe(1);
    // the air-thrust prompt only appears when the jump is heading short of the hill
    const air = await run(true, createLevel2Pilot({ ...AIR(0.5) }));
    expect(air.seen.get('l2-thrust')).toBe(0.5);
    expect(first.seen.has('l2-thrust')).toBe(false);
    // a player who forgets SHIFT is told to realign before touchdown (gentle bullet-time)
    const noShift = await run(true, createLevel2Pilot({ ...SIMPLE, stabilize: false }));
    expect(noShift.seen.get('l2-land')).toBe(0.7);
  });

  it('ring gate: threading pays the bonus once; missing it pays nothing', async () => {
    const through = await play(createLevel2Pilot(SIMPLE));
    const late = await play(createLevel2Pilot(AIR(1.5)));
    expect(through.ring).toBe(true);
    expect(late.complete).toBe(true);
    expect(late.ring).toBe(false);
    const jumps = (o: Outcome) => o.landings.reduce((a, l) => a + l.points, 0);
    expect(through.result!.breakdown[0].points - jumps(through)).toBe(L2_RING_BONUS);
    expect(late.result!.breakdown[0].points - jumps(late)).toBe(0);
  });

  it('medals: casual completions → bronze, a clean taught run → silver, tricks + target/PERFECT → gold', async () => {
    const cases: [string, L2PilotOptions, LevelResult['medal']][] = [
      ['short tap, hard landing', { ...AIR(0.5, 0.25) }, 'bronze'],
      ['half ramp boost', { ...SIMPLE, groundBoost: 0.25 }, 'bronze'],
      ['air thrust, clean', AIR(0.3), 'silver'],
      ['simple taught line', SIMPLE, 'silver'],
      ['skilled: flips + ramp boost + bullseye', {}, 'gold'],
      ['skilled: flips + air thrust → PERFECT', { groundBoost: 0, thrustDelay: 0.6, thrustTime: 0.6 }, 'gold'],
    ];
    const rows: string[] = [];
    for (const [name, o, medal] of cases) {
      const out = await play(createLevel2Pilot(o));
      expect(out.complete, name).toBe(true);
      rows.push(`${name}: ${out.result!.score} ${out.result!.medal} (${out.big!.quality})`);
      expect(out.result!.medal, `${name} (${out.result!.score})`).toBe(medal);
    }
    console.log(`[L2 medals] bronze ${LEVEL_2.medals.bronze} / silver ${LEVEL_2.medals.silver} / gold ${LEVEL_2.medals.gold}\n  ${rows.join('\n  ')}`);
  });
});
