/**
 * LandingMarker — shows where and how the car will touch down while snapshot.prediction is valid.
 *
 *  - Reticle on the predicted point, aligned to the surface normal and to the car heading:
 *    outer ring + inner dot + 4 ticks (the forward tick is longer), a faint inner ring and a
 *    "ping" that expands faster as timeToImpact -> 0. Cyan for perfect/clean, amber hard, red crash.
 *    A soft dark backing keeps it legible on bright concrete. A faint x-ray pass keeps it readable
 *    when the car itself hides it from the chase camera (gliding level, the point is right behind
 *    the car on screen).
 *  - Footprint ghost: a thin outline of the car's tire-contact footprint, placed at the predicted
 *    point with the car's CURRENT attitude — when the attitude matches the surface it lies flat on
 *    it; any pitch/roll error visibly tilts it into / out of the surface. The part hidden below the
 *    surface is drawn faintly (x-ray pass) so the misalignment always reads.
 */
import { useEffect, useMemo } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  GreaterDepth,
  Group,
  Matrix4,
  Mesh,
  type PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { useFrame } from '@react-three/fiber';
import { runtime } from '@/game/runtime';
import type { LandingQuality } from '@/game/types';
import { VEHICLE, WHEEL_POSITIONS } from '@/game/vehicleSpec';
import { PALETTE } from '@/render/palette';
import { PREMULTIPLIED } from '../core/blending';
import { FX_ORDER } from '../core/FXSystem';
import { disableRaycast } from '../core/objects';
import { useRunReset } from '../core/useRunReset';
import { clamp, damp, linearColor, projectOnPlaneSafe, smoothstep } from '../core/math';
import { useConst } from '../core/useConst';

/** Minimum reticle radius as a fraction of the viewport height, and the world-size cap (m). */
const MIN_SCREEN_RADIUS = 0.03;
const MAX_RADIUS = 11;

const QUALITY_COLOR: Record<LandingQuality, Color> = {
  perfect: linearColor(PALETTE.cyanGlow, 1.35),
  clean: linearColor(PALETTE.cyan, 1.25),
  hard: linearColor(PALETTE.amber, 1.25),
  crash: linearColor(PALETTE.danger, 1.3),
};

const RETICLE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RETICLE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uPing;
uniform float uTime;
varying vec2 vUv;

float band(float x, float center, float halfWidth, float aa) {
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(x - center));
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;  // +y = car forward
  float r = length(p);
  float aa = fwidth(r) * 1.25;
  vec2 ap = abs(p);

  // line half-widths never drop below ~1.2 px (fwidth(r) ~ one pixel in radius units)
  float px = fwidth(r);
  float outer = band(r, 0.92, max(0.024, px * 1.2), aa);
  float inner = band(r, 0.5, max(0.009, px * 0.7), aa) * 0.45;
  float dotC = 1.0 - smoothstep(0.06 - aa, 0.06 + aa, max(r, 0.0));
  float tw = max(0.022, px * 1.1);
  float tickX = (1.0 - smoothstep(tw - aa, tw + aa, ap.y)) * smoothstep(0.66 - aa, 0.66 + aa, ap.x) * (1.0 - smoothstep(0.83 - aa, 0.83 + aa, ap.x));
  float fwdStart = p.y > 0.0 ? 0.58 : 0.66;
  float tickY = (1.0 - smoothstep(tw - aa, tw + aa, ap.x)) * smoothstep(fwdStart - aa, fwdStart + aa, ap.y) * (1.0 - smoothstep(0.83 - aa, 0.83 + aa, ap.y));
  float lines = max(max(outer, inner), max(dotC, max(tickX, tickY)));

  // ping expanding from the center to the outer ring
  float pr = fract(uPing);
  float ping = band(r, mix(0.08, 0.92, pr), 0.012, aa) * pow(1.0 - pr, 1.4) * 0.8;
  float fill = (1.0 - smoothstep(0.88, 0.92, r)) * 0.05;
  float a = max(lines, ping) + fill;

  // soft dark backing just around the strokes (legibility on bright surfaces)
  float backing = max(band(r, 0.92, 0.07, 0.03), band(r, 0.0, 0.11, 0.03)) * 0.22;

  float glowA = a * uOpacity;
  float outA = clamp(glowA * 0.75 + backing * uOpacity * (1.0 - a), 0.0, 1.0);
  if (outA < 0.002 && glowA < 0.002) discard;
  gl_FragColor = vec4(uColor * glowA, outA);
}
`;

const GHOST_VERT = /* glsl */ `
attribute vec3 aStroke;   // outward normal x, z (local XZ plane), base half width (m)
attribute float aEdge;    // -1 / +1 across the stroke
uniform float uMinPx;
uniform float uViewportH;
varying float vEdge;
void main() {
  vEdge = aEdge;
  // strokes never get thinner than uMinPx on screen
  vec4 mvCenter = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mvCenter.z, 0.1);
  float minHalf = 0.5 * uMinPx * 2.0 * depth / (projectionMatrix[1][1] * uViewportH);
  float halfWidth = max(aStroke.z, minHalf);
  vec3 p = position + vec3(aStroke.x, 0.0, aStroke.y) * (aEdge * halfWidth);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const GHOST_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vEdge;
