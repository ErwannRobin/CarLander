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
| Vertical booster | F | Underbody jets: hop, or cushion a landing. Same fuel as the thrusters |
| Stabilizer | Shift | Levels the car toward the landing surface |
| Vacuum | Enter (hold) | Level 3: stick to the crescent and drive upside down |
| Restart | R | |
| Pause | Esc / P | |

Keys can be remapped in Settings. Gamepads (B = vertical booster) and touch controls are supported.

**On a phone** (landscape): tilt the phone like a steering wheel to steer. Left thumb: GAS and BRAKE. Right thumb:
THRUST and JUMP (the vertical booster); VACUUM appears on Level 3, STABILIZE and ROLL appear in the air.
Drag a finger over the scene to look around; the camera returns behind the car on its own. Tilt steering needs
the motion sensor, which browsers only give to secure pages (https, or localhost) and, on iPhone, after you
accept the prompt on your first tap. Otherwise (or with Settings → Tilt steering off) an on-screen stick steers.

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
