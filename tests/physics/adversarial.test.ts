/**
 * Adversarial physics tests (QA): try to break the vehicle with situations a player or a level
 * designer can create — very fast impacts into trimesh faces and edges, platform edges, upside-down
 * touchdowns, vacuum spam, thrust into a ceiling, long inverted drives, steep slopes, reversing.
 *
 * Every scenario checks that the state stays finite and bounded, that nothing tunnels through
 * geometry, and that the gameplay outcome is the sensible one.
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT, TEST_RAMP, TEST_RAMP_PATH, TEST_VACUUM, TEST_VACUUM_PATH } from '@/game/levels/testLevels';
import type { GameSim } from '@/game/sim/GameSim';
import { frameAt, TrackPath } from '@/game/track/TrackPath';
import type { CrashReason, GameEvent, LevelDef, TrackFrame } from '@/game/types';
import { CHASSIS_COLLIDERS, VEHICLE } from '@/game/vehicleSpec';
import { attitude, createSim, D2R, input, ofType, placeForDrop, run } from './helpers';

const REST_Y = -VEHICLE.groundY;

/** Corners of both chassis colliders (chassis local), incl. the rounding radius. */
const CHASSIS_CORNERS: Vector3[] = [];
for (const c of CHASSIS_COLLIDERS) {
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1])
        CHASSIS_CORNERS.push(
          new Vector3(
            c.center[0] + sx * (c.halfExtents[0] + c.borderRadius),
            c.center[1] + sy * (c.halfExtents[1] + c.borderRadius),
            c.center[2] + sz * (c.halfExtents[2] + c.borderRadius),
          ),
        );
}

function finiteState(sim: GameSim): boolean {
  const v = sim.snapshot.vehicle;
  return [v.position, v.velocity, v.angularVelocity].every((x) => Number.isFinite(x.x + x.y + x.z)) && Number.isFinite(v.quaternion.w);
}

/**
 * How deep (m) a world point lies inside a ribbon slab (≤ 0 = outside), using the nearest frame:
 * inside = within the half width, between the drive surface and the slab bottom, between the caps.
 */
function slabDepth(frames: TrackFrame[], halfWidth: number, thickness: number, p: Vector3): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const d = frames[i].position.distanceToSquared(p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const f = frames[best];
  const rel = p.clone().sub(f.position);
  const lateral = halfWidth - Math.abs(rel.dot(f.right));
  const vertical = Math.min(-rel.dot(f.up), rel.dot(f.up) + thickness);
  // caps: the start cap faces −forward, the end cap +forward (positive = inside)
  let along = Infinity;
  if (best === 0) along = rel.dot(f.forward);
  else if (best === frames.length - 1) along = -rel.dot(f.forward);
  return Math.min(lateral, vertical, along);
}

/** Deepest chassis-corner penetration into the slab this tick. */
function chassisDepth(sim: GameSim, frames: TrackFrame[], halfWidth: number, thickness: number): number {
  const v = sim.snapshot.vehicle;
  let worst = -Infinity;
  const w = new Vector3();
  for (const c of CHASSIS_CORNERS) {
    w.copy(c).applyQuaternion(v.quaternion).add(v.position);
    worst = Math.max(worst, slabDepth(frames, halfWidth, thickness, w));
  }
  return worst;
}

/** A 16 m wide, 1.2 m thick ribbon slab floating at y = 10 from z = 900 to z = 860. */
const SLAB = new TrackPath({ position: [0, 10, 900] }).straight(40);
const SLAB_LEVEL: LevelDef = {
  ...TEST_FLAT,
  pieces: [...TEST_FLAT.pieces, { kind: 'ribbon', id: 'slab', frames: SLAB.frames, width: 16, style: 'platform', adhesive: false }],
};

interface ImpactRun {
  maxDepth: number;
  finite: boolean;
  maxSpeed: number;
  events: GameEvent[];
}

