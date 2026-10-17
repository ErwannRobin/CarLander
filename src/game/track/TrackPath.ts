import { Quaternion, Vector3 } from 'three';
import type { TrackFrame, V3 } from '../types';

/**
 * Turtle-graphics builder for track centerlines.
 *
 * Local frame convention: right = +X, up = +Y, forward = -Z.
 *  - pitch  (+ = nose up)      rotates about local +X
 *  - yaw    (+ = turn LEFT)    rotates about local +Y
 *  - roll   (+ = roll RIGHT)   rotates about local forward (-Z): `up` tilts towards `right`
 *
 * Every command integrates the frame along arc length, sampling a frame every `step` meters
 * (and exactly at each command end). The resulting frames feed buildRibbon() for both
 * render meshes and physics colliders, so geometry and physics always match.
 *
 * Example — runway, kicker ramp, then a separate landing deck 70 m further and 6 m lower:
 *   const run = new TrackPath({ position: [0, 0, 0] }).straight(300).up(18, 30);
 *   const lip = run.end();
 *   const land = TrackPath.fromFrame(TrackPath.offsetFrame(lip, { forward: 70, up: -6, pitchDeg: -18 - 4 }))
 *     .up(22, 60).straight(200);
 */

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_FWD = new Vector3(0, 0, -1);
const DEG = Math.PI / 180;
/** Max integration micro-step (m). */
const MICRO = 0.1;

export interface PathStart {
  position: V3 | Vector3;
  /** Heading: 0 faces -Z; +90 faces -X (left). */
  yawDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;
}

/** Build an orientation from intrinsic yaw -> pitch -> roll (degrees, track conventions above). */
export function orientationFromAngles(yawDeg = 0, pitchDeg = 0, rollDeg = 0): Quaternion {
  const qy = new Quaternion().setFromAxisAngle(AXIS_Y, yawDeg * DEG);
  const qp = new Quaternion().setFromAxisAngle(AXIS_X, pitchDeg * DEG);
  const qr = new Quaternion().setFromAxisAngle(AXIS_FWD, rollDeg * DEG);
  return qy.multiply(qp).multiply(qr);
}

export function makeFrame(position: Vector3, quaternion: Quaternion, s: number): TrackFrame {
  const q = quaternion.clone().normalize();
  return {
    s,
    position: position.clone(),
    quaternion: q,
    forward: AXIS_FWD.clone().applyQuaternion(q),
    up: AXIS_Y.clone().applyQuaternion(q),
    right: AXIS_X.clone().applyQuaternion(q),
  };
}

export function cloneFrame(f: TrackFrame): TrackFrame {
  return makeFrame(f.position, f.quaternion, f.s);
}

export class TrackPath {
  readonly frames: TrackFrame[] = [];
  readonly step: number;
  private pos = new Vector3();
  private q = new Quaternion();
  private s = 0;

  constructor(start: PathStart, step = 1) {
    this.step = step;
    if (start.position instanceof Vector3) this.pos.copy(start.position);
    else this.pos.set(start.position[0], start.position[1], start.position[2]);
    this.q.copy(orientationFromAngles(start.yawDeg, start.pitchDeg, start.rollDeg));
    this.frames.push(makeFrame(this.pos, this.q, 0));
  }

  /** Start a new path exactly at an existing frame (arc length restarts at 0). */
  static fromFrame(frame: TrackFrame, step = 1): TrackPath {
    const p = new TrackPath({ position: frame.position }, step);
    p.q.copy(frame.quaternion);
    p.frames[0] = makeFrame(p.pos, p.q, 0);
    return p;
  }

  /**
   * A new frame displaced from `frame` along its own axes, optionally re-oriented by extra
   * intrinsic angles (degrees, track conventions) applied on top of the frame's orientation.
   */
  static offsetFrame(
    frame: TrackFrame,
    o: { forward?: number; up?: number; right?: number; yawDeg?: number; pitchDeg?: number; rollDeg?: number },
  ): TrackFrame {
    const pos = frame.position
      .clone()
      .addScaledVector(frame.forward, o.forward ?? 0)
      .addScaledVector(frame.up, o.up ?? 0)
      .addScaledVector(frame.right, o.right ?? 0);
    const q = frame.quaternion.clone().multiply(orientationFromAngles(o.yawDeg, o.pitchDeg, o.rollDeg));
    return makeFrame(pos, q, 0);
  }

  /** Same as offsetFrame but the displacement is given in WORLD axes. */
  static translateFrame(frame: TrackFrame, delta: V3): TrackFrame {
    return makeFrame(frame.position.clone().add(new Vector3(...delta)), frame.quaternion, 0);
  }

