/**
 * LEVEL 1 on a phone: the tilt gas stays tipped forward at the lip and the stabilizer is never
 * pressed — the touch assist (LevelDef.touchAssist) must still bring the car into the rings.
 */
import { describe, expect, it } from 'vitest';
import { LEVEL_1, level1PilotWith } from '@/game/levels/level1';
import { applyTouchAssist } from '@/game/sim/touchAssist';
import { Autopilot, runAutopilot } from '@/game/sim/autopilot';
import { NEUTRAL_INPUT, type InputState, type SimSnapshot } from '@/game/types';
import { createSim } from '../physics/helpers';

const snapAt = (airborne: boolean, airTime: number) =>
  ({ phase: 'running', vehicle: { airborne }, air: { airTime } }) as unknown as SimSnapshot;
const def = LEVEL_1.touchAssist!;
const held = (): InputState => ({ ...NEUTRAL_INPUT, throttle: 1 });

describe('applyTouchAssist', () => {
  it('level 1 defines it', () => expect(def).toBeDefined());
  it('does nothing on the ground', () => {
    expect(applyTouchAssist(held(), snapAt(false, 0), def)).toMatchObject({ throttle: 1, stabilize: false });
  });
  it('drops the pitch axis in the air, keeps the other inputs', () => {
    const i = applyTouchAssist({ ...held(), boost: true, steer: 0.5 }, snapAt(true, 0.2), def);
    expect(i).toMatchObject({ throttle: 0, boost: true, steer: 0.5, stabilize: false });
  });
  it('holds the stabilizer later in the flight', () => {
    expect(applyTouchAssist(held(), snapAt(true, 1), def)).toMatchObject({ throttle: 0, stabilize: true });
  });
});

describe('LEVEL 1 — phone player', () => {
  it('gas still tipped forward in the air + thrusters only: finishes in the rings', async () => {
    const base = level1PilotWith({ stabilize: 'none', matchSlope: false });
    const phone = new Autopilot([
      {
        name: 'phone',
        controllers: [
          (snap, ctx) => {
            const o: Partial<InputState> = { ...base.next(snap, ctx.events) };
            if (snap.vehicle.airborne) o.throttle = 1; // never lets go of the gas
            o.stabilize = false; // never presses the stabilizer
            return o;
          },
        ],
      },
    ]);
    // same wrapper as the game: assist applied to the sampled input
    const sim = await createSim(LEVEL_1, { flightAssist: true, firstAttempt: false });
    const wrapped = new Autopilot([
      { name: 'assist', controllers: [(snap, ctx) => applyTouchAssist({ ...NEUTRAL_INPUT, ...phone.next(snap, ctx.events) }, snap, def)] },
    ]);
    runAutopilot(sim, wrapped, { maxTime: 24, stopOnCrash: true });
    expect(sim.snapshot.phase).toBe('complete');
    sim.dispose();
  });
});
