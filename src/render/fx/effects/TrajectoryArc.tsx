/**
 * TrajectoryArc — dotted, fading line along snapshot.prediction.path.
 *
 * The path (<= 48 points) is resampled at a fixed arc-length spacing; the dot phase flows toward
 * the impact point. Dots fade in a few meters away from the car (no clutter around it) and fade out
 * before the reticle. Dots keep a minimum on-screen size so the arc stays readable far away.
 * One instanced draw call; positions are rewritten each frame into a fixed buffer.
 */
import { useEffect, useMemo } from 'react';
import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
} from 'three';
import { useFrame } from '@react-three/fiber';
import { runtime } from '@/game/runtime';
import type { LandingQuality } from '@/game/types';
import { PALETTE } from '@/render/palette';
import { PREMULTIPLIED } from '../core/blending';
import { FX_ORDER } from '../core/FXSystem';
import { disableRaycast } from '../core/objects';
import { useRunReset } from '../core/useRunReset';
import { damp, linearColor, smoothstep } from '../core/math';
import { useConst } from '../core/useConst';

const MAX_DOTS = 120;
const SPACING = 1.35; // m between dots
const FLOW_SPEED = 5; // m/s
const MAX_PATH = 64;

const TINT: Record<LandingQuality, Color> = {
  perfect: linearColor(PALETTE.cyanGlow).lerp(linearColor(PALETTE.warmWhite), 0.45).multiplyScalar(1.1),
  clean: linearColor(PALETTE.cyan).lerp(linearColor(PALETTE.warmWhite), 0.45).multiplyScalar(1.1),
  hard: linearColor(PALETTE.amber).lerp(linearColor(PALETTE.warmWhite), 0.35).multiplyScalar(1.1),
  crash: linearColor(PALETTE.danger).lerp(linearColor(PALETTE.warmWhite), 0.3).multiplyScalar(1.1),
};

const VERT = /* glsl */ `
attribute vec4 iDot; // xyz, alpha
uniform float uSize;
uniform float uMinPx;
uniform float uViewportH;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 mv = viewMatrix * vec4(iDot.xyz, 1.0);
  float depth = max(-mv.z, 0.1);
  // world size, but never smaller than uMinPx on screen
  float minWorld = uMinPx * 2.0 * depth / (projectionMatrix[1][1] * uViewportH);
  float size = max(uSize, minWorld);
  mv.xy += position.xy * size;
  vUv = uv;
  vAlpha = iDot.w;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;
void main() {
  float r = length(vUv * 2.0 - 1.0);
  float aa = fwidth(r) * 1.5;
  float a = (1.0 - smoothstep(0.75 - aa, 0.75 + aa, r)) * vAlpha * uOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, a * 0.7);
}
`;

export function TrajectoryArc() {
  const res = useMemo(() => {
    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const dots = new InstancedBufferAttribute(new Float32Array(MAX_DOTS * 4), 4);
    dots.setUsage(DynamicDrawUsage);
    g.setAttribute('iDot', dots);
    g.instanceCount = 0;
    const color = new Color();
    const m = new ShaderMaterial({
      name: 'fx-trajectory-arc',
      uniforms: {
        uColor: { value: color },
        uOpacity: { value: 0 },
        uSize: { value: 0.16 },
        uMinPx: { value: 3.2 },
        uViewportH: { value: 1080 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      ...PREMULTIPLIED,
    });
    const mesh = disableRaycast(new Mesh(g, m));
    mesh.name = 'fx-trajectory-arc';
    mesh.frustumCulled = false;
    mesh.renderOrder = FX_ORDER.markers;
    mesh.visible = false;
    return { mesh, geometry: g, material: m, dots, color, range: { start: 0, count: 0 } };
  }, []);

  const st = useConst(() => ({
    opacity: 0,
    phase: 0,
    hasColor: false,
    cum: new Float32Array(MAX_PATH),
  }));

  useRunReset(() => {
    st.opacity = 0;
    st.hasColor = false;
    res.mesh.visible = false;
  });

  useEffect(
    () => () => {
      res.geometry.dispose();
      res.material.dispose();
    },
    [res],
  );

  useFrame((state) => {
    const frame = runtime.frame;
    const snap = frame.snapshot;
    const pred = snap.prediction;
    const valid = !!pred && pred.valid && pred.path.length >= 2 && !snap.vehicle.crashed;
    const realDt = frame.paused ? 0 : frame.dt;
    if (realDt > 0) st.opacity += ((valid ? 1 : 0) - st.opacity) * damp(valid ? 8 : 10, realDt);
    if (!valid || st.opacity < 0.01) {
      res.mesh.visible = false;
      return;
    }
    const path = pred!.path;
    const n = Math.min(path.length, MAX_PATH);
    // cumulative arc length
    const cum = st.cum;
    cum[0] = 0;
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + path[i].distanceTo(path[i - 1]);
    const total = cum[n - 1];
    if (total < 1) {
      res.mesh.visible = false;
      return;
    }
    st.phase = (st.phase + realDt * FLOW_SPEED) % SPACING;

    const c = TINT[pred!.predictedQuality];
    if (!st.hasColor) {
      res.color.copy(c);
      st.hasColor = true;
    } else if (realDt > 0) {
      res.color.lerp(c, damp(10, realDt));
    }

    const arr = res.dots.array as Float32Array;
    let count = 0;
    let seg = 1;
    for (let s = st.phase; s < total && count < MAX_DOTS; s += SPACING) {
      while (seg < n - 1 && cum[seg] < s) seg++;
      const s0 = cum[seg - 1];
      const s1 = cum[seg];
      const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      const a = path[seg - 1];
      const b = path[seg];
      const alpha = smoothstep(2.5, 9, s) * (1 - smoothstep(total - 7, total - 2.5, s));
      if (alpha <= 0.01) continue;
      const o = count * 4;
      arr[o] = a.x + (b.x - a.x) * f;
      arr[o + 1] = a.y + (b.y - a.y) * f;
      arr[o + 2] = a.z + (b.z - a.z) * f;
      arr[o + 3] = alpha;
      count++;
    }
    res.geometry.instanceCount = count;
    res.mesh.visible = count > 0;
    if (count === 0) return;
    res.range.count = count * 4;
    res.dots.updateRanges.length = 0;
    res.dots.updateRanges.push(res.range);
    res.dots.needsUpdate = true;
    res.material.uniforms.uOpacity.value = st.opacity * 0.85;
    res.material.uniforms.uViewportH.value = state.size.height * state.viewport.dpr;
  });

  return <primitive object={res.mesh} />;
}
