# Reveal Trailer — Production Plan

Working title on screen: **[TITLE TBD]** (placeholder `SITE-9` in rough cuts).
Track: *Geneburn – Escaping (No Vocals)*, 2:51.6, 105.0 BPM, constant grid.
Target: **1:51** master, 2560×1440, 16:9, captured at 60 fps and delivered at 30 or 60.

All times below are **trailer time (T)** unless marked `t` (source-track time).
Analysis data: `music/analysis.json`, plots: `music/analysis_*.png`, tools: `tools/`.

---

## 1. Audio analysis / timeline

### 1.1 What the waveform says

Measured with spectral-flux onsets, per-band energy (sub <60, low 60–200, mid 200–2k, high 2–8k), self-similarity novelty, and a beat-grid fit per section.

- **Tempo:** 105.0 BPM throughout. Beat = 0.5714 s, bar = 2.286 s, 8-bar phrase = 18.29 s.
- **Grid anchor:** the first downbeat after the drop is t 18.412. Every later section fits the same grid to within 10 ms (beat = 18.412 + n × 0.5714), so any downbeat can be computed.

| t (source) | Section | What happens in the audio | Use |
| --- | --- | --- | --- |
| 0.00–8.5 | **Intro swell** | Pad swells in, peaks around 2.7 s (soft low transient at 2.746), then decays to −33 dB. No drums. | Cold open bed |
| 8.5–18.2 | **Low build** | Quiet pulse texture begins (9.18). Transients at 11.326 (strongest in the intro), 16.149 and 17.200. A heartbeat-like sub pulse runs 13.15–15.73 (about 12 hits). Novelty rises steeply into 18.2. | Pre-drop build |
| **18.233** | **DROP 1** | Impact transient with a +10 dB loudness jump. Downbeat at 18.412. | **FIRST GUNSHOT** |
| 18.4–36.7 | Groove A | Drums plus bass, −16 dB. Lighter phrase. | Gun-feel shots |
| 36.7–61.2 | Groove B | Phrase change at bar 8: the sub rises about 5 dB and hats thicken after 45 s. | (cut for length) |
| **61.26–64.12** | **Dip** | The sub drops out for 5 beats (−25 dB). A pickup roll on 62.4–63.8. | Co-op setup: hold the aim |
| **64.126** | **Bar 20 hit** | Sub returns with a +7 dB jump. | **CO-OP REVEAL** |
| 73.29 | Bar 24 hit | A +5 dB accent. | **SHOTGUN HERO** |
| **80.12–82.91** | **Drum fill** | 13 very hard hits (onset strength up to 106× the median), then the section ends. | **Detail montage** (3–8 frame shots) |
| 82.95–96.1 | Breakdown | Pad only, no drums, −30 dB. | (cut) |
| 96.1–110.2 | Pulse | Kick pulse returns, building. | (cut) |
| **110.2–120.4** | **Near-silence** | Decays to −50 dB (t 113–114.4). A lone transient at 114.525, a low hit at 116.812, then a riser 118→121 with pickups at 120.43, 120.66, 120.84, 120.99 and 121.15. | **RESET**: cover, breathing, mag swap |
| **121.293** | **DROP 2** | The strongest transient in the track: low-band flux 101× the median, −13 dB. | **Action returns** |
| 121.3–159.2 | Climax | The loudest, densest section. High-band flux grows steadily from 140 to 158. | Final montage |
| **157.29 / 157.58 / 157.86 / 158.14** | **Final hits** | Four-hit ending figure, landing on bar 61 (157.84). | **BIG FINAL HIT**, then the music cuts |
| 159.2–169.5 | Outro | Soft sub pulses (160.15, 162.43, 164.72), fading to silence by 169.5. | Logo bed |

### 1.2 The edit: building a 1:51 trailer from the 2:51 track

The cut is **phrase-aligned**: every splice lands on a downbeat, where a drum hit masks it, with a 15 ms crossfade.

| Edit | T (trailer) | ← t (source) | Bars | Notes |
| --- | --- | --- | --- | --- |
| E0 | 0.000–3.000 | — | — | SFX only, black |
| E1 | 3.000–12.000 | 0.000–9.000 | intro | Fades out over the last 2.5 s, under the rising rotor |
| E2 | 12.000–25.000 | — | — | **Insertion cinematic**: almost no music; rotor, wind, breathing |
| E3 | 25.000–41.355 | 11.200–27.555 | build + bars 0–3 | Music re-enters on the 11.326 transient (T 25.126) = weapon-raise CLICK |
| E4 | 41.355–69.372 | 54.983–83.000 | bars 16–27 + fill | Hard stop after the fill |
| E5 | 69.372–78.065 | 112.600–121.293 | near-silence + riser | Reset |
| E6 | 78.065–87.184 | 121.293–130.412 | bars 45–48 | Drop 2 |
| E7 | 87.184–96.884 | 148.698–158.398 | bars 57–60 + final hits | **Music CUT** at T 96.884 |
| E8 | 96.884–100.300 | — | — | Standoff in silence, then ONE GUNSHOT |
| E9 | 101.500–111.000 | 159.950–169.450 | outro | Under the logo |