function impactRun(sim: GameSim, frames: TrackFrame[], halfWidth: number, seconds = 1.5): ImpactRun {
  let maxDepth = -Infinity;
  let finite = true;
  let maxSpeed = 0;
  const events = run(sim, seconds, undefined, () => {
    maxDepth = Math.max(maxDepth, chassisDepth(sim, frames, halfWidth, 1.2));
    finite &&= finiteState(sim);
    maxSpeed = Math.max(maxSpeed, sim.snapshot.vehicle.speed);
  });
  return { maxDepth, finite, maxSpeed, events };
}

describe('high-speed impacts into trimesh faces and edges', () => {
  // the car starts 2.5 m from the face so gravity cannot drop it out of the slab's height band
  const cases: [string, Vector3, Quaternion, Vector3][] = [
    ['end cap, nose first, 80 m/s', new Vector3(0, 9.45, 900 + 2.2 + 2.5), new Quaternion(), new Vector3(0, 0, -80)],
    ['side face, tail first, 80 m/s', new Vector3(8 + 2.2 + 2.5, 9.45, 880), attitude(0, 0, -90), new Vector3(-80, 0, 0)],
    ['side face, tail first, 40 m/s', new Vector3(8 + 2.2 + 2.5, 9.45, 880), attitude(0, 0, -90), new Vector3(-40, 0, 0)],
    ['side face, broadside, 80 m/s', new Vector3(8 + 1 + 2.5, 9.45, 880), new Quaternion(), new Vector3(-80, 0, 0)],
    ['top edge of the cap (ramp edge), 80 m/s', new Vector3(0, 10.05, 900 + 2.2 + 2.5), new Quaternion(), new Vector3(0, 0, -80)],
    ['top edge, diagonal + pitched, 80 m/s', new Vector3(6, 9.9, 904.5), attitude(10, 15, 20), new Vector3(-20, -2, -77)],
  ];
  for (const [name, p, q, v] of cases) {
    it(`${name}: no tunneling, finite, impact crash`, async () => {
      const sim = await createSim(SLAB_LEVEL);
      sim.placeVehicle(p, q, v);
      const r = impactRun(sim, SLAB.frames, 8);
      expect(r.finite).toBe(true);
      expect(r.maxDepth).toBeLessThan(0.15); // never more than contact-slop deep inside the slab
      expect(r.maxSpeed).toBeLessThan(v.length() + 1); // never thrown out faster than it came in
      const crash = ofType(r.events, 'crash');
      expect(crash).toHaveLength(1);
      expect(['impact', 'nose-dive', 'roof']).toContain(crash[0].reason);
      sim.dispose();
    });
  }

  it('TEST_RAMP kicker side face (pitched frames), 80 m/s: no tunneling', async () => {
    const sim = await createSim(TEST_RAMP);
    const frames = TEST_RAMP_PATH.kicker;
    const f = frames[15];
    const start = f.position.clone().addScaledVector(f.up, -0.6).addScaledVector(f.right, 8 + 2.2 + 2.5);
    // tail first toward the side face (car forward = frame right)
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), f.right);
    sim.placeVehicle(start, q, f.right.clone().multiplyScalar(-80));
    const r = impactRun(sim, frames, 8);
    expect(r.finite).toBe(true);
    expect(r.maxDepth).toBeLessThan(0.15);
    expect(ofType(r.events, 'crash')[0]?.reason).toBe('impact');
    sim.dispose();
  });
});

