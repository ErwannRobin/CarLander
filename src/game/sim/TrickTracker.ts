import type { Vector3 } from 'three';
import { RAD } from '../physics/util';
import { TUNING } from '../tuning';
import type { GameEvent, TrickInstance, TrickKind } from '../types';

type Move = 'pitch' | 'yaw' | 'roll';

const MULT_LABEL = ['', '', 'DOUBLE ', 'TRIPLE ', 'QUADRUPLE ', 'QUINTUPLE '];

const KIND_BIT: Record<TrickKind, number> = {
  frontflip: 0,
  backflip: 1,
  spin: 2,
  barrelRoll: 3,
  hangTime: 4,
  inverted: 5,
  bullseye: 6,
};

/** Points for `count` rotations of a move worth `base`: each extra rotation is worth ×1.5 the previous. */
export function rotationPoints(base: number, count: number): number {
  let total = 0;
  let p = base;
  for (let i = 0; i < count; i++) {
    total += p;
    p *= TUNING.scoring.extraRotationFactor;
  }
  return Math.round(total);
}

export function trickLabel(kind: TrickKind, count: number): string {
  const mult = count < MULT_LABEL.length ? MULT_LABEL[count] : `${count}× `;
  switch (kind) {
    case 'frontflip':
      return `${mult}FRONTFLIP`;
    case 'backflip':
      return `${mult}BACKFLIP`;
    case 'barrelRoll':
      return `${mult}BARREL ROLL`;
    case 'spin':
      return `${count * 360} SPIN`;
    default:
      return kind.toUpperCase();
  }
}

function basePoints(kind: TrickKind): number {
  const s = TUNING.scoring;
  if (kind === 'frontflip' || kind === 'backflip') return s.flip;
  if (kind === 'barrelRoll') return s.barrelRoll;
  if (kind === 'spin') return s.spin;
  return 0;
}

/**
 * Tracks rotations during a jump (ARCHITECTURE §6).
 *
 * Integrates body-frame angular velocity into accumulated pitch / yaw / roll (degrees, chassis
 * axes: +pitch = nose up, +yaw = left, +roll = roll right). Each full 360° registers a trick and
 * emits a `trick` event immediately (the move's entry is upgraded in place: BACKFLIP → DOUBLE
 * BACKFLIP). On landing, a rotation within the tolerance (≥ 330°) of the next full turn also
 * counts. Bonuses (hang time, inverted, bullseye) are appended through `addBonus`.
 */
export class TrickTracker {
  readonly rotation = { pitch: 0, yaw: 0, roll: 0 };
  readonly tricks: TrickInstance[] = [];
  private readonly counted: Record<Move, number> = { pitch: 0, yaw: 0, roll: 0 };
  private readonly entries: Record<Move, TrickInstance | null> = { pitch: null, yaw: null, roll: null };
  private hangTimeAwarded = false;

  reset(): void {
    this.rotation.pitch = 0;
    this.rotation.yaw = 0;
    this.rotation.roll = 0;
    this.tricks.length = 0;
    this.counted.pitch = 0;
    this.counted.yaw = 0;
    this.counted.roll = 0;
    this.entries.pitch = null;
    this.entries.yaw = null;
    this.entries.roll = null;
    this.hangTimeAwarded = false;
  }

  /** Integrates one tick of body-local angular velocity (rad/s). */
  update(localAngVel: Vector3, dt: number, airTime: number, events: GameEvent[]): void {
    this.rotation.pitch += localAngVel.x * dt * RAD;
    this.rotation.yaw += localAngVel.y * dt * RAD;
    this.rotation.roll += -localAngVel.z * dt * RAD;
    this.check('pitch', 0, events);
    this.check('yaw', 0, events);
    this.check('roll', 0, events);
    const s = TUNING.scoring;
    if (!this.hangTimeAwarded && airTime > s.hangTimeMin) {
      this.hangTimeAwarded = true;
      this.addBonus('hangTime', 'HANG TIME', 1, s.hangTimeBase, events);
    }
  }

  /** Landing: counts near-complete rotations (tolerance) and finalizes hang time points. */
  finalize(airTime: number, events: GameEvent[]): void {
    const tol = TUNING.scoring.landingToleranceDeg;
    this.check('pitch', tol, events);
    this.check('yaw', tol, events);
    this.check('roll', tol, events);
    const s = TUNING.scoring;
    const hang = this.tricks.find((t) => t.kind === 'hangTime');
    if (hang) {
      hang.label = `HANG TIME ${airTime.toFixed(1)} s`;
      hang.points = Math.round(s.hangTimeBase + s.hangTimePerSec * Math.max(0, airTime - s.hangTimeMin));
    }
  }

  addBonus(kind: TrickKind, label: string, count: number, points: number, events: GameEvent[]): TrickInstance {
    const t: TrickInstance = { kind, label, count, points: Math.round(points) };
    this.tricks.push(t);
    events.push({ type: 'trick', trick: { ...t } });
    return t;
  }

  /** Adds an already-announced trick (e.g. the INVERTED bonus carried into a jump) without an event. */
  adopt(t: TrickInstance): void {
    this.tricks.push(t);
  }

  get trickPoints(): number {
    let p = 0;
    for (const t of this.tricks) p += t.points;
    return p;
  }

  /** Distinct trick kinds in this jump (combo multiplier input). Allocation-free (read every air tick). */
  get distinctKinds(): number {
    let mask = 0;
    let n = 0;
    for (const t of this.tricks) {
      const bit = 1 << KIND_BIT[t.kind];
      if ((mask & bit) === 0) {
        mask |= bit;
        n++;
      }
    }
    return n;
  }

  private check(move: Move, toleranceDeg: number, events: GameEvent[]): void {
    const deg = this.rotation[move];
    const count = Math.floor((Math.abs(deg) + toleranceDeg) / 360);
    if (count <= this.counted[move]) return;
    this.counted[move] = count;
    const kind: TrickKind =
      move === 'pitch' ? (deg > 0 ? 'backflip' : 'frontflip') : move === 'yaw' ? 'spin' : 'barrelRoll';
    const points = rotationPoints(basePoints(kind), count);
    let entry = this.entries[move];
    if (!entry) {
      entry = { kind, label: '', count: 0, points: 0 };
      this.entries[move] = entry;
      this.tricks.push(entry);
    }
    entry.kind = kind;
    entry.count = count;
    entry.points = points;
    entry.label = trickLabel(kind, count);
    events.push({ type: 'trick', trick: { ...entry } });
  }
}