### 1.3 Timeline markers (trailer time)

```
T 000.000  BLACK. room tone / hum / far thrum
T 001.900  far servo whine (tiny)
T 003.000  music in (intro swell)
T 005.750  ● CLICK magazine (swell peak, t 2.746)
T 007.300  ● CLACK charging handle
T 012.000  ▌ exterior, music out, rotor
T 012.550  ● BOOT THUMP
T 017.650  ● BOOTS HIT STEEL (fast-rope)
T 019.900  ● mask ECU, breathing loudest
T 023.450  ● BEEP (robot sensor, far)
T 025.000  ● CLICK selector
T 025.126  ▌ MUSIC RE-ENTERS + MATCH CUT to gameplay (t 11.326)
T 026.950–029.530  ● sub pulses → robot tease cuts (sensor / foot / servo / flashlight)
T 029.949  ● transient: player stops, weapon rises
T 031.000  ● transient (strong): laser crosses smoke, something moves
T 031.967  ◌ 2-frame audio vacuum
T 032.033  ███ DROP 1: FIRST SHOT
T 032.212  bar 0 · 034.498 bar 1 · 036.783 bar 2 · 039.069 bar 3
T 041.355  ▌ splice (bar 16)
T 043.641  bar 17 · 045.927 bar 18
T 047.632  ◌ DIP (sub out): aim and hold
T 050.498  ███ BAR 20: SECOND WEAPON FIRES (co-op reveal)
T 052.784  bar 21 · 055.070 bar 22 · 057.355 bar 23
T 059.666  ███ BAR 24 ACCENT: SHOTGUN HERO
T 061.927  bar 25 · 064.212 bar 26
T 066.494  ▌ FILL: 13 detail cuts at 066.494 066.778 067.063 067.353 067.498 067.678
                          067.922 068.206 068.491 068.781 069.002 069.182 069.286
T 069.372  ▌ HARD CUT TO QUIET (reset)
T 071.297  ● far robot footstep (t 114.525)
T 073.584  ● CLICK new magazine (t 116.812)
T 074.770  riser begins
T 077.206 077.433 077.613 077.758 077.920  pickups (weapon rising, leaning out)
T 078.065  ███ DROP 2: ACTION RETURNS
T 080.327  bar 46 · 082.612 bar 47 · 084.898 bar 48
T 087.184  ▌ splice (bar 57) · 089.469 bar 58 · 091.755 bar 59 · 094.041 bar 60
T 094.041–095.776  dark / flash / dark / flash strobe on beats
T 095.776  ███ hit 1 · 096.061 hit 2 · 096.345 ███ BAR 61 BIG FINAL HIT · 096.630 hit 4
T 096.884  ▌ MUSIC CUT: near-black, one robot left
T 099.400  ● BEEP (robot eye)
T 100.300  ███ ONE GUNSHOT → cut to black on the flash
T 101.702  ● logo light-up (outro sub, t 160.152)
T 103.983  ● descriptor line (t 162.433)
T 106.271  ● final line (t 164.721)
T 111.000  end
```

---

## 2. Trailer story structure

The viewer's four reactions, mapped to the edit, alternating **CONTROL** and **CHAOS**:

| Act | T | Mode | Viewer thinks | Reveals |
| --- | --- | --- | --- | --- |
| I · Cold open | 0–12 | CONTROL | "What is this?" | A rifle being loaded in red light. Where we are and who is loading it stay unclear. |
| II · Insertion | 12–25.1 | CONTROL | "They didn't come to investigate." | A squad, a masked lead operator, an aircraft (silhouette only). A far-off BEEP. |
| III · Build | 25.1–32.0 | tension | "Something's in here." | Gameplay begins. Fragments of a machine: sensor, foot, servo. Never the whole robot. |
| IV · First contact | 32.0–41.4 | CHAOS | "Jesus, these guns feel good." | Gunplay: recoil, sparks, shells, hit reactions, reload, lean. |
| V · Threat | 41.4–50.5 | CHAOS↑ | "Wait — we're fighting robots?" | The whole robot. It survives hits, gets close, comes in numbers. |
| VI · Co-op | 50.5–69.4 | CHAOS↑↑ | "There's someone next to me." | A second weapon fires from frame edge, then two operators, then the squad. Shotgun hero. Detail montage. |
| VII · Reset | 69.4–78.1 | CONTROL | (holds breath) | Cover, breathing in the mask, near-empty mag, robot footsteps, CLICK. |
| VIII · Climax | 78.1–96.9 | CHAOS max | "I want to play this with my friends." | Squad versus swarm. Shots get shorter. Ends on dark/flash strobes and the big hit. |
| IX · Standoff | 96.9–100.3 | CONTROL | — | One robot, one operator, one shot. |
| X · Title | 100.3–111 | — | "I want to see more." | Logo through directional light, one descriptor line. |

**Text budget:** no mid-trailer message cards. The co-op idea is discovered, never written. The only text is the brief technical annotations (§6) and the title block.

---

## 3. Exact shot list

Legend:

