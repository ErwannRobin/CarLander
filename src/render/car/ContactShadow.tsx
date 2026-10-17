/**
 * <ContactShadow/> — a soft blob under the car for presets without shadow maps (low quality), so
 * the car still sits on the track. Placed at the average grounded wheel contact, oriented by the
 * contact normals (works upside down on the vacuum track) and faded out in the air. The falloff is
 * analytic (rounded-rectangle superellipse), so there is no texture to manage.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Matrix4, type Mesh, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { runtime } from '@/game/runtime';
import { VEHICLE } from '@/game/vehicleSpec';

const point = new Vector3();
const normal = new Vector3();
const fwd = new Vector3();
const right = new Vector3();
const basisQ = new Quaternion();
const basis = new Matrix4();
const UP = new Vector3(0, 1, 0);

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = abs(vUv - 0.5) * 2.0;
  float r = pow(pow(p.x, 4.0) + pow(p.y, 4.0), 0.25);
  float a = 1.0 - smoothstep(0.5, 1.0, r);
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * uOpacity);
}`;

export function ContactShadow({ opacity = 0.85 }: { opacity?: number }) {
  const ref = useRef<Mesh>(null);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uOpacity: { value: 0 } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  const fade = useRef(0);

  useFrame((_, delta) => {
    const m = ref.current;
    if (!m) return;
    const v = runtime.frame.snapshot.vehicle;
    let n = 0;
    point.set(0, 0, 0);
    normal.set(0, 0, 0);
    for (const w of v.wheels) {
      if (!w.grounded) continue;
      point.add(w.contactPoint);
      normal.add(w.contactNormal);
      n++;
    }
    const target = n >= 2 && !v.crashed ? 1 : 0;
    fade.current += (target - fade.current) * Math.min(1, delta * 10);
    const a = fade.current;
    m.visible = a > 0.01 && n > 0;
    if (!m.visible) return;
    point.divideScalar(n);
    if (normal.lengthSq() < 1e-6) normal.copy(UP);
    normal.normalize();
    // basis: plane normal = contact normal, long axis = car forward projected on the plane
    fwd.set(0, 0, -1).applyQuaternion(runtime.frame.quaternion).projectOnPlane(normal);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1).projectOnPlane(normal);
    fwd.normalize();
    right.crossVectors(fwd, normal).normalize();
    // plane geometry lies in XY facing +Z: X = right, Y = forward (length), Z = normal (right-handed)
    basis.makeBasis(right, fwd, normal);
    basisQ.setFromRotationMatrix(basis);
    m.quaternion.copy(basisQ);
    m.position.copy(point).addScaledVector(normal, 0.03);
    material.uniforms.uOpacity.value = opacity * a;
  });

  return (
    <mesh ref={ref} renderOrder={1} frustumCulled={false} material={material}>
      <planeGeometry args={[VEHICLE.width * 1.9, VEHICLE.length * 1.4]} />
    </mesh>
  );
}
