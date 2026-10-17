import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT, TEST_RAMP } from '@/game/levels/testLevels';
import { TUNING } from '@/game/tuning';
import type { LevelDef } from '@/game/types';
import { attitude, createSim, input, ofType, placeForDrop, run } from '../physics/helpers';

describe('crash detection', () => {
  it('dropped upside down → roof (keeps simulating, requests 0.35× for 0.6 s)', async () => {
    const sim = await createSim(TEST_FLAT);
    placeForDrop(sim, { impact: 6, rollDeg: 180 });
    const scales: number[] = [];
    let crashAt = -1;
    const events = run(sim, 2, undefined, (t, evs) => {
      if (evs.some((e) => e.type === 'crash')) crashAt = t;
      if (crashAt > 0) scales.push(sim.snapshot.timeScale);
    });
    const crash = ofType(events, 'crash');
    expect(crash).toHaveLength(1);
    expect(['roof', 'rollover']).toContain(crash[0].reason);
    expect(sim.snapshot.phase).toBe('crashed');
    expect(sim.snapshot.crashReason).toBe(crash[0].reason);
    expect(sim.snapshot.vehicle.crashed).toBe(true);
    expect(scales[0]).toBe(TUNING.crash.timeScale);
    expect(scales.filter((s) => s === TUNING.crash.timeScale).length / 120).toBeCloseTo(TUNING.crash.slowMoTime, 1);
    expect(scales[scales.length - 1]).toBe(1);
    sim.dispose();
  });

  it('lying on its side → rollover after 0.25 s', async () => {
    const sim = await createSim(TEST_FLAT);
    sim.placeVehicle(new Vector3(0, 1.05, 0), attitude(0, 90));
    let crashAt = -1;
    const events = run(sim, 1.5, undefined, (t, evs) => {
      if (crashAt < 0 && evs.some((e) => e.type === 'crash')) crashAt = t;
    });
    expect(ofType(events, 'crash')[0]?.reason).toBe('rollover');
    expect(crashAt).toBeGreaterThan(TUNING.crash.rolloverTime);
    expect(crashAt).toBeLessThan(1);
    sim.dispose();
  });

  it('nose-first out of the air → nose-dive', async () => {
    const sim = await createSim(TEST_FLAT);
    placeForDrop(sim, { impact: 20, pitchDeg: -60, horizontal: 5 });
    const events = run(sim, 2);
    expect(ofType(events, 'crash')[0]?.reason).toBe('nose-dive');
    expect(ofType(events, 'crash')[0].impactSpeed).toBeGreaterThan(TUNING.crash.noseDiveSpeed);
    sim.dispose();
  });

  it('falling below killY → fell', async () => {
    const sim = await createSim(TEST_FLAT);
    sim.placeVehicle(new Vector3(2000, -40, 0), new Quaternion()); // off the deck, killY −60
    const events = run(sim, 3);
    const crash = ofType(events, 'crash');
    expect(crash).toHaveLength(1);
    expect(crash[0].reason).toBe('fell');
    expect(sim.snapshot.vehicle.position.y).toBeLessThan(TEST_FLAT.killY);
    sim.dispose();
  });

  it('driving into a wall at speed → impact; a gentle bump is not a crash', async () => {
    const level: LevelDef = {
      ...TEST_FLAT,
      pieces: [...TEST_FLAT.pieces, { kind: 'box', id: 'wall', center: [0, 2, 1300], size: [30, 4, 2], style: 'metal' }],
    };
    const fast = await createSim(level);
    fast.placeVehicle(new Vector3(0, 0.36, 1330), new Quaternion(), new Vector3(0, 0, -35));
    const evFast = run(fast, 2);
    expect(ofType(evFast, 'crash')[0]?.reason).toBe('impact');
    expect(ofType(evFast, 'impact').length).toBeGreaterThan(0);
    fast.dispose();

    const slow = await createSim(level);
    slow.placeVehicle(new Vector3(0, 0.36, 1310), new Quaternion(), new Vector3(0, 0, -5));
    const evSlow = run(slow, 2);
    expect(ofType(evSlow, 'crash')).toHaveLength(0);
    expect(ofType(evSlow, 'impact').length).toBeGreaterThan(0); // still a scrape/hit event for VFX
    expect(slow.snapshot.phase).toBe('running');
    slow.dispose();
  });

  it('regression: flipping into a trimesh deck registers chassis contacts and crashes', async () => {
    // W held through the jump = endless frontflips; the roof must hit the ribbon deck and crash
    const sim = await createSim(TEST_RAMP);
    const events = run(sim, 14, input({ throttle: 1 }), () => sim.snapshot.phase === 'crashed');
    expect(sim.snapshot.phase).toBe('crashed');
    expect(['roof', 'rollover', 'nose-dive', 'hard-impact', 'impact']).toContain(ofType(events, 'crash')[0].reason);
    // contacts on the trimesh were seen (not just inferred from Δv)
    expect(ofType(events, 'impact').length).toBeGreaterThan(0);
    sim.dispose();
  });

  it('ignores player input after a crash (the car tumbles on its own)', async () => {
    const sim = await createSim(TEST_FLAT);
    placeForDrop(sim, { impact: 6, rollDeg: 180 });
    run(sim, 1);
    expect(sim.snapshot.phase).toBe('crashed');
    const events = run(sim, 1, input({ throttle: 1, boost: true, vacuum: true }));
    expect(sim.snapshot.vehicle.boosting).toBe(false);
    expect(sim.snapshot.vehicle.throttle).toBe(0);
    expect(ofType(events, 'boostStart')).toHaveLength(0);
    expect(ofType(events, 'crash')).toHaveLength(0); // crash events never repeat
    sim.dispose();
  });
});