describe('platform edges and corners', () => {
  const pad: LevelDef = {
    ...TEST_FLAT,
    pieces: [{ kind: 'box', id: 'pad', center: [0, -1, 0], size: [10, 2, 10], style: 'platform' }],
    killY: -60,
  };
  const cases: [string, number, number, number][] = [
    ['right wheels over the side edge', 4.6, 0, 0],
    ['over a corner', 4.6, 4.2, 0],
    ['front axle over the front edge', 0, -4.6, 0],
    ['mostly off the edge, tilted', 5.2, 0, 20],
    ['belly on the edge', 5.4, 0, 0],
  ];
  const legit: CrashReason[] = ['missed-platform', 'fell', 'rollover', 'hard-impact', 'roof'];
  for (const [name, x, z, roll] of cases) {
    it(`${name}: finite, the jump resolves, the car ends up resting or crashed`, async () => {
      const sim = await createSim(pad);
      placeForDrop(sim, { impact: 7, x, z, horizontal: 0.5, rollDeg: roll });
      let finite = true;
      let maxW = 0;
      const events = run(sim, 4, undefined, () => {
        finite &&= finiteState(sim);
        maxW = Math.max(maxW, sim.snapshot.vehicle.angularVelocity.length());
      });
      expect(finite).toBe(true);
      expect(maxW).toBeLessThan(12);
      expect(ofType(events, 'takeoff')).toHaveLength(1);
      const landings = ofType(events, 'landing');
      const crashes = ofType(events, 'crash');
      expect(landings.length + crashes.length).toBeGreaterThan(0);
      for (const c of crashes) expect(legit).toContain(c.reason);
      if (crashes.length === 0) {
        // resting on the pad: stopped, wheels or tub on the deck, not stuck mid-jump
        expect(sim.snapshot.vehicle.speed).toBeLessThan(0.5);
        expect(sim.snapshot.air.airborne).toBe(false);
        expect(sim.snapshot.vehicle.position.y).toBeGreaterThan(0);
      }
      sim.dispose();
    });
  }
});

describe('upside-down touchdowns', () => {
  it('resting on the roof (placed in contact, no fall) is a roof crash', async () => {
    const sim = await createSim(TEST_FLAT);
    const cabin = CHASSIS_COLLIDERS[1];
    sim.placeVehicle(new Vector3(0, cabin.center[1] + cabin.halfExtents[1] + cabin.borderRadius, 0), attitude(0, 180));
    const events = run(sim, 1);
    expect(ofType(events, 'crash')[0]?.reason).toBe('roof');
    expect(finiteState(sim)).toBe(true);
    sim.dispose();
  });

  it('a 0.5 m/s exactly-inverted touchdown is a roof crash, never a landing', async () => {
    const sim = await createSim(TEST_FLAT);
    placeForDrop(sim, { impact: 0.5, rollDeg: 180, horizontal: 0 });
    const events = run(sim, 3);
    expect(ofType(events, 'crash')[0]?.reason).toBe('roof');
    expect(ofType(events, 'landing').every((l) => l.result.quality === 'crash')).toBe(true);
    expect(finiteState(sim)).toBe(true);
    sim.dispose();
  });
});

describe('vacuum spam at the overhang', () => {
  for (const period of [1, 2, 6, 20]) {
    it(`toggling every ${period} tick(s): stable, events consistent`, async () => {
      const sim = await createSim(TEST_VACUUM);
      // on the vertical wall heading into the overhang at 24 m/s, vacuum engaged
      const f = frameAt(TEST_VACUUM_PATH.crescent, 26 * (Math.PI / 2) + 4);
      sim.placeVehicle(f.position.clone().addScaledVector(f.up, REST_Y), f.quaternion.clone(), f.forward.clone().multiplyScalar(24));
      run(sim, 0.3, input({ vacuum: true, throttle: 0.5 }));
      expect(sim.snapshot.vehicle.vacuum.mode).toBe('engaged');
      let tick = 0;
      let finite = true;
      let maxW = 0;
      const events = run(
        sim,
        3,
        () => {
          tick++;
          return input({ vacuum: Math.floor(tick / period) % 2 === 0, throttle: 0.6 });
        },
        () => {
          finite &&= finiteState(sim);
          maxW = Math.max(maxW, sim.snapshot.vehicle.angularVelocity.length());
        },
      );
      expect(finite).toBe(true);
      expect(maxW).toBeLessThan(10);
      // button and suction state machines stay consistent (start: held + engaged)
      let held = true;
      let engaged = true;
      for (const e of events) {
        if (e.type === 'vacuumOn') {
          expect(held).toBe(false);
          held = true;
        } else if (e.type === 'vacuumOff') {
          expect(held).toBe(true);
          held = false;
        } else if (e.type === 'vacuumEngaged') {
          expect(engaged).toBe(false);
          engaged = true;
        } else if (e.type === 'vacuumReleased') {
          expect(engaged).toBe(true);
          engaged = false;
        }
      }
      const vac = sim.snapshot.vehicle.vacuum;
      expect(vac.strength).toBeGreaterThanOrEqual(0);
      expect(vac.strength).toBeLessThanOrEqual(1);
      for (const c of ofType(events, 'crash')) expect(['impact', 'hard-impact', 'roof', 'rollover', 'fell', 'nose-dive']).toContain(c.reason);
      sim.dispose();
    });
  }
});

