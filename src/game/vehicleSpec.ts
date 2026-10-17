/**
 * Shared vehicle dimensions — used by physics (colliders, hardpoints), the procedural
 * car model (geometry), VFX (nozzle / RCS emitters) and the camera.
 *
 * Chassis local frame: right = +X, up = +Y, forward = -Z.
 * Origin: x = 0 (center line), z = 0 (middle of the wheelbase),
 *         y = 0 at wheel-center (axle) height when the car rests on flat ground.
 * => flat ground at rest is at y = -WHEEL_RADIUS.
 */

export const VEHICLE = {
  /** Overall body length / width / height (m). */
  length: 4.46,
  width: 1.98,
  height: 1.12,

  wheelRadius: 0.36,
  wheelWidthFront: 0.29,
  wheelWidthRear: 0.33,
  wheelbase: 2.72,
  trackFront: 1.7,
  trackRear: 1.72,

  /** Ground y in chassis space at rest. */
  groundY: -0.36,
  /** Body underside (floor) y in chassis space (12 cm ground clearance). */
  floorY: -0.24,
  /** Roof top y in chassis space. */
  roofY: 0.76,
  /** Front-most / rear-most body z. */
  noseZ: -2.23,
  tailZ: 2.23,

  /** Suspension (spring) lengths, hardpoint -> wheel center (m). */
  suspension: {
    /** Hardpoint height above the axle at rest. Spring length at static rest == hardpointY. */
    hardpointY: 0.3,
    /** Natural (fully extended) length — wheel droops to here in the air. */
    restLength: 0.42,
    /** Minimum length (bump stop). */
    minLength: 0.12,
  },

  /** Physics mass properties. */
  mass: 1450,
  /** Center of mass (chassis local) — low, battery-in-floor. */
  centerOfMass: [0, -0.1, 0.05] as [number, number, number],
  /** Principal angular inertia (kg m^2) about X (pitch), Y (yaw), Z (roll). */
  inertia: [2450, 2800, 600] as [number, number, number],
} as const;

/** Wheel centers at rest (chassis local), order FL, FR, RL, RR. */
export const WHEEL_POSITIONS: ReadonlyArray<[number, number, number]> = [
  [-VEHICLE.trackFront / 2, 0, -VEHICLE.wheelbase / 2],
  [VEHICLE.trackFront / 2, 0, -VEHICLE.wheelbase / 2],
  [-VEHICLE.trackRear / 2, 0, VEHICLE.wheelbase / 2],
  [VEHICLE.trackRear / 2, 0, VEHICLE.wheelbase / 2],
];

/** Suspension hardpoints (ray origins), chassis local, order FL, FR, RL, RR. */
export const HARDPOINTS: ReadonlyArray<[number, number, number]> = WHEEL_POSITIONS.map(
  ([x, , z]) => [x, VEHICLE.suspension.hardpointY, z] as [number, number, number],
);

/**
 * Main rocket nozzles (chassis local). Exhaust leaves along +Z (backwards).
 * Two nozzles integrated in the rear diffuser / light-bar area.
 */
export const NOZZLES: ReadonlyArray<{ position: [number, number, number]; radius: number }> = [
  { position: [-0.34, -0.02, 2.2], radius: 0.13 },
  { position: [0.34, -0.02, 2.2], radius: 0.13 },
];

/**
 * Cold-gas RCS ports used for air-control visuals (chassis local).
 * `dir` is the jet (exhaust) direction; the reaction force on the car is -dir.
 * A port contributes torque r x (-dir) about the center of mass.
 */
export const RCS_PORTS: ReadonlyArray<{ position: [number, number, number]; dir: [number, number, number] }> = [
  // front corners: up / down / sideways
  { position: [-0.78, 0.18, -1.95], dir: [0, 1, 0] },
  { position: [0.78, 0.18, -1.95], dir: [0, 1, 0] },
  { position: [-0.78, -0.2, -1.95], dir: [0, -1, 0] },
  { position: [0.78, -0.2, -1.95], dir: [0, -1, 0] },
  { position: [-0.95, 0.0, -1.85], dir: [-1, 0, 0] },
  { position: [0.95, 0.0, -1.85], dir: [1, 0, 0] },
  // rear corners: up / down / sideways
  { position: [-0.8, 0.22, 1.95], dir: [0, 1, 0] },
  { position: [0.8, 0.22, 1.95], dir: [0, 1, 0] },
  { position: [-0.8, -0.2, 1.95], dir: [0, -1, 0] },
  { position: [0.8, -0.2, 1.95], dir: [0, -1, 0] },
  { position: [-0.97, 0.0, 1.85], dir: [-1, 0, 0] },
  { position: [0.97, 0.0, 1.85], dir: [1, 0, 0] },
];

/** Vacuum skirt footprint under the floor (chassis local) — suction rays start here. */
export const VACUUM_SKIRT = {
  halfWidth: 0.78,
  halfLength: 1.75,
  y: VEHICLE.floorY,
} as const;

/** Physics collider boxes (chassis local): rounded cuboids. */
export const CHASSIS_COLLIDERS: ReadonlyArray<{
  center: [number, number, number];
  halfExtents: [number, number, number];
  borderRadius: number;
}> = [
  // main tub
  { center: [0, 0.02, 0], halfExtents: [0.88, 0.14, 2.1], borderRadius: 0.1 },
  // cabin / greenhouse
  { center: [0, 0.48, 0.2], halfExtents: [0.6, 0.16, 0.95], borderRadius: 0.08 },
];
