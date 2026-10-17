/**
 * Procedural rock: canyon walls and spires in warm sandstone.
 *
 * Both use the same geological model: a seeded stack of alternating HARD (cliff-forming, light
 * sandstone, vertical) and SOFT (bench-forming, redder siltstone, receding) layers. Walls step
 * back at every soft layer (classic stepped canyon profile), get large buttresses/alcoves, a few
 * deep clefts and desert-varnish streaks; spires erode inward at soft layers into stacked plates
 * under a cap rock. Geometry is displaced once on the CPU, vertex-colored, and shaded with the
 * shared rock material (vertex colors + tiling grain normal map). One draw call each.
 */
import { BufferAttribute, BufferGeometry, Color, Group, Mesh } from 'three';
import { getLevelMaterials } from '../materials';
import { useKitBuild, ValueNoise, type Disposable, type KitTransform } from './common';

/** Warm sandstone palette (sRGB): first half hard cliff tones, second half soft siltstone tones. */
export const SANDSTONE = ['#d39b6b', '#c98b5c', '#ddae80', '#c08055', '#a9623f', '#b56f48', '#9e5a3a', '#bd7a52'];

function KitRoot({ t, object }: { t: KitTransform; object: Group }) {
  return (
    <group name={t.name} position={t.position} rotation={t.rotation} scale={t.scale}>
      <primitive object={object} />
    </group>
  );
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function rng(seed: number): () => number {
  let a = (seed * 9301 + 49297) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Layer {
  y0: number;
  y1: number;
  hard: boolean;
  /** Horizontal setback produced across this layer (soft layers only), as a fraction of its thickness. */
  slope: number;
  color: Color;
  /** Accumulated setback at y0 (filled by buildStrata). */
  base: number;
}

/** Seeded alternating stack covering [yMin, yMax]. `slope` scales bench setbacks. */
function buildStrata(yMin: number, yMax: number, thickness: number, slope: number, seed: number, palette: string[]): Layer[] {
  const r = rng(seed);
  const half = Math.max(1, Math.floor(palette.length / 2));
  const layers: Layer[] = [];
  let y = yMin;
  let hard = r() > 0.4;
  let base = 0;
  while (y < yMax) {
    const t = hard ? thickness * (0.8 + r() * 1.6) : thickness * (0.3 + r() * 0.5);
    const color = new Color(hard ? palette[Math.floor(r() * half)] : palette[half + Math.floor(r() * (palette.length - half))]);
    // soft layers lean towards the cliff tones so bands read as strata, not stripes
    if (!hard) color.lerp(new Color(palette[0]), 0.45);
    color.multiplyScalar(0.95 + r() * 0.1);
    const s = hard ? 0 : slope * (0.6 + r() * 0.9);
    layers.push({ y0: y, y1: y + t, hard, slope: s, color, base });
    base += s * t;
    y += t;
    // mostly alternate, sometimes stack two hard layers
    hard = hard ? r() < 0.18 : true;
  }
  return layers;
}

function layerAt(layers: Layer[], y: number): Layer {
  // layers are few (< 60); linear scan is fine at build time
  for (const l of layers) if (y < l.y1) return l;
  return layers[layers.length - 1];
}

/** Accumulated setback at height y (smooth inside soft layers). */
function setbackAt(layers: Layer[], y: number): number {
  const l = layerAt(layers, y);
  if (l.hard) return l.base;
  const f = smoothstep(l.y0, l.y1, y);
  return l.base + l.slope * (l.y1 - l.y0) * f;
}

const _c = new Color();

function finish(pos: number[], col: number[], uv: number[], idx: number[], owned: Disposable[]): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  const uvs = new Float32Array(uv);
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setAttribute('uv1', new BufferAttribute(uvs.slice(), 2));
  g.setIndex(new BufferAttribute(pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  owned.push(g);
  const mesh = new Mesh(g, getLevelMaterials().rock);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* ------------------------------------------------------------------ */
/* CanyonWall                                                           */
/* ------------------------------------------------------------------ */

export interface CanyonWallProps extends KitTransform {
  /** Length along X (m). Default 320. */
  width?: number;
  /** Height (m). Base at y = 0. Default 160. */
  height?: number;
  /** Buttress / alcove amplitude towards +Z (m). Default 22. */
  relief?: number;
  /** Bench setback per soft layer (fraction of its thickness). Default 0.8. */
  benchSlope?: number;
  /** Depth of the plateau behind the rim (m). Default 60. */
  plateau?: number;
  /** Typical hard layer thickness (m). Default: height / 16 (min 6). */
  strata?: number;
  seed?: number;
  /** Vertex spacing (m). Default 2.5 (≈ 8–10k vertices for the default size). */
  resolution?: number;
  palette?: string[];
  /** Plan curvature radius (m), wall bending around +Z; 0 = straight. Default 0. */
  curve?: number;
}

/** Stepped sandstone cliff face (facing +Z): cliffs and benches, buttresses, clefts, plateau. */
export function CanyonWall(props: CanyonWallProps) {
  const {
    width = 320,
    height = 160,
    relief = 22,
    benchSlope = 0.8,
    plateau = 60,
    strata: strataProp,
    seed = 1,
    resolution = 2.5,
    palette = SANDSTONE,
    curve = 0,
  } = props;
  const built = useKitBuild(() => {
    const owned: Disposable[] = [];
    const root = new Group();
    const n = new ValueNoise(seed);
    const strata = strataProp ?? Math.max(6, height / 16);
    const layers = buildStrata(-5, height * 1.2, strata, benchSlope, seed, palette);
    const nx = Math.max(8, Math.round(width / resolution));
    const ny = Math.max(6, Math.round(height / resolution));
    const pos: number[] = [];
    const col: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const place = (x: number, y: number, z: number): [number, number, number] => {
      if (curve <= 0) return [x, y, z];
      const th = x / curve;
      const r = curve - z;
      return [Math.sin(th) * r, y, curve - Math.cos(th) * r];
    };
    const rimY = new Float32Array(nx + 1);
    const rimZ = new Float32Array(nx + 1);
    // stepped mesa skyline
    const skyline = (x: number) => {
      const v = n.fbm2(x / 160 + 5.3, 1.7, 3) * 2.2;
      const q = Math.floor(v);
      return (q + smoothstep(0.75, 1, v - q)) * strata * 0.9;
    };
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = -width / 2 + (i / nx) * width;
        const top = height + skyline(x);
        const y = (j / ny) * top;
        // bench width varies along the wall
        const benchK = 0.55 + 0.9 * (n.fbm2(x / 140, 3.1, 3) * 0.5 + 0.5);
        let z = -setbackAt(layers, y) * benchK;
        // terraced buttresses and alcoves: blocky mesa fronts with crisp transitions
        const bt = n.fbm2(x / 130 + y / 1400, y / 700, 3);
        z += relief * (smoothstep(-0.18, 0.18, bt) - 0.5) * 1.6 + relief * 0.25 * n.fbm2(x / 40, y / 300, 2);
        // a few sharp V-clefts
        const ridge = 1 - Math.abs(n.noise2(x / 60 + 2.2, y / 500));
        z -= relief * 0.8 * Math.pow(ridge, 18) * (0.6 + 0.4 * n.noise2(x / 11, y / 13));
        const l = layerAt(layers, y);
        // texture within layers: vertical fractures in hard rock, crumbly soft rock
        z += l.hard ? 0.9 * n.fbm2(x / 3.5, y / 16, 3) : 0.6 * n.fbm2(x / 2.5, y / 2.5, 2);
        // talus apron at the foot, rounded rim
        z += relief * 0.9 * (1 - smoothstep(0, 0.16 * height, y)) * (0.7 + 0.3 * n.noise2(x / 25, 9.1));
        z -= 3 * smoothstep(top - 3, top, y);
        const p = place(x, y, z);
        pos.push(p[0], p[1], p[2]);
        uv.push(x, y);
        // color: layer tone, darker in clefts, desert-varnish streaks below ledges on hard faces
        _c.copy(l.color);
        const fromTop = (l.y1 - y) / Math.max(1, l.y1 - l.y0);
        const varnish = l.hard ? smoothstep(0.55, 0.85, n.noise2(x / 5 + 11, y / 60)) * (0.4 + 0.6 * fromTop) : 0;
        _c.multiplyScalar((1 - 0.25 * varnish) * (1 - 0.25 * Math.pow(ridge, 18)));
        col.push(_c.r, _c.g, _c.b);
        if (j === ny) {
          rimY[i] = y;
          rimZ[i] = z;
        }
      }
    }
    const row = nx + 1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * row + i;
        idx.push(a, a + 1, a + row + 1, a, a + row + 1, a + row);
      }
    }
    // plateau behind the rim
    const base = pos.length / 3;
    const pz = Math.max(4, Math.round(plateau / (resolution * 2)));
    const capColor = layerAt(layers, height).color;
    for (let k = 0; k <= pz; k++) {
      for (let i = 0; i <= nx; i++) {
        const x = -width / 2 + (i / nx) * width;
        const t = k / pz;
        const z = rimZ[i] - t * plateau;
        const y = rimY[i] + 1.2 * n.fbm2(x / 25, z / 25, 3) * t;
        const p = place(x, y, z);
        pos.push(p[0], p[1], p[2]);
        uv.push(x, z);
        _c.copy(capColor).multiplyScalar(1.02 + 0.1 * n.noise2(x / 9, z / 9));
        col.push(_c.r, _c.g, _c.b);
      }
    }
    for (let k = 0; k < pz; k++) {
      for (let i = 0; i < nx; i++) {
        const a = base + k * row + i;
        // columns advance along +X, rows towards -Z => x cross (-z) = +y (faces up)
        idx.push(a, a + 1, a + row + 1, a, a + row + 1, a + row);
      }
    }
    root.add(finish(pos, col, uv, idx, owned));
    return { root, owned };
  }, [width, height, relief, benchSlope, plateau, strataProp, seed, resolution, palette.join(), curve]);
  return <KitRoot t={props} object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* RockSpire                                                            */
/* ------------------------------------------------------------------ */

export interface RockSpireProps extends KitTransform {
  /** Height above y = 0 (m). Default 120. */
  height?: number;
  /** Base radius (m). Default 16. */
  radius?: number;
  /** Top radius / base radius. Default 0.6. */
  taper?: number;
  /** Lean (deg) towards +X. Default 0. */
  lean?: number;
  /** Typical hard layer thickness (m). Default 8. */
  strata?: number;
  /** Extend below y = 0 (m). Default 30. */
  below?: number;
  seed?: number;
  /** Radial segments. Default 24. */
  segments?: number;
  palette?: string[];
}

/** Eroded sandstone butte / hoodoo: stacked hard plates over eroded soft layers, under a cap rock. */
export function RockSpire(props: RockSpireProps) {
  const { height = 120, radius = 16, taper = 0.6, lean = 0, strata = 8, below = 30, seed = 3, segments = 24, palette = SANDSTONE } = props;
  const built = useKitBuild(() => {
    const owned: Disposable[] = [];
    const root = new Group();
    const n = new ValueNoise(seed);
    const layers = buildStrata(-below, height + 1, strata, 0, seed + 7, palette);
    // per-layer center jitter -> irregular stacked plates
    const r = rng(seed + 13);
    const jitter = layers.map(() => [(r() - 0.5) * 0.12 * radius, (r() - 0.5) * 0.12 * radius]);
    const rings = Math.max(10, Math.round((height + below) / 1.6));
    const pos: number[] = [];
    const col: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const leanK = Math.tan((lean * Math.PI) / 180);
    const seg = segments;
    let topY = 0;
    let topCx = 0;
    let topCz = 0;
    for (let j = 0; j <= rings; j++) {
      const y = -below + (j / rings) * (height + below);
      const v = Math.max(0, y) / height;
      const li = Math.max(0, layers.findIndex((l) => y < l.y1));
      const l = layers[li];
      // soft layers erode inward, with soft transitions at the layer boundaries
      const edge = Math.min(y - l.y0, l.y1 - y);
      const erode = l.hard ? 0 : 0.16 * smoothstep(0, 1.2, edge);
      const flare = 0.4 * (1 - smoothstep(0, 0.16, v));
      const cap = v > 0.9 ? 0.1 * smoothstep(0.9, 0.95, v) : 0;
      const R = radius * (1 + flare - (1 - taper) * smoothstep(0.04, 1, v) + cap - erode);
      const [jx, jz] = jitter[li];
      const cx = leanK * Math.max(0, y) + jx;
      const cz = jz;
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const c = Math.cos(th);
        const s = Math.sin(th);
        const lump = n.fbm2(c * 1.4 + li * 3.1, s * 1.4 + y * 0.01, 4);
        const crack = Math.pow(1 - Math.abs(n.noise2(th * 2.2 + 1.7, y / 90)), 8);
        const rr = R * (1 + 0.22 * lump) * (1 - 0.18 * crack);
        pos.push(cx + c * rr, y, cz + s * rr);
        uv.push(th * radius, y);
        _c.copy(l.color).multiplyScalar((0.86 + 0.14 * (lump * 0.5 + 0.5)) * (1 - 0.2 * crack));
        col.push(_c.r, _c.g, _c.b);
      }
      if (j === rings) {
        topY = y;
        topCx = cx;
        topCz = cz;
      }
    }
    const row = seg + 1;
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * row + i;
        // CCW from outside: ring j -> ring j+1 going around +theta
        idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    // cap: fan to a slightly domed center
    const center = pos.length / 3;
    pos.push(topCx, topY + radius * taper * 0.08, topCz);
    uv.push(0, 0);
    _c.copy(layers[layers.length - 1].color);
    col.push(_c.r, _c.g, _c.b);
    const last = rings * row;
    for (let i = 0; i < seg; i++) idx.push(center, last + i + 1, last + i);
    root.add(finish(pos, col, uv, idx, owned));
    return { root, owned };
  }, [height, radius, taper, lean, strata, below, seed, segments, palette.join()]);
  return <KitRoot t={props} object={built.root} />;
}
