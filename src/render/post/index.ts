/**
 * Post-processing module.
 *
 *   <PostFX theme={level.theme} quality={quality} />
 *
 * The custom effects are also available as standalone R3F components (each owns, drives and
 * disposes its effect) for use in another <EffectComposer>, and as raw postprocessing classes.
 */
export { PostFX, type PostFXProps } from './PostFX';
export { HeatDistortion, SpeedFX, FilmGrade, SPEED_FX_START_KMH, SPEED_FX_FULL_KMH } from './components';
export { HeatDistortionEffect } from './HeatDistortionEffect';
export { SpeedFXEffect } from './SpeedFXEffect';
export { FilmGradeEffect } from './FilmGradeEffect';