- **Type:** `GP` real gameplay (first-person, real systems, scripted or recorded input) · `CIN` cinematic (custom camera and lighting, real game assets) · `MG` motion graphics.
- **Status:** ✅ possible with the current project · 🔧 needs small trailer-specific setup (§5).

Lens values are full-frame equivalents. The capture tool converts them to vertical FOV.

### Act I — Cold open (T 0.000–12.000)

| ID | T in–out | Dur | Camera | Action | Lighting | Transition out | Audio event | Type | Asset / status |
|---|---|---|---|---|---|---|---|---|---|
| A01 | 0.000–3.000 | 3.00 | — | Black | — | Sound bridge | Metal room tone, 50/100 Hz hum, far low thrum (the rotor, not yet identifiable); tiny servo whine at 1.9 | — | Audio only 🔧 |
| A02 | 3.000–5.200 | 2.20 | 100 mm macro, f/1.4, slow dolly-in 1.5 cm/s, 1° handheld drift | M4A1 receiver and empty magwell. A gloved hand slides into frame and rests on the lower receiver. | Black set, one hard cool top-rim light raking the receiver edges | Cut on action (the mag enters frame) | Glove friction on metal; music swell begins | CIN | M4A1 model, glove 🔧 (macro set + DOF) |
| A03 | 5.200–6.600 | 1.40 | 85 mm, side profile on the magwell, locked off | Magazine rises into the well and seats. **CLICK at 5.750**; the receiver shudders 1 mm. | Same rim plus a faint bounce | Hard cut on the click's tail | `rel_magin`, dry, above the music | CIN | Real mag part ✅ (macro set 🔧) |
| A04 | 6.600–8.400 | 1.80 | 50 mm close on the charging handle, micro handheld | Hand pulls the charging handle back and releases it. **CLACK at 7.300**. | Rim plus a red glow creeping in from frame left | Cut | `rel_boltback` then `rel_boltforward` | CIN | Real bolt part ✅ |
| A05 | 8.400–11.200 | 2.80 | 35 mm, low, across the rifle; rack focus from the muzzle (foreground) to the holo sight's red ring | A red light slowly sweeps across the rifle. **MG:** a small annotation tracks beside the receiver (§6). | Rotating red practical, deep black, dust motes in the beam | The red sweep leaves frame and the image goes to black: a light wipe | Thrum grows; one short radio-static click | CIN + MG | Holo sight ✅, rotating red light 🔧 |
| A06 | 11.200–12.000 | 0.80 | — | Black | — | Sound bridge | The thrum opens into full-band rotor and wind (door opening) | — | Audio 🔧 |

### Act II — Hero operator insertion (T 12.000–25.126)

| ID | T in–out | Dur | Camera | Action | Lighting | Transition out | Audio event | Type | Asset / status |
|---|---|---|---|---|---|---|---|---|---|
| B01 | 12.000–13.400 | 1.40 | 24 mm on the ground, lens 5 cm above the steel deck, static | Dust skates across the deck in rotor wash. A boot enters and plants (**THUMP at 12.550**). Operator 1 walks past: knee pad, mag pouches, rifle hanging low. | Night. Sodium lamp bokeh far behind; cold blue fill. | Operator's leg passes the lens: foreground wipe | Boot impact, gear jingle, rotor approaching (low-pass opening) | CIN | Vanta operator walk ✅, LZ set + wash dust 🔧 |
| B02 | 13.400–14.600 | 1.20 | 35 mm at hip height, tracking behind, handheld | Operator 2: plate carrier, radio antenna whipping, gloves on the rifle. No faces. | Backlit by the sodium lamp | Cut on a footfall | Cloth, radio squelch | CIN | Soldier skin ✅ |
| B03 | 14.600–16.200 | 1.60 | 24 mm low angle, slow tilt up | The searchlight beam sweeps over containers; smoke and dust churn. The aircraft is a dark silhouette with one red nav light. | Searchlight as a volumetric cone, otherwise black | The beam hits the lens (flare): cut on the flare | Rotor peaks, blade slap | CIN | Aircraft silhouette (VTOL mesh, unlit) 🔧, volumetric cone 🔧 |
| B04 | 16.200–17.400 | 1.20 | 50 mm insert, slight push | Glove gripping the rope; the rope vibrates; tilt down to boots approaching the deck. | Searchlight from above, hard | Cut | Rope friction hiss, carabiner tick | CIN | Rope 🔧, descending operator 🔧 |
| B05 | 17.400–18.200 | 0.80 | 35 mm low, locked | Boots hit the steel deck: **THUD at 17.650**. Dust ring; the rope goes slack. | — | Cut on the impact | Heavy boot impact with a sub layer | CIN | 🔧 |
| B06 | 18.200–19.900 | 1.70 | 85 mm, slow crane up from the torso | Plate carrier, radio LED blinking, sling snapping tight, then up to the respirator's chin. | Warm sodium kicker from the right, cold fill | Continuous move into B07 | First inhale through the mask (valve click) | CIN | Lead operator: Vanta kit + respirator 🔧 |
| B07 | 19.900–21.900 | 2.00 | 100 mm ECU, f/1.2; the background disappears | **MASK REVEAL.** Lens rings and twin filters; a tiny warm highlight crawls across a lens. Exhale through the valve. | One small controlled highlight; face nearly black | Cut | **Breathing dominant**: inhale, valve, filter resonance, exhale. Rotor receding. | CIN | Respirator 🔧 (add valve, lens reflection) |
| B08 | 21.900–23.300 | 1.40 | 28 mm, low, wide | Lead operator foreground right; two teammates step in behind and naturally form a V. The aircraft lifts away behind them and the searchlight silhouettes all three. | Backlit silhouette, dust | Cut | Rotor fading into the distance; wind settling | CIN | 3 operators ✅ + aircraft 🔧 |
| B09 | 23.300–24.300 | 1.00 | 135 mm across the yard, into a dark doorway | Far in the dark, a tiny red-orange slit lights up. **BEEP at 23.450.** Cut before it reads. | Black; the visor glow is the only light | Cut | BEEP, then silence | CIN | RogueRobot dormant visor and wake ramp ✅ |
| B10 | 24.300–25.126 | 0.83 | 85 mm profile MCU on the lead | The head turns about 4°; the glove tightens on the grip; the rifle starts rising. **CLICK (selector) at 25.000.** | Rim only | **MATCH CUT** on the rising rifle | Selector click; music hits on the cut | CIN | ✅ |