describe('thrust into a ceiling', () => {
  const level: LevelDef = {
    ...TEST_FLAT,
    pieces: [...TEST_FLAT.pieces, { kind: 'box', id: 'ceiling', center: [0, 30, 1000], size: [60, 2, 60], style: 'metal' }],
  };
  for (const pitch of [90, 60, 40]) {
    it(`pitched ${pitch}° with full thrust: stops at the ceiling, finite, crashes`, async () => {
      const sim = await createSim(level);
      sim.placeVehicle(new Vector3(0, 14, 1012), attitude(pitch, 0), new Vector3(0, 12, 0));
      let maxTop = -Infinity;
      let finite = true;
      const w = new Vector3();
      const events = run(
        sim,
        4,
        (s) => {
          s.vehicle.setFuel(1);
          return input({ boost: true });
        },
        () => {
          finite &&= finiteState(sim);
          const v = sim.snapshot.vehicle;
          for (const c of CHASSIS_CORNERS) maxTop = Math.max(maxTop, w.copy(c).applyQuaternion(v.quaternion).add(v.position).y);
        },
      );
      expect(finite).toBe(true);
      expect(maxTop).toBeLessThan(29 + 0.1); // ceiling underside at y = 29
      expect(maxTop).toBeGreaterThan(28.5); // really reached it
      expect(ofType(events, 'crash')).toHaveLength(1);
      sim.dispose();
    });
  }
});

