/**
 * Lighting fixtures: stadium floodlights and truss-mounted light rigs.
 *
 * Fixtures always render their emissive lenses (bloom) plus a soft additive glow; a REAL
 * SpotLight is only created when requested AND a slot is available in the quality-dependent
 * budget (see useLightSlot: high 6 / medium 3 / low 0). Optional fake volumetric beam cones.
 */
import { useMemo } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Points,
  PointsMaterial,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { V3 } from '@/game/types';
import { getLevelMaterials } from '../materials';
import { chamferRect, GeoBuilder, loftSections, taperedPrism } from '../geometry/GeoBuilder';
import { latticeBeam, latticeTower, MemberBatch } from '../geometry/truss';
import { getGlowTexture, meshFrom, useKitBuild, useLightSlot, type Disposable, type KitTransform } from './common';

export interface FixtureLightOptions {
  /** Candela. Default 2.4 * distance^2 (≈ 2.4 lux-ish at the aim point). */
  intensity?: number;
  /** Cone half-angle (rad). Default 0.38. */
  angle?: number;
  penumbra?: number;
  /** Range (m). Default 3 x distance to aim. */
  distance?: number;
  /** Shadow-casting spot (expensive; use on one hero fixture at most). Default false. */
  castShadow?: boolean;
}

/** Head orientation: local +Z faces the aim point. */
function aimQuaternion(from: Vector3, to: Vector3): Quaternion {
  const fwd = new Vector3().subVectors(to, from);
  // aim point at the head itself: keep a sane default instead of NaN (look ahead, slightly down)
  if (fwd.lengthSq() < 1e-6) fwd.set(0, -0.3, -1);
  fwd.normalize();
  let right = new Vector3().crossVectors(new Vector3(0, 1, 0), fwd);
  if (right.lengthSq() < 1e-6) right = new Vector3(1, 0, 0);
  right.normalize();
  const up = new Vector3().crossVectors(fwd, right).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, fwd));
}

/**
 * Appends a lamp head (housing + visor to `housing`, lens discs to `lenses`), centered at the
 * origin of `m`, lenses facing local +Z. Returns the head size.
 */
function addLampHead(housing: GeoBuilder, lenses: GeoBuilder, m: Matrix4, cols: number, rows: number, lens: number): { w: number; h: number } {
  const pitch = lens * 2.25;
  const w = cols * pitch + lens * 0.6;
  const h = rows * pitch + lens * 0.6;
  const d = lens * 1.3;
  const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number) =>
    taperedPrism(housing, chamferRect(sx / 2, sz / 2, Math.min(sx, sz) * 0.08), -sy / 2, sy / 2, [1, 1], [1, 1], {
      matrix: m.clone().multiply(new Matrix4().makeTranslation(x, y, z)),
      capTop: true,
      capBottom: true,
    });
  box(w, h, d, 0, 0, 0);
  // visor and back fins
  box(w * 1.04, lens * 0.12, lens * 1.1, 0, h / 2 + lens * 0.06, d / 2 + lens * 0.3);
  for (let i = 0; i < 4; i++) box(w * 0.9, lens * 0.08, lens * 0.5, 0, -h / 2 + ((i + 0.5) * h) / 4, -d / 2 - lens * 0.25);
  const disc = new CylinderGeometry(lens, lens * 0.92, lens * 0.16, 20, 1, false);
  disc.rotateX(Math.PI / 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c - (cols - 1) / 2) * pitch;
      const y = (r - (rows - 1) / 2) * pitch;
      lenses.append(disc, m.clone().multiply(new Matrix4().makeTranslation(x, y, d / 2 + lens * 0.02)));
    }
  }
  disc.dispose();
  return { w, h };
}

const beamVertex = /* glsl */ `
  varying float vAlong;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vAlong = uv.y;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const beamFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlong;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    // clamp everything: MSAA sample extrapolation can push varyings slightly out of range and a
    // single NaN (pow of a negative) would be smeared over the whole frame by the bloom chain
    float facing = clamp(abs(dot(normalize(vN + 1e-5), normalize(vV + 1e-5))), 0.0, 1.0);
    float along = clamp(vAlong, 0.0, 1.0);
    float a = facing * facing * pow(along, 2.4) * uOpacity;
    gl_FragColor = vec4(uColor * a, 1.0);
  }`;