### Act III — Build (T 25.126–32.033)

| ID | T in–out | Dur | Camera | Action | Lighting | Transition out | Audio event | Type | Asset / status |
|---|---|---|---|---|---|---|---|---|---|
| C01 | 25.126–26.950 | 1.82 | First person | The rifle **finishes the same rise** into point-fire. Slow walk into a dark Site-9 hall during a power cut, flashlight on. Real weapon bob and inertia. | Red emergency strips pulsing, flashlight cone | Cut on the sub pulse | Music in; boots, gear, room reflections | GP | Site-9 power cut ✅, flashlight ✅ |
| C02 | 26.950–27.750 | 0.80 | 100 mm ECU | A tiny red optical sensor flickers on (robot visor). | Visor glow only | Cut | Electrical tick, sub pulse | CIN | Visor wake flicker ✅ |
| C03 | 27.750–28.450 | 0.70 | 50 mm on the floor | A mechanical foot shifts its weight on steel. | Red strip spill | Cut | Metal scrape, hydraulic hiss | CIN | Robot dormant shuffle ✅ |
| C04 | 28.450–29.100 | 0.65 | 85 mm silhouette | A head or neck servo rotates. | Backlit red | Cut | Servo whine, rising | CIN | Wake animation ✅ |
| C05 | 29.100–29.949 | 0.85 | First person | The flashlight sweeps across a metal chest plate for about 6 frames. Cut before it reads. | Flashlight | Cut | Pulse | GP | ✅ |
| C06 | 29.949–31.000 | 1.05 | First person | The player stops; the rifle rises to ADS (holo ring). Breath held. | — | Cut | Music thins; cloth | GP | ✅ |
| C07 | 31.000–32.033 | 1.03 | 35 mm over the shoulder, slow push | A laser crosses drifting smoke; at the far end of the room, a silhouette with a red slit moves. Last 2 frames: audio vacuum. | Laser plus smoke, red slit | **Hard cut on the shot** | Strong transient; then 2 frames of near-silence | CIN | Thick laser 🔧, smoke ✅ |

### Act IV — First contact (T 32.033–41.355)

| ID | T in–out | Dur | Camera | Action | Lighting | Transition out | Audio event | Type | Asset / status |
|---|---|---|---|---|---|---|---|---|---|
| D01 | 32.033–33.350 | 1.32 | First person, ADS | **BANG.** Muzzle flash lights the room; the robot takes a chest hit (driven back), sparks; the casing flies right. Real rearward recoil. | Muzzle flash ×3 (power-cut boost) | Cut on the second shot | Full rifle report + hall tail, music ducked −3 dB | GP | ✅ |
| D02 | 33.350–34.498 | 1.15 | 24 mm low on the robot | Second round: the head snaps and sparks spray. **It doesn't go down**; it steps forward. | Flash from off-screen | Cut | Metal impact, servo strain | CIN | Hit reactions, stagger ✅ |
| D03 | 34.498–35.640 | 1.14 | First person, point fire | Hip double-tap into a second robot at 6 m; real recoil recovery visible. | — | Cut | — | GP | ✅ |
| D04 | 35.640–36.783 | 1.14 | 50 mm side profile on the shooter | Third-person operator firing; flashes paint the walls; the casing arcs through frame. | Flash-lit | Cut | — | CIN | Operator firing + shells ✅ |
| D05 | 36.783–37.920 | 1.14 | First person | Tactical reload: mag out, mag in, on the beat. | — | Cut | `rel_magout`, `rel_magin` | GP | Reload animation ✅ |
| D06 | 37.920–39.069 | 1.15 | First person | Lean right around a pillar; ADS; single headshot; the visor flashes white. | — | Cut | — | GP | Lean ✅, headshot flash ✅ |
| D07 | 39.069–40.210 | 1.14 | 35 mm | The robot ragdolls into a rack; body thud. | Red strip | Cut | Body-fall thud | CIN | Ragdoll ✅ |
| D08 | 40.210–41.355 | 1.15 | First person | Mosin ADS shot, then the full bolt cycle (CHK-CHK). | — | **Flash white-out** into the splice | Bolt open/close | GP | Bolt action ✅ |

