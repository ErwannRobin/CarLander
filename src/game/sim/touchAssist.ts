import type { InputState, SimSnapshot, TouchAssistDef } from '../types';

/**
 * Touch-only flight help for a beginner level (LevelDef.touchAssist). On a phone the gas is a
 * tilt, so a player still tipping the phone forward at the lip pitches the nose down in the air.
 * In the air the pitch axis is ignored (`ignorePitch`) and, from `autoStabilize` seconds after
 * lift-off, the stabilizer is held for the player. Mutates and returns `input`.
 */
export function applyTouchAssist(input: InputState, snap: SimSnapshot, def: TouchAssistDef): InputState {
  if (snap.phase !== 'running' || !snap.vehicle.airborne) return input;
  const t = snap.air.airTime;
  if (def.ignorePitch) input.throttle = 0;
  if (t >= def.autoStabilize) input.stabilize = true;
  return input;
}
