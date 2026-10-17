import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT, TEST_RAMP, TEST_RAMP_PATH, TEST_VACUUM, TEST_VACUUM_PATH } from '@/game/levels/testLevels';
import { initPhysics, isPhysicsReady } from '@/game/physics/initPhysics';
import { PhysicsWorld, createRayHit } from '@/game/physics/PhysicsWorld';
import { Vehicle } from '@/game/physics/Vehicle';
import { frameAt } from '@/game/track/TrackPath';
import type { LevelDef } from '@/game/types';
import { R2D } from './helpers';

const DOWN = new Vector3(0, -1, 0);

describe('initPhysics', () => {
  it('is idempotent and concurrent-safe', async () => {
    await Promise.all([initPhysics(), initPhysics(), initPhysics()]);
    await initPhysics();
    expect(isPhysicsReady()).toBe(true);
  });
});

describe('PhysicsWorld', () => {
  it('maps every collider to its piece surface info', async () => {
    await initPhysics();
    const pw = new PhysicsWorld(TEST_RAMP);
    const runway = pw.raycast(new Vector3(0, 10, -100), DOWN, 50);
    expect(runway).not.toBeNull();
    expect(runway!.surface).toMatchObject({ pieceId: 'ramp-runway', kind: 'asphalt', style: 'runway', adhesive: false });
    expect(runway!.distance).toBeCloseTo(10, 3);
    expect(runway!.normal.y).toBeCloseTo(1, 4);
    const land = TEST_RAMP_PATH.landing[30].position;
    const deck = pw.raycast(new Vector3(land.x, land.y + 10, land.z), DOWN, 50);
    expect(deck!.surface).toMatchObject({ pieceId: 'ramp-landing', kind: 'landing' });
    expect(pw.bounds.min.y).toBeLessThan(-8);
    pw.dispose();
  });

  it('adhesive-only queries skip non-adhesive pieces', async () => {
    await initPhysics();
    const pw = new PhysicsWorld(TEST_VACUUM);
    const hill = TEST_VACUUM_PATH.hill[40].position;
    const from = new Vector3(hill.x, hill.y + 5, hill.z);
    expect(pw.raycast(from, DOWN, 20)?.surface.pieceId).toBe('vac-hill');
    expect(pw.raycast(from, DOWN, 20, undefined, { adhesiveOnly: true })).toBeNull();
    const runway = pw.raycast(new Vector3(0, 5, -50), DOWN, 20, undefined, { adhesiveOnly: true });
    expect(runway?.surface).toMatchObject({ pieceId: 'vac-runway', adhesive: true });
    pw.dispose();
  });

  it('queries never hit the car itself', async () => {
    await initPhysics();
    const pw = new PhysicsWorld(TEST_FLAT);
    const car = new Vehicle(pw, { position: new Vector3(0, 3, 0), quaternion: new Quaternion() }, { fuel: TEST_FLAT.fuel, vacuumEnabled: false });
    pw.step();
    // straight through the chassis: must report the deck (y = 0), not the car body (y ≈ 3)
    const hit = pw.raycast(new Vector3(0, 10, 0), DOWN, 50);
    expect(hit!.distance).toBeCloseTo(10, 2);
    expect(hit!.surface.pieceId).toBe('deck');
    car.dispose();
    pw.dispose();
  });

  it('smooths ribbon normals on curves (continuous across facets)', async () => {
    await initPhysics();
    const pw = new PhysicsWorld(TEST_VACUUM);
    const frames = TEST_VACUUM_PATH.crescent;
    // a point a third of the way up the quarter pipe, between two frames
    const s = 18.5;
    const f = frameAt(frames, s);
    const origin = f.position.clone().addScaledVector(f.up, 2);
    const dir = f.up.clone().negate();
    const hit = pw.raycast(origin, dir, 5, createRayHit(), { slot: 30 });
    expect(hit).not.toBeNull();
    expect(Math.acos(Math.min(1, hit!.normal.dot(f.up))) * R2D).toBeLessThan(0.3);
    // two samples straddling a frame boundary differ by less than the facet angle
    const a = frameAt(frames, 19.98);
    const b = frameAt(frames, 20.02);
    const ha = pw.raycast(a.position.clone().addScaledVector(a.up, 1), a.up.clone().negate(), 3, createRayHit(), { slot: 31 })!;
    const na = ha.normal.clone();
    const hb = pw.raycast(b.position.clone().addScaledVector(b.up, 1), b.up.clone().negate(), 3, createRayHit(), { slot: 31 })!;
    expect(Math.acos(Math.min(1, na.dot(hb.normal))) * R2D).toBeLessThan(0.3);
    // the underside of the inverted beam faces down
    const beam = frameAt(frames, TEST_VACUUM_PATH.invertedStart + 30);
    const up = pw.raycast(beam.position.clone().addScaledVector(beam.up, 1.5), beam.up.clone().negate(), 4)!;
    expect(up.normal.y).toBeLessThan(-0.99);
    pw.dispose();
  });

  it('builds rotated cuboids from rotationDeg (YXZ degrees)', async () => {
    await initPhysics();
    const level: LevelDef = {
      ...TEST_FLAT,
      pieces: [{ kind: 'box', id: 'tilted', center: [0, 0, 0], size: [20, 2, 20], rotationDeg: [0, 0, 20], style: 'metal', adhesive: true }],
    };
    const pw = new PhysicsWorld(level);
    const hit = pw.raycast(new Vector3(0, 10, 0), DOWN, 50);
    expect(hit).not.toBeNull();
    expect(Math.acos(hit!.normal.y) * R2D).toBeCloseTo(20, 1);
    expect(hit!.surface).toMatchObject({ kind: 'metal', adhesive: true });
    pw.dispose();
  });

  it('skips non-collidable boxes', async () => {
    await initPhysics();
    const level: LevelDef = {
      ...TEST_FLAT,
      pieces: [
        ...TEST_FLAT.pieces,
        { kind: 'box', id: 'ghost', center: [0, 5, 0], size: [4, 1, 4], style: 'glass', collidable: false },
      ],
    };
    const pw = new PhysicsWorld(level);
    expect(pw.raycast(new Vector3(0, 10, 0), DOWN, 50)!.surface.pieceId).toBe('deck');
    pw.dispose();
  });
});
