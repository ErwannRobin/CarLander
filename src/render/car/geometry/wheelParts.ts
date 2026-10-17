/**
 * Wheel geometry, built in a wheel-local frame: axle along +X (outboard = +X), centre at origin.
 * Left wheels reuse the same geometry rotated by PI about Y (see CarModel), so nothing is mirrored.
 *
 * Parts:
 *  - tire: lathe with a real sidewall bulge, rounded shoulders and 4 circumferential grooves
 *  - rim (vertex-coloured metal): concave forged 10-spoke face, machined lip, barrel, hub, centre lock,
 *    plus the rotating brake disc and bell (merged so one draw call spins with the wheel)
 *  - blur dish: concave surface over the spokes, faded in at high spin rates to avoid strobing
 *  - caliper: fixed (steers with the wheel, never spins)
 */
import { BufferGeometry, Color } from 'three';
import { VEHICLE } from '@/game/vehicleSpec';
import { concatGeometries, gridGeometry, latheGeometry, loftRings, mergeParts, paintVertexColor, paintVertexColorBy } from './loft';

export const WHEEL_R: number = VEHICLE.wheelRadius;
/** Rim flange radius (21" class rim on a low-profile tire). */
export const RIM_R = 0.268;
const BARREL_R = 0.246;
const HUB_R = 0.072;
const SPOKES = 10;

export interface WheelGeometrySet {
  tire: BufferGeometry;
  rim: BufferGeometry;
  blur: BufferGeometry;
  caliper: BufferGeometry;
  /** Half width used to build (for placement / debugging). */
  halfWidth: number;
}

type P2 = [number, number];

/** Duplicate a profile point to create a crease. */
function crease(pts: P2[], p: P2): void {
  pts.push(p, [p[0], p[1]]);
}

function tireProfile(width: number): P2[] {
  const hw = width / 2;
  const ht = hw - 0.024; // tread half width
  const R = WHEEL_R;
  const pts: P2[] = [];
  // inner bead -> inner sidewall (outside on the right: radius right, height up)
  pts.push([RIM_R - 0.004, -hw + 0.02]);
  pts.push([RIM_R + 0.006, -hw + 0.006]);
  pts.push([0.29, -hw + 0.0015]);
  pts.push([0.31, -hw]);
  pts.push([0.327, -hw + 0.0025]);
  pts.push([0.34, -hw + 0.008]);
  pts.push([0.349, -hw + 0.014]);
  pts.push([0.355, -ht - 0.003]);
  pts.push([0.3585, -ht + 0.003]);
  pts.push([R, -ht + 0.012]);
  // tread with grooves (symmetric about 0)
  const grooves = [-0.62, -0.22, 0.22, 0.62].map((f) => f * ht);
  const gw = 0.0115;
  const depth = 0.009;
  for (const g of grooves) {
    crease(pts, [R, g - gw / 2]);
    pts.push([R - depth, g - gw / 2 + 0.0015]);
    pts.push([R - depth, g + gw / 2 - 0.0015]);
    crease(pts, [R, g + gw / 2]);
  }
  pts.push([R, ht - 0.012]);
  pts.push([0.3585, ht - 0.003]);
  pts.push([0.355, ht + 0.003]);
  pts.push([0.349, hw - 0.014]);
  pts.push([0.34, hw - 0.008]);
  pts.push([0.327, hw - 0.0025]);
  pts.push([0.31, hw]);
  pts.push([0.292, hw - 0.002]);
  // rim protector rib on the outer sidewall
  pts.push([0.281, hw - 0.004]);
  pts.push([0.276, hw + 0.002]);
  pts.push([RIM_R + 0.003, hw - 0.004]);
  pts.push([RIM_R - 0.004, hw - 0.02]);
  return pts;
}

/** Concave spoke face height (axial) as a function of radius. */
function spokeFaceH(r: number, hw: number): number {
  const hHub = hw - 0.098;
  const hLip = hw - 0.02;
  const t = Math.min(1, Math.max(0, (r - HUB_R) / (BARREL_R - HUB_R)));
  return hHub + (hLip - hHub) * Math.pow(t, 1.55);
}

const C_SPOKE_SIDE = new Color('#22272c');
const C_SPOKE_FACE = new Color('#a6aeb7');
const C_LIP = new Color('#b9c0c8');
const C_BARREL = new Color('#121417');
const C_NUT = new Color('#cfd4da');
const C_DISC = new Color('#70757b');
const C_HAT = new Color('#24272b');
const C_HUB = new Color('#2c3238');

/** Five twin-spoke pairs: each pair merges at the hub and splays towards the rim (forged look). */
const PAIRS = 5;

/**
 * Closed loft with one flat facet per section edge: every facet owns its vertices, so the machined
 * face, the chamfers and the flanks shade as crisp flats (a smooth closed loft of a 6-point section
 * reads as a bent tube). Same triangle count as the smooth loft; normals stay smooth along the path.
 * `rings` = ring-major xyz, every ring with the same number of points.
 */