### Act V — The threat (T 41.355–50.498)

| ID | T in–out | Dur | Camera | Action | Lighting | Transition out | Audio event | Type | Asset / status |
|---|---|---|---|---|---|---|---|---|---|
| E01 | 41.355–42.500 | 1.15 | Robot POV, 28 mm | Desaturated red-channel view; an MG bracket locks onto an operator crossing. | Red monochrome | Cut | Synthetic chirps, servo | CIN + MG | POV grade 🔧 |
| E02 | 42.500–43.641 | 1.14 | 35 mm, locked | Service-lift doors slide open: three robots inside in red light. | Lift amber call light, red | Cut | Lift chime, doors | CIN | Service lifts ✅ |
| E03 | 43.641–44.790 | 1.15 | 24 mm on the floor | A robot stomps toward the lens; its foot lands next to the camera. | Backlit | Foreground wipe (the foot) | Heavy metal footsteps | CIN | Stomping walk ✅ |
| E04 | 44.790–45.927 | 1.14 | First person | AK full auto at a charging robot: it absorbs about six hits, staggers, keeps coming. | Flashes | Cut | AK burst | GP | ✅ |
| E05 | 45.927–47.632 | 1.70 | First person | The robot winds up an overhead swing; switch to the pistol; three fast shots; it drops at your feet. | — | Cut | Pistol | GP | Melee wind-up ✅, pistol ✅ |
| E06 | 47.632–50.498 | 2.87 | First person, ADS, very steady | **THE DIP.** Three robots advance through smoke down a long hall. Hold the aim; breathing. Nothing fires. | Red strips, smoke | **Cut on the hit** | The sub drops out; breathing and footsteps | GP | ✅ |

### Act VI — Co-op discovered (T 50.498–69.372)

| ID | T in–out | Dur | Camera | Action | Lighting | Transition out | Audio event | Type | Asset / status |
|---|---|---|---|---|---|---|---|---|---|
| F01 | **50.498**–51.640 | 1.14 | First person, same framing as E06 | A **second muzzle flash from the frame's right edge**: a teammate's rifle fires beside you. | Flash from the right | Cut | Second gun report (different weapon), panned right | GP | AI squadmate ✅ |
| F02 | 51.640–52.784 | 1.14 | 28 mm wide, frontal and low | **Two operators** shoulder to shoulder firing down the hall; the flashes alternate. | Strobing flashes | Cut | Two weapons | CIN | Allies ✅ |
| F03 | 52.784–53.920 | 1.14 | 35 mm | One operator suppresses on full auto… | — | Cut | — | CIN | ✅ |
| F04 | 53.920–55.070 | 1.15 | 50 mm | …the other reloads behind cover (real IK reload). | — | Cut | Mag change | CIN | Soldier reload ✅ |
| F05 | 55.070–56.210 | 1.14 | Wide | Crossfire: a robot hit from two directions spins and falls. | Tracers | Cut | — | CIN | ✅ |
| F06 | 56.210–57.355 | 1.15 | 35 mm | An operator crosses the foreground through smoke. | — | **Hidden cut** on the body wipe | — | CIN | ✅ |
| F07 | 57.355–58.500 | 1.14 | First person | Squad push; a teammate ahead; a robot rises from a floor hatch. | — | Cut | Hatch, servo | GP | Rise spawn ✅ |
| F08 | 58.500–59.666 | 1.17 | First person, shotgun | A sprinter robot charges out of the dark straight at the lens. | — | **Cut on the blast** | Sprint stomps | GP | Sprinters ✅ |
| F09 | **59.666**–61.927 | 2.26 | First person, then the shot holds | **SHOTGUN HERO.** Point-blank blast; the robot is thrown back, sparks and fragments; **pump CHK-CHUNK** fully audible at about 60.45. Breathes longer than the shots around it. | Huge flash | Cut | `boom_close`, `pump`; music ducked −4 dB | GP | Shotgun ✅ |
| F10 | 61.927–63.070 | 1.14 | 50 mm | A teammate leans out from a pillar and fires. | — | Cut | — | CIN | AI lean 🔧 (or a crouch pop-up ✅) |
| F11 | 63.070–64.212 | 1.14 | 24 mm | A robot falls across the foreground. | — | Foreground wipe | Body fall | CIN | ✅ |
| F12a–d | 64.212–66.494 | 4 × 0.57 | Mixed | Charging bays glow and spew robots → the squad fires → two robots drop → a wide of the assembly hall in chaos. | Bay glow | Cuts on beats | — | GP/CIN | Assembly hall ✅ |
| **M01–M13** | 66.494–69.372 | 3–17 frames each | Macro | **DETAIL MONTAGE**, one cut per fill hit: magazine · cartridge · bolt carrier · holo ring → **robot chest sensor (circle match)** · knee joint · boot · laser dot · bouncing casing · sparks · trigger finger · visor white-flash · muzzle flash | Hard practicals | **Hard cut to quiet** | Each fill hit has a mechanical sound | CIN + MG | Macro set 🔧 |

