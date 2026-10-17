/**
 * Level 2 architecture (render only): kicker bodies, start gate, launch pylons, the cable-suspended
 * ring gate over the chasm and the cable-stayed landing abutment. Everything is placed from the
 * course data (src/game/levels/level2/course.ts) so it follows the gameplay geometry.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  TorusGeometry,
  Vector3,
} from 'three';
import { runtime } from '@/game/runtime';
import { L2_COURSE as C } from '@/game/levels/level2/course';
import type { TrackFrame, V3 } from '@/game/types';
import { Arch, CableStays, FacilityBase, LEDStrip, Monolith, Pylon, TrussBeam, TrussTower, drawLabel, ensureFonts, getLevelMaterials } from '@/render/level';
import { PALETTE } from '@/render/palette';
import { useOwned } from './useOwned';

const v3 = (p: Vector3): V3 => [p.x, p.y, p.z];

/* ------------------------------------------------------------------ */
/* Kicker bodies                                                         */
/* ------------------------------------------------------------------ */

/**
 * Solid wedge under a kicker ribbon: side walls from the slab underside down to the table and a
 * vertical back face under the lip (the kicker ribbons carry no auto supports).
 */
function buildWedge(frames: TrackFrame[], halfWidth: number, deckY: number, positions: number[], normals: number[], uvs: number[]) {
  const T = 1.2; // ribbon slab thickness
  const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3, n: Vector3, u0: number, u1: number) => {
    for (const [p, u, v] of [
      [a, u0, 0],
      [b, u1, 0],
      [c, u1, 1],
      [a, u0, 0],
      [c, u1, 1],
      [d, u0, 1],
    ] as [Vector3, number, number][]) {
      positions.push(p.x, p.y, p.z);
      normals.push(n.x, n.y, n.z);
      uvs.push(u, v * Math.max(0.1, a.y - deckY));
    }
  };
  for (const side of [-1, 1]) {
    for (let i = 0; i < frames.length - 1; i++) {
      const f0 = frames[i];
      const f1 = frames[i + 1];
      const t0 = f0.position.clone().addScaledVector(f0.up, -T).addScaledVector(f0.right, side * halfWidth);
      const t1 = f1.position.clone().addScaledVector(f1.up, -T).addScaledVector(f1.right, side * halfWidth);
      if (t0.y <= deckY + 0.02 && t1.y <= deckY + 0.02) continue;
      const b0 = new Vector3(t0.x, deckY, t0.z);
      const b1 = new Vector3(t1.x, deckY, t1.z);
      const n = f0.right.clone().multiplyScalar(side);
      n.y = 0;
      n.normalize();
      // CCW seen from outside
      if (side > 0) quad(t0, b0, b1, t1, n, f0.s, f1.s);
      else quad(t0, t1, b1, b0, n, f0.s, f1.s);
    }
  }
  // back face under the lip, facing forward
  const fl = frames[frames.length - 1];
  const tl = fl.position.clone().addScaledVector(fl.up, -T).addScaledVector(fl.right, -halfWidth);
  const tr = fl.position.clone().addScaledVector(fl.up, -T).addScaledVector(fl.right, halfWidth);
  const n = new Vector3(fl.forward.x, 0, fl.forward.z).normalize();
  quad(tl, new Vector3(tl.x, deckY, tl.z), new Vector3(tr.x, deckY, tr.z), tr, n, 0, halfWidth * 2);
}

