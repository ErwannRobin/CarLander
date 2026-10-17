import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  type Vector3,
} from 'three';
import { runtime } from '@/game/runtime';
import type { LevelDef } from '@/game/types';
import { useEnv } from './context';
import { mulberry32 } from './noise';
import { CUMULUS_FRAGMENT, CUMULUS_VERTEX } from './shaders/cumulus';
import { getPuffAtlasTexture, PUFF_GRID } from './textures';

/* ------------------------------------------------------------------ */
/* Placement                                                            */
/* ------------------------------------------------------------------ */

interface Keepout {
  x: number;
  z: number;
  r: number;
}

interface Region {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  deckY: number;
  keepouts: Keepout[];
}

const DEFAULT_REGION: Region = {
  minX: -150,
  maxX: 150,
  minZ: -3200,
  maxZ: 400,
  deckY: 10,
  // no level: keep a 130 m corridor along the runway line (x = 0) clear
  keepouts: [],
};

/** Horizontal keep-out discs around every structure of the level (clouds must not clip them). */
function regionFromLevel(level: LevelDef | null): Region {
  if (!level) return DEFAULT_REGION;
  const keepouts: Keepout[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let deckY = -Infinity;
  const add = (x: number, y: number, z: number, r: number) => {
    keepouts.push({ x, z, r });
    minX = Math.min(minX, x - r);
    maxX = Math.max(maxX, x + r);
    minZ = Math.min(minZ, z - r);
    maxZ = Math.max(maxZ, z + r);
    deckY = Math.max(deckY, y);
  };
  for (const p of level.pieces) {
    if (p.kind === 'box') {
      const r = Math.hypot(p.size[0], p.size[2]) * 0.5 + 40;
      add(p.center[0], p.center[1], p.center[2], r);
    } else {
      const frames = p.frames;
      const step = Math.max(1, Math.floor(frames.length / 160));
      for (let i = 0; i < frames.length; i += step) {
        const f = frames[i];
        const w = typeof p.width === 'number' ? p.width : p.width(f.s);
        add(f.position.x, f.position.y, f.position.z, w * 0.5 + 45);
      }
    }
  }
  if (!keepouts.length) return DEFAULT_REGION;
  return { minX, maxX, minZ, maxZ, deckY, keepouts };
}

function blocked(region: Region, x: number, z: number, r: number): boolean {
  if (!region.keepouts.length) return Math.abs(x) < 130 + r;
  for (const k of region.keepouts) {
    const dx = x - k.x;
    const dz = z - k.z;
    const rr = k.r + r;
    if (dx * dx + dz * dz < rr * rr) return true;
  }
  return false;
}

interface SpriteData {
  count: number;
  center: Float32Array; // x y z size
  params: Float32Array; // rot tile height opacity
  normal: Float32Array; // nx ny nz rand
  base: Float32Array; // cluster base y, cluster radius
}

function buildSprites(region: Region, seaTop: number, amount: number, budget: number, seed: number): SpriteData {
  const rnd = mulberry32(seed);
  const clusters = Math.max(4, Math.round(36 * amount * budget));
  const perSprite = budget >= 0.9 ? 1 : budget >= 0.6 ? 0.75 : 0.55;
  const center: number[] = [];
  const params: number[] = [];
  const normal: number[] = [];
  const base: number[] = [];
  const spanX = region.maxX - region.minX;
  const spanZ = region.maxZ - region.minZ;
  const deck = Math.min(region.deckY, 60);
  for (let c = 0; c < clusters; c++) {
    let cx = 0;
    let cz = 0;
    let R = 0;
    let ok = false;
    for (let attempt = 0; attempt < 24 && !ok; attempt++) {
      R = 38 + rnd() * rnd() * 85;
      // lateral bands on both sides of the facility, 100–900 m out, some far beyond
      const side = rnd() < 0.5 ? -1 : 1;
      const lateral = 120 + Math.pow(rnd(), 1.4) * 900;
      cx = side > 0 ? region.maxX + lateral - spanX * 0.35 * rnd() : region.minX - lateral + spanX * 0.35 * rnd();
      cz = region.minZ - 300 + rnd() * (spanZ + 600);
      ok = !blocked(region, cx, cz, R * 1.2);
    }
    if (!ok) continue;
    // mostly well below the decks, a few up at deck height far out (depth cue)
    const high = rnd() < 0.22;
    const cy = high ? deck - 25 + rnd() * 45 : seaTop + 30 + rnd() * Math.max(30, deck - seaTop - 80);
    const H = R * (0.5 + rnd() * 0.3);
    const n = Math.round((9 + R / 9) * perSprite);
    for (let k = 0; k < n; k++) {
      const ang = rnd() * Math.PI * 2;
      const rad = R * Math.sqrt(rnd()) * 0.82;
      const dome = 1 - (rad / R) * (rad / R);
      const sy = H * dome * Math.pow(rnd(), 0.6);
      const x = cx + Math.cos(ang) * rad;
      const z = cz + Math.sin(ang) * rad * 0.85;
      const y = cy + sy;
      const size = R * (0.8 + 0.5 * rnd()) * (1 - 0.25 * (rad / R)) * (0.85 + 0.3 * dome);
      center.push(x, y, z, size);
      const hf = sy / Math.max(1, H);
      params.push((rnd() - 0.5) * 0.5, Math.floor(rnd() * PUFF_GRID * PUFF_GRID), hf, 0.9 + rnd() * 0.1);
      // rounded cluster normal (center lowered so tops point up, bases point down/out)
      let nx = x - cx;
      let ny = y - (cy + H * 0.25);
      let nz = z - cz;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      normal.push(nx, ny, nz, rnd());
      base.push(cy, R);
    }
  }
  return {
    count: center.length / 4,
    center: new Float32Array(center),
    params: new Float32Array(params),
    normal: new Float32Array(normal),
    base: new Float32Array(base),
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

const NEAR_FADE = new Vector2(25, 110);

/**
 * Scattered volumetric-looking cumulus clusters around and below the structures: instanced
 * billboards with a procedural puff atlas and sun-side lighting, depth-sorted back to front.
 * Placement keeps clear of the level's structures (`level` prop or `runtime.level`), budgeted by
 * `quality.clouds`.
 */
export function Clouds({ level }: { level?: LevelDef | null }) {
  const { atmosphere, theme, quality } = useEnv();
  const ref = useRef<Mesh>(null);
  const trackedLevel = useRef<LevelDef | null | undefined>(undefined);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        name: 'env.cumulus',
        uniforms: {
          ...atmosphere,
          uAtlas: { value: getPuffAtlasTexture() },
          uGrid: { value: PUFF_GRID },
          uNearFade: { value: NEAR_FADE },
          uLit: { value: new Color() },
          uShade: { value: new Color() },
          uBright: { value: 1.3 },
        },
        vertexShader: CUMULUS_VERTEX,
        fragmentShader: CUMULUS_FRAGMENT,
        transparent: true,
        premultipliedAlpha: true,
        blending: NormalBlending,
        depthWrite: false,
        fog: false,
      }),
    [atmosphere],
  );
  useEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    const u = material.uniforms;
    (u.uLit.value as Color).set(theme.clouds.cumulus.lit);
    (u.uShade.value as Color).set(theme.clouds.cumulus.shade);
    u.uBright.value = theme.clouds.brightness;
  }, [material, theme]);

  // geometry + sort state (rebuilt when the level / theme / budget changes)
  const sim = useMemo(
    () => ({
      quad: new PlaneGeometry(1, 1),
      geometry: null as InstancedBufferGeometry | null,
      data: null as SpriteData | null,
      order: new Uint32Array(0),
      dist: new Float32Array(0),
      lastCam: { x: Infinity, y: Infinity, z: Infinity },
    }),
    [],
  );
  useEffect(
    () => () => {
      sim.geometry?.dispose();
      sim.geometry = null;
      sim.quad.dispose();
    },
    [sim],
  );

  const rebuild = (lvl: LevelDef | null) => {
    const region = regionFromLevel(lvl);
    const c = theme.clouds;
    const data = buildSprites(region, c.seaTop, c.cumulus.amount, quality.clouds, 1729 + (lvl?.id ?? 0) * 97);
    const g = new InstancedBufferGeometry();
    g.index = sim.quad.index;
    g.setAttribute('position', sim.quad.getAttribute('position'));
    g.setAttribute('aCenter', new InstancedBufferAttribute(new Float32Array(data.center), 4));
    g.setAttribute('aParams', new InstancedBufferAttribute(new Float32Array(data.params), 4));
    g.setAttribute('aNormal', new InstancedBufferAttribute(new Float32Array(data.normal), 4));
    g.setAttribute('aBase', new InstancedBufferAttribute(new Float32Array(data.base), 2));
    g.instanceCount = data.count;
    sim.geometry?.dispose();
    sim.geometry = g;
    if (ref.current) ref.current.geometry = g;
    sim.data = data;
    sim.order = new Uint32Array(data.count);
    for (let i = 0; i < data.count; i++) sim.order[i] = i;
    sim.dist = new Float32Array(data.count);
    sim.lastCam.x = Infinity;
  };

  // rebuild on theme / budget / level change (and on first mount, before the first frame)
  useLayoutEffect(() => {
    const lvl = level !== undefined ? level : runtime.level;
    trackedLevel.current = lvl;
    rebuild(lvl);
  }, [theme, quality.clouds, level]);

  useFrame((state) => {
    // follow runtime.level when no explicit level is given (the runner sets it after mount)
    if (level === undefined && runtime.level !== trackedLevel.current) {
      trackedLevel.current = runtime.level;
      rebuild(runtime.level);
    }
    const data = sim.data;
    const g = sim.geometry;
    if (!data || !g || data.count === 0) return;
    if (ref.current && ref.current.geometry !== g) ref.current.geometry = g;
    const cam: Vector3 = state.camera.position;
    const lc = sim.lastCam;
    if ((cam.x - lc.x) ** 2 + (cam.y - lc.y) ** 2 + (cam.z - lc.z) ** 2 < 1) return;
    lc.x = cam.x;
    lc.y = cam.y;
    lc.z = cam.z;

    // back-to-front order by distance (insertion sort: nearly sorted frame to frame)
    const order = sim.order;
    const dist = sim.dist;
    const center = data.center;
    const params = data.params;
    const normal = data.normal;
    const base = data.base;
    const n = data.count;
    for (let i = 0; i < n; i++) {
      const dx = center[i * 4] - cam.x;
      const dy = center[i * 4 + 1] - cam.y;
      const dz = center[i * 4 + 2] - cam.z;
      dist[i] = dx * dx + dy * dy + dz * dz;
    }
    for (let i = 1; i < n; i++) {
      const v = order[i];
      const dv = dist[v];
      let j = i - 1;
      while (j >= 0 && dist[order[j]] < dv) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = v;
    }
    const aC = g.getAttribute('aCenter') as InstancedBufferAttribute;
    const aP = g.getAttribute('aParams') as InstancedBufferAttribute;
    const aN = g.getAttribute('aNormal') as InstancedBufferAttribute;
    const aB = g.getAttribute('aBase') as InstancedBufferAttribute;
    const ob = aB.array as Float32Array;
    const oc = aC.array as Float32Array;
    const op = aP.array as Float32Array;
    const on = aN.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const s = order[k] * 4;
      const d = k * 4;
      oc[d] = center[s];
      oc[d + 1] = center[s + 1];
      oc[d + 2] = center[s + 2];
      oc[d + 3] = center[s + 3];
      op[d] = params[s];
      op[d + 1] = params[s + 1];
      op[d + 2] = params[s + 2];
      op[d + 3] = params[s + 3];
      on[d] = normal[s];
      on[d + 1] = normal[s + 1];
      on[d + 2] = normal[s + 2];
      on[d + 3] = normal[s + 3];
      const s2 = order[k] * 2;
      ob[k * 2] = base[s2];
      ob[k * 2 + 1] = base[s2 + 1];
    }
    aC.needsUpdate = true;
    aP.needsUpdate = true;
    aN.needsUpdate = true;
    aB.needsUpdate = true;
  });

  return <mesh ref={ref} material={material} renderOrder={-10} frustumCulled={false} />;
}
