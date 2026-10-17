import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { orientationFromAngles } from '@/game/track/TrackPath';
import { GeoBuilder, loftSections, taperedPrism, type LoftSection, type Vec2 } from '@/render/level/geometry/GeoBuilder';
import { addPylon } from '@/render/level/geometry/supports';

// pre-fix addPylon (verbatim logic) for comparison
function shaftSection(hx: number, hz: number): Vec2[] {
  const c = Math.min(hx, hz) * 0.22, g = hz * 0.34, e = Math.min(hx * 0.12, 0.22);
  return [[-hx + c, hz], [hx - c, hz], [hx, hz - c], [hx, g / 2], [hx - e, g / 2], [hx - e, -g / 2], [hx, -g / 2], [hx, -hz + c], [hx - c, -hz], [-hx + c, -hz], [-hx, -hz + c], [-hx, -g / 2], [-hx + e, -g / 2], [-hx + e, g / 2], [-hx, g / 2], [-hx, hz - c]];
}
function oldPylon(b: GeoBuilder, p: { top: Vector3; quaternion: Quaternion; deckWidth: number; bottomY: number }) {
  const W = p.deckWidth, hx = Math.min(3.2, Math.max(1.3, W * 0.075)), hz = hx * 0.58, span = W * 0.34, headHz = hz * 1.9;
  const flareH = Math.min(18, Math.max(7, span * 1.25));
  const fwd = new Vector3(0, 0, -1).applyQuaternion(p.quaternion), yaw = Math.atan2(-fwd.x, -fwd.z);
  const headM = new Matrix4().compose(p.top, p.quaternion, new Vector3(1, 1, 1));
  taperedPrism(b, shaftSection(span, headHz), -0.55, 0.02, [1, 1], [1, 1], { matrix: headM, capBottom: false });
  const bandBottom = new Vector3(0, -0.55, 0).applyMatrix4(headM), topY = bandBottom.y + 0.05, len = topY - p.bottomY;
  const m = new Matrix4().compose(new Vector3(bandBottom.x, 0, bandBottom.z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw), new Vector3(1, 1, 1));
  const sections: LoftSection[] = [{ y: p.bottomY, sx: 1, sz: 1 }];
  for (let i = 0; i <= 9; i++) { const e = Math.pow(i / 9, 2.6); sections.push({ y: topY - flareH * (1 - i / 9), sx: 1 + (span / hx - 1) * e, sz: 1 + (headHz / hz - 1) * e }); }
  void len;
  loftSections(b, shaftSection(hx, hz), sections, m);
}

/** Highest pylon vertex relative to the drive surface plane (m, + = pierces the deck). */
function pierce(make: (b: GeoBuilder, p: Parameters<typeof addPylon>[1]) => void, W: number, pitch: number, roll: number, thickness = 1.2) {
  const q = orientationFromAngles(0, pitch, roll);
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  const deck = new Vector3(0, 50, 0);
  const b = new GeoBuilder();
  make(b, { top: deck.clone().addScaledVector(up, -thickness), quaternion: q, deckWidth: W, bottomY: -400 });
  let max = -Infinity;
  const v = new Vector3();
  for (let i = 0; i < b.pos.length; i += 3) {
    v.set(b.pos[i], b.pos[i + 1], b.pos[i + 2]).sub(deck);
    // only points inside the deck footprint count (head span < W/2)
    max = Math.max(max, v.dot(up));
  }
  return max;
}

describe('pylon head never pierces the drive surface', () => {
  const cases: [number, number, number][] = [[26, 0, 0], [26, -18, 0], [30, -32, 0], [36, -32, 0], [40, -30, 0], [26, 0, 15], [34, -24, 0]];
  for (const [W, pitch, roll] of cases) {
    it(`W=${W} pitch=${pitch} roll=${roll}`, () => {
      const before = pierce(oldPylon, W, pitch, roll);
      const after = pierce(addPylon, W, pitch, roll);
      console.log(`W=${W} pitch=${pitch} roll=${roll}: old ${before.toFixed(3)} m  new ${after.toFixed(3)} m (relative to drive surface)`);
      expect(after).toBeLessThan(-1.0); // stays inside / below the 1.2 m slab (head top is 2 cm into its underside)
    });
  }
});
