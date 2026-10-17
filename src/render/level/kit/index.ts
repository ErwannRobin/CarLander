/**
 * Architecture kit — parametric, merged/instanced decor for level designers.
 * Every component accepts KitTransform (position / rotation (Euler XYZ rad) / scale / name).
 */
export { TrussTower, TrussBeam, Pylon, Arch, CableStays, RingGate, LEDStrip, addLedBar } from './structures';
export type { TrussTowerProps, TrussBeamProps, PylonProps, ArchProps, CableStaysProps, RingGateProps, LEDStripProps } from './structures';
export { Floodlight, LightRig } from './lighting';
export type { FloodlightProps, LightRigProps, FixtureLightOptions } from './lighting';
export { Grandstand, Monolith, Billboard, FacilityBase } from './architecture';
export type { GrandstandProps, MonolithProps, BillboardProps, FacilityBaseProps } from './architecture';
export { CanyonWall, RockSpire, SANDSTONE } from './terrain';
export type { CanyonWallProps, RockSpireProps } from './terrain';
export { kitLightBudget, useLightSlot, ValueNoise, type KitTransform } from './common';
export { getCladdingMaterial, getPanelMap, type CladdingVariant } from './kitMaterials';
