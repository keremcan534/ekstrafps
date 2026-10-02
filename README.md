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
| 1-9, 0, mouse wheel | AK-47, MK47, AS VAL, M4A1, RD-704, PPSh-41, Mosin, Kar98k, pistol, shotgun |
| **Lab** | |
| G | aim rays: camera ray, bore ray, muzzle vector, wall probes, bullet trajectories |
| L | test laser (parallel to the bore) |
| J | debug crosshair |
| N | damage numbers |
| Z | slow motion |
| I | infinite ammo |
| K | reset robots |
| Y | respawn the Black Division squad |
| O | god mode |
| U | enemy AI on / off |
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
- **Aimed recoil goes rearward.**
  - When aimed, the gun drives back into the shoulder instead of flipping the sights out of view.
  - The climb moves to the view: the dot stays on the target and the world moves.
  - `feel.adsRecoilRearward` sets the share (0 = old muzzle flip, default 0.85).
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

## Robot hit reactions and ragdolls

`targets/RobotTarget.ts`. Each robot is 11 body parts: pelvis, torso, head, upper and lower arms, thighs and shins.

- **Alive.**
  - Every part is a kinematic hitbox that follows the animated pose, so what you see is what you hit.
  - Zones and damage:

    | Zone | Damage multiplier |
    | --- | --- |
    | head | round's crit multiplier |
    | thorax | ×1 |
    | stomach | ×0.9 |
    | arms | ×0.6 |
    | legs | ×0.7 |

  - Hits push spring reactions sized by the round's momentum:

    | Hit | Reaction |
    | --- | --- |
    | head | snaps back |
    | chest | driven back; arms and head whip |
    | gut | folds forward |
    | arm | thrown back; torso spins |
    | leg | buckles; heavy rounds drop the robot to one knee |

  - Heavy rounds knock it back a step. Repeated hits build stagger: bigger reactions and an unsteady sway.
  - Wounds show: low health gives a hunch and a flickering visor; leg damage gives a limp.
- **Dead.**
  - The same bodies turn dynamic and are jointed into a ragdoll:
    - revolute waist, neck, elbows and knees, with limits
    - spherical hips and shoulders, with weak muscle tone
  - It inherits the animated velocity, plus the killing round's momentum at the exact hit point.
  - The knees buckle for a moment.
  - A headshot snaps the head back and the body falls backward.
  - Corpses still take bullet impulses. Body falls play a metal thud.
- **Tuning.** `feel.hitReactionScale`, `feel.ragdollForce`, `feel.robotRespawnTime`.

## Maps

Pick a map on the start screen. A map can also be opened directly with `?map=site9`.

### Weapon Lab

The graybox test range plus the Black Division container yard.

### Site-9 (Survival)

Vanta Dynamics' research campus, single level, about 220 × 170 m.

**Layout.** 16 rooms are generated from rectangles by `world/LayoutBuilder.ts`. It builds walls where rooms meet, door openings, per-room materials, contact shadows along wall bases, and light pools under lamps.

| Area | What's there |
| --- | --- |
| Arrival Lobby | The start, behind the lifts. |
| Cafeteria and Security | The two cheap side routes. |
| Atrium | Glass roof and the ATLAS statue. The direct route, and more expensive. |
| Further in | Garden court, medical bay, assembly hall, warehouse, hangar with a VTOL, R&D labs, clean room, prototype lab, server hall with the data core, cooling plant, barracks, power plant. |

**Economy (Zombies).**
- Points: 10 per hit, 60 per kill, 100 per head kill.
- 29 links between rooms: 26 roll-up shutters ($750–$2000), the rest open archways.
- Wall weapons: buying one you own refills its ammo for half price.
- Two weapon slots, with limited spare ammo.
- Vanta contractors cost $1500 at the security terminal (max 3). They follow you and fight; robots attack them too.