### Act VII — Reset (T 69.372–78.065)

| ID | T in–out | Dur | Camera | Action | Lighting | Transition out | Audio event | Type | Asset / status |
|---|---|---|---|---|---|---|---|---|---|
| G01 | 69.372–71.297 | 1.93 | 50 mm, locked | Sudden quiet. The lead operator behind a pillar, chest heaving; casings still rolling; dust falling through the red light. | Red pulse, dust | Cut | **Breathing in the mask**, casing tinkle | CIN | ✅ + respirator 🔧 |
| G02 | 71.297–72.500 | 1.20 | 85 mm insert | Mag release; the magazine slides out: two rounds left, visible at the lips. Far footstep at **71.297**. | — | Cut | Heavy distant robot step | CIN | Mag ✅ (round count on the model 🔧) |
| G03 | 72.500–73.300 | 0.80 | Over the shoulder, through a gap | A robot silhouette approaches; its footsteps get closer. | Backlit | Cut on the click | Servo, steps | CIN | ✅ |
| G04 | 73.300–74.500 | 1.20 | 100 mm macro | New magazine seats: **CLICK at 73.584**. | Rim | Cut | `rel_magin`, dry and loud | CIN | ✅ |
| G05 | 74.500–76.000 | 1.50 | 100 mm ECU | A respirator lens catches the red light; one exhale. | — | Cut | Exhale | CIN | 🔧 |
| G06 | 76.000–78.065 | 2.07 | 35 mm slow push | The rifle rises; the operator leans out of cover; the pickups build. | — | **Cut on the drop** | Riser, pickups | CIN/GP | ✅ |

### Act VIII — Climax (T 78.065–96.884)

| ID | T in–out | Dur | Camera | Action | Type |
|---|---|---|---|---|---|
| H01 | **78.065**–79.180 | 1.12 | First person: lean out, full auto into a robot at 4 m (music ducked −3 dB) | GP |
| H02 | 79.180–80.327 | 1.15 | A second operator enters frame firing; the robot is caught from two sides | CIN |
| H03 | 80.327–81.470 | 1.14 | A robot charges the lens (24 mm on the floor) | CIN |
| H04 | 81.470–82.612 | 1.14 | Empty reload under pressure, with the robot visible over the gun | GP |
| H05 | 82.612–83.760 | 1.15 | Robot eye ECU flares red | CIN |
| H06 | 83.760–84.898 | 1.14 | A teammate fires from cover, then gets back behind it | CIN |
| H07 | 84.898–86.040 | 1.14 | Sparks shower; a robot topples | CIN |
| H08 | 86.040–87.184 | 1.14 | An operator moves through smoke (smoke-in transition) | CIN |
| H09 | 87.184–88.330 | 1.15 | Smoke-out: another robot rises from a hatch | CIN |
| H10 | 88.330–89.469 | 1.14 | Close-range rifle, point fire | GP |
| H11–H14 | 89.469–91.755 | 4 × 0.57 | The squad of four firing · head snap · casing macro · assembly hall swarm | mixed |
| H15–H18 | 91.755–94.041 | 4 × 0.57 | Muzzle · robot · teammate · robot falls | mixed |
| H19 | 94.041–95.776 | 1.73 | **Dark / flash / dark / flash** on the beats: black frames, each broken by a 3-frame muzzle-flash exposure | GP |
| H20 | **95.776** | 0.29 | Hit 1: wide | CIN |
| H21 | 96.061 | 0.28 | Hit 2 | CIN |
| H22 | **96.345** | 0.29 | **BIG FINAL HIT**: shotgun or Mosin into a robot that blows backward in a spark burst | GP |
| H23 | 96.630–96.884 | 0.25 | Hit 4: muzzle flash → **music cut** | GP |

### Act IX — Standoff (T 96.884–100.300)

| ID | T in–out | Dur | Camera | Action | Audio | Type |
|---|---|---|---|---|---|---|
| I01 | 96.884–98.600 | 1.72 | 35 mm, near black | One robot stands at the far end in smoke; the operator's silhouette is foreground left and slowly aims. | Tiny mechanical ambience, a ringing tail | CIN |
| I02 | 98.600–99.700 | 1.10 | 100 mm ECU | The visor brightens from dim to full red-orange. **BEEP at 99.400.** | BEEP | CIN |
| I03 | 99.700–100.300 | 0.60 | Through the holo sight | Red ring over the red visor (circle match). **ONE GUNSHOT at 100.300.** The flash frame holds 2 frames, then **CUT TO BLACK**. | The biggest single report in the mix | GP |

### Act X — Title (T 100.333–111.000)

| ID | T | Visual | Audio |
|---|---|---|---|
| J01 | 100.333–101.700 | Black | The gunshot's hall tail decays |
| J02 | 101.700 | Directional light rakes across dark brushed steel; floating dust; the title emerges as the light passes | Breaker clunk plus a rising electrical hum; outro sub hit |
| J03 | 103.983 | Descriptor, small, tracked wide | Outro sub |
| J04 | 106.271 | Final line (only if true) | — |
| J05 | 110.5–111.0 | Out to black | Silence |