describe('long inverted drive', () => {
  // 600 m straight beam, drive surface facing down, 40 m above the deck
  const beam = new TrackPath({ position: [0, 40, 0], rollDeg: 180 }).straight(600);
  const level: LevelDef = {
    ...TEST_FLAT,
    vacuumEnabled: true,
    pieces: [...TEST_FLAT.pieces, { kind: 'ribbon', id: 'beam', frames: beam.frames, width: 16, style: 'adhesive', adhesive: true }],
  };

  async function onBeam(): Promise<GameSim> {
    const sim = await createSim(level);
    const f = frameAt(beam.frames, 30);
    sim.placeVehicle(f.position.clone().addScaledVector(f.up, REST_Y), f.quaternion.clone(), f.forward.clone().multiplyScalar(5));
    run(sim, 1, input({ vacuum: true }));
    return sim;
  }

  it('18 s of weaving at 24 m/s upside down: stays attached, no crash', async () => {
    const sim = await onBeam();
    let maxUpY = -1;
    let lowWheelTicks = 0;
    let maxLat = 0;
    let ticks = 0;
    const f0 = beam.frames[0];
    const events = run(
      sim,
      18,
      (s, t) => {
        const v = s.snapshot.vehicle;
        const lateral = v.position.clone().sub(f0.position).dot(f0.right); // + = beam right
        const heading = Math.atan2(v.forward.dot(f0.right), v.forward.dot(f0.forward));
        return input({
          vacuum: true,
          throttle: Math.max(-1, Math.min(1, (24 - v.forwardSpeed) * 0.4)),
          steer: Math.max(-1, Math.min(1, -0.12 * lateral - 0.9 * heading + 0.55 * Math.sin(t * 1.3))),
        });
      },
      () => {
        const v = sim.snapshot.vehicle;
        ticks++;
        maxUpY = Math.max(maxUpY, v.up.y);
        if (v.groundedWheels < 3) lowWheelTicks++;
        maxLat = Math.max(maxLat, Math.abs(v.position.clone().sub(f0.position).dot(f0.right)));
      },
    );
    expect(maxUpY).toBeLessThan(-0.9);
    expect(lowWheelTicks / ticks).toBeLessThan(0.01);
    expect(maxLat).toBeLessThan(7);
    expect(ofType(events, 'crash')).toHaveLength(0);
    expect(ofType(events, 'takeoff')).toHaveLength(0);
    expect(sim.snapshot.score.invertedDistance).toBeGreaterThan(350);
    expect(finiteState(sim)).toBe(true);
    sim.dispose();
  });

  it('grinding a side rail while inverted is a scrape (impact events), never a rollover', async () => {
    const railed = new TrackPath({ position: [0, 40, 0], rollDeg: 180 }).straight(300);
    const railLevel: LevelDef = {
      ...TEST_FLAT,
      vacuumEnabled: true,
      pieces: [...TEST_FLAT.pieces, { kind: 'ribbon', id: 'beam', frames: railed.frames, width: 10, rails: 0.7, style: 'adhesive', adhesive: true }],
    };
    const sim = await createSim(railLevel);
    const f = frameAt(railed.frames, 20);
    sim.placeVehicle(f.position.clone().addScaledVector(f.up, REST_Y), f.quaternion.clone(), f.forward.clone().multiplyScalar(5));
    run(sim, 1, input({ vacuum: true }));
    let contactTicks = 0;
    let maxUpY = -1;
    // drive at 20 m/s steering toward the car's right ⇒ into the right-hand rail
    const events = run(
      sim,
      6,
      (s) => input({ vacuum: true, throttle: (20 - s.snapshot.vehicle.forwardSpeed) * 0.4, steer: 0.15 }),
      () => {
        if (sim.vehicle.touchingCount > 0) contactTicks++;
        maxUpY = Math.max(maxUpY, sim.snapshot.vehicle.up.y);
      },
    );
    expect(contactTicks / 120).toBeGreaterThan(1); // really grinding the rail
    expect(ofType(events, 'impact').length).toBeGreaterThan(0);
    expect(ofType(events, 'crash')).toHaveLength(0);
    expect(maxUpY).toBeLessThan(-0.9);
    sim.dispose();
  });

  it('full lock at 15 m/s upside down on a wide adhesive ceiling (box piece): tight circle, no spin, attached', async () => {
    // an 80 m square adhesive slab: its underside (normal −Y) at y = 39 is the drive surface
    const ceiling: LevelDef = {
      ...TEST_FLAT,
      vacuumEnabled: true,
      pieces: [...TEST_FLAT.pieces, { kind: 'box', id: 'ceiling', center: [0, 40, 1000], size: [80, 2, 80], style: 'metal', adhesive: true }],
    };
    const sim = await createSim(ceiling);
    sim.placeVehicle(new Vector3(0, 39 - REST_Y, 1025), attitude(0, 180), new Vector3(0, 0, -5));
    run(sim, 1, input({ vacuum: true }));
    expect(sim.snapshot.vehicle.groundedWheels).toBe(4);
    run(sim, 2, (s) => input({ vacuum: true, throttle: (15 - s.snapshot.vehicle.forwardSpeed) * 0.5 }));
    let maxBeta = 0;
    let maxUpY = -1;
    run(
      sim,
      4,
      (s) => input({ vacuum: true, throttle: (15 - s.snapshot.vehicle.forwardSpeed) * 0.5, steer: -1 }),
      (t) => {
        const v = sim.snapshot.vehicle;
        maxUpY = Math.max(maxUpY, v.up.y);
        if (t > 1) maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(v.velocity.dot(v.right), v.velocity.dot(v.forward))) / D2R);
      },
    );
    expect(maxUpY).toBeLessThan(-0.9);
    expect(maxBeta).toBeLessThan(12);
    expect(sim.snapshot.phase).toBe('running');
    // turning left in the car's own frame: positive yaw rate about the car's up
    expect(sim.snapshot.vehicle.angularVelocity.dot(sim.snapshot.vehicle.up)).toBeGreaterThan(0.5);
    sim.dispose();
  });
});

