/**
 * Track rendering, procedural materials and the architecture kit.
 *
 * Gameplay geometry (one line in the scene):
 *   <LevelGeometry level={level} />
 *     - ribbons via buildRibbon() with the physics options (width / thickness / rails): drive surface
 *       per TrackStyle, concrete/metal slab sides, rails, edge caps, emissive edge LEDs + light spill
 *     - box pieces, auto supports (chalice pylons every ~30 m under level decks, truss backing +
 *       lattice tower behind steep / vertical / inverted sections)
 *     - zone markers (target rings, finish arch, ring gates, checkpoint frames, deck markings for
 *       `visible: true` trigger zones such as the L3 RELEASE zone — also on inverted decks)
 *     - floating hint signage bound to objectives (reads runtime.frame)
 *   Static geometry is merged per material; rebuilt + disposed when `level` changes. Wide box tops
 *   use marking-free "field" variants of runway / ramp / landing / adhesive (no tiled lanes).
 *
 * Imperative use (no React): buildLevelGeometry(level, options) -> { group, probe, dispose() }.
 * Shared materials / procedural textures: getLevelMaterials() (cached; disposeLevelMaterials()
 * only on full teardown).
 *
 * Architecture kit (decor for level designers), all accept position / rotation / scale / name:
 *   <TrussTower> <TrussBeam from to> <Pylon> <Arch> <CableStays> <RingGate> <LEDStrip points>
 *   <Floodlight> <LightRig> <Grandstand> <Monolith> <Billboard text> <FacilityBase>
 *   <CanyonWall> <RockSpire>
 */
export { LevelGeometry, type LevelGeometryProps } from './LevelGeometry';
export { FloatingHints, type FloatingHintsProps } from './FloatingHints';
export { buildLevelGeometry, type LevelBuild, type LevelBuildOptions } from './buildLevel';
export type { SupportOptions } from './geometry/supports';
export { SurfaceProbe, type SurfaceHit } from './geometry/surfaceProbe';
export {
  getLevelMaterials,
  disposeLevelMaterials,
  withAlbedoDetail,
  LED_TINTS,
  type LevelMaterials,
  type LedColor,
} from './materials';
export {
  getAsphaltDetail,
  getConcreteDetail,
  getBrushedDetail,
  getLayoutTextures,
  getFieldLayoutTextures,
  getFasciaTextures,
  getLedDotTexture,
  type DetailTextures,
  type LayoutTextures,
} from './textures/trackTextures';
export { getTargetTextures } from './textures/markerTextures';
export { ensureFonts, drawSignPanel, drawLabel, drawBillboard, type SignContent, type BillboardContent } from './textures/textTextures';
export * from './kit';
