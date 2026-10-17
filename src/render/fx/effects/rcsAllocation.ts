/**
 * RCS port selection (pure, testable).
 *
 * Each port i produces a torque  tau_i = (r_i - CoM) x (-dir_i)  about the center of mass.
 * Commanded activity (snapshot.vehicle.rcs) is expressed in torque space as
 *   c = (pitch about +X, yaw about +Y, roll-right about -Z).
 * Each torque axis is normalized by the largest magnitude any port achieves on it, so pure-roll
 * commands (weaker lever arms) light their ports as fully as pitch / yaw. Activation is the signed
 * alignment  a_i = dot(tau~_i, c): ports that would fight another commanded axis cancel out, which
 * naturally selects the efficient diagonal pairs for mixed commands.
 */
import { RCS_PORTS, VEHICLE } from '@/game/vehicleSpec';

export type TorqueAxes = readonly [pitch: number, yaw: number, rollRight: number];

function computeNormalizedTorques(): TorqueAxes[] {
  const [cx, cy, cz] = VEHICLE.centerOfMass;
  const raw = RCS_PORTS.map(({ position: p, dir: d }) => {
    const rx = p[0] - cx;
    const ry = p[1] - cy;
    const rz = p[2] - cz;
    const fx = -d[0];
    const fy = -d[1];
    const fz = -d[2];
    const tx = ry * fz - rz * fy;
    const ty = rz * fx - rx * fz;
    const tz = rx * fy - ry * fx;
    return [tx, ty, -tz] as const; // roll right = rotation about -Z
  });
  const max = [0, 0, 0];
  for (const t of raw) for (let k = 0; k < 3; k++) max[k] = Math.max(max[k], Math.abs(t[k]));
  return raw.map((t) => [
    max[0] > 1e-6 ? t[0] / max[0] : 0,
    max[1] > 1e-6 ? t[1] / max[1] : 0,
    max[2] > 1e-6 ? t[2] / max[2] : 0,
  ]);
}

/** Normalized per-port torque (pitch, yaw, roll-right), same order as RCS_PORTS. */
export const RCS_TORQUE: ReadonlyArray<TorqueAxes> = computeNormalizedTorques();

/**
 * Writes the activation (0..1) of every RCS port for the commanded activity into `out`.
 * `pitch` about +X (nose up), `yaw` about +Y (nose left), `roll` + = roll right.
 */
export function allocateRcs(pitch: number, yaw: number, roll: number, out: Float32Array, deadzone = 0.22): Float32Array {
  const inv = 1 / (1 - deadzone);
  for (let i = 0; i < RCS_TORQUE.length; i++) {
    const t = RCS_TORQUE[i];
    const a = (t[0] * pitch + t[1] * yaw + t[2] * roll - deadzone) * inv;
    out[i] = a < 0 ? 0 : a > 1 ? 1 : a;
  }
  return out;
}

/** Command magnitude below which no jet fires (flight-assist noise)... */
export const RCS_VISIBLE_MIN = 0.03;
/** ...and at which the selected jets are fully open. */
export const RCS_VISIBLE_FULL = 0.35;

/**
 * Jet levels (0..1 per port, RCS_PORTS order) for the sim's `vehicle.rcs` command, for visuals.
 *
 * The sim reports rcs as the normalized angular acceleration it applies: full scale only while a
 * rotation spins up or stops, and ~0.05–0.2 while the stabilizer / flight assist carry a slow roll
 * (e.g. righting the car after the Level 3 release). Feeding that magnitude straight into
 * `allocateRcs` would keep the jets dark through most such maneuvers (deadzone), so ports are
 * selected from the command DIRECTION and the magnitude maps to intensity through
 * [RCS_VISIBLE_MIN, RCS_VISIBLE_FULL]: gentle corrections show fainter, shorter jets.
 */
export function rcsJetLevels(pitch: number, yaw: number, roll: number, out: Float32Array): Float32Array {
  const mag = Math.sqrt(pitch * pitch + yaw * yaw + roll * roll);
  const k = (mag - RCS_VISIBLE_MIN) / (RCS_VISIBLE_FULL - RCS_VISIBLE_MIN);
  if (!(k > 0)) return out.fill(0); // also catches NaN commands
  const inv = 1 / mag;
  allocateRcs(pitch * inv, yaw * inv, roll * inv, out);
  const scale = k < 1 ? k : 1;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}