/** Additive cone from a head (apex) along +Z of `m` to `length`. uv.y = 1 at the apex. */
function makeBeam(length: number, radius: number, color: Color, opacity: number, owned: Disposable[]): Mesh {
  const geo = new CylinderGeometry(radius * 0.08, radius, length, 28, 1, true);
  geo.translate(0, -length / 2, 0); // apex at origin, cone along -Y
  geo.rotateX(-Math.PI / 2); // -Y -> +Z
  const mat = new ShaderMaterial({
    uniforms: { uColor: { value: color }, uOpacity: { value: opacity } },
    vertexShader: beamVertex,
    fragmentShader: beamFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
  owned.push(geo, mat);
  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 3;
  return mesh;
}

/** Additive glow points (one per position) using the cached glow texture. */
function makeGlows(positions: Vector3[], size: number, color: Color, opacity: number, owned: Disposable[]): Points {
  const geo = new BufferGeometry();
  const arr = new Float32Array(positions.length * 3);
  positions.forEach((p, i) => arr.set([p.x, p.y, p.z], i * 3));
  geo.setAttribute('position', new BufferAttribute(arr, 3));
  const mat = new PointsMaterial({
    map: getGlowTexture(),
    size,
    sizeAttenuation: true,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  owned.push(geo, mat);
  const pts = new Points(geo, mat);
  pts.renderOrder = 4;
  return pts;
}

/* ------------------------------------------------------------------ */
/* Floodlight                                                           */
/* ------------------------------------------------------------------ */

export interface FloodlightProps extends KitTransform {
  /** Mast height (m). Default 26. */
  height?: number;
  /** Aim point in the PARENT space (same space as `position`). Default 40 m ahead (-Z) at ground level. */
  aim?: V3;
  /** Lens grid [columns, rows]. Default [3, 2]. */
  lenses?: [number, number];
  /** Lens radius (m) — scales the head. Default 0.38. */
  lensSize?: number;
  /** Lamp color. Default warm white. */
  color?: string;
  /** Real SpotLight (budgeted). `true` = defaults. */
  light?: boolean | FixtureLightOptions;
  /** Soft additive glow around the head. Default true. */
  glow?: boolean;
  /** Fake volumetric beam; number = opacity. Default false. */
  beam?: boolean | number;
  /** Render the mast (false for heads mounted on other structures). Default true. */
  mast?: boolean;
}

/** Stadium floodlight: tapered mast, yoke, visored lamp head with emissive lenses. */
export function Floodlight(props: FloodlightProps) {
  const {
    height = 26,
    aim,
    lenses = [3, 2],
    lensSize = 0.38,
    color = '#fff4e2',
    light = false,
    glow = true,
    beam = false,
    mast = true,
  } = props;
  const granted = useLightSlot(light !== false);
  const tKey = JSON.stringify([props.position, props.rotation, props.scale, aim]);
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    // aim point in component-local space
    const rootM = new Matrix4().compose(
      new Vector3(...(props.position ?? [0, 0, 0])),
      new Quaternion().setFromEuler(new Object3D().rotation.set(...(props.rotation ?? [0, 0, 0]))),
      typeof props.scale === 'number' ? new Vector3(props.scale, props.scale, props.scale) : new Vector3(...(props.scale ?? [1, 1, 1])),
    );
    const aimWorld = aim ? new Vector3(...aim) : new Vector3(0, 0, -40).applyMatrix4(rootM);
    const aimLocal = aimWorld.clone().applyMatrix4(rootM.clone().invert());
    const headPos = new Vector3(0, height + 1.2, 0);
    const q = aimQuaternion(headPos, aimLocal);
    const headM = new Matrix4().compose(headPos, q, new Vector3(1, 1, 1));
    const housing = new GeoBuilder();
    const lensB = new GeoBuilder();
    const size = addLampHead(housing, lensB, headM, lenses[0], lenses[1], lensSize);
    if (mast) {
      loftSections(housing, chamferRect(0.42, 0.42, 0.16), [
        { y: 0, sx: 1, sz: 1 },
        { y: height * 0.6, sx: 0.8, sz: 0.8 },
        { y: height + 0.2, sx: 0.55, sz: 0.55 },
      ]);
      // yoke: horizontal arm under the head + neck
      const back = new Vector3(0, 0, -lensSize * 1.4).applyQuaternion(q).add(headPos);
      // neck from the mast top to the back of the head (merged into the housing)
      const dir = new Vector3().subVectors(back, new Vector3(0, height, 0));
      const len = dir.length();
      const nq = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
      taperedPrism(housing, chamferRect(0.16, 0.16, 0.05), 0, len, [1, 1], [1, 1], {
        matrix: new Matrix4().compose(new Vector3(0, height, 0), nq, new Vector3(1, 1, 1)),
        capTop: true,
      });
      const plinth = new GeoBuilder();
      taperedPrism(plinth, chamferRect(0.9, 0.9, 0.2), 0, 0.7, [1, 1], [0.85, 0.85], { capTop: true });
      const pm = meshFrom(plinth, lib.pylon, owned);
      if (pm) root.add(pm);
    }
    const hm = meshFrom(housing, lib.graphite, owned);
    if (hm) root.add(hm);
    const lm = meshFrom(lensB, lib.lamp, owned, { cast: false, receive: false });
    if (lm) root.add(lm);
    const lampColor = new Color(color);
    const front = new Vector3(0, 0, lensSize * 1.2).applyQuaternion(q).add(headPos);
    if (glow) root.add(makeGlows([front], Math.max(size.w, size.h) * 4.2, lampColor, 0.62, owned));
    if (beam) {
      const dist = headPos.distanceTo(aimLocal);
      const b = makeBeam(Math.min(dist * 0.85, 120), Math.max(size.w, dist * 0.3), lampColor.clone(), typeof beam === 'number' ? beam : 0.05, owned);
      b.position.copy(front);
      b.quaternion.copy(q);
      root.add(b);
    }
    const target = new Object3D();
    target.position.copy(aimLocal);
    root.add(target);
    return { root, owned, target, headPos: front, distance: headPos.distanceTo(aimLocal) };
  }, [tKey, height, lenses[0], lenses[1], lensSize, color, glow, beam, mast]);

  const opts: FixtureLightOptions = typeof light === 'object' ? light : {};
  const d = built.distance;
  return (
    <group name={props.name} position={props.position} rotation={props.rotation} scale={props.scale}>
      <primitive object={built.root} />
      {granted && (
        <spotLight
          position={built.headPos}
          target={built.target}
          color={color}
          intensity={opts.intensity ?? 2.4 * d * d}
          angle={opts.angle ?? 0.38}
          penumbra={opts.penumbra ?? 0.65}
          distance={opts.distance ?? d * 3}
          decay={2}
          castShadow={opts.castShadow ?? false}
          shadow-mapSize={[1024, 1024]}
          shadow-bias={-0.0004}
        />
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* LightRig                                                             */
/* ------------------------------------------------------------------ */

export interface LightRigProps extends KitTransform {
  /** Beam length (m). Default 36. */
  width?: number;
  /** Beam height above the ground (m). Default 22. */
  height?: number;
  /** Lamp heads along the beam. Default 8. */
  count?: number;
  /** Aim point in the PARENT space. Default 40 m ahead (-Z) on the ground. */
  aim?: V3;
  color?: string;
  /** Real SpotLights to request (budgeted, spread along the rig). Default 1. */
  lights?: number;
  /** Lattice masts at both ends (false = beam only, e.g. hung from a roof). Default true. */
  masts?: boolean;
  /** Fake volumetric beams; number = opacity. Default false. */
  beams?: boolean | number;
}

function RigLight({ position, target, color, intensity, distance }: { position: Vector3; target: Object3D; color: string; intensity: number; distance: number }) {
  const granted = useLightSlot(true);
  if (!granted) return null;
  return <spotLight position={position} target={target} color={color} intensity={intensity} angle={0.55} penumbra={0.7} distance={distance} decay={2} />;
}

/** Truss beam on two lattice masts carrying a row of aimed lamp heads (≈ 4 draw calls). */
export function LightRig(props: LightRigProps) {
  const { width = 36, height = 22, count = 8, aim, color = '#fff4e2', lights = 1, masts = true, beams = false } = props;
  const tKey = JSON.stringify([props.position, props.rotation, props.scale, aim]);
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    const rootM = new Matrix4().compose(
      new Vector3(...(props.position ?? [0, 0, 0])),
      new Quaternion().setFromEuler(new Object3D().rotation.set(...(props.rotation ?? [0, 0, 0]))),
      typeof props.scale === 'number' ? new Vector3(props.scale, props.scale, props.scale) : new Vector3(...(props.scale ?? [1, 1, 1])),
    );
    const aimWorld = aim ? new Vector3(...aim) : new Vector3(0, 0, -40).applyMatrix4(rootM);
    const aimLocal = aimWorld.clone().applyMatrix4(rootM.clone().invert());
    const batch = new MemberBatch();
    const bw = 1.6;
    latticeBeam(batch, { from: new Vector3(-width / 2, height, 0), to: new Vector3(width / 2, height, 0), width: bw, height: bw, bay: 1.8 });
    if (masts) {
      for (const s of [-1, 1]) {
        latticeTower(batch, {
          base: new Vector3(s * (width / 2), 0, 0),
          height: height + bw,
          width: bw,
          depth: bw,
          bay: 1.8,
          legRadius: 0.07,
          braceRadius: 0.04,
          pattern: 'zigzag',
        });
      }
    }
    const truss = batch.build(lib.steel, true);
    if (truss) {
      root.add(truss);
      owned.push(truss);
    }
    const housing = new GeoBuilder();
    const lensB = new GeoBuilder();
    const fronts: Vector3[] = [];
    let headSize = 1;
    const lampColor = new Color(color);
    const beamMeshes: Mesh[] = [];
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * ((width - 3) / Math.max(1, count - 1));
      const pos = new Vector3(x, height - 1.1, 0.4);
      const q = aimQuaternion(pos, aimLocal);
      const s = addLampHead(housing, lensB, new Matrix4().compose(pos, q, new Vector3(1, 1, 1)), 2, 2, 0.3);
      headSize = Math.max(s.w, s.h);
      const front = new Vector3(0, 0, 0.45).applyQuaternion(q).add(pos);
      fronts.push(front);
      if (beams) {
        const dist = pos.distanceTo(aimLocal);
        const b = makeBeam(Math.min(dist * 1.1, 140), Math.max(2, dist * 0.22), lampColor.clone(), typeof beams === 'number' ? beams : 0.07, owned);
        b.position.copy(front);
        b.quaternion.copy(q);
        beamMeshes.push(b);
      }
    }
    const hm = meshFrom(housing, lib.graphite, owned);
    if (hm) root.add(hm);
    const lm = meshFrom(lensB, lib.lamp, owned, { cast: false, receive: false });
    if (lm) root.add(lm);
    root.add(makeGlows(fronts, headSize * 3, lampColor, 0.45, owned));
    for (const b of beamMeshes) root.add(b);
    const target = new Object3D();
    target.position.copy(aimLocal);
    root.add(target);
    const n = Math.max(0, Math.min(lights, count));
    const lightPositions = Array.from({ length: n }, (_, k) => fronts[Math.round(((k + 0.5) / n) * (count - 1))] ?? fronts[0]);
    return { root, owned, target, lightPositions, distance: new Vector3(0, height, 0).distanceTo(aimLocal) };
  }, [tKey, width, height, count, color, lights, masts, beams]);
  const d = built.distance;
  const perLight = useMemo(() => (3.2 * d * d * Math.max(1, count)) / Math.max(1, built.lightPositions.length) / 4, [d, count, built]);
  return (
    <group name={props.name} position={props.position} rotation={props.rotation} scale={props.scale}>
      <primitive object={built.root} />
      {built.lightPositions.map((p, i) => (
        <RigLight key={i} position={p} target={built.target} color={color} intensity={perLight} distance={d * 3} />
      ))}
    </group>
  );
}
