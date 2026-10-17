/**
 * SpeedLines — thin air streaks in a cylinder around the camera's forward axis, above ~160 km/h.
 *
 * Fully GPU-driven: each streak has a fixed angle / radius / phase; the shader scrolls it toward
 * the camera by the accumulated travel distance. The mesh follows the camera, so the vertex
 * shader works directly in view space. Streaks are faded by their projected distance from the
 * screen center so the middle of the frame (the car) is never cluttered. Intensity follows speed,
 * with extra density while boosting.
 */
import { useEffect, useMemo } from 'react';
import type { ThemeId } from '@/game/types';
import {
  BufferAttribute,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';
import { useFrame } from '@react-three/fiber';
import { runtime } from '@/game/runtime';
import { KMH } from '@/game/tuning';
import { PALETTE } from '@/render/palette';
import { ADDITIVE } from '../core/blending';
import { FX_ORDER } from '../core/FXSystem';
import { disableRaycast } from '../core/objects';
import { useRunReset } from '../core/useRunReset';
import { damp, linearColor, smoothstep } from '../core/math';
import { FX_THEMES, resolveFXTheme } from '../core/theme';
import { useConst } from '../core/useConst';

const BASE_COUNT = 80;
const RANGE = 70; // m of streak field ahead of the camera
/** Peak streak brightness (HDR, before the theme's emissive scale). */
const PEAK = 0.52;

export interface SpeedLinesProps {
  /** Theme for brightness compensation (default: runtime.level?.theme). */
  theme?: ThemeId;
}

const VERT = /* glsl */ `
attribute vec4 aStreak;   // theta, radius, phase, speedFactor
attribute vec4 aStreak2;  // lengthFactor, widthFactor, brightness, unused
uniform float uTravel;
uniform float uLen;
uniform float uWidth;
uniform float uIntensity;
uniform float uDensity;
uniform float uViewportH;
varying float vAlpha;
varying vec2 vUv;

void main() {
  float theta = aStreak.x;
  float r = aStreak.y;
  // head travels from -RANGE toward the camera, then wraps
  float span = ${RANGE.toFixed(1)};
  float zHead = -span + mod(aStreak.z * span + uTravel * aStreak.w, span - 1.5);
  float len = uLen * aStreak2.x;
  float zTail = zHead - len;
  float along = position.y + 0.5;           // 0 = tail, 1 = head
  vec2 radial = vec2(cos(theta), sin(theta));
  vec2 tangent = vec2(-radial.y, radial.x);
  float z = mix(zTail, zHead, along);
  // width in pixels (uWidth px * widthFactor), converted to view-space meters at this depth
  float widthM = uWidth * aStreak2.y * 2.0 * max(-z, 0.5) / (projectionMatrix[1][1] * uViewportH);
  vec3 p = vec3(radial * r + tangent * (position.x * widthM), z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);

  // keep the screen center clear: fade by the projected radius of THIS vertex (tails reach
  // toward the vanishing point and must vanish before the middle of the frame)
  float proj = (r / max(-z, 0.5)) * projectionMatrix[1][1];
  float centerMask = smoothstep(0.45, 0.9, proj);
  float farFade = 1.0 - smoothstep(span * 0.55, span, -zTail);
  float nearFade = smoothstep(1.5, 6.0, -zHead);
  // density: streaks with a low brightness id only appear at high intensity / boost
  float gate = smoothstep(aStreak2.z - 0.15, aStreak2.z, uDensity);
  vAlpha = uIntensity * centerMask * farFade * nearFade * gate * (0.55 + 0.45 * aStreak2.z);
  vUv = vec2(position.x + 0.5, along);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
varying vec2 vUv;
void main() {
  // clamp: MSAA can extrapolate varyings slightly outside [0, 1] (pow of a negative base = NaN,
  // which bloom would smear across the whole frame)
  float across = clamp(1.0 - abs(vUv.x * 2.0 - 1.0), 0.0, 1.0);
  float along = clamp(vUv.y, 0.0, 1.0);
  float a = vAlpha * pow(across, 1.6) * pow(along, 2.2) * smoothstep(0.0, 0.08, 1.08 - along);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

const _camPos = new Vector3();

export function SpeedLines({ theme }: SpeedLinesProps = {}) {
  const mesh = useMemo(() => {
    const count = Math.max(24, Math.round(BASE_COUNT * runtime.quality.particles));
    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const a1 = new Float32Array(count * 4);
    const a2 = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      a1[i * 4] = Math.random() * Math.PI * 2;
      a1[i * 4 + 1] = 3.2 + Math.pow(Math.random(), 0.7) * 7.5;
      a1[i * 4 + 2] = Math.random();
      a1[i * 4 + 3] = 0.85 + Math.random() * 0.5;
      a2[i * 4] = 0.6 + Math.random() * 0.8;
      a2[i * 4 + 1] = 0.7 + Math.random() * 0.6;
      a2[i * 4 + 2] = Math.random();
      a2[i * 4 + 3] = 0;
    }
    g.setAttribute('aStreak', new InstancedBufferAttribute(a1, 4));
    g.setAttribute('aStreak2', new InstancedBufferAttribute(a2, 4));
    g.instanceCount = count;
    const m = new ShaderMaterial({
      name: 'fx-speed-lines',
      uniforms: {
        uTravel: { value: 0 },
        uLen: { value: 4 },
        uWidth: { value: 1.6 },
        uViewportH: { value: 1080 },
        uIntensity: { value: 0 },
        uDensity: { value: 0 },
        uColor: { value: linearColor(PALETTE.warmWhite, 1.0).lerp(linearColor(PALETTE.cyanGlow, 1.0), 0.25) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // the streak quads face radially outwards; the camera sits on the axis (inside)
      side: DoubleSide,
      ...ADDITIVE,
    });
    const mesh = disableRaycast(new Mesh(g, m));
    mesh.name = 'fx-speed-lines';
    mesh.frustumCulled = false;
    mesh.renderOrder = FX_ORDER.overlay;
    mesh.visible = false;
    return mesh;
  }, []);

  const st = useConst(() => ({ intensity: 0, density: 0, travel: 0 }));

  useRunReset(() => {
    st.intensity = 0;
    st.density = 0;
    mesh.visible = false;
  });

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
    [mesh],
  );

  useFrame((state) => {
    const frame = runtime.frame;
    const v = frame.snapshot.vehicle;
    const dt = frame.paused ? 0 : frame.simDt;
    const kmh = v.speed * KMH;
    const boost = v.boostLevel;
    const target = v.crashed ? 0 : smoothstep(160, 270, kmh) * (0.75 + 0.25 * boost) + boost * smoothstep(120, 200, kmh) * 0.3;
    if (dt > 0) {
      st.intensity += (target - st.intensity) * damp(target > st.intensity ? 3 : 5, frame.dt);
      st.density += (Math.min(0.75, 0.25 + 0.25 * smoothstep(200, 290, kmh) + 0.25 * boost) - st.density) * damp(4, frame.dt);
      st.travel += v.speed * dt;
    }
    mesh.visible = st.intensity > 0.01;
    if (!mesh.visible) return;
    const cam = state.camera;
    cam.getWorldPosition(_camPos);
    mesh.position.copy(_camPos);
    cam.getWorldQuaternion(mesh.quaternion);
    const u = mesh.material.uniforms;
    u.uTravel.value = st.travel % 100000;
    u.uLen.value = 2 + v.speed * 0.06;
    // emissive^2: thin bright lines read much stronger against a dark night sky than a bright day
    const k = FX_THEMES[resolveFXTheme(theme)].emissive;
    u.uIntensity.value = st.intensity * PEAK * k * k;
    u.uDensity.value = st.density;
    u.uViewportH.value = state.size.height * state.viewport.dpr;
  });

  return <primitive object={mesh} />;
}