describe('steep slope (25°)', () => {
  const level: LevelDef = {
    ...TEST_FLAT,
    pieces: [...TEST_FLAT.pieces, { kind: 'box', id: 'slope', center: [0, 20, 1000], size: [80, 2, 140], rotationDeg: [25, 0, 0], style: 'platform' }],
  };
  const slopeQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 25 * D2R);
  const n = new Vector3(0, 1, 0).applyQuaternion(slopeQ);
  const topCenter = new Vector3(0, 20, 1000).addScaledVector(n, 1);

  async function parked(yawDeg: number): Promise<GameSim> {
    const sim = await createSim(level);
    const q = slopeQ.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yawDeg * D2R));
    sim.placeVehicle(topCenter.clone().addScaledVector(n, REST_Y), q);
    run(sim, 1);
    return sim;
  }

  for (const [name, yaw] of [
    ['facing uphill', 0],
    ['facing downhill', 180],
    ['parked across the slope', 90],
  ] as [string, number][]) {
    it(`${name}: no creep with neutral input (auto hold)`, async () => {
      const sim = await parked(yaw);
      const p0 = sim.snapshot.vehicle.position.clone();
      run(sim, 5);
      expect(sim.snapshot.vehicle.position.distanceTo(p0)).toBeLessThan(0.01);
      expect(sim.snapshot.vehicle.speed).toBeLessThan(0.02);
      expect(sim.snapshot.vehicle.groundedWheels).toBe(4);
      sim.dispose();
    });
  }

  it('braking while rolling downhill stops the car; releasing the brake then holds it', async () => {
    const sim = await parked(180);
    // the auto hold keeps a parked car still: drive downhill to ≈ 10 m/s first
    run(sim, 6, input({ throttle: 1 }), () => sim.snapshot.vehicle.forwardSpeed > 10);
    expect(sim.snapshot.vehicle.forwardSpeed).toBeGreaterThan(9);
    let stopped = -1;
    run(sim, 4, input({ throttle: -1 }), (t) => {
      if (sim.snapshot.vehicle.forwardSpeed < 0.3) stopped = t;
      return stopped > 0;
    });
    expect(stopped).toBeGreaterThan(0);
    expect(stopped).toBeLessThan(1.2); // 26 m/s² brakes vs 5.9 m/s² of slope
    run(sim, 0.5);
    const p0 = sim.snapshot.vehicle.position.clone();
    run(sim, 4);
    expect(sim.snapshot.vehicle.position.distanceTo(p0)).toBeLessThan(0.02);
    sim.dispose();
  });
});

describe('reverse driving', () => {
  it('reverses straight to the limit, turns a tight circle without spinning, then drives forward again', async () => {
    const sim = await createSim(TEST_FLAT);
    run(sim, 5, input({ throttle: -1 }));
    let v = sim.snapshot.vehicle;
    expect(v.forwardSpeed).toBeLessThan(-13);
    expect(Math.abs(v.position.x)).toBeLessThan(0.2);
    expect(v.position.z).toBeGreaterThan(1440); // moved backwards (+Z)

    const pts: Vector3[] = [];
    let maxBeta = 0;
    run(
      sim,
      6,
      (s) => input({ throttle: -Math.max(-1, Math.min(1, (10 + s.snapshot.vehicle.forwardSpeed) * 0.8)), steer: -1 }),
      (t) => {
        const vv = sim.snapshot.vehicle;
        if (t > 2) {
          pts.push(vv.position.clone());
          maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(vv.velocity.dot(vv.right), -vv.velocity.dot(vv.forward))) / D2R);
        }
      },
    );
    const c = pts.reduce((a, p) => a.add(p), new Vector3()).divideScalar(pts.length);
    const radius = pts.reduce((a, p) => a + Math.hypot(p.x - c.x, p.z - c.z), 0) / pts.length;
    expect(radius).toBeGreaterThan(6);
    expect(radius).toBeLessThan(10);
    expect(maxBeta).toBeLessThan(15);
    v = sim.snapshot.vehicle;
    expect(v.up.y).toBeGreaterThan(0.98);
    // steering left while reversing: the nose swings right (negative yaw rate seen from above)
    expect(v.angularVelocity.y).toBeLessThan(0);

    let forwardAt = -1;
    run(sim, 3, input({ throttle: 1 }), (t) => {
      if (forwardAt < 0 && sim.snapshot.vehicle.forwardSpeed > 0.5) forwardAt = t;
    });
    expect(forwardAt).toBeGreaterThan(0);
    expect(forwardAt).toBeLessThan(1);
    expect(sim.snapshot.vehicle.forwardSpeed).toBeGreaterThan(20);
    sim.dispose();
  });
});