**Pacing (Left 4 Dead director).**
- Newly opened zones get a few powered-down robots. They wake when they see you, hear gunfire, get shot, or a neighbour wakes.
- Mobs arrive from service lifts (chime, doors open), charging bays or hatches. Bays and hatches only spawn out of sight.
- Intensity runs build-up → peak → fade → relax.
- Dynamic difficulty scales mob size and toughness from your health and the damage you've taken recently.
- Threat grows with time and with how many zones are open.
- Solo: death ends the run.

**4 Teams (PvPvE, default; `?mode=solo` for classic survival).**
- Four squads of four start in opposite corners: you + three Vanta operators (hooded field kit, blue IFF band) in the lobby; Bravo (hangar), Charlie (barracks) and Delta (power plant) are AI. Hired contractors come on top (up to 5 with you).
- Everyone has their own wallet and plays the same economy: AI operators buy wall weapons, restock at ammo caches, open shutters and hire contractors with their own money. Every point a teammate earns also pays each other member 5%.
- Bought guns run dry; the starting pistol never does. With every gun empty you draw it automatically.
- Downed teammates get revived; give up with **X** (or the GIVE UP button). You redeploy after 7 s next to a standing teammate, or somewhere random with your squad if everyone is down. Fallen squadmates rejoin after a minute.
- AI plans like a player: each operator picks the gun they want, farms for it (hunting awake robots or watching a lift), chips in with teammates to open the shutter in the way, buys it, and once well armed pushes teams it heard firing. Between fights they restock, heal, try the supply crate or switch on sentries with their own money.
- In a fight: the squad shares a focus target, goes for the head on calm targets, backs off from robots while shooting, falls back when badly hurt and retreats when swarmed. Getting shot alerts everyone nearby: they turn to the shooter, hold the angle or push it, and the squad goes after you. Nobody revives a teammate while a hostile is in view or they're under fire.
- Your squad: **Y** (SQUAD on touch) switches between free roam (default: they farm, buy and open doors on their own within ~55 m of you) and follow me. **F** next to a downed operator revives them (3 s). They call out on the radio.
- Running AI carry their weapon low ready or high port; handguns are pushed out to aim and tucked in otherwise. Firing on the move scatters (hip fire most, aimed a little, mid-air a lot).
- Raids at 6000 / 14000 / 22000 team score: the power dies and two Black Division squads land far from you, out of sight, hostile to everyone. A power breaker restores the lights ($750). First team to 20000 wins.

**Facility extras (random spots each game, on the map).** Medical stations ($400, full heal), armor lockers ($1000, plates soak 60% of damage), power breakers (cut the lights / restore power), a supply crate ($950, random weapon, moves after a few uses), sentry turrets ($1500, 60 s for whoever paid), plus ten extra wall weapons. **L** toggles your flashlight (it switches on when the power dies). Enemy operators who fire show up on the minimap for a moment.

**Map.** **M** opens the full map: zones, shutter prices, weapons, terminal, you, allies, robots. A rotating minimap sits in the corner. **F** (or **USE** on touch) buys or uses whatever you are looking at.

**Performance.**
- Room geometry is merged per room, so whole rooms are culled.
- The shadow camera follows the player.
- On phones: no point lights, no robot shadows, smaller pools.

## Black Division

The enemy faction: four all-black operators in plate carriers and high-cut helmets with glowing quad night vision. They are faceless on purpose. They patrol the container yard behind the range. To get there, press **M** and pick the yard door station, or walk through either door in the back wall. Code: `enemies/`, `ai/NavGrid.ts`.

### Behaviour

- **Patrol.** They walk in a column on the leader's trail and scan as they go.
- **Spotting.**
  - Each soldier has a view cone, line-of-sight rays, and an awareness meter.
  - Awareness builds faster when you are close or sprinting, and slower when you are crouched and still.
  - They also hear your gunfire: about 45 m normally, about 14 m with the AS VAL.
