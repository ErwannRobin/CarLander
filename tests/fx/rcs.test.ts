import { describe, expect, it } from 'vitest';

import { allocateRcs, rcsJetLevels, RCS_TORQUE, RCS_VISIBLE_FULL, RCS_VISIBLE_MIN } from '@/render/fx/effects/rcsAllocation';
import { RCS_PORTS, VEHICLE } from '@/game/vehicleSpec';

/**
 * Hand-derived expectations (chassis: right +X, up +Y, forward -Z; jet dir = exhaust, force = -dir):
 *  pitch + (about +X, nose up)   : front down-jets (2,3) push the nose up, rear up-jets (6,7) push the tail down
 *  pitch - (nose down)           : front up-jets (0,1), rear down-jets (8,9)
 *  yaw + (about +Y, nose left)   : front right-jet (5) pushes the nose left, rear left-jet (10) pushes the tail right
 *  yaw - (nose right)            : front left-jet (4), rear right-jet (11)
 *  roll + (roll right, about -Z) : right up-jets (1,7) push the right side down, left down-jets (2,8) push the left side up
 *  roll - (roll left)            : left up-jets (0,6), right down-jets (3,9)
 */
const CASES: [string, number, number, number, number[]][] = [
  ['pitch up', 1, 0, 0, [2, 3, 6, 7]],
  ['pitch down', -1, 0, 0, [0, 1, 8, 9]],
  ['yaw left', 0, 1, 0, [5, 10]],
  ['yaw right', 0, -1, 0, [4, 11]],
  ['roll right', 0, 0, 1, [1, 2, 7, 8]],
  ['roll left', 0, 0, -1, [0, 3, 6, 9]],
  // mixed: pitch up + roll right -> only the diagonal ports that serve both
  ['pitch up + roll right', 1, 0, 1, [2, 7]],
  ['pitch down + roll left', -1, 0, -1, [0, 9]],
];

const active = (out: Float32Array) => [...out].map((a, i) => (a > 0.05 ? i : -1)).filter((i) => i >= 0);

/** Independent torque computation (no shared code with rcsAllocation). */
function torque(i: number): [number, number, number] {
  const p = RCS_PORTS[i].position;
  const d = RCS_PORTS[i].dir;
  const c = VEHICLE.centerOfMass;
  const r = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const f = [-d[0], -d[1], -d[2]];
  const t = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return [t[0], t[1], -t[2]]; // pitch about +X, yaw about +Y, roll-right about -Z
}

describe('RCS port allocation', () => {
  for (const [name, p, y, r, expected] of CASES) {
    it(name, () => {
      const out = allocateRcs(p, y, r, new Float32Array(RCS_PORTS.length));
      expect(active(out)).toEqual(expected);
      // every active port's real torque must push the commanded axes the right way
      for (const i of expected) {
        const t = torque(i);
        expect(t[0] * p + t[1] * y + t[2] * r).toBeGreaterThan(0);
        expect(out[i]).toBeGreaterThan(0.5);
      }
    });
  }
  it('zero command -> no jets; tiny command stays in the deadzone', () => {
    expect(active(allocateRcs(0, 0, 0, new Float32Array(12)))).toEqual([]);
    expect(active(allocateRcs(0.1, -0.1, 0.1, new Float32Array(12)))).toEqual([]);
  });
  it('outputs are always in [0, 1] and finite', () => {
    const out = new Float32Array(12);
    for (let k = 0; k < 2000; k++) {
      allocateRcs(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1, out);
      for (const a of out) {
        expect(Number.isFinite(a)).toBe(true);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
  });
  it('normalized torque table is consistent with an independent computation', () => {
    for (let i = 0; i < RCS_PORTS.length; i++) {
      const t = torque(i);
      for (let k = 0; k < 3; k++) expect(Math.sign(RCS_TORQUE[i][k]) + 0).toBe(Math.abs(t[k]) < 1e-9 ? 0 : Math.sign(t[k]));
    }
  });

  describe('rcsJetLevels (visual levels)', () => {
    for (const [name, p, y, r, expected] of CASES) {
      it(`${name}: same ports at full and gentle magnitudes`, () => {
        const full = rcsJetLevels(p, y, r, new Float32Array(12));
        expect(active(full)).toEqual(expected);
        for (const i of expected) expect(full[i]).toBeGreaterThan(0.9);
        // the stabilizer's slow-roll corrections (~0.1-0.2) still select the same ports, fainter
        const k = 0.15 / Math.hypot(p, y, r);
        const gentle = rcsJetLevels(p * k, y * k, r * k, new Float32Array(12));
        expect(active(gentle)).toEqual(expected);
        for (const i of expected) {
          expect(gentle[i]).toBeGreaterThan(0.3);
          expect(gentle[i]).toBeLessThan(0.6);
        }
      });
    }
    it('flight-assist noise, zero and NaN stay dark', () => {
      expect(active(rcsJetLevels(0.02, -0.01, 0.01, new Float32Array(12)))).toEqual([]);
      expect(active(rcsJetLevels(0, 0, 0, new Float32Array(12)))).toEqual([]);
      expect(active(rcsJetLevels(NaN, 0.5, 0, new Float32Array(12)))).toEqual([]);
    });
    it('levels ramp monotonically with magnitude between the thresholds', () => {
      let prev = -1;
      for (let m = 0; m <= 1; m += 0.01) {
        const l = rcsJetLevels(m, 0, 0, new Float32Array(12))[2];
        expect(l).toBeGreaterThanOrEqual(prev);
        if (m <= RCS_VISIBLE_MIN) expect(l).toBe(0);
        if (m >= RCS_VISIBLE_FULL) expect(l).toBeCloseTo(1, 5);
        prev = l;
      }
    });
    it('real L3 release trace (sim rcs samples) keeps a jet lit through the roll', () => {
      // (pitch, yaw, roll) sampled from the real sim while the stabilizer rights the car after release
      const trace = [[0, 0.3, 0.67], [0.01, 0.18, 0.4], [0.02, 0.11, 0.24], [0.04, 0.08, 0.14], [0.06, 0.06, 0.08], [0.1, 0.02, -0.09], [0.11, -0.0, -0.13], [0.1, -0.02, -0.15], [0.08, -0.04, -0.15], [0.05, -0.05, -0.12]];
      for (const [p, y, r] of trace) {
        const l = rcsJetLevels(p, y, r, new Float32Array(12));
        expect(Math.max(...l)).toBeGreaterThan(0.1);
        // and the legacy magnitude-blind allocation would have been dark for most of them
      }
      const darkLegacy = trace.filter(([p, y, r]) => Math.max(...allocateRcs(p, y, r, new Float32Array(12))) < 0.1).length;
      expect(darkLegacy).toBeGreaterThanOrEqual(6);
    });
  });
});
