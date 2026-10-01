# Weapon Lab

A graybox FPS weapon-feel sandbox: the foundation for a co-op PvE robot shooter.
It targets Android and iOS (through Capacitor) and also runs in a desktop browser.

**Stack:** TypeScript, Three.js (rendering), Rapier (physics, WASM), Vite, lil-gui

## Run

```bash
npm install
npm run dev
```

- Open http://localhost:5173 on desktop.
- To test on a phone, open `http://<your-PC-LAN-IP>:5173` on a device on the same Wi-Fi.
- To force the touch UI on desktop, add `?touch` to the URL.
- `?nolock` runs without pointer lock (used for automated testing).

## Controls

| Desktop | Action |
| --- | --- |
| WASD / Mouse | move / look |
| Shift / Space / C | sprint / jump / crouch |
| LMB / RMB | fire / aim down sights |
| R | reload |
| 1 2 3, wheel, Q | switch weapon (Q = last weapon) |
| Tab (or P) | live tuning panel |
| H | debug HUD |
| N | damage numbers |

On touch devices:
- **Left side:** floating move stick. Push it to the top edge to sprint.
- **Right side:** drag to look.
- **FIRE** buttons, one on each side. The right one also works as a look pad while you hold it.
- **ADS** toggle, **JUMP**, **CROUCH** toggle and **R** (reload).
- Weapon slot buttons, plus ⚙ for tuning and DBG for the debug HUD.

## Where tuning lives

All feel values are data in `src/config/` and can be edited live in the tuning panel:

| File | What it contains |
| --- | --- |
| `weapons/*.json` | one file per weapon: damage, fire rate, spread, recoil (aim / camera / visual), ADS, sway, bob, FX, audio event names |
| `player.json` | movement, camera, FOV, sensitivity, touch aim assist |
| `feel.json` | global multipliers and toggles |

The panel's **Save to source** button writes the current values back into these JSON files. This only works while the dev server is running.

## Architecture (src/)

```
core/      Game loop (120 Hz fixed sim), Input (keyboard/mouse/touch), Physics (Rapier wrapper), Spring, Haptics
player/    PlayerController (kinematic character), PlayerCamera (layered camera), PlayerConfig
weapons/   WeaponData (types), Weapon (state machine), WeaponController (wiring), RecoilSystem,
           Viewmodel (pose layers), WeaponAnimator (procedural reloads), WeaponModels, Hitscan
fx/        Particles (instanced, pooled), ImpactSystem, Decals, Shells, MuzzleFlash, Textures
targets/   Damageable, RobotTarget
world/     Arena, PhysicsProps, MeshBuilder
audio/     AudioSystem (layered events), SoundBank (event -> layers), Synth (placeholder sounds)
ui/        HUD, DebugHUD, TuningPanel, TouchControls
```

To replace placeholder audio, put files in `public/audio/` and add `file: 'audio/x.ogg'` to a layer in `audio/SoundBank.ts`.