---

## 4. What we can shoot with the current project (✅)

- **Guns:** 10 weapon models with real moving mag, bolt, slide and pump. Real rifle, pistol, bolt-action and pump animations, tactical and empty reloads. Holo and red-dot reticles.
- **Handling:** procedural recoil (rearward in ADS), lean, shoulder swap, weapon inertia, sway, bob.
- **Effects:** physical shell casings; muzzle flash with side flames and light (brighter in a power cut); world sparks and smoke at the muzzle.
- **Impacts:** metal sparks and dents; robot orange and blue sparks; a blue-white head-hit burst; explosion and smoke.
- **Robots:**
  - **Dormant → wake** sequence: slumped pose, then a 0.7 s straighten with the visor ramping up and flickering.
  - Stomping walk, sprinters, overhead melee.
  - Zoned hit reactions, stagger, limp, low-health visor flicker.
  - Full ragdoll deaths with spark bursts.
  - Spawns that rise from the floor; service-lift arrivals.
- **Operators:**
  - Vanta squadmates: hooded field kit and blue IFF band.
  - Black Division respirators; the Warden.
  - They carry, aim, fire and reload with IK.
  - AI squad behaviour: shared focus target, cover pop-ups, suppression.
- **Places:** Site-9 power-cut lighting (pulsing red emergency strips, flickers) and the flashlight. Assembly hall (charging bays, gantries), server hall (data core), power plant (reactor column), cooling plant, warehouse. The night container yard (sodium lamps).
- **Audio:** recorded close gunshots per weapon, hall tail, distant reports, reload parts, pump, bolt, shells, metal hits, gear-rustle steps, power-down, robot wake, boot, stagger and death.

## 5. What needs small trailer-specific setup (🔧)

Everything here uses **real game assets**. The trailer-only parts are the camera, lighting, set dressing and post. Nothing in this list adds a gameplay system the game doesn't have.

| # | Setup | Why | Effort |
| --- | --- | --- | --- |
| 1 | **Trailer capture mode** (`?trailer=<shot>`): deterministic fixed-step clock and seeded RNG; HUD, debug, help and price/label signs hidden; cinematic camera rig (keyframed position, target, lens, focus); frame export to disk through the dev server | Required for every shot | Core |
| 2 | **Post chain** (trailer only): HDR render → bloom → depth of field (cinematic shots) → colour grade → subtle grain, vignette and chromatic fringe; per-shot exposure | Emissives look flat without bloom; there's no DOF at all | Core |
| 3 | **Macro set**: weapon model in world space on a black set; rim light; rotating red practical | Act I, montage, reset inserts | Small |
| 4 | **LZ set** in the container yard: rotor-wash dust, a volumetric searchlight cone, the aircraft as an unlit silhouette with a blinking nav light, a rope, a scripted descent | Act II | Medium |
| 5 | **Lead operator look**: Vanta field kit + Black Division respirator, plus an exhale valve and a lens highlight. **Recommend making this a real in-game squad-lead cosmetic**, so the trailer shows a real asset. | Mask reveal | Small |
| 6 | **Thick laser beam** (additive, scattering in smoke) for the trailer camera | The game laser is 1 px | Small |
| 7 | **Robot POV** grade, plus an MG bracket | E01 | Small |
| 8 | **Audio export**: the game's synthesized sounds (wake, boot, servo, death, falls) rendered to WAV, and a capture-time **sound-event log**, so the offline mix replays the exact game sounds in sync | Sound design | Small |
| 9 | **New SFX** (offline): rotor, wind, mask breathing, servo whines, robot footsteps, room tone, hum, BEEP, rope, breaker clunk | Missing from the game | Medium |

**Hide or avoid:**

- Floating price and label signs.
- Toasts and the debug HUD.
- Robot and operator close-ups that show box seams in full light: always shoot those dark, backlit or in silhouette.
- The VTOL in full light.
- The ATLAS statue.
- Blocky viewmodel hands in macro shots: keep them out of focus or in silhouette.

## 6. Motion design plan

**Principle:** graphics live in the world and leave quickly. No HUD demo. Type: one condensed technical sans (for example *Barlow Condensed* or *Rajdhani*), all caps, letter-spaced 12%, 70% white with 1 px hairlines; red-orange `#FF4A1C` for robot-side graphics only.

| Where | Element | Content (real data from `src/config`) | Behaviour |
| --- | --- | --- | --- |
| A05 | Weapon annotation tracked to the receiver | `M4A1 · 5.56×45 M855 · 910 m/s · 3.0 KG` | Hairline draws out from the receiver over 6 frames; text types in; holds 1.2 s; retracts as the red light leaves |
| B09 / I02 | Robot designation fragment beside the visor | `SITE-9 · VANTA DYNAMICS` plus a small unit ID | Appears for 10 frames in red-orange; flickers off with the visor |
| E01 | Robot POV target bracket on an operator | Corner brackets, range ticks | Tracks the 3D position; snaps on with 2-frame overshoot |
| M01–M13 | Measurement ticks on 3 montage frames | Calibres: `5.56×45`, `12GA`, `7.62×54R` | Single-frame flash-ins, synced to the fill |
| J02–J04 | Title block | `[TITLE]` / descriptor / final line | The light sweep reveals the title (a mask follows the light); descriptor tracks out 2% |

