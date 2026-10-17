# ROADSTER FLIGHT — Architecture & Build Spec

A premium web arcade game: a rocket-assisted electric sports car that launches off monumental
ramps, performs controlled aerial stunts, drives upside down with a vacuum adhesion system, and
must **land perfectly**. Three handcrafted tutorial levels: LEARN TO FLY → CLEAR THE GAP → THE INVERTED RAMP.

Pillars, in priority order:
1. Spectacular, coherent visual presentation (premium indie / high-end commercial look).
2. Immediately understandable, deeply satisfying vehicle control (deterministic-feeling arcade physics).
3. A compelling progression: learn to fly → tricks over a gap → master the inverted ramp and land.

---------------------------------------------------------------------------------------------------

## 1. Stack & commands

- Vite 8 + React 19 + TypeScript 7 (`tsc` is the native compiler), Three.js r186, @react-three/fiber 9,
  @react-three/drei 10, @react-three/postprocessing 3 (+ postprocessing 6), Rapier 0.21
  (`@dimforge/rapier3d-compat`, raw API — NOT @react-three/rapier), zustand 5.
- Fonts (bundled, offline): Michroma (display), Inter Variable (UI), JetBrains Mono (telemetry numerals).
- Path alias: `@/` → `src/`.

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on http://127.0.0.1:5173 (strictPort). A shared instance is usually already running — check with `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/` before starting one (start it with `nohup npm run dev > /tmp/vite.log 2>&1 &`). |
| `npx tsc --noEmit` | Typecheck the whole project. Other agents' in-progress files may error — filter output to your own paths. |
| `npx vitest run tests/<dir>` | Headless tests (Node; Rapier works in Node). |
| `node scripts/shot.mjs <path> <out.png> [--ready] [--wait ms] [--keys "KeyW:2000,Space:500"] [--series N] [--fps] [--mobile] [--eval js]` | Headless Chromium (GPU/Metal) screenshot + console error capture. Read the PNG with the Read tool to *see* your work. Dev pages set `window.__shotReady = true` when ready. |

Dev sandbox pages: `dev/<name>.html` + `dev/<name>.tsx` (served at `http://127.0.0.1:5173/dev/<name>.html`).
Each module owner builds its own sandbox page that imports ONLY its module (+ shared foundation), so a
broken file elsewhere does not break your page.

`src/dev/mockRuntime.ts` provides `useMockRuntime()` / `<MockRuntimeDriver/>`: a scripted fake sim
(accelerate → jump with thrust and a backflip → landing → vacuum engage → drift → crash → loop, on a
flat ground plane at y = 0) that drives `runtime.frame` and emits `runtime.events`. Render/audio/UI
sandboxes should use it until the real sim is integrated. `freezeAt: seconds` freezes the timeline for screenshots.

## 2. Directory map & ownership

Foundation (shared, READ-ONLY for module agents unless stated):
- `src/game/types.ts` — **all shared contracts** (input, vehicle state, snapshot, events, level defs, settings). Only the physics/sim owner may make *additive* edits.
- `src/game/vehicleSpec.ts` — car dimensions, wheel/hardpoint positions, nozzles, RCS ports, colliders.
- `src/game/tuning.ts` — physics/gameplay constants (physics owner may edit values).
- `src/game/track/TrackPath.ts` — turtle builder for track centerlines (frames). `Ribbon.ts` — frames → render meshes + collider trimesh. `zones.ts` — oriented-box zones & Euler helpers.
- `src/game/events.ts` (EventBus), `src/game/runtime.ts` (module singleton `runtime`), `src/game/snapshot.ts` (factories).
- `src/render/palette.ts` (color tokens), `src/config/quality.ts` (quality presets), `src/styles/base.css` (CSS tokens, fonts).
- `scripts/shot.mjs`, `src/dev/mockRuntime.ts`.

