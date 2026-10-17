/**
 * In-world tutorial signage bound to objectives.
 *
 * Each FloatingHintDef becomes a dark-glass panel (tracked Michroma title + key caps) with slim
 * titanium edge bars. Panels yaw-billboard towards the approaching car (runtime.frame.position),
 * are visible only while `objectiveId === runtime.frame.snapshot.objective.id` — or, for an
 * integer string, equals the objective index — (always when the hint has no objectiveId), fade
 * in/out, fade away when the car gets very close and stay hidden once it has driven past
 * (re-armed on restart: 'reset' event / runtime.runId).
 * All per-frame work reads runtime.frame inside useFrame; no React state per frame.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import {
  BackSide,
  BoxGeometry,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type CanvasTexture,
} from 'three';
import type { ControlHint, FloatingHintDef } from '@/game/types';
import { runtime } from '@/game/runtime';
import { PALETTE } from '@/render/palette';
import { drawSignPanel, ensureFonts } from './textures/textTextures';

export interface FloatingHintsProps {
  hints: FloatingHintDef[];
  /** Maps a hint to key labels (e.g. from the user's current bindings). Default: hint.keys. */
  resolveKeys?: (hint: ControlHint) => string[];
  /** Panel width in meters. Default 8. */
  width?: number;
  /** Fade time constant (s). Default 0.35. */
  fadeTime?: number;
}

interface PanelRuntime {
  def: FloatingHintDef;
  /** `def.objectiveId` read as an objective index when it is an integer string (types.ts: "index (or id)"). */
  objectiveIndex: number | null;
  group: Group;
  panelMat: MeshBasicMaterial;
  backMat: MeshBasicMaterial;
  edgeMat: MeshStandardMaterial;
  texture: CanvasTexture;
  alpha: number;
  yaw: number;
  phase: number;
  /** Closest approach of the car this run (to detect that it has driven past the sign). */
  minDist: number;
  runId: number;
}

const panelGeo = new PlaneGeometry(1, 1);
const edgeGeo = new BoxGeometry(1, 1, 1);