**Transitions** (no fade/glitch chains), each tied to motion or shape:

- **Light wipe:** A05 → black.
- **Foreground body wipes:** B01, E03, F06, F11.
- **Lens-flare cut:** B03.
- **MATCH CUT on the rising rifle:** B10 → C01.
- **Flash white-out:** D08 → E01.
- **Circle match:** holo ring → robot chest sensor (M04 → M05); holo ring → visor (I03).
- **Smoke in/out:** H08 → H09.
- **Cut to black on the muzzle flash:** I03.

## 7. Sound design plan

**Stems:** `MUSIC` (the edit, §1.2) · `GUNS` (report + mech + tail) · `FOLEY` (gear, boots, cloth, mags) · `ROBOT` (servos, steps, impacts, synthetic chirps) · `AMB` (room tone, hum, rotor, wind) · `VOX` (breathing only; no dialogue).

- **Guns as percussion.** Every gameplay shot's report is placed on, or a few frames before, a beat. Reports punch above the music: −1 dBFS peaks on guns, with the music bus around −8 LUFS short-term in the climax.
- **Ducking** (sidechain from the GUNS bus): music −3 dB, 5 ms attack, 180 ms release on gameplay shots. **−4 to −6 dB on hero moments:** D01 first shot, F01 co-op shot, F09 shotgun, H01, H22, I03.
- **Pre-shot vacuum:** 2–3 frames before D01, H22 and I03, all beds dip about 10 dB, then the report hits.
- **Indoor tails:** `tail_hall` sized per room (hall for the assembly hall, tighter for corridors). Tails ring into the cuts, and into the black after I03.
- **Mechanics above the music:** `rel_magin` (A03, G04), charging handle (A04), `pump` (F09), bolt (D08): close, dry, with a 2–3 kHz presence lift.
- **Robots:** servo whines (FM-modulated saw, pitch sweeps tied to motion), heavy footsteps (`metal_hit` + 60 Hz thump), a synthetic BEEP (1.85 kHz sine with a short metallic ring), the game's `robot.wake` and `robot.boot`.
- **Insertion:**
  - Rotor: AM noise at about 19 Hz blade pass plus a 4.7 Hz main thump, low-passed by distance; a doppler-ish approach, then recession.
  - Wind and rope hiss.
  - Mask breathing: shaped noise through a resonant filter-canister band (about 900 Hz and 2.3 kHz), a valve click on each exhale, slight wet flutter. Not Vader: band-limited, low level, natural rhythm (inhale 1.1 s, exhale 0.9 s).
- **Reset:** breathing up front, the music almost gone, a distant robot step on 71.297, the CLICK on 73.584 as the loudest element.
- **Master:** −14 LUFS integrated for online, true peak −1 dBTP; 48 kHz / 24-bit stems plus the mix.

---

## Capture plan (Phase 4)

**REAL GAMEPLAY (GP)** — first person, real weapon controller, real ballistics, real robot AI and reactions; the only things trailer-specific are the clean frame (no HUD) and the grade.

- **Option A (preferred for authenticity):** you play in `?trailer=clean` (HUD hidden, grade on) and record with OBS at 2560×1440, 60 fps, CQP 16. I'll cut from those takes.
- **Option B (repeatable):** scripted input played into the real PlayerController and WeaponController in the deterministic capture mode. The systems, physics and hits are all real; only the inputs are authored, like a demo recording.
- GP shots: C01, C05, C06, D01, D03, D05, D06, D08, E04, E05, E06, F01, F07, F08, F09, H01, H04, H10, H19, H22, H23, I03.

**CINEMATIC (CIN)** — custom camera and lighting, real game assets, deterministic capture with the post chain. Everything else in the shot list.

## Pipeline

1. `tools/edit_music.py`: builds the music edit from §1.2 → `build/music_edit.wav`.
2. `tools/animatic.py`: the rough cut, with every shot as a timed storyboard card over the music edit and temp SFX → `build/animatic.mp4` (Phase 5 v0).
3. Game `?trailer=<shot>` captures frames → `frames/<shot>/`.
4. `tools/assemble.py`: EDL from this shot list → frames + MG + mix → `build/trailer.mp4`.
5. Cutdowns (60 s / 30 s / 15 s vertical) only after the master is approved.

## Open decisions

1. **Title, descriptor, final line.** No title exists in the repo. The game ships to Android/iOS (Capacitor) and the desktop browser, not Steam, so no STEAM / WISHLIST text unless that becomes true.
2. **Co-op honesty.** There is no online multiplayer in the code today. The squad is you + AI Vanta operators. The reveal shows a squad fighting together, which is true. A "CO-OP" descriptor or "with friends" framing is only accurate if online co-op is real or announced as planned.
3. **Squad identity.** Recommended: the hero squad is Vanta (the player faction), and the lead wears the respirator variant, which should be added to the game as a real cosmetic. The alternative, a Black Division squad, would contradict the gameplay, where Black Division are the hostile raiders.