function facetedLoft(rings: number[][]): BufferGeometry {
  const n = rings.length;
  const m = rings[0].length / 3;
  const facets: BufferGeometry[] = [];
  for (let j = 0; j < m; j++) {
    const j1 = (j + 1) % m;
    const pos = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const r = rings[i];
      for (let a = 0; a < 3; a++) {
        pos[i * 6 + a] = r[j * 3 + a];
        pos[i * 6 + 3 + a] = r[j1 * 3 + a];
      }
    }
    // same (ring, point) ordering as loftRings' closed grid => same outward winding
    facets.push(gridGeometry(pos, n, 2));
  }
  return concatGeometries(facets);
}

function buildSpokes(hw: number): BufferGeometry {
  const geos: BufferGeometry[] = [];
  const steps = 18;
  for (let p = 0; p < PAIRS; p++) {
    for (const sgn of [-1, 1]) {
      const rings: number[][] = [];
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const r = HUB_R - 0.014 + (BARREL_R + 0.004 - (HUB_R - 0.014)) * t;
        const phi = (p / PAIRS) * Math.PI * 2 + sgn * (0.045 + 0.075 * Math.pow(t, 1.1));
        const ry = Math.cos(phi);
        const rz = Math.sin(phi);
        const ty = -rz;
        const tz = ry;
        const h = spokeFaceH(r, hw);
        const wf = 0.046 - 0.016 * t; // face width
        const wb = wf * 0.62; // back width
        const d = 0.036 - 0.013 * t; // depth
        const ch = 0.0055; // chamfer
        const sec: P2[] = [
          [-wf / 2, -ch],
          [-wf / 2 + ch, 0],
          [wf / 2 - ch, 0],
          [wf / 2, -ch],
          [wb / 2, -d],
          [-wb / 2, -d],
        ];
        const ring: number[] = [];
        for (const [to, ho] of sec) ring.push(h + ho, ry * r + ty * to, rz * r + tz * to);
        rings.push(ring);
      }
      geos.push(facetedLoft(rings));
    }
  }
  const g = mergeParts(geos);
  // machined (diamond-cut) faces, dark graphite flanks
  const nrm = g.getAttribute('normal');
  return paintVertexColorBy(g, (_, c, i) => {
    const nx = nrm.getX(i ?? 0);
    c.copy(C_SPOKE_SIDE).lerp(C_SPOKE_FACE, Math.min(1, Math.max(0, (nx - 0.62) / 0.25)));
  });
}

function buildRim(hw: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  // lip + barrel (outside on the right)
  const lip: P2[] = [];
  lip.push([RIM_R - 0.003, hw - 0.022]);
  lip.push([RIM_R + 0.006, hw - 0.016]);
  lip.push([RIM_R + 0.007, hw - 0.01]);
  lip.push([RIM_R + 0.002, hw - 0.0045]);
  lip.push([RIM_R - 0.008, hw - 0.004]);
  lip.push([BARREL_R + 0.004, hw - 0.008]);
  crease(lip, [BARREL_R, hw - 0.014]);
  lip.push([BARREL_R, -hw + 0.03]);
  lip.push([BARREL_R + 0.008, -hw + 0.02]);
  const lipGeo = latheGeometry(lip, { axis: 'x', segments: 72 });
  paintVertexColorBy(lipGeo, (p, c) => {
    const r = Math.hypot(p.y, p.z);
    c.copy(r > BARREL_R + 0.003 ? C_LIP : C_BARREL);
  });
  parts.push(lipGeo);

  // spokes
  parts.push(buildSpokes(hw));

  // hub face + centre lock
  const hHub = spokeFaceH(HUB_R, hw);
  const hub: P2[] = [
    [HUB_R + 0.004, hHub - 0.03],
    [HUB_R + 0.004, hHub - 0.004],
    [HUB_R - 0.004, hHub + 0.002],
    [0.042, hHub + 0.006],
    [0.038, hHub + 0.006],
  ];
  parts.push(paintVertexColor(latheGeometry(hub, { axis: 'x', segments: 40 }), C_HUB));
  // centre lock: low hexagonal nut (non-indexed for crisp flats) under a domed titanium cap
  const nut: P2[] = [
    [0.0335, hHub + 0.004],
    [0.0335, hHub + 0.019],
    [0.029, hHub + 0.0235],
  ];
  const nutGeo = latheGeometry(nut, { axis: 'x', segments: 6, phiStart: Math.PI / 6 }).toNonIndexed();
  nutGeo.computeVertexNormals();
  parts.push(paintVertexColor(nutGeo, C_NUT));
  const cap: P2[] = [
    [0.0262, hHub + 0.022],
    [0.0262, hHub + 0.027],
    [0.022, hHub + 0.0325],
    [0.014, hHub + 0.0355],
    [0.0, hHub + 0.0365],
  ];
  parts.push(paintVertexColor(latheGeometry(cap, { axis: 'x', segments: 36 }), C_LIP));

  // brake disc (rotates with the wheel) + bell
  const dIn = 0.118;
  const dOut = 0.206;
  const h0 = -0.052;
  const h1 = -0.02;
  const disc: P2[] = [];
  crease(disc, [dOut, h1]);
  crease(disc, [dIn, h1]);
  crease(disc, [dIn, h0]);
  crease(disc, [dOut, h0]);
  disc.push([dOut, h1]);
  const discGeo = latheGeometry(disc, { axis: 'x', segments: 64 });
  paintVertexColorBy(discGeo, (p, c) => {
    const r = Math.hypot(p.y, p.z);
    const t = (r - dIn) / (dOut - dIn);
    // subtle concentric banding reads as a machined friction ring
    const band = 0.85 + 0.15 * Math.cos(t * Math.PI * 9);
    c.copy(C_DISC).multiplyScalar(t < 0.08 ? 0.55 : band);
  });
  parts.push(discGeo);
  const bell: P2[] = [];
  crease(bell, [dIn + 0.002, h1 + 0.001]);
  crease(bell, [dIn - 0.004, h1 + 0.001]);
  bell.push([dIn - 0.008, hHub - 0.03]);
  crease(bell, [HUB_R + 0.004, hHub - 0.03]);
  const bellGeo = latheGeometry(bell, { axis: 'x', segments: 48 });
  parts.push(paintVertexColor(bellGeo, C_HAT));

  return mergeParts(parts, true);
}

