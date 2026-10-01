# Weapon Lab

A tactical weapon-handling sandbox: the foundation for a co-op PvE robot shooter.
It targets Android and iOS (through Capacitor) and also runs in a desktop browser.

**Stack:** TypeScript, Three.js (rendering), Rapier (physics, WASM), Vite, lil-gui

## Run

- **Windows:** double-click `start-lab.bat`. It installs dependencies on first run, starts the server and opens the browser.
- **Any OS:** run the commands below.

  ```bash
  npm install
  npm run lab
  ```

  `npm run lab` opens the browser. `npm run dev` starts the server without opening it.
- **Phone:** on the same Wi-Fi, open `http://<PC-IP>:5173`.
- **URL flags:**
  - `?touch` forces the touch UI on desktop.
  - `?nolock` runs without pointer lock (used for automated tests).

On the start screen, click anywhere or press Enter. Esc releases the mouse.

## Controls (desktop)

| Key | Action |
| --- | --- |
| WASD / Mouse | move / look |
| Shift / Space / C | sprint / jump / crouch |
| Q / E (hold) | lean left / right |
| V | swap shoulder |
| LMB / RMB | fire (point fire, no crosshair) / aim down sights |
| R / B / T | reload / fire mode / inspect (magazine, chamber) |
| [ / ] | zero distance |
| 1-8, mouse wheel | AK-47, MK47, AS VAL, M4A1, RD-704, PPSh-41, pistol, shotgun |
| **Lab** | |
| G | aim rays: camera ray, bore ray, muzzle vector, wall probes, bullet trajectories |
| L | test laser (parallel to the bore) |
| J | debug crosshair |
| N | damage numbers |
| Z | slow motion |
| I | infinite ammo |
| K | reset robots |
| M | next test station (wall test, lean pillar, long range…) |
| H / Tab / F1 | debug HUD / tuning panel / help |

The touch UI adds LEAN ◀ ▶ (hold), MODE, RAY and LSR buttons, plus a weapon strip.
RAY, LSR, the debug HUD, help and the last weapon are remembered between sessions.

## Gun-handling model

The camera and the weapon are separate bodies. The camera responds instantly. The weapon is held in two hands and responds physically.

- **Muzzle-based shooting.** Every bullet leaves the real muzzle along the bore.
  - At hip (point fire), the gun points at the camera ray at `aim.hipConvergence`.
  - In ADS, the sight sits on the eye and the bore is elevated so the trajectory crosses the line of sight at `aim.zeroDistance`.
  - The weapon renders with the world camera's FOV, so the muzzle you see is the muzzle that fires.
- **Handling from `weight`, `length` and `ergonomics`** (`weapons/Handling.ts`). These drive:
  - inertia (turn lag and settle)
  - ADS time and settle
  - sway amplitude
  - arm-stamina drain
  - raise/lower speed
  - recoil mass

  Heavy, long and low-ergonomics guns feel heavier because of how the systems interact, not because of slower animations.
- **Procedural recoil** (`Viewmodel.kick` + `RecoilSystem`).
  - Each shot is an impulse into springs that rotate the gun around the shoulder.
  - Leftover energy makes taps, bursts and full auto differ naturally.
  - Part of the climb reaches the view. A kept fraction must be corrected by the player.
  - Recovery is restrained, and sustained fire converges.
- **Sway.** Breathing, hand tremor and slow drift. It gets worse when arm stamina drops, and is calmer when crouched or aimed.
- **Movement moves the weapon.** Direction-aware bob, lag under acceleration (stopping, changing direction), strafe cant and landing dip. There is no movement spread.
- **Wall collision.** Probes from the shoulder along the aim. The gun slides back, then rises to high ready; when blocked it cannot fire. Long guns hit walls sooner than pistols.
- **Lean and shoulder swap.**
  - Lean tilts the upper body around the hips, and walls limit it. The weapon, muzzle and bullets follow.
  - Shoulder swap moves and mirrors the gun, including the muzzle origin and the wall probes.
- **Ballistics** (`weapons/Ballistics.ts`, `config/ammo.json`).
  - Projectiles simulate muzzle velocity (from barrel length), gravity, quadratic drag, travel time and grazing-angle ricochets.
  - Damage and impulse scale with remaining velocity.
  - Mechanical accuracy is MOA × the ammo's accuracy modifier. There is no hip-fire bloom.
- **Mechanism.** Magazine plus chamber: a tactical reload gives mag+1. The PPSh fires from an open bolt and the shotgun uses a pump. Fire modes are selectable. Malfunctions, attachments and optics have hooks in the data and architecture.

## Where tuning lives

All of these are editable live in the tuning panel. **Save to source** writes them back to disk (dev server only).

| File | What it contains |
| --- | --- |
| `src/config/weapons/*.json` | handling, mechanism, MOA, recoil, aim and zero, sights, FX, audio |
| `src/config/ammo.json` | calibers: velocity, mass, BC, damage, ricochet, tracer, modifiers |
| `src/config/player.json` | movement, camera, sensitivity |
| `src/config/feel.json` | global multipliers and lab toggles |

## Architecture (src/)

```
core/      Game loop (120 Hz fixed sim), Input, Physics (Rapier), Spring, Noise, LabTools, Haptics
player/    PlayerController (kinematic character + lean), PlayerCamera (layered camera)
weapons/   WeaponData, AmmoData, Handling, Weapon (mechanism), WeaponController (handling loop),
           Viewmodel (physical weapon pose), RecoilSystem (view recoil), Ballistics (projectiles),
           WeaponAnimator (procedural reloads), WeaponModels (8 procedural guns)
fx/        Particles, ImpactSystem, Decals, Shells, MuzzleFlash, Laser, DebugDraw, Textures
targets/   Damageable, RobotTarget
world/     Arena, PhysicsProps, MeshBuilder
audio/     AudioSystem, SoundBank (event -> layers), Synth (placeholder sounds)
ui/        HUD, DebugHUD, TuningPanel, TouchControls
```