Modules:
| Owner | Paths |
|---|---|
| Physics & simulation | `src/game/physics/**`, `src/game/sim/**`, `src/game/levels/testLevels.ts`, `tests/physics/**`, `tests/sim/**`, `dev/physics.*` |
| Car model | `src/render/car/**`, `dev/car.*` |
| Environment & post | `src/render/env/**`, `src/render/post/**`, `dev/env.*` |
| VFX | `src/render/fx/**`, `dev/fx.*` |
| Track rendering & architecture kit | `src/render/level/**`, `dev/kit.*` |
| Audio | `src/audio/**`, `dev/audio.*` |
| UI, input, stores | `src/ui/**`, `src/state/**`, `src/input/**`, `dev/ui.*` |
| Integration (lead) | `src/App.tsx`, `src/main.tsx`, `src/game/GameRunner.ts`, `src/render/camera/**`, `src/render/scenes/**`, `src/render/GameCanvas.tsx` |
| Levels | `src/game/levels/level{1,2,3}.ts` (+ `level{N}/` helpers), `src/render/levels/**`, `tests/levels/**` |

Never edit files you don't own. If you need something from another module, code against the
contract in `types.ts` / this document and note the assumption in your final report.

## 3. Conventions

- Units SI. World +Y up. Levels progress roughly toward **-Z**.
- Local frames (car AND track frames): **right = +X, up = +Y, forward = -Z**.
- Car chassis origin: center line, middle of wheelbase, **axle height at rest** ⇒ flat ground at rest is at chassis y = -0.36 (`VEHICLE.groundY`). A car resting on ground at world y = h has its origin at y = h + 0.36.
- Wheel order: FL, FR, RL, RR.
- Track turtle angles: pitch + = nose up; yaw + = turn LEFT; roll + = roll RIGHT.
- Box/zone `rotationDeg` = three.js Euler `[x, y, z]` degrees, order `'YXZ'` (see `zones.ts`).
- Palette (`PALETTE`): graphite, titanium, warm white, electric cyan (#38e8ff), occasional orange rocket exhaust (#ff7a1c). Red only for Level 3 LED edge strips (Tesla-like) and crash/danger feedback. No neon overload, no generic cyberpunk.
- Color management: renderer uses sRGB output + ACES/AgX tone mapping (set in the canvas by integration). Author colors in sRGB hex.
- Performance budget (high preset, M-series laptop): 60 fps at 1440p; < 250 draw calls; < 1.5M triangles; particles via instanced / points systems with fixed pools (no per-particle Mesh). Dispose geometries/materials/textures you create imperatively (`useEffect` cleanup).
- R3F: never call setState per frame. Read `runtime.frame` inside `useFrame`. Allocate scratch vectors at module or ref scope, not per frame.

## 4. Runtime model

```
Input (keyboard/touch/gamepad/autopilot) ─► InputState
                                             │ sampled once per fixed tick
GameRunner (integration) ── fixed 120 Hz ──► GameSim.step(input)  [src/game/sim, pure TS + Rapier]
     │                                          │ snapshot + events
     │  every rendered frame (useFrame prio -100)
     ├─► runtime.frame = { interpolated pose, snapshot, dt, simDt, time, paused }
     ├─► runtime.events.emit(e)  ──► VFX / audio / camera / UI subscribers
     └─► hud store (throttled ~30 Hz) ──► React HUD
Camera rig (prio -50) ─► reads runtime.frame
Car, FX, env (prio 0) ─► read runtime.frame
EffectComposer (prio 1) renders
```

- The sim is **headless** (no DOM, no React). It uses `three` math classes and Rapier only.
- Slow motion: the sim *requests* `snapshot.timeScale` (tutorial prompts, crash, perfect landing); the runner scales real time before accumulating fixed ticks. Physics dt is always constant ⇒ deterministic for a given input sequence.
- Restart (`R`): the runner calls `sim.reset()` — immediate, deterministic (fresh Rapier world), emits `{type:'reset'}`; renderers clear transient state (particles, trails) on `reset`.

### GameSim API (physics/sim owner implements in `src/game/sim/GameSim.ts`)

```ts
await initPhysics();                         // src/game/physics/initPhysics.ts — RAPIER.init() once
const sim = new GameSim(level: LevelDef, opts?: { firstAttempt?: boolean });
sim.step(input: InputState): void;           // one fixed tick of TUNING.dt
sim.snapshot: SimSnapshot;                   // current state (mutated in place each tick)
sim.prevPose / sim.currPose: { position: Vector3; quaternion: Quaternion }  // for interpolation
sim.drainEvents(): GameEvent[];              // events since last drain
sim.reset(): void;                           // restart challenge (same level), emits 'reset'
sim.dispose(): void;
sim.world (Rapier World) and sim.vehicle are exposed for debugging.
```

## 5. Physics specification (custom raycast vehicle on Rapier)

Fixed timestep 1/120 s, gravity 14 m/s² (arcade-weighty; tune in `TUNING`). Rigid chassis = Rapier dynamic
body with CCD, explicit mass properties from `VEHICLE` (mass 1450 kg, low CoM, inertia [2450, 2800, 600]),
colliders from `CHASSIS_COLLIDERS` (round cuboids, density 0, friction ~0.4, restitution ~0.05). Level
colliders: ribbon trimeshes (from `buildRibbon(...).collider`), cuboids for box pieces. Each static
collider maps to surface info `{ kind, adhesive, pieceId }`.

**Suspension (per wheel):** ray from hardpoint along chassis −up, length `restLength + wheelRadius`
(exclude the car body). Spring length L = hit − r, compression x = restLength − L. Force
F = k·x + c·ẋ (separate bump/rebound damping), clamped ≥ 0, plus a stiff bump-stop near `minLength`.
Static sag ≈ 0.12 m (k ≈ 42 kN/m per wheel at G = 14), damping ratio ≈ 0.5. Apply along the contact
normal (or chassis up) at the hardpoint. Anti-roll bars front/rear. Visual `suspensionLength` = L (droops to rest in air).

**Tires:** contact frame from the hit normal; wheel forward = chassis forward rotated by steer angle,
projected on the contact plane. Lateral force cancels lateral slip velocity (stable impulse-style
formulation), longitudinal drive/brake; friction circle μ·N (μ ≈ 1.3–1.5, N = suspension force).
Drive: AWD 40/60, electric curve (strong low-end, fades to `maxSpeed`), brake then reverse when
nearly stopped, rolling + aero drag, light downforce ∝ v². Speed-sensitive steering (≈ 30° at
standstill → ≈ 6° at top speed), rate-limited. Yaw stability assist to prevent unintended spins;
rollover resistance on the ground (arcade). Expose per-wheel `slip` 0..1 for smoke/squeal.

**Thrusters (Space):** force = mass·`thrustAccel` along chassis forward at the CoM. Works on the ground
(acceleration beyond `maxSpeed` up to `maxSpeedBoost`) and in the air (directional: the player aims it
with pitch/yaw ⇒ climbing is possible because thrustAccel > gravity). Fuel: `LevelDef.fuel`
(capacity in seconds of burn, regen while grounded after a delay). `boostLevel` smoothed for visuals.
While thrusting in the air, air control authority +25% (thrust vectoring).

**Air control (no wheel contact for > 0.08 s):** target-rate controller in chassis axes:
throttle → pitch (W = nose down), steer → yaw, roll → roll. torque = I·(ω_target − ω)·response,
clamped; axes without input are damped (`airDamping`) so rotation stops predictably when keys are
released. Report `rcs` per axis (−1..1) for RCS jet visuals.

**Stabilizer (Shift):** PD controller that rotates the car toward a target attitude:
up = predicted landing-surface normal (or world up if no prediction), forward = velocity direction
projected on that plane (falls back to current forward). Max rate ≈ 4 rad/s, critically damped,
never snaps. **Flight assist** (settings, default on): when no rotation input for 0.35 s, a weak
version (≈ 25% gain) of the same controller.

**Vacuum adhesion system (Enter, hold) — dedicated component `src/game/physics/VacuumSystem.ts`:**
- Available only if `level.vacuumEnabled`. Modes: `off` (not held), `armed` (held, no compatible surface in range), `engaged` (pulling).
- Each tick while held: cast 5 rays (skirt center + 4 corners from `VACUUM_SKIRT`) along chassis −up, max `vacuumRange` (≈ 5 m). Only `adhesive` surfaces count. Compute a distance-weighted average normal n and nearest distance d.
- Suction force on the chassis: −n · mass · G · `vacuumPeakG` · falloff(d) · strength, applied at the CoM (falloff = 1 up to 1.2 m, smooth to 0 at range). `strength` ramps toward its target with rate ≈ 8/s on engage, ≈ 14/s on release ⇒ no snapping, and detachment is natural (the force fades and gravity/momentum take over).
- Alignment torque (only when engaged and fewer than 3 wheels grounded): PD torque rotating chassis up toward n, gain ∝ strength, clamped — it *assists* the catch but never overrides the body orientation fully (suspension does the rest once wheels touch).
- On a ceiling: gravity (1 g away from surface) + suction (2.6 g toward) ⇒ springs carry ≈ 1.6 g ⇒ tire normal load ⇒ grip ⇒ normal driving/steering upside down. Tires/suspension need no special case.
- When engaged and grounded, a slight extra downforce on normal floors is fine. Engagement does not change gravity, mass or controls.
- Events: `vacuumOn`, `vacuumOff`, `vacuumEngaged` (first tick engaged), `vacuumReleased` (engaged → not engaged).

**Ground/air state:** `airborne` after 0.08 s with zero grounded wheels; a *jump* starts when airborne
for > 0.25 s (takeoff event at the first airborne tick, position recorded). Sub-threshold hops are not scored.

**Crash detection** (relative to the touched surface normal, NOT world up, so driving inverted on the
vacuum track is fine):
- chassis upside-down/sideways on a surface: chassis contact with |angle(up, n)| > 70° held 0.25 s → `rollover`; roof contact → `roof`.
- high-energy chassis impact: contact force event or single-tick Δv > 16 m/s → `impact`; nose-first into a surface at > 15 m/s → `nose-dive`.
- landing evaluated as crash (see §6) → `hard-impact`.
- falling below `level.killY` → `fell`.
On crash: phase `crashed`, keep simulating for the drama (car tumbles, sparks), request timeScale 0.35 for 0.6 s, then the runner auto-restarts after ≈ 1.6 s real time (or immediately on R / any action key).

**Trajectory prediction (`src/game/sim/TrajectoryPredictor.ts`):** while airborne (and while engaged on the vacuum near the end of a structure), every 3 ticks integrate a ballistic path (gravity only) from the current state with 0.04 s steps up to 6 s, raycasting each segment against static colliders. Output `LandingPrediction` incl. path (≤ 48 pts), surface normal, `alignmentDeg`, signed pitch/roll errors relative to the surface (in the car's heading frame), predicted quality, `inTarget`.

## 6. Landing, tricks, scoring

**Landing evaluation** (`LandingEvaluator.ts`): at touchdown after a jump (first tick with ≥ 2 wheels
grounded or chassis contact): angle(chassis up, surface normal), impact speed along the normal (from
pre-contact velocity), drift angle (heading vs velocity in the surface plane, if |v_t| > 4 m/s), wheels
touching within 0.15 s. Then a **settle window** of 0.7 s: any crash condition, leaving the platform
(falling, no ground) or rollover downgrades to `crash`.

| Quality | Angle | Impact | Drift | Notes |
|---|---|---|---|---|
| PERFECT | ≤ 9° | ≤ 8 m/s | ≤ 9° | ≥ 3 wheels within 0.15 s, no chassis hit |
| CLEAN | ≤ 24° | ≤ 14 | ≤ 28° | |
| HARD | ≤ 50° | ≤ 24 | ≤ 70° | survived |
| CRASH | otherwise, or any crash during settle | | | |

Thresholds live in `TUNING.landing`. Outcome is deterministic — never random.

**Tricks** (`TrickTracker.ts`): integrate body-frame angular velocity during a jump → accumulated
pitch / yaw / roll. Each full 360° (counted at 330° on landing, tolerance for near-complete rotations)
registers: pitch nose-down = FRONTFLIP, nose-up = BACKFLIP, yaw = SPIN (360/720/…), roll = BARREL ROLL;
multiples → DOUBLE/TRIPLE. Emit `trick` events as each rotation completes. Bonuses: HANG TIME (air > 3 s),
INVERTED (distance driven upside down on the vacuum, ≥ 20 m), BULLSEYE (landing within the inner 25% of the target zone).

**Scoring per jump:** base = airTime·120 + distance·4 + Σ trick points (flip 600, barrel roll 500,
spin 400 per 360, scaled ×1.5 for each extra rotation in the same move) ; multiplier =
landing (PERFECT ×2 + 1000 flat, CLEAN ×1.5, HARD ×1, CRASH ⇒ 0, pending points lost) ×
combo (1 + 0.5·(distinct tricks − 1)) × chain (+0.25 per consecutive non-crash landing within 3 s of the
previous landing; resets on hard landing or crash). Level result adds a time bonus and the final
landing bonus; medals from `LevelDef.medals`.

## 7. Objectives, prompts & tutorial flow

`LevelDef.objectives` is an ordered list; the sim evaluates the active objective's `complete(ctx)` each
tick (after physics + events). `prompt` shows a big center prompt while `when(ctx)` holds; `slowMo`
(first attempt only) requests bullet-time until the player performs the action — used for the L1
"HOLD SPACE — FIRE THRUSTERS" moment right after the ramp lip. Level completion = landing (≥
`finish.minQuality`) inside `finish.zoneId` + `settleTime` stable, after the preceding objectives.
`floatingHints` are world-space signs bound to objectives.

## 8. Levels (design briefs — final geometry is tuned with headless autopilot tests)

All levels float in a vast sky facility: the action happens on monumental elevated structures,
with a sea of clouds and a distant landscape far below (communicates height and danger).

**L1 — LEARN TO FLY** (theme `morning`: crisp golden-morning light, warm white concrete, soft haze).
Wide (≈ 26 m) straight runway (≈ 380 m) with lane markings and distance boards → small kicker
(≈ 16–18°) narrower (≈ 16 m) with orange/white chevrons → open gap over the clouds → long, forgiving
landing deck (gentle downslope at its start) with huge concentric target rings (target zone) → finish.
One mechanic at a time: W accelerate → A/D align with the ramp → SPACE thrust (bullet-time prompt at
the lip, first attempt) → W/S pitch to match the landing slope → SHIFT stabilize → land in the target.
Ballistic without thrust should fall short of the target zone (thrust is the lesson) but a crash is
still avoidable; with thrust the target is easy. Spawn rolling slowly so it's fun within 10 s.

**L2 — CLEAR THE GAP** (theme `canyon`: late golden hour, dramatic long shadows, colossal canyon walls,
monumental architectural pylons). A more demanding track: two rollers/kickers for trick practice
(optional combo), a boost straight, then a big launch ramp (≈ 26–30°) over a huge chasm (≈ 140–180 m)
with a suspended ring gate mid-gap (bonus), landing on a long ski-jump style downslope (≈ 28–32°) that
flattens into the finish deck. Simple successful line: full speed + short thrust + stabilize. Skilled
line: backflip(s)/spins + thrust to adjust + realign to the slope ⇒ PERFECT + combo. Primary objective:
land on all four wheels beyond the gap.

**L3 — THE INVERTED RAMP** (theme `night`: dusk-to-night arena, floodlights, red LED edge strips,
steel truss towers). Inspired directly by Tesla's Oct-2026 "Real life, baby" demo: a **tall free-standing
crescent ramp** — a concrete-grey drive surface with a white center line and **red LED strips along both
edges**, supported by a **steel lattice truss tower** behind it. Profile: horizontal entry → quarter pipe →
vertical wall → **overhang that curves past vertical into an inverted section at the top** (C / wave shape).
In the video the car climbs it, reaches the inverted top, detaches, fires **blue cold-gas RCS jets** to
flip upright while falling, and lands in a huge cloud of smoke.
Game version (monumental scale, ~60–80 m tall): start runway → jump across a void (aerial approach) onto a
landing deck aligned with the crescent entry (cyan guide chevrons) → HOLD ENTER: vacuum engages on the
quarter pipe → climb the vertical wall → overhang → an extended **inverted beam** (the red-lit truss arm,
≈ 80–140 m, gently curving sideways) driven upside down → a marked RELEASE zone near its end → release Enter
→ fall/fly inverted → reorient (Q/E roll or SHIFT) with blue RCS puffs → thrust to adjust → land on a
**distant platform** with a ski-jump landing hill → finish. Must be completable through input in headless
autopilot tests.

## 9. Visual direction

- Sky: custom gradient shader (zenith → horizon haze), sun disk + glow, high cirrus; volumetric-looking
  cloud sea BELOW the facility + scattered cumulus around; distant landscape/mountain silhouettes with
  strong atmospheric perspective (fog/haze tinted by the theme). The environment map for reflections is
  generated in-scene (no external HDR files).
- Materials: polished concrete (subtle noise, panel seams), brushed titanium, warm white panels, dark
  graphite asphalt with crisp white lane lines, tasteful thin emissive accents (cyan; red LEDs only in L3).
- Lighting: one shadow-casting sun following the car (tight frustum, soft PCF), hemisphere fill, AO (N8AO on high),
  bloom only on emissives/exhaust, ACES/AgX tone mapping, subtle vignette.
- Car (hero): sculpted lofted body (not boxes), pearl/titanium metallic paint with clearcoat reflections,
  dark glass canopy, light bars, detailed multi-spoke wheels with brake discs/calipers, rear rocket nozzle
  assemblies, suspension travel, wheel spin and steering, body roll/pitch from the physics pose.
- FX: orange rocket exhaust (core + plume + heat shimmer + light), blue/white RCS jets, tire smoke, landing
  dust/smoke clouds, sparks on scrapes, vacuum underglow/airflow, speed lines at high speed, landing marker
  reticle + subtle trajectory arc, perfect-landing celebration burst. Effects never hide the car.
- Camera: chase cam with anticipation, velocity-based framing in the air (flips don't spin the camera),
  limited roll, FOV widening with speed, collision-aware, up-vector follows the driving surface when
  grounded (so steering stays screen-consistent on the inverted ramp), returns to world-up in the air.

## 10. Audio direction

Procedural WebAudio (no sample files required): electric motor whine (pitch ∝ wheel speed, two
detuned harmonics + filtered noise), wind (∝ v²), rocket roar (filtered noise + low rumble + crackle),
RCS hiss puffs, vacuum turbine (rising whine) with distinctive engage *thunk-whoosh* and release *hiss*,
tire squeal, landing thuds by quality, scrape/crash crunch, PERFECT chime, trick ding, UI ticks.
Music: restrained procedural ambient/synth score with a pulse that intensifies in the air. Buses:
master / music / sfx + mute. AudioContext resumed on first user gesture.

## 11. UI

Premium, minimal, secondary to the 3D scene. Michroma for display headings (wide tracking), Inter for UI,
JetBrains Mono for numbers. Glassy graphite panels, hairline titanium borders, cyan accents.
Screens: Title (over a live 3D vehicle preview), Level Select (unlock progression, best score/medal/
best landing), Settings (master/music/sfx volume, mute, graphics quality, camera shake, flight assist,
trajectory preview, key remapping), Pause (resume, restart, settings, quit), Level Complete (score
breakdown count-up, medal, personal best, next/retry/menu), Crash overlay (brief). HUD: speed (km/h),
fuel/thrust gauge, vacuum indicator (OFF / ARMED / ENGAGED, L3), current objective + adaptive control
guide, altitude & air time while airborne, trick feed & combo, landing quality banner, attitude
indicator vs. the predicted landing surface. Touch controls on coarse pointers. Every visible button works.

## 12. Controls

| Action | Default keys | Notes |
|---|---|---|
| Accelerate / pitch down (air) | W, ArrowUp | |
| Brake / reverse / pitch up (air) | S, ArrowDown | |
| Steer / yaw (air) | A D, ArrowLeft ArrowRight | |
| Roll (air) | Q, E | barrel rolls / reorientation |
| Thrusters | Space | |
| Vacuum (hold) | Enter | Level 3 |
| Stabilize (hold) | ShiftLeft, ShiftRight | gyro auto-level |
| Restart | R | instant |
| Pause | Escape, P | |

Gamepad (bonus): left stick steer/pitch, RT accelerate, LT brake, A thrust, RB vacuum, LB stabilize, bumpers/X-Y roll.
