/**
 * ROADSTER FLIGHT — visual effects module.
 *
 *   <GameFX showTrajectory />            all gameplay effects (wraps everything in <FXProvider>)
 *
 * Individual effects (must be rendered inside <FXProvider>, except SpeedLines / LandingMarker /
 * TrajectoryArc which are standalone):
 *   RocketExhaust, RcsJets, TireSmoke, LandingFX, ImpactFX, VacuumFX, SpeedLines, LandingMarker,
 *   TrajectoryArc
 *
 * Everything is driven by `runtime.frame` (pose + snapshot) and `runtime.events`, and clears its
 * transient state on the 'reset' event (or a `runtime.runId` change).
 *
 * Engine pieces for custom effects: FXProvider / useFX / useFXFrame / useFXReset, ParticlePool +
 * ParticleSpawn, RingWavePool + RingSpawn, per-theme look (FX_THEMES).
 */
export { GameFX, type GameFXProps } from './GameFX';
export { FXProvider, type FXProviderProps, useFX, useFXFrame, useFXReset } from './FXContext';
export { FXSystem, FX_ORDER, type FXFrameContext, type FXTick } from './core/FXSystem';
export { FX_THEMES, type FXThemeLook, resolveFXTheme } from './core/theme';
export {
  ParticlePool,
  ParticleSpawn,
  type ParticlePoolOptions,
  type PoolBlending,
  SPRITE_GLOW,
  SPRITE_SMOKE,
  MAX_LOCAL_LIGHTS,
  randomSmokeSprite,
} from './core/ParticlePool';
export { RingWavePool, RingSpawn, type RingKind } from './core/RingWavePool';
export { createSpriteAtlas } from './core/spriteAtlas';
export { RocketExhaust } from './effects/RocketExhaust';
export { RcsJets } from './effects/RcsJets';
export { allocateRcs, rcsJetLevels, RCS_TORQUE, RCS_VISIBLE_FULL, RCS_VISIBLE_MIN } from './effects/rcsAllocation';
export { TireSmoke } from './effects/TireSmoke';
export { LandingFX } from './effects/LandingFX';
export { ImpactFX } from './effects/ImpactFX';
export { VacuumFX } from './effects/VacuumFX';
export { SpeedLines, type SpeedLinesProps } from './effects/SpeedLines';
export { LandingMarker } from './effects/LandingMarker';
export { TrajectoryArc } from './effects/TrajectoryArc';