export function L2KickerBodies() {
  const built = useOwned(() => {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    for (const k of [C.layout.k1, C.layout.k2]) {
      const p = k === C.layout.k1 ? C.layout.params.k1 : C.layout.params.k2;
      buildWedge(k.ramp, p.width / 2, k.ramp[0].position.y, positions, normals, uvs);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geo.setAttribute('uv1', new BufferAttribute(new Float32Array(uvs), 2));
    const mesh = new Mesh(geo, getLevelMaterials().sideConcrete);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'l2-kicker-bodies';
    return { root: mesh, owned: [geo] };
  }, []);
  return <primitive object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* Start gate + launch pylons                                           */
/* ------------------------------------------------------------------ */

export function L2StartGate() {
  const y = C.yStart;
  return <Arch name="l2-start-arch" position={[0, y, -24]} span={40} height={15} legWidth={3} legDepth={3.6} beamHeight={4.4} legsBelow={70} text="CLEAR THE GAP" lightColor="cyan" />;
}

/** Twin graphite pylons framing the big lip, with a cyan crown band. */
export function L2LaunchPylons() {
  const lip = C.layout.bigLip.position;
  const base = lip.y - 70;
  return (
    <group name="l2-launch-pylons">
      {[-1, 1].map((s) => (
        <Monolith key={s} position={[s * 17, base, lip.z + 6]} size={[4.5, 70 + 34, 4.5]} variant="graphite" seams={1} bands={2} seamColor="cyan" below={0} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Ring gate suspension + threading flash                               */
/* ------------------------------------------------------------------ */

const RING_TOWER_X = 112;
const RING_BEAM_Y = 168;

/** Cylinders between point pairs, merged into one mesh (steel cables / hangers). */
function cableMesh(pairs: [Vector3, Vector3][], radius: number): Mesh {
  const geos: BufferGeometry[] = [];
  const base = new CylinderGeometry(radius, radius, 1, 6, 1, true);
  const up = new Vector3(0, 1, 0);
  const positions: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  for (const [a, b] of pairs) {
    const d = new Vector3().subVectors(b, a);
    const len = d.length();
    const m = new Matrix4().compose(a.clone().addScaledVector(d, 0.5), new Quaternion().setFromUnitVectors(up, d.normalize()), new Vector3(1, len, 1));
    const g = base.clone().applyMatrix4(m);
    const off = positions.length / 3;
    positions.push(...(g.getAttribute('position').array as Float32Array));
    normals.push(...(g.getAttribute('normal').array as Float32Array));
    const idx = g.getIndex()!.array;
    for (let i = 0; i < idx.length; i++) index.push(idx[i] + off);
    geos.push(g);
  }
  base.dispose();
  for (const g of geos) g.dispose();
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geo.setIndex(index);
  const mesh = new Mesh(geo, getLevelMaterials().steel);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

export function L2RingSuspension() {
  const [gx, gy, gz] = C.gate;
  const R = C.gateRadius;
  const built = useOwned(() => {
    const root = new Group();
    root.name = 'l2-ring-hangers';
    // hangers from the beam to the ring's upper node housings, plus two lateral stays to the lower ones
    const a = (Math.PI / 4) * 1;
    const nodes = [-1, 1].map((s) => new Vector3(gx + s * Math.cos(a) * R, gy + Math.sin(a) * R, gz));
    const lower = [-1, 1].map((s) => new Vector3(gx + s * Math.cos(a) * R, gy - Math.sin(a) * R, gz));
    const beamY = RING_BEAM_Y - 2.2;
    const pairs: [Vector3, Vector3][] = [
      [nodes[0], new Vector3(gx - 9, beamY, gz)],
      [nodes[1], new Vector3(gx + 9, beamY, gz)],
      [lower[0], new Vector3(gx - 34, beamY, gz)],
      [lower[1], new Vector3(gx + 34, beamY, gz)],
    ];
    const mesh = cableMesh(pairs, 0.11);
    root.add(mesh);
    return { root, owned: [mesh.geometry] };
  }, [gx, gy, gz, R]);
  return (
    <group name="l2-ring-suspension">
      {[-1, 1].map((s) => (
        <TrussTower key={s} position={[s * RING_TOWER_X, -24, gz]} height={RING_BEAM_Y - -24 + 3} width={9} depth={9} taper={0.55} pattern="x" footings={false} topLights="cyan" />
      ))}
      <TrussBeam from={[-RING_TOWER_X, RING_BEAM_Y, gz]} to={[RING_TOWER_X, RING_BEAM_Y, gz]} width={5} height={4.4} ledColor="cyan" ledSide="both" />
      <primitive object={built.root} />
      <L2RingFlash />
    </group>
  );
}

/** Cyan burst + floating "RING GATE +1500" label when the car threads the gate. */
function L2RingFlash() {
  const [gx, gy, gz] = C.gate;
  const R = C.gateRadius;
  const state = useRef({ t: -1 });
  const built = useOwned(() => {
    const root = new Group();
    root.position.set(gx, gy, gz);
    const ringGeo = new TorusGeometry(R * 0.95, 0.28, 10, 96);
    const ringMat = new MeshBasicMaterial({
      color: PALETTE.cyan,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    ringMat.color.multiplyScalar(4);
    const ring = new Mesh(ringGeo, ringMat);
    ring.visible = false;
    ring.renderOrder = 5;
    root.add(ring);
    const labelGeo = new PlaneGeometry(1, 1);
    const labelMat = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: DoubleSide, toneMapped: false });
    const label = new Mesh(labelGeo, labelMat);
    label.visible = false;
    label.renderOrder = 6;
    root.add(label);
    const owned: { dispose(): void }[] = [ringGeo, ringMat, labelGeo, labelMat];
    return { root, owned, ring, ringMat, label, labelMat };
  }, [gx, gy, gz, R]);

  useEffect(() => {
    let alive = true;
    void ensureFonts().then(() => {
      if (!alive) return;
      const tex = drawLabel({ text: 'RING GATE  +1500', fontPx: 120, trackingEm: 0.34, padEm: 0.5, color: '#eaffff', rule: PALETTE.cyan });
      built.labelMat.map = tex.texture;
      built.labelMat.needsUpdate = true;
      built.label.scale.set(4.2 * tex.aspect, 4.2, 1);
      built.owned.push(tex.texture);
    });
    const offs = [
      runtime.events.on('checkpoint', (e) => {
        if (e.id === 'l2-ring') state.current.t = 0;
      }),
      runtime.events.on('reset', () => (state.current.t = -1)),
    ];
    return () => {
      alive = false;
      offs.forEach((o) => o());
    };
  }, [built]);

  useFrame(({ camera }) => {
    const s = state.current;
    const { ring, ringMat, label, labelMat } = built;
    if (s.t < 0) {
      ring.visible = false;
      label.visible = false;
      return;
    }
    s.t += runtime.frame.simDt > 0 ? runtime.frame.simDt : runtime.frame.dt;
    const k = s.t;
    ring.visible = k < 0.9;
    ringMat.opacity = Math.max(0, 1 - k / 0.9);
    ring.scale.setScalar(1 + k * 0.9);
    label.visible = k < 2.2;
    labelMat.opacity = Math.min(1, k / 0.15) * Math.max(0, Math.min(1, (2.2 - k) / 0.5));
    label.position.set(0, R + 4 + k * 3, 0);
    label.quaternion.copy(camera.quaternion);
    if (k > 2.4) s.t = -1;
  });
  return <primitive object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* Landing abutment                                                      */
/* ------------------------------------------------------------------ */

/**
 * The landing hill's head: a stepped facility base under the catch shelf, a colossal pier into the
 * cloud sea, and two cable-stayed masts that carry the cantilevered knuckle (the corridor under the
 * knuckle stays empty — that is where an undershoot falls onto the shelf).
 */
export function L2LandingStructure() {
  const shelf = C.layout.shelf;
  const [sx, sy, sz] = shelf.center;
  const [sw, sh, sd] = shelf.size;
  const shelfTop = sy + sh / 2;
  const land = C.layout.landing;
  const hw = C.layout.params.landWidthTop / 2;
  // mast feet on the shelf, beside the hill; heads well above the knuckle
  const mastZ = sz - sd * 0.18;
  const mastX = hw + 9;
  const headY = C.yKnuckle + 62;
  const attach = (s: number, side: number): V3 => {
    const f = land.find((fr) => fr.s >= s) ?? land[land.length - 1];
    const p = f.position.clone().addScaledVector(f.right, side * (hw - 0.6)).addScaledVector(f.up, -0.6);
    return v3(p);
  };
  return (
    <group name="l2-landing-structure">
      <FacilityBase position={[sx, shelfTop - sh, sz]} size={[sw, sd]} depth={54} steps={3} bottomScale={0.42} lights coreColor="cyan" />
      <Pylon position={[sx, shelfTop - sh - 54, sz]} height={380} deckWidth={sw * 0.5} />
      {[-1, 1].map((side) => (
        <CableStays
          key={side}
          position={[0, 0, 0]}
          anchor={[side * mastX, headY, mastZ]}
          mastBase={[side * mastX, shelfTop, mastZ]}
          mastWidth={2.6}
          radius={0.13}
          points={[attach(2, side), attach(14, side), attach(28, side), attach(44, side), attach(62, side)]}
        />
      ))}
      {/* thin cyan reveal along the shelf's front edge: reads the abutment line from the lip */}
      <LEDStrip
        points={[
          [sx - sw / 2 + 2, shelfTop + 0.05, sz + sd / 2 - 0.3],
          [sx + sw / 2 - 2, shelfTop + 0.05, sz + sd / 2 - 0.3],
        ]}
        color="cyan"
        width={0.3}
        height={0.12}
      />
    </group>
  );
}