void main() {
  float aa = min(fwidth(vEdge) * 1.2, 0.9);
  float a = (1.0 - smoothstep(1.0 - aa, 1.0, abs(vEdge))) * uOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, a * 0.6);
}
`;

interface StrokeBuffers {
  pos: number[];
  stroke: number[];
  edge: number[];
  idx: number[];
}

/** Closed stroke along a polyline (local XZ plane, y = 0); width is resolved in the vertex shader. */
function closedStroke(pts: [number, number][], halfWidth: number, out: StrokeBuffers, ox = 0, oz = 0) {
  const base = out.pos.length / 3;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x, z] = pts[i];
    const [xp, zp] = pts[(i - 1 + n) % n];
    const [xn, zn] = pts[(i + 1) % n];
    let tx = xn - xp;
    let tz = zn - zp;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    // outward normal in XZ (polyline wound so that (tz, -tx) points outwards)
    for (const side of [1, -1]) {
      out.pos.push(x + ox, 0, z + oz);
      out.stroke.push(tz, -tx, halfWidth);
      out.edge.push(side);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = base + i * 2;
    const b = base + ((i + 1) % n) * 2;
    out.idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
}

/** Rounded-rectangle outline points (local XZ), wound so the stroke normal points outwards. */
function roundedRectPoints(halfW: number, halfL: number, radius: number): [number, number][] {
  const pts: [number, number][] = [];
  const seg = 8;
  const corners: [number, number, number][] = [
    [halfW - radius, -(halfL - radius), -Math.PI / 2],
    [halfW - radius, halfL - radius, 0],
    [-(halfW - radius), halfL - radius, Math.PI / 2],
    [-(halfW - radius), -(halfL - radius), Math.PI],
  ];
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
    }
  }
  return pts;
}

function buildGhostGeometry(): BufferGeometry {
  const out: StrokeBuffers = { pos: [], stroke: [], edge: [], idx: [] };
  // body footprint (slightly inset from the bodywork)
  closedStroke(roundedRectPoints(VEHICLE.width / 2 - 0.04, VEHICLE.length / 2 - 0.05, 0.42), 0.03, out);
  // tire contact patches
  for (const [x, , z] of WHEEL_POSITIONS) closedStroke(roundedRectPoints(0.15, 0.24, 0.07), 0.022, out, x, z);
  // forward chevron (open polyline: two short strokes)
  const tipZ = -VEHICLE.length / 2 - 0.55;
  const baseZ = -VEHICLE.length / 2 - 0.25;
  for (const [x0, z0, x1, z1] of [
    [-0.32, baseZ, 0, tipZ],
    [0, tipZ, 0.32, baseZ],
  ]) {
    const l = Math.hypot(x1 - x0, z1 - z0);
    const nx = (z1 - z0) / l;
    const nz = -(x1 - x0) / l;
    const base = out.pos.length / 3;
    for (const [x, z] of [
      [x0, z0],
      [x1, z1],
    ]) {
      for (const side of [1, -1]) {
        out.pos.push(x, 0, z);
        out.stroke.push(nx, nz, 0.022);
        out.edge.push(side);
      }
    }
    out.idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(out.pos), 3));
  g.setAttribute('aStroke', new BufferAttribute(new Float32Array(out.stroke), 3));
  g.setAttribute('aEdge', new BufferAttribute(new Float32Array(out.edge), 1));
  g.setIndex(out.idx);
  return g;
}

function premultipliedMaterial(name: string, vert: string, frag: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({
    name,
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    ...PREMULTIPLIED,
  });
}

// scratch
const _fwd = new Vector3();
const _right = new Vector3();
const _n = new Vector3();
const _m = new Matrix4();
const _camPos = new Vector3();
const _camDir = new Vector3();
const _offset = new Vector3();

export function LandingMarker() {
  const res = useMemo(() => {
    const root = new Group();
    root.name = 'fx-landing-marker';
    const color = new Color();
    const reticleMat = premultipliedMaterial('fx-reticle', RETICLE_VERT, RETICLE_FRAG, {
      uColor: { value: color },
      uOpacity: { value: 0 },
      uPing: { value: 0 },
      uTime: { value: 0 },
    });
    reticleMat.polygonOffset = true;
    reticleMat.polygonOffsetFactor = -3;
    reticleMat.polygonOffsetUnits = -6;
    const reticleGeo = new PlaneGeometry(2, 2);
    const reticle = disableRaycast(new Mesh(reticleGeo, reticleMat));
    reticle.name = 'fx-reticle';
    reticle.frustumCulled = false;
    reticle.renderOrder = FX_ORDER.markers;
    // x-ray pass: the parts hidden behind geometry (usually the car), drawn faintly
    const reticleXrayMat = premultipliedMaterial('fx-reticle-xray', RETICLE_VERT, RETICLE_FRAG, {
      uColor: { value: color },
      uOpacity: { value: 0 },
      uPing: reticleMat.uniforms.uPing,
      uTime: reticleMat.uniforms.uTime,
    });
    reticleXrayMat.depthFunc = GreaterDepth;
    const reticleXray = disableRaycast(new Mesh(reticleGeo, reticleXrayMat));
    reticleXray.frustumCulled = false;
    reticleXray.renderOrder = FX_ORDER.markers;
    reticle.add(reticleXray);

    const ghostGeo = buildGhostGeometry();
    const viewportH = { value: 1080 };
    const ghostMat = premultipliedMaterial('fx-ghost', GHOST_VERT, GHOST_FRAG, {
      uColor: { value: color },
      uOpacity: { value: 0 },
      uMinPx: { value: 1.6 },
      uViewportH: viewportH,
    });
    ghostMat.polygonOffset = true;
    ghostMat.polygonOffsetFactor = -3;
    ghostMat.polygonOffsetUnits = -6;
    const ghost = disableRaycast(new Mesh(ghostGeo, ghostMat));
    ghost.frustumCulled = false;
    ghost.renderOrder = FX_ORDER.markers;
    // x-ray pass: the part of the ghost below the surface / behind geometry, drawn faintly
    const ghostXrayMat = premultipliedMaterial('fx-ghost-xray', GHOST_VERT, GHOST_FRAG, {
      uColor: { value: color },
      uOpacity: { value: 0 },
      uMinPx: { value: 1.6 },
      uViewportH: viewportH,
    });
    ghostXrayMat.depthFunc = GreaterDepth;
    const ghostXray = disableRaycast(new Mesh(ghostGeo, ghostXrayMat));
    ghostXray.frustumCulled = false;
    ghostXray.renderOrder = FX_ORDER.markers;
    const ghostGroup = new Group();
    ghostGroup.add(ghost, ghostXray);

    root.add(reticle, ghostGroup);
    root.visible = false;
    return { root, reticle, reticleGeo, ghostGroup, ghostGeo, color, reticleMat, reticleXrayMat, ghostMat, ghostXrayMat, viewportH };
  }, []);

  const st = useConst(() => ({
    opacity: 0,
    ping: 0,
    hasColor: false,
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
  }));

  useRunReset(() => {
    st.opacity = 0;
    st.hasColor = false;
    res.root.visible = false;
  });

  useEffect(
    () => () => {
      res.reticleGeo.dispose();
      res.reticleMat.dispose();
      res.reticleXrayMat.dispose();
      res.ghostGeo.dispose();
      res.ghostMat.dispose();
      res.ghostXrayMat.dispose();
    },
    [res],
  );

  useFrame((state) => {
    const frame = runtime.frame;
    const snap = frame.snapshot;
    const pred = snap.prediction;
    const valid = !!pred && pred.valid && !snap.vehicle.crashed && snap.phase !== 'crashed';
    const realDt = frame.paused ? 0 : frame.dt;

    // fade in/out; keep the last pose while fading out. When the prediction is lost on the ground
    // (touchdown), drop out fast: the car immediately runs past the predicted point, and a slow
    // fade would leave a large reticle lingering between the camera and the car. In-air dropouts
    // (prediction flicker) fade slowly.
    const target = valid ? smoothstep(0.05, 0.25, pred!.timeToImpact) : 0;
    const rate = valid ? 10 : snap.vehicle.groundedWheels > 0 ? 30 : 6;
    if (realDt > 0) st.opacity += (target - st.opacity) * damp(rate, realDt);
    res.root.visible = st.opacity > 0.01;
    if (!res.root.visible) return;

    if (valid && pred) {
      st.point.copy(pred.point);
      st.normal.copy(pred.normal);
      // a degenerate normal would give a NaN reticle basis
      if (st.normal.lengthSq() > 1e-6) st.normal.normalize();
      else st.normal.set(0, 1, 0);
      const c = QUALITY_COLOR[pred.predictedQuality];
      if (!st.hasColor) {
        res.color.copy(c);
        st.hasColor = true;
      } else if (realDt > 0) {
        res.color.lerp(c, damp(12, realDt));
      }
      // ping frequency rises as impact approaches (0.8 Hz far -> 5 Hz at touchdown)
      const urgency = 1 - smoothstep(0, 3, pred.timeToImpact);
      st.ping += realDt * (0.8 + 4.2 * urgency * urgency);
    }

    // reticle orientation: normal + car heading projected on the surface
    _n.copy(st.normal);
    _fwd.set(0, 0, -1).applyQuaternion(frame.quaternion);
    if (snap.vehicle.speed > 2) _fwd.lerp(_offset.copy(snap.vehicle.velocity).normalize(), 0.5);
    projectOnPlaneSafe(_fwd, _n);
    _right.crossVectors(_fwd, _n).normalize();
    _m.makeBasis(_right, _fwd, _n);
    res.reticle.quaternion.setFromRotationMatrix(_m);
    res.reticle.position.copy(st.point).addScaledVector(_n, 0.04);
    state.camera.getWorldPosition(_camPos);
    const dist = _camPos.distanceTo(st.point);
    // Never draw the marker between the camera and the car (view depth of the point well short of
    // the car's): it would cover the lower part of the frame. Only happens once the car has passed
    // the point; while airborne the predicted point always lies beyond the car.
    state.camera.getWorldDirection(_camDir);
    const carDepth = _offset.copy(frame.position).sub(_camPos).dot(_camDir);
    const pointDepth = _offset.copy(st.point).sub(_camPos).dot(_camDir);
    const opacity = st.opacity * (1 - smoothstep(1, 4, carDepth - pointDepth));
    // world radius grows gently with distance, and never projects smaller than MIN_SCREEN_RADIUS
    // of the viewport height (the point can be 100+ m ahead at full speed)
    const fov = (state.camera as PerspectiveCamera).isPerspectiveCamera ? (state.camera as PerspectiveCamera).fov : 60;
    const minRadius = MIN_SCREEN_RADIUS * 2 * dist * Math.tan((fov * Math.PI) / 360);
    const radius = Math.min(MAX_RADIUS, Math.max(clamp(2.5 + dist * 0.012, 2.5, 6), minRadius));
    const pulse = 1 + 0.03 * Math.sin(st.ping * Math.PI * 2);
    res.reticle.scale.setScalar(radius * pulse);
    res.reticleMat.uniforms.uOpacity.value = opacity;
    res.reticleXrayMat.uniforms.uOpacity.value = opacity * 0.4;
    res.reticleMat.uniforms.uPing.value = st.ping;

    // footprint ghost with the car's current attitude, origin at the predicted point
    res.ghostGroup.position.copy(st.point).addScaledVector(_n, 0.05);
    res.ghostGroup.quaternion.copy(frame.quaternion);
    const tti = pred && valid ? pred.timeToImpact : 0;
    const ghostFade = opacity * smoothstep(0.12, 0.45, tti || 0.45);
    res.ghostMat.uniforms.uOpacity.value = 0.85 * ghostFade;
    res.ghostXrayMat.uniforms.uOpacity.value = 0.25 * ghostFade;
    res.viewportH.value = state.size.height * state.viewport.dpr;
  });

  return <primitive object={res.root} />;
}
