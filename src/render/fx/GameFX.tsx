/**
 * GameFX — every gameplay effect for the game scene, driven by runtime.frame + runtime.events.
 * Mount once inside the R3F canvas, next to the car (it reads the same interpolated pose).
 */
import type { ReactNode } from 'react';
import type { ThemeId } from '@/game/types';
import { FXProvider } from './FXContext';
import { ImpactFX } from './effects/ImpactFX';
import { LandingFX } from './effects/LandingFX';
import { LandingMarker } from './effects/LandingMarker';
import { RcsJets } from './effects/RcsJets';
import { RocketExhaust } from './effects/RocketExhaust';
import { SpeedLines } from './effects/SpeedLines';
import { TireSmoke } from './effects/TireSmoke';
import { TrajectoryArc } from './effects/TrajectoryArc';
import { VacuumFX } from './effects/VacuumFX';

export interface GameFXProps {
  /** Dotted predicted trajectory (Settings.showTrajectory). Default true. */
  showTrajectory?: boolean;
  /** Landing reticle + footprint ghost. Default true. */
  showLandingMarker?: boolean;
  /** Speed streaks above ~160 km/h. Default true. */
  speedLines?: boolean;
  /** Theme override for the FX look (default: `runtime.level?.theme`, else morning). */
  theme?: ThemeId;
  /** World direction towards the key light for smoke shading (default: the scene's shadow-casting sun). */
  lightDirection?: readonly [number, number, number];
  /** Extra effects rendered inside the same FX provider (they can use useFX / useFXFrame). */
  children?: ReactNode;
}

export function GameFX({
  showTrajectory = true,
  showLandingMarker = true,
  speedLines = true,
  theme,
  lightDirection,
  children,
}: GameFXProps) {
  return (
    <FXProvider theme={theme} lightDirection={lightDirection}>
      <TireSmoke />
      <LandingFX />
      <ImpactFX />
      <VacuumFX />
      <RcsJets />
      <RocketExhaust />
      {speedLines && <SpeedLines theme={theme} />}
      {showLandingMarker && <LandingMarker />}
      {showTrajectory && <TrajectoryArc />}
      {children}
    </FXProvider>
  );
}
