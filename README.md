<div align="center">

# ROADSTER FLIGHT

**Launch a rocket-assisted roadster off monumental ramps above the clouds. Then land it perfectly.**

### [▶ Play it in your browser](https://erwannrobin.github.io/CarLander/)

[![CI](https://github.com/ErwannRobin/CarLander/actions/workflows/ci.yml/badge.svg)](https://github.com/ErwannRobin/CarLander/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<img src="docs/screenshots/title.png" alt="Title screen: a white roadster on a glowing platform above the clouds" width="800">

</div>

A free 3D arcade game that runs in the browser, on desktop or phone. You drive a futuristic electric
roadster with rocket thrusters off huge ramps, fly it, do tricks and try to land without crashing.
It is a proof of concept.

## Features

- Four handcrafted levels, from a morning runway to a 190 m canyon gap.
- Arcade flight physics: thrusters, a vertical booster, a stabilizer and a vacuum that sticks the car to a ramp.
- Landings graded PERFECT, CLEAN, HARD or CRASH, with score, combo, medals and level unlocks.
- Replay of your run with a spectator camera, slow motion and a 10 s video export.
- Keyboard, gamepad and touch controls. On a phone, the device tilts like a steering wheel.
- Fully procedural: the car, the environments, the effects and the audio. There are no external models, textures or sound files.

<div align="center">
<img src="docs/screenshots/level1.png" alt="Level 1: the car on the runway, with the HUD" width="800">
</div>

## Quick start

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

Other commands (`make help` lists the same ones as `make` targets):

```bash
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build on http://127.0.0.1:4173
npm test           # headless physics, sim and level tests
```

## Controls

| Action | Keyboard | Notes |
|---|---|---|
| Accelerate / brake & reverse | W / S (or ↑ / ↓) | In the air: pitch nose down / nose up |
| Steer | A / D (or ← / →) | In the air: yaw |
| Roll | Q / E | Air only |
| Thrusters | Space | Uses fuel, refills on the ground |
| Vertical booster | F | Underbody jets: hop, or cushion a landing. Same fuel as the thrusters |
| Stabilizer | Shift | Levels the car toward the landing surface |
| Vacuum | Enter (hold) | Level 3: stick to the crescent and drive upside down |
| Restart | R | |
| Pause | Esc / P | |

Keys can be remapped in Settings. Gamepads (B = vertical booster) and touch controls are supported.

**On a phone** (landscape): the phone is the controller. Turn it like a steering wheel to steer, tip it forward
for GAS and back for BRAKE (the neutral pose is wherever you hold it when the 3-2-1 ends; tap the small gas /
brake meter to recentre). Right thumb: THRUST and JUMP (the vertical booster); VACUUM appears on Level 3,
STABILIZE and ROLL appear in the air. Drag a finger over the scene to look around and pinch to zoom; the orbit
returns behind the car on its own (a tap resets orbit and zoom). Tilt controls need the motion sensor, which
browsers only give to secure pages (https, or localhost) and, on iPhone, after you accept the prompt when you
press Play. If the sensor is refused or missing (or with Settings → Tilt controls off) a small on-screen stick
steers and drives instead. On the home screen, drag to turn the car and pinch (or scroll) to zoom.
Every run starts with a 3-2-1 countdown (`?nocountdown=1` skips it for QA).

## Levels

1. **Learn to Fly** (morning runway). Full throttle down the runway, let go at the lip, fire the
   thrusters, match the slope and stabilize into the target rings.
2. **Kickflip** (jump jets over a line of parked cars, then land a kickflip on the far side).
3. **The Inverted Ramp** (night arena, after Tesla's crescent-ramp demo). Floor it down a straight
   road (no jump), hold the vacuum up an 86 m crescent, drive the straight beam upside down, release,
   flip upright and land on the distant hill.
4. **Clear the Gap** (golden-hour canyon). Flip off two trick kickers, boost up the big ramp,
   clear a 190 m chasm through the ring gate and land on all four wheels.

Landings are graded PERFECT, CLEAN, HARD or CRASH. The score adds distance, air time, tricks,
landing quality and a combo multiplier. Medals, best scores and level unlocks are saved locally.

## Dev tools

- `/?level=1|2|3|4` jumps straight into a level. Add `&autopilot=1` to watch the level's reference
  pilot play it. `/?unlockAll=1` unlocks every level.
- `window.__game` (while playing) exposes the runner, sim snapshot, camera, scene, stores and
  `frameStats()`.
- Module sandboxes: `/dev/{physics,car,env,fx,kit,audio,ui}.html`.
- `node scripts/shot.mjs <path> <out.png>` takes headless Chromium screenshots of the running
  game (run it without arguments for the options).

## Tech stack

Vite, React 19, TypeScript, three.js with React Three Fiber, Rapier physics (raw API) and zustand.
Tests run with Vitest, headless in Node.

## Project layout

| Path | Content |
|---|---|
| `src/game` | Simulation, vehicle physics, replay and the level definitions |
| `src/render` | three.js scene: car, environments, effects |
| `src/audio` | Procedural sound effects and music |
| `src/input` | Keyboard, gamepad and touch input |
| `src/ui` | Menus, HUD and screens |
| `src/state` | zustand stores and saved progress |
| `dev/` | Sandbox pages for single modules |
| `tests/` | Physics, sim, level and replay tests |
| `scripts/` | Screenshot and smoke-test tool |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module layout, the sim/render contract and the design briefs.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

Code: [MIT](LICENSE) © Erwann Robin. The fonts (Inter, JetBrains Mono, Michroma) come from
[Fontsource](https://fontsource.org) and are under the SIL Open Font License.

ROADSTER FLIGHT is an independent fan project. It is not affiliated with, sponsored by or endorsed
by Tesla, Inc. References to real stunts are for homage only; all names and trademarks belong to
their owners.
