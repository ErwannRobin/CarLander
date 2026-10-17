import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { TrackPath, frameAt, joinFrames } from '@/game/track/TrackPath';
import { buildRibbon } from '@/game/track/Ribbon';

const close = (a: number, b: number, eps = 0.05) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('TrackPath', () => {
  it('straight goes towards -Z by default', () => {
    const p = new TrackPath({ position: [0, 0, 0] }).straight(100);
    const e = p.end();
    close(e.position.z, -100);
    close(e.position.y, 0);
    expect(p.frames.length).toBe(101);
  });

  it('quarter pipe up(90, R) ends R forward, R up, facing +Y', () => {
    const p = new TrackPath({ position: [0, 0, 0] }).up(90, 10);
    const e = p.end();
    close(e.position.z, -10);
    close(e.position.y, 10);
    close(e.forward.y, 1, 1e-3);
    // up vector now points backwards (+Z)
    close(e.up.z, 1, 1e-3);
  });

  it('half loop ends inverted heading back', () => {
    const p = new TrackPath({ position: [0, 0, 0] }).up(180, 20);
    const e = p.end();
    close(e.position.y, 40);
    close(e.position.z, 0, 0.1);
    close(e.forward.z, 1, 1e-3);
    close(e.up.y, -1, 1e-3);
  });

  it('left turns towards -X, right towards +X', () => {
    const l = new TrackPath({ position: [0, 0, 0] }).left(90, 10).end();
    close(l.position.x, -10);
    close(l.forward.x, -1, 1e-3);
    const r = new TrackPath({ position: [0, 0, 0] }).right(90, 10).end();
    close(r.position.x, 10);
  });

  it('roll right tilts up towards +X', () => {
    const e = new TrackPath({ position: [0, 0, 0] }).roll(90, 10).end();
    close(e.up.x, 1, 1e-3);
    close(e.position.z, -10);
  });

  it('yawDeg start heading 90 faces -X', () => {
    const e = new TrackPath({ position: [0, 0, 0], yawDeg: 90 }).straight(10).end();
    close(e.position.x, -10);
  });

  it('frameAt interpolates and joinFrames keeps arc length continuous', () => {
    const a = new TrackPath({ position: [0, 0, 0] }).straight(10);
    const b = TrackPath.fromFrame(a.end()).straight(5);
    const all = joinFrames(a.frames, b.frames);
    close(all[all.length - 1].s, 15, 1e-6);
    close(frameAt(all, 12.5).position.z, -12.5);
  });
});

describe('Ribbon + Rapier', () => {
  it('collider raycasts hit the drive surface with outward normals (upright and inverted)', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -14, z: 0 });
    // upright deck at y=0, then an inverted ceiling 20 m above (up = -Y)
    const deck = new TrackPath({ position: [0, 0, 0] }).straight(40);
    const ceil = new TrackPath({ position: [0, 20, 0], rollDeg: 180 }).straight(40);
    for (const p of [deck, ceil]) {
      const g = buildRibbon(p.frames, { width: 10, thickness: 1 });
      world.createCollider(RAPIER.ColliderDesc.trimesh(g.collider.vertices, g.collider.indices));
    }
    world.step();
    const down = world.castRayAndGetNormal(new RAPIER.Ray({ x: 0, y: 5, z: -20 }, { x: 0, y: -1, z: 0 }), 100, true);
    expect(down).not.toBeNull();
    close(down!.timeOfImpact, 5, 1e-3);
    close(down!.normal.y, 1, 1e-3);
    const up = world.castRayAndGetNormal(new RAPIER.Ray({ x: 0, y: 15, z: -20 }, { x: 0, y: 1, z: 0 }), 100, true);
    expect(up).not.toBeNull();
    close(up!.timeOfImpact, 5, 1e-3);
    close(up!.normal.y, -1, 1e-3);
    const n = new Vector3(up!.normal.x, up!.normal.y, up!.normal.z);
    expect(n.y).toBeLessThan(-0.99);
  });
});