export function FloatingHints({ hints, resolveKeys, width = 8, fadeTime = 0.35 }: FloatingHintsProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void ensureFonts().then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // Everything a panel bakes in: artwork AND placement / binding (hint ids may repeat across
  // levels, so a level switch must not keep a previous level's positions or objectives).
  const key = useMemo(
    () =>
      JSON.stringify(
        hints.map((h) => [
          h.id,
          h.text,
          h.position,
          h.objectiveId ?? null,
          h.hint ? (resolveKeys ? resolveKeys(h.hint) : h.hint.keys) : null,
          h.hint?.label ?? null,
        ]),
      ),
    [hints, resolveKeys],
  );

  const panels = useMemo<PanelRuntime[]>(() => {
    if (!ready) return [];
    return hints.map((def, i) => {
      const keys = def.hint ? (resolveKeys ? resolveKeys(def.hint) : def.hint.keys) : undefined;
      const sign = drawSignPanel({ title: def.text, keys, keyLabel: def.hint?.label });
      const h = width / sign.aspect;
      const group = new Group();
      group.name = `hint:${def.id}`;
      group.position.set(...def.position);
      // front: artwork (never mirrored); back: plain dark glass
      const panelMat = new MeshBasicMaterial({
        map: sign.texture,
        transparent: true,
        depthWrite: false,
        side: FrontSide,
        opacity: 0,
        fog: true,
      });
      const backMat = new MeshBasicMaterial({
        color: PALETTE.graphite900,
        transparent: true,
        depthWrite: false,
        side: BackSide,
        opacity: 0,
        fog: true,
      });
      const panel = new Mesh(panelGeo, panelMat);
      panel.scale.set(width, h, 1);
      panel.renderOrder = 2;
      group.add(panel);
      const back = new Mesh(panelGeo, backMat);
      back.scale.set(width, h, 1);
      back.renderOrder = 2;
      group.add(back);
      const edgeMat = new MeshStandardMaterial({
        color: PALETTE.titanium200,
        metalness: 1,
        roughness: 0.3,
        transparent: true,
        opacity: 0,
      });
      for (const y of [h / 2 + 0.06, -h / 2 - 0.06]) {
        const bar = new Mesh(edgeGeo, edgeMat);
        bar.position.set(0, y, -0.02);
        bar.scale.set(width * 0.985, 0.07, 0.12);
        group.add(bar);
      }
      group.visible = false;
      const id = def.objectiveId?.trim();
      return {
        def,
        objectiveIndex: id && /^\d+$/.test(id) ? Number(id) : null,
        group,
        panelMat,
        backMat,
        edgeMat,
        texture: sign.texture,
        alpha: 0,
        yaw: Math.PI,
        phase: i * 1.7,
        minDist: Infinity,
        runId: runtime.runId,
      };
    });
    // `key` captures the content of hints / resolveKeys (rebuild only when the artwork changes)
  }, [ready, key, width]);

  useEffect(
    () => () => {
      for (const p of panels) {
        p.texture.dispose();
        p.panelMat.dispose();
        p.backMat.dispose();
        p.edgeMat.dispose();
      }
    },
    [panels],
  );

  // Restart re-arms the "already passed" state. runtime.runId covers runners that bump it; the
  // 'reset' event covers the rest (e.g. the dev mock loop), whichever comes first.
  useEffect(() => {
    const off = runtime.events.on('reset', () => {
      for (const p of panels) p.minDist = Infinity;
    });
    return () => {
      off();
    };
  }, [panels]);

  useFrame((_, delta) => {
    const f = runtime.frame;
    const objective = f.snapshot.objective;
    const car = f.position;
    const dt = Math.min(0.1, Math.max(0, delta));
    const k = 1 - Math.exp(-dt / Math.max(1e-3, fadeTime));
    for (const p of panels) {
      const active = !p.def.objectiveId || p.def.objectiveId === objective.id || p.objectiveIndex === objective.index;
      const g = p.group;
      const [px, py, pz] = p.def.position;
      const dx = car.x - px;
      const dz = car.z - pz;
      // a non-finite pose (sim blow-up) must not poison the fade state forever
      const rawDist = Math.hypot(dx, dz, car.y - py);
      const dist = Number.isFinite(rawDist) ? rawDist : Infinity;
      // fade out when the car is very close, and stay hidden once it has driven past
      // (moved 4 m away from a close approach). Re-armed on restart (runtime.runId).
      if (p.runId !== runtime.runId) {
        p.runId = runtime.runId;
        p.minDist = Infinity;
      }
      if (dist < p.minDist) p.minDist = dist;
      const passed = p.minDist < 30 && dist > p.minDist + 4;
      const near = Math.min(1, Math.max(0, (dist - 7) / 12));
      const target = active && !passed ? near : 0;
      p.alpha += (target - p.alpha) * k;
      if (p.alpha < 0.004 && target === 0) {
        g.visible = false;
        continue;
      }
      g.visible = true;
      // yaw billboard towards the car: damped while visible, snapped while (nearly) invisible
      if (Math.hypot(dx, dz) > 0.5 && dist < Infinity) {
        const want = Math.atan2(dx, dz);
        let d = want - p.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        p.yaw += p.alpha < 0.05 ? d : d * Math.min(1, dt * 4);
      }
      g.rotation.set(0, p.yaw, 0);
      g.position.set(px, py + Math.sin(f.time * 0.9 + p.phase) * 0.12, pz);
      p.panelMat.opacity = p.alpha;
      p.backMat.opacity = p.alpha * 0.85;
      p.edgeMat.opacity = p.alpha;
    }
  });

  return (
    <group name="floating-hints">
      {panels.map((p) => (
        <primitive key={p.def.id} object={p.group} />
      ))}
    </group>
  );
}