  get length(): number {
    return this.s;
  }

  straight(length: number): this {
    return this.curve({ length });
  }

  /** Pitch up by `deg` along a circular arc of `radius`. */
  up(deg: number, radius: number): this {
    return this.curve({ pitchDeg: deg, length: Math.abs(deg) * DEG * radius });
  }

  down(deg: number, radius: number): this {
    return this.curve({ pitchDeg: -deg, length: Math.abs(deg) * DEG * radius });
  }

  left(deg: number, radius: number): this {
    return this.curve({ yawDeg: deg, length: Math.abs(deg) * DEG * radius });
  }

  right(deg: number, radius: number): this {
    return this.curve({ yawDeg: -deg, length: Math.abs(deg) * DEG * radius });
  }

  /** Twist about the forward axis over `length` (+ = roll right / bank right). */
  roll(deg: number, length: number): this {
    return this.curve({ rollDeg: deg, length });
  }

  /**
   * General segment: rotate the frame by pitch/yaw/roll (local, degrees) distributed uniformly
   * over `length` meters while advancing along the (changing) forward direction.
   */
  curve(seg: { length: number; pitchDeg?: number; yawDeg?: number; rollDeg?: number }): this {
    const L = Math.max(0, seg.length);
    if (L <= 1e-9) return this;
    // Local angular rate vector (rad per meter) in local axes (X, Y, Z).
    // Roll is about -Z, so a +roll maps to a negative Z component.
    const w = new Vector3(
      ((seg.pitchDeg ?? 0) * DEG) / L,
      ((seg.yawDeg ?? 0) * DEG) / L,
      (-(seg.rollDeg ?? 0) * DEG) / L,
    );
    const wLen = w.length();
    const wAxis = wLen > 1e-12 ? w.clone().divideScalar(wLen) : new Vector3(1, 0, 0);

    const nFrames = Math.max(1, Math.ceil(L / this.step - 1e-9));
    const frameDs = L / nFrames;
    const nMicro = Math.max(1, Math.ceil(frameDs / MICRO));
    const ds = frameDs / nMicro;

    const qHalf = new Quaternion().setFromAxisAngle(wAxis, (wLen * ds) / 2);
    const qFull = new Quaternion().setFromAxisAngle(wAxis, wLen * ds);
    const qMid = new Quaternion();
    const fwd = new Vector3();

    for (let f = 0; f < nFrames; f++) {
      for (let m = 0; m < nMicro; m++) {
        qMid.copy(this.q).multiply(qHalf);
        fwd.copy(AXIS_FWD).applyQuaternion(qMid);
        this.pos.addScaledVector(fwd, ds);
        this.q.multiply(qFull).normalize();
        this.s += ds;
      }
      this.frames.push(makeFrame(this.pos, this.q, this.s));
    }
    return this;
  }

  /** Copy of the last frame. */
  end(): TrackFrame {
    return cloneFrame(this.frames[this.frames.length - 1]);
  }

  /** Interpolated frame at arc length s (clamped). */
  at(s: number): TrackFrame {
    return frameAt(this.frames, s);
  }
}

/** Interpolated frame at arc length `s` along a frame list (clamped). */
export function frameAt(frames: TrackFrame[], s: number): TrackFrame {
  if (frames.length === 0) throw new Error('frameAt: empty frames');
  if (s <= frames[0].s) return cloneFrame(frames[0]);
  const last = frames[frames.length - 1];
  if (s >= last.s) return cloneFrame(last);
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const t = (s - a.s) / Math.max(1e-9, b.s - a.s);
  const pos = a.position.clone().lerp(b.position, t);
  const q = a.quaternion.clone().slerp(b.quaternion, t);
  return makeFrame(pos, q, s);
}

/** Concatenate frame lists (e.g. when a piece is assembled from several TrackPaths); arc length is made continuous. */
export function joinFrames(...lists: TrackFrame[][]): TrackFrame[] {
  const out: TrackFrame[] = [];
  let offset = 0;
  for (const list of lists) {
    if (list.length === 0) continue;
    const start = out.length > 0 ? 1 : 0; // skip duplicated junction frame
    const base = list[0].s;
    for (let i = start; i < list.length; i++) {
      const f = cloneFrame(list[i]);
      f.s = list[i].s - base + offset;
      out.push(f);
    }
    offset = out[out.length - 1].s;
  }
  return out;
}

/** Signed pitch (deg) of a frame's forward vector relative to the horizon (+ = climbing). */
export function framePitchDeg(f: TrackFrame): number {
  return Math.asin(Math.max(-1, Math.min(1, f.forward.y))) / DEG;
}