- **Contact.**
  - The spotter stops and reports on the radio: *"I see the enemy."*
  - The leader orders *"Spread out."*
  - The squad splits into roles:

    | Role | What it does |
    | --- | --- |
    | anchor | holds at about 22 m |
    | flanker (2) | one swings about 75° left, one about 75° right |
    | pusher | closes to about 10 m |

  - Positions are scored for line of sight, low cover and spacing. In low cover they crouch, then pop up to shoot.
- **Search.** When they lose you, they search around your last known position. If they don't find you, they go back to patrolling.

### Shooting

- Reaction time before the first shot.
- Aim error that tightens the longer you stay visible.
- Bursts with recoil, then reloads.
- They hold fire when a squadmate is in the line of fire.
- Getting hit throws off their aim.
- Their rounds are real projectiles with red tracers. Near misses crack past your head and suppress you (dark vignette, shake).

### Armor and damage

| Part | Rule |
| --- | --- |
| Plate (thorax) | Class rating 40. Penetration chance comes from the round's `penetration` vs the armor. A stopped round deals 30% blunt damage. |
| Helmet | Class rating 30. |
| Face | ×3 damage. |
| Arms | ×0.6 damage. |
| Legs | ×0.7 damage. |

Penetration chance against the plate:

| Round | Chance |
| --- | --- |
| 7.62x39 PS | about 37% |
| Mosin LPS | about 80% |
| 5.56 M855 | about 25% |
| Buckshot | almost never |

Dead soldiers ragdoll and drop their rifle as a physics object. The squad calls *"Man down."*

### You

- 100 HP. Health regeneration is optional (tuning panel).
- Getting hit gives:
  - a damage vignette
  - a directional hit indicator
  - aim punch and screen shake
  - a hurt sound
- When you die, they radio *"Target down."* and go back to patrolling. You respawn at the firing line.

### Voice and tuning

- Voice lines are placeholders made from offline TTS that was pitched down and run through mask and radio processing (`public/audio/voice/`). Drop in real recordings with the same names to replace them.
- Tuning: *Black Division* folder in the panel. It covers AI on/off, god mode, enemy damage scale, enemy accuracy and regeneration.

## Sound

Gunshots are layered: a recorded close blast (several variations per weapon), synth low-end punch and mechanical action, a room tail that grows with the size of the room you're in, and a distant report that takes over from ~20 m and darkens past ~70 m. The recorded shots were cut from Pixabay sound effects (Pixabay Content License) by freesound_community, pwlpl, haruudu, sovetsky_rastov72 and u_2n07b18i8q (the M4/M16 reload recording by freesound_community drives the magazine and charging-handle sounds; the power-cut slam and the Black Division encounter sting are by universfield, the raid arrival impact by black_kumizhi); the cuts live in `public/audio/guns`.

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
game/      Survival (economy, doors, wall weapons, director, dynamic difficulty)
player/    PlayerController (kinematic character + lean), PlayerCamera (layered camera), PlayerHealth
weapons/   WeaponData, AmmoData, Handling, Weapon (mechanism), WeaponController (handling loop),
           Viewmodel (physical weapon pose), RecoilSystem (view recoil), Ballistics (projectiles),
           WeaponAnimator (procedural reloads, bolt cycling), WeaponModels (10 procedural guns, textured)
fx/        Particles, ImpactSystem, Decals, Shells, MuzzleFlash, Laser, DebugDraw, Textures
targets/   Humanoid (shared body: zoned hitboxes, armor, reactions, ragdoll), RobotTarget, Damageable
enemies/   SoldierSkin, Soldier, BlackDivision (squad brain), RogueRobot (wanderer/mob melee robot), Ally (hired contractor)
ai/        NavGrid (baked walkable grid, A* + path smoothing)
world/     GameMap, Arena (Weapon Lab), Site9 + LayoutBuilder, PhysicsProps, MeshBuilder
audio/     AudioSystem, SoundBank (event -> layers), Synth (placeholder sounds)
ui/        HUD, StatusHUD, SurvivalHUD, MapOverlay (map + minimap), DebugHUD, TuningPanel, TouchControls
```