function buildTire(width: number): BufferGeometry {
  return latheGeometry(tireProfile(width), { axis: 'x', segments: 80 });
}

function buildBlur(hw: number): BufferGeometry {
  const pts: P2[] = [];
  const n = 14;
  for (let k = 0; k <= n; k++) {
    const r = BARREL_R - 0.002 - ((BARREL_R - 0.002 - (HUB_R - 0.002)) * k) / n;
    pts.push([r, spokeFaceH(r, hw) + 0.004]);
  }
  return latheGeometry(pts, { axis: 'x', segments: 64 });
}

/** Caliper body centred at phi = 0 (top of the disc); rotate about X to position it. */
function buildCaliper(): BufferGeometry {
  const span = 0.86; // radians
  const rIn = 0.152;
  const rOut = 0.229;
  const hIn = -0.088;
  const hOut = 0.016;
  const rr = 0.01; // corner radius
  const steps = 18;
  // rounded rectangle section in (r, h), closed loop
  const sec: P2[] = [];
  const corners: [number, number, number][] = [
    [rOut - rr, hOut - rr, 0],
    [rIn + rr, hOut - rr, Math.PI / 2],
    [rIn + rr, hIn + rr, Math.PI],
    [rOut - rr, hIn + rr, (3 * Math.PI) / 2],
  ];
  for (const [cr, ch, a0] of corners) {
    for (let k = 0; k <= 3; k++) {
      const a = a0 + (k / 3) * (Math.PI / 2);
      sec.push([cr + Math.cos(a) * rr, ch + Math.sin(a) * rr]);
    }
  }
  const rings: number[][] = [];
  const cR = (rIn + rOut) / 2;
  const cH = (hIn + hOut) / 2;
  for (let k = -1; k <= steps + 1; k++) {
    // first/last rings collapse to the centroid to cap the ends (with a small taper ring)
    const kk = Math.min(steps, Math.max(0, k));
    const t = kk / steps;
    const phi = -span / 2 + span * t;
    const ring: number[] = [];
    const taper = k < 0 || k > steps ? 0 : k === 0 || k === steps ? 0.82 : 1;
    for (const [r, h] of sec) {
      const rrr = cR + (r - cR) * taper;
      const hhh = cH + (h - cH) * taper;
      ring.push(hhh, Math.cos(phi) * rrr, Math.sin(phi) * rrr);
    }
    rings.push(ring);
  }
  const geo = loftRings(rings, { closedRing: true });
  return paintVertexColor(geo, '#ffffff');
}

const cache = new Map<number, WheelGeometrySet>();

/** Wheel geometry for a given tire width (front / rear share the rest of the design). */
export function buildWheelSet(width: number): WheelGeometrySet {
  const key = Math.round(width * 1000);
  const hit = cache.get(key);
  if (hit) return hit;
  const hw = width / 2;
  const set: WheelGeometrySet = {
    tire: buildTire(width),
    rim: buildRim(hw),
    blur: buildBlur(hw),
    caliper: buildCaliper(),
    halfWidth: hw,
  };
  cache.set(key, set);
  return set;
}

/** Forget cached wheel geometry (after disposal). */
export function clearWheelCache(): void {
  cache.clear();
}
