# ROADSTER FLIGHT

A 3D browser arcade game (proof of concept). You drive a futuristic electric roadster with rocket
thrusters off monumental ramps above the clouds, fly it, do tricks, and try to land without crashing.

Built with Vite, React 19, TypeScript, three.js / React Three Fiber, Rapier physics and zustand.
Everything is procedural: the car, the environments, the effects and the audio. There are no
external assets.

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # typecheck + production build into dist/
npm test           # headless physics, sim and level tests
```

## Controls

| Action | Keyboard | Notes |
|---|---|---|
| Accelerate / brake & reverse | W / S (or ↑ / ↓) | In the air: pitch nose down / nose up |
| Steer | A / D (or ← / →) | In the air: yaw |
| Roll | Q / E | Air only |
| Thrusters | Space | Uses fuel, refills on the ground |
| Stabilizer | Shift | Levels the car toward the landing surface |
| Vacuum | Enter (hold) | Level 3: stick to the crescent and drive upside down |
| Restart | R | |
| Pause | Esc / P | |

Keys can be remapped in Settings. Gamepads and touch controls are supported.

## Levels

1. **Learn to Fly** (morning runway). Full throttle down the runway, let go at the lip, fire the
   thrusters, match the slope and stabilize into the target rings.
2. **Clear the Gap** (golden-hour canyon). Flip off two trick kickers, boost up the big ramp,
   clear a 190 m chasm through the ring gate and land on all four wheels.
3. **The Inverted Ramp** (night arena, after Tesla's crescent-ramp demo). Jump onto the arena,
   hold the vacuum up an 86 m crescent, drive the beam upside down, release, flip upright and
   land on the distant hill.

Landings are graded PERFECT, CLEAN, HARD or CRASH. The score adds distance, air time, tricks,
landing quality and a combo multiplier. Medals, best scores and level unlocks are saved locally.

## Dev tools

- `/?level=1|2|3` jumps straight into a level. Add `&autopilot=1` to watch the level's reference
  pilot play it. `/?unlockAll=1` unlocks every level.
- `window.__game` (while playing) exposes the runner, sim snapshot, camera, scene, stores and
  `frameStats()`.
- Module sandboxes: `/dev/{physics,car,env,fx,kit,audio,ui}.html`.
- `node scripts/shot.mjs <path> <out.png>` takes headless Chromium screenshots of the running
  game (run it without arguments for the options).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module layout, the sim/render contract and the
design briefs.
