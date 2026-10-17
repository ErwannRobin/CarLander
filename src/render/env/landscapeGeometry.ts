/**
 * Distant landscape geometry: concentric polar height-field bands (2.2–6.9 km) around the origin.
 * Heights are relative to the cloud-sea top (the mesh is placed at y = seaTop); band bases sink
 * well below it so they are hidden by the clouds / haze.
 *
 *  - mountains: ridged multifractal ranges, broken into massifs by an azimuthal mask so the horizon
 *    alternates between majestic ranges and open cloud sea;
 *  - mesas: terraced plateaus with near-vertical cliffs, talus aprons and a far escarpment.
 *
 * Built on the CPU once per (kind, seed, detail) and cached; geometry objects are recreated from
 * the cached arrays, so disposing them on unmount is cheap and safe.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { fbm, Perlin2, ridged, smoothstep } from './noise';

export type LandscapeKind = 'mountains' | 'mesas';

interface Band {
  r0: number;
  r1: number;
  /** angular segments at detail 1 */
  segments: number;
  rows: number;
  /** peak height above the cloud top (m) */
  amp: number;
  /** horizontal feature size (m) */
  feature: number;
  /** azimuthal massif mask threshold (higher = sparser) */
  sparsity: number;
}

const MOUNTAIN_BANDS: Band[] = [
  { r0: 2300, r1: 3700, segments: 2000, rows: 22, amp: 360, feature: 1250, sparsity: 0.58 },
  { r0: 3500, r1: 5200, segments: 1500, rows: 18, amp: 620, feature: 1800, sparsity: 0.5 },
  { r0: 5000, r1: 6900, segments: 1000, rows: 14, amp: 980, feature: 2600, sparsity: 0.38 },
];

const MESA_BANDS: Band[] = [
  { r0: 2200, r1: 3700, segments: 2000, rows: 28, amp: 300, feature: 1300, sparsity: 0.5 },
  { r0: 3500, r1: 5300, segments: 1600, rows: 22, amp: 380, feature: 1700, sparsity: 0.4 },
  { r0: 5100, r1: 6900, segments: 1200, rows: 16, amp: 430, feature: 2400, sparsity: 0.25 },
];

const BASE = -170; // band base below the cloud top

interface Cached {
  positions: Float32Array;
  rock: Float32Array;
  indices: Uint32Array;
}
const cache = new Map<string, Cached>();

function massif(noise: Perlin2, theta: number, band: number, sparsity: number): number {
  // seamless 1D noise around the circle
  const k = 2.2 + band * 0.9;
  const n = fbm(noise, Math.cos(theta) * k + band * 31.7, Math.sin(theta) * k - band * 17.3, 4) * 0.5 + 0.5;
  return smoothstep(sparsity - 0.12, sparsity + 0.18, n);
}

function mountainHeight(noise: Perlin2, x: number, z: number, t: number, theta: number, bi: number, b: Band): number {
  const prof = smoothstep(0, 0.4, t) * (1 - smoothstep(0.62, 1, t));
  const m = massif(noise, theta, bi, b.sparsity);
  if (prof * m <= 0) return BASE;
  const f = 1 / b.feature;
  const r = ridged(noise, x * f + bi * 13.1, z * f - bi * 7.7, 7);
  const lift = Math.pow(r * 1.2, 1.7);
  return BASE + (b.amp - BASE) * prof * m * lift;
}

function mesaHeight(noise: Perlin2, x: number, z: number, t: number, theta: number, bi: number, b: Band): number {
  const prof = smoothstep(0, 0.22, t) * (1 - smoothstep(0.8, 1, t));
  const m = bi === 2 ? 1 : massif(noise, theta, bi, b.sparsity);
  const f = 1 / b.feature;
  // domain warp gives eroded, irregular plateau outlines
  const wx = fbm(noise, x * f * 1.7 + 5.2, z * f * 1.7 - 3.1, 3) * 0.35;
  const wz = fbm(noise, x * f * 1.7 - 9.4, z * f * 1.7 + 1.3, 3) * 0.35;
  let n = fbm(noise, x * f + wx + bi * 21.3, z * f + wz - bi * 4.9, 5) * 0.5 + 0.5;
  n += fbm(noise, x * f * 6, z * f * 6, 2) * 0.025; // ragged cliff edges
  n = n * (0.55 + 0.45 * m) * prof + (bi === 2 ? 0.12 * prof : 0);
  const talus = smoothstep(0.4, 0.52, n);
  const tier1 = smoothstep(0.52, 0.545, n);
  const tier2 = smoothstep(0.64, 0.66, n);
  const tier3 = smoothstep(0.73, 0.745, n);
  const top = b.amp;
  return BASE + 110 * talus + (top * 0.55 - BASE - 110) * tier1 + top * 0.3 * tier2 + top * 0.25 * tier3;
}

function build(kind: LandscapeKind, seed: number, detail: number, heightScale: number): Cached {
  const noise = new Perlin2(seed);
  const bands = kind === 'mesas' ? MESA_BANDS : MOUNTAIN_BANDS;
  let vCount = 0;
  let iCount = 0;
  const dims = bands.map((b) => {
    const seg = Math.max(256, Math.round(b.segments * detail));
    const rows = Math.max(8, Math.round(b.rows * (0.6 + 0.4 * detail)));
    vCount += (seg + 1) * (rows + 1);
    iCount += seg * rows * 6;
    return { seg, rows };
  });
  const positions = new Float32Array(vCount * 3);
  const rock = new Float32Array(vCount);
  const indices = new Uint32Array(iCount);
  let v = 0;
  let ii = 0;
  bands.forEach((b, bi) => {
    const { seg, rows } = dims[bi];
    const first = v;
    for (let i = 0; i <= seg; i++) {
      const theta = ((i % seg) / seg) * Math.PI * 2;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      for (let j = 0; j <= rows; j++) {
        const t = j / rows;
        const r = b.r0 + (b.r1 - b.r0) * Math.pow(t, 0.92);
        const x = c * r;
        const z = s * r;
        const h =
          kind === 'mesas' ? mesaHeight(noise, x, z, t, theta, bi, b) : mountainHeight(noise, x, z, t, theta, bi, b);
        const y = BASE + (h - BASE) * heightScale;
        positions[v * 3] = x;
        positions[v * 3 + 1] = y;
        positions[v * 3 + 2] = z;
        rock[v] = noise.noise(x * 0.004 + 3.3, z * 0.004 - 1.7) * 0.5 + 0.5;
        v++;
      }
    }
    const stride = rows + 1;
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < rows; j++) {
        // counter-clockwise seen from above (radial x tangential points down, so swap)
        const a = first + i * stride + j;
        const b2 = a + stride;
        indices[ii++] = a;
        indices[ii++] = b2;
        indices[ii++] = a + 1;
        indices[ii++] = b2;
        indices[ii++] = b2 + 1;
        indices[ii++] = a + 1;
      }
    }
  });
  return { positions, rock, indices };
}

/** Returns a fresh BufferGeometry backed by cached arrays (dispose it freely). */
export function createLandscapeGeometry(kind: LandscapeKind, seed: number, detail: number, heightScale: number): BufferGeometry {
  const key = `${kind}:${seed}:${detail}:${heightScale}`;
  let data = cache.get(key);
  if (!data) {
    data = build(kind, seed, detail, heightScale);
    cache.set(key, data);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('aRock', new BufferAttribute(data.rock, 1));
  g.setIndex(new BufferAttribute(data.indices, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
