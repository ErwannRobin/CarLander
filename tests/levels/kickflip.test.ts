/** LEVEL 2 — KICKFLIP: the reference run (jump jets over the cars, then a kickflip) finishes; a run without the kickflip does not, and a run without the jump crashes into the cars. */
import { describe, expect, it } from 'vitest';
import { kickflipPilotWith, LEVEL_KICKFLIP } from '@/game/levels/kickflip';
import { KF } from '@/game/levels/kickflip/layout';
import { runAutopilot } from '@/game/sim/autopilot';
import { createSim, ofType } from '../physics/helpers';

async function fly(opts: Parameters<typeof kickflipPilotWith>[0] = {}) {
  const sim = await createSim(LEVEL_KICKFLIP, { flightAssist: true });
  const report = runAutopilot(sim, kickflipPilotWith(opts), { maxTime: 30, stopOnCrash: true });
  const landing = ofType(report.events, 'landing')[0]?.result ?? null;
  const crash = ofType(report.events, 'crash')[0] ?? null;
  const tricks = ofType(report.events, 'trick').map((e) => e.trick.label);
  const out = {
    complete: sim.snapshot.phase === 'complete',
    quality: landing?.quality,
    distFromLip: landing ? KF.lip.position.z - landing.position.z : null,
    crash: crash?.reason ?? null,
    tricks,
    jumpSpeed: Math.round(ofType(report.events, 'takeoff')[0]?.speed ?? -1),
  };
  sim.dispose();
  return out;
}

describe('level 2 kickflip', () => {
  it('reference jump + kickflip run completes', async () => {
    const o = await fly();
    console.log('reference', JSON.stringify(o));
    expect(o.tricks.some((t) => t.includes('BARREL ROLL'))).toBe(true);
    expect(o.complete).toBe(true);
  }, 120000);

  it('slower run-up still clears the cars', async () => {
    const o = await fly({ speed: 35 });
    console.log('slow', JSON.stringify(o));
    expect(o.crash).not.toBe('impact');
    expect(o.distFromLip).toBeGreaterThan(13);
  }, 120000);

  it('not jumping crashes into the cars', async () => {
    const o = await fly({ jump: false });
    console.log('no jump', JSON.stringify(o));
    expect(o.complete).toBe(false);
  }, 120000);

  it('landing without a kickflip does not finish', async () => {
    const o = await fly({ kickflip: false });
    console.log('no flip', JSON.stringify(o));
    expect(o.complete).toBe(false);
  }, 120000);
});
