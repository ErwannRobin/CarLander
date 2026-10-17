/**
 * Gameplay & physics tuning. Owned by the physics module; other modules may READ these.
 * All values SI (m, s, kg, N, rad) unless the name says otherwise.
 *
 * Feel targets these values are tuned for (verified by tests/physics + tests/sim):
 *  - 0–100 km/h ≈ 2.3 s, ≈ 205 km/h on wheels, ≈ 290 km/h with thrust
 *  - static sag ≈ 0.12 m, at rest |v| < 0.05 m/s after 3 s
 *  - full lock at 60 km/h → radius ≈ 10–15 m without spinning; 200 km/h lane change stays planted
 *  - W held → 360° flip in ≈ 1.3 s, release → rotation stops in ≈ 0.5 s
 *  - stabilizer levels a 70° roll in ≈ 1.2 s
 */
export const TUNING = {
  /** Fixed physics timestep. */
  dt: 1 / 120,
  /** Max physics ticks per rendered frame (spiral-of-death guard). */
  maxTicksPerFrame: 10,
  gravity: 14,

  // --- drive -------------------------------------------------------
  /** Top speed on wheels without thrust (m/s) ~ 205 km/h. */
  maxSpeed: 57,
  /** Peak drive acceleration at low speed (m/s^2) — constant-force region of the e-motor. */
  driveAccel: 13.6,
  /** Speed where the motor leaves the constant-force region and becomes power-limited (m/s). */
  driveBaseSpeed: 19.5,
  /** Soft limiter: drive fades to zero over this many m/s around maxSpeed. */
  driveLimiterWidth: 7,
  reverseMaxSpeed: 14,
  reverseAccel: 8,
  brakeDecel: 26,
  /** Gentle regen deceleration when coasting (no throttle) (m/s^2). */
  coastDecel: 1.1,
  /** Below this speed with no throttle the tires hold the car still (m/s). */
  holdSpeed: 0.6,
  /** Absolute speed cap including thrust (m/s) ~ 290 km/h. */
  maxSpeedBoost: 80,

  // --- rocket thrusters ---------------------------------------------
  /** Thrust acceleration along chassis forward (m/s^2). Must exceed gravity to climb. */
  thrustAccel: 24,

  // --- air control ---------------------------------------------------
  airPitchRate: 5.4,
  airYawRate: 3.4,
  airRollRate: 5.6,
  /** How fast the angular velocity approaches the target rate (1/s). */
  airControlResponse: 7,
  /** Angular damping when no input on an axis (1/s). */
  airDamping: 2.6,

  // --- vacuum ---------------------------------------------------------
  /** Max range from the underbody to a compatible surface (m). */
  vacuumRange: 5,
  /** Peak suction acceleration (multiples of gravity) when close to the surface. */
  vacuumPeakG: 2.6,

  // --- landing thresholds -----------------------------------------------
  landing: {
    perfect: { angleDeg: 9, impact: 8, driftDeg: 9 },
    clean: { angleDeg: 24, impact: 14, driftDeg: 28 },
    hard: { angleDeg: 50, impact: 24, driftDeg: 70 },
    /** Wheels must touch within this window after touchdown to count (s). */
    touchdownWindow: 0.15,
    /** PERFECT requires at least this many wheels within the touchdown window. */
    perfectMinWheels: 3,
    /** Drift angle is only evaluated above this tangential speed (m/s). */
    driftMinSpeed: 4,
    /** Post-touchdown window during which a crash downgrades the landing (s). */
    settleTime: 0.7,
  },

  /* ================================================================== */
  /* Detailed vehicle model                                              */
  /* ================================================================== */

  suspension: {
    /** Spring rate per wheel (N/m): static sag ≈ m·g/4/k ≈ 0.12 m. */
    stiffness: 42000,
    /**
     * Damping per wheel (N·s/m): firm compression (ζ ≈ 0.75) so PERFECT-range landings (≤ 8 m/s)
     * never bottom the tub out, overdamped rebound so hard landings don't bounce.
     */
    bumpDamping: 6500,
    reboundDamping: 7500,
    /** Progressive bump stop: engages below this spring length (m) — 5 cm under static sag. */
    bumpStopStart: 0.25,
    /** Quadratic bump-stop rate (N/m²): F = k·(start − L)². Kept soft: stiffness stores energy (bounce). */
    bumpStopStiffness: 3.5e6,
    /** Extra compression damping inside the bump-stop zone (N·s/m) — absorbs landings. */
    bumpStopDamping: 22000,
    /** Anti-roll bar rates (N/m of left/right compression difference). */
    antiRollFront: 14000,
    antiRollRear: 9000,
    /** Safety clamp per wheel (N) — high enough not to cap landing damping (stable: c·dt/m ≈ 0.6). */
    maxForce: 130000,
    /** Visual droop speed of an unloaded wheel (m/s). */
    droopSpeed: 2.5,
  },

  tire: {
    /** Peak friction coefficient (friction circle radius = μ·N). */
    friction: 1.45,
    rollingResistance: 0.012,
    /**
     * Tire forces are applied this fraction of the way from the contact point up to the CoM height
     * (classic raycast-vehicle "roll influence") — keeps body roll readable but never tippy.
     */
    forceLift: 0.55,
    /** AWD torque split (front share, rear = 1 − front). */
    frontDriveShare: 0.4,
    /** Sequential impulse iterations for the tire contact solver. */
    iterations: 4,
    /** Lateral slip speed mapped to full slip visuals (m/s). */
    slipVisualSpeed: 6,
  },

  steering: {
    /** Max wheel angle at standstill / at top speed (deg). */
    maxAngleDeg: 30,
    minAngleDeg: 6,
    /** Speed scale of the falloff between the two (m/s). */
    speedFalloff: 17,
    /** Normalized steering rate (1/s) towards input / back to center. */
    rate: 4.5,
    returnRate: 6.5,
  },

  assists: {
    /** Yaw-rate stability: allowed excess over the kinematic yaw rate (rad/s + fraction). */
    yawMargin: 0.12,
    yawMarginFrac: 0.2,
    /** Gain removing yaw-rate excess (1/s). */
    yawGain: 9,
    /** Ground rollover resistance: dead zone (deg), stiffness (1/s²), damping (1/s). */
    rollDeadzoneDeg: 6,
    rollStiffness: 40,
    rollDamping: 7,
    /** Max angular acceleration from ground assists (rad/s²). */
    maxAccel: 14,
  },

  aero: {
    /** Quadratic drag coefficient (N per (m/s)²). */
    drag: 0.48,
    /** Downforce coefficient when grounded (N per (m/s)² of forward speed). */
    downforce: 1.4,
  },

  air: {
    /** No wheel contact for this long ⇒ airborne (s). */
    airborneDelay: 0.08,
    /** Airborne for longer than this ⇒ a scored jump (s). */
    jumpMinAirTime: 0.25,
    /** Constant deceleration added to airDamping so released rotations stop in ≈ 0.5 s (rad/s²). */
    stopDecel: 6.5,
    /** Max angular acceleration of air control per axis (rad/s²): pitch, yaw, roll. */
    maxAccel: [34, 24, 38] as [number, number, number],
    /** Air-control authority multiplier while thrusting (thrust vectoring). */
    thrustAuthority: 1.25,
  },

  stabilizer: {
    /** Attitude P gain (1/s): desired rate = gain · error (cascaded with the rate loop: ζ ≈ 0.9). */
    gain: 2.3,
    /** Inner rate-loop response (1/s). */
    response: 7.5,
    /** Max correction rate (rad/s). */
    maxRate: 4,
    /** Max angular acceleration (rad/s²). */
    maxAccel: 30,
    /** Flight assist: weak automatic leveling after no rotation input for `assistDelay`. */
    assistGain: 0.25,
    assistDelay: 0.35,
    assistMaxRate: 1.2,
    /** Below this projected speed the stabilizer keeps the current heading (m/s). */
    headingMinSpeed: 3,
  },

  boost: {
    /** Thrust fades out over the last m/s before maxSpeedBoost. */
    speedFade: 6,
    levelRiseRate: 10,
    levelFallRate: 5,
  },

  vacuum: {
    /** Strength ramp rates (1/s). */
    engageRate: 8,
    releaseRate: 14,
    /** Full suction up to this underbody distance (m); smooth falloff to vacuumRange. */
    fullRange: 1.2,
    /**
     * Suction scales with how much gravity already presses the car into the surface, so the
     * springs always carry ≈ (vacuumPeakG − 1) g: ceiling → vacuumPeakG, wall → wallG,
     * floor → floorG ("slight extra downforce").
     */
    wallG: 1.6,
    floorG: 0.4,
    /** Alignment PD (only with < 3 wheels grounded): rad/s² per rad, 1/s, clamp rad/s². */
    alignKp: 20,
    alignKd: 6.5,
    alignMaxAccel: 14,
  },

  crash: {
    /** Chassis contact with |angle(up, n)| above this for `rolloverTime` ⇒ rollover. */
    rolloverAngleDeg: 70,
    rolloverTime: 0.25,
    /** Single-tick contact Δv above this ⇒ impact crash (m/s). */
    impactDeltaV: 16,
    /** Nose-first chassis contact faster than this ⇒ nose-dive (m/s). */
    noseDiveSpeed: 15,
    /** Requested time scale and its duration (sim seconds) after a crash. */
    timeScale: 0.35,
    slowMoTime: 0.6,
  },

  perfectSlowMo: { timeScale: 0.5, duration: 0.35 },

  prediction: {
    /** Predict every N ticks. */
    interval: 3,
    /** Integration step (s) and horizon (s). */
    step: 0.04,
    horizon: 6,
    maxPoints: 48,
  },

  scoring: {
    airTimePoints: 120,
    distancePoints: 4,
    flip: 600,
    barrelRoll: 500,
    spin: 400,
    /** Each extra rotation of the same move is worth ×1.5 the previous one. */
    extraRotationFactor: 1.5,
    /** A rotation counts at 330° on landing (tolerance for near-complete rotations). */
    landingToleranceDeg: 30,
    hangTimeMin: 3,
    hangTimeBase: 400,
    hangTimePerSec: 150,
    invertedMinDistance: 20,
    invertedPerMeter: 12,
    bullseye: 750,
    bullseyeRadius: 0.25,
    perfectMult: 2,
    perfectBonus: 1000,
    cleanMult: 1.5,
    hardMult: 1,
    comboPerTrick: 0.5,
    chainStep: 0.25,
    chainWindow: 3,
    /** Level result bonuses. */
    timeBonusPar: 90,
    timeBonusPerSec: 40,
    finalLanding: { perfect: 2500, clean: 1200, hard: 400 },
  },
} as const;

export const KMH = 3.6;
