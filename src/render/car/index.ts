/**
 * Hero car module — procedural, lofted sports car matching src/game/vehicleSpec.ts.
 *
 *  <CarModel ref paint? />  pure visual, imperative CarModelHandle (origin = chassis origin)
 *  <Car />                  game binding: reads runtime.frame each frame (useFrame priority 0)
 *  <ShowroomCar />          title preview (idle pose, light breathing, settle; same chassis origin)
 *
 * All three share the chassis origin of src/game/vehicleSpec.ts: a car resting on a floor at
 * height h is placed at y = h - VEHICLE.groundY (0.36 m above the floor).
 */
export { CarModel, visualSuspensionLength, type CarModelHandle, type CarModelProps } from './CarModel';
export { Car, type CarProps } from './Car';
export { ShowroomCar, type ShowroomCarProps } from './ShowroomCar';
export { acquireCarGeometry, releaseCarGeometry, type CarGeometry } from './carAssets';
export { rcsPortSurface, type RcsPortVisual } from './geometry/details';
