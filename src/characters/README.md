# Characters built on MASTER_HUMANOID_RIG

Every humanoid is the one master body + one skeleton; a faction differs only by a texture set (a
"look") and modular gear. Nothing below is per-character code: a character is data.

## Skeleton (immutable)
`scripts/blender/canonical_skeleton.json` (v2, 69 bones incl. sockets; left = mirror of right).
Names, hierarchy, local axes and rest orientations never change per character. Axis convention
and mirror rule: see the notes in that file. Runtime loader + checks: `src/characters/master/MasterRig.ts`.
Sockets (non-deforming bones): RightHandWeaponSocket, LeftHandWeaponSocket, HeadSocket, FaceSocket,
ChestSocket, BackSocket, BeltSocket_R/L, ThighSocket_R/L. The gear sockets lie ON the body surface
(placed by rays from inside the body, scripts/blender/build_canonical_rig.py): HeadSocket = crown of
the skull (+Y up, +Z forward), FaceSocket = skin between the eyes (+Y forward, +Z up), ChestSocket =
sternum, BackSocket = back at the same height, BeltSocket = hip side at the trouser waistband,
ThighSocket = outer thigh, 35 % down from the hip (all +Y up, +Z forward). A gear offset therefore
reads as "this far off that surface point". The weapon sockets are fitted in the AK-47 lab
(src/characters/master/masterRig.json).

## Files (`public/assets/characters/`, served at `/assets/characters/`)
```
master/master_humanoid_rigged.glb   LOD0 / hero (all LODs: same skeleton, same UVs, material "Body")
master/master_lod1.glb              gameplay near (~30k tris)
master/master_lod2.glb              mid + phone main (~10k tris)
master/master_lod3.glb              far (~4.5k tris)
master/skeleton.json                rest data of every bone
textures/<look>/base_color.webp     2048 sRGB (+ base_color_1k.webp for phones)
textures/<look>/normal.webp         2048 tangent space, OpenGL (+Y): the geometry baked from the high-res
                                    source + the look's fabric normal (+ normal_512.webp for phones)
textures/<look>/orm.webp            1024: R = occlusion, G = roughness, B = metallic (glTF order) (+ orm_512.webp)
textures/<look>/look.json           only in a colour version of another look: {"maps": "<look>"} - it has
                                    just its base colour and shares that look's normal / ORM maps
gear/<kind>/<id>.glb + <id>.json    kinds: helmets, masks, nvg, vests, backpacks, pouches, radios, hats, coats
gear/<kind>/<id>_lod.glb            the item decimated (scripts/blender/lod_gear.py; same UVs and skin, no
                                    materials): drawn past the far distance on desktop, always on phones
gear/<kind>/<id>/<look>/            the item's texture version for a look (`variants`)
characters/<id>.json                vanta, black_division, warden, pmc (bravo), pmc_green (charlie), pmc_grey (delta)
animations/humanoid/*.glb           clips on the canonical skeleton (lab test clips only, see Animation)
```
Body GLBs carry UVs and one material named "Body"; the runtime fills it from the look's textures.
Looks: `master` (neutral black underlayer), `vanta`, `black_division`, `pmc`, `pmc_green`, `pmc_grey`,
`warden`. A look is made with `node scripts/meshy-master.mjs retexture <look> --prompt="..."` (Meshy paints
on the master's own UVs; sources in production/assets/src/chars/master/texture/<look>/), then
`python scripts/make_look.py <look>` writes the game sizes and applies the rules every look obeys:
- no skin on the hands or forearms (every look is gloved and long-sleeved): Meshy's "glove gap" /
  rolled sleeves are repainted in the look's own glove / sleeve colour (masks from
  scripts/blender/region_masks.py);
- palettes (`LOOKS` in make_look.py): a cloth colour repainted, shading kept, the head never touched.
  The PMC rivals are one Meshy look in three colourways (khaki, green, grey) - no credits, and the
  teams can be told apart. Gear follows with `variants` (scripts/gear-variant.py --recolour=R,G,B).

## Gear `<id>.json`
```json
{ "id": "vanta_helmet", "kind": "helmets", "model": "vanta_helmet.glb",
  "attach": "socket", "socket": "HeadSocket",
  "position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1 }
```
- `attach: "socket"`: rigid; the GLB's scene root goes under the socket bone with this local
  transform (metres, socket bone space = glTF bone space). One fit per gear item, shared by every
  character that wears it.
- `attach: "skinned"`: the GLB holds a SkinnedMesh bound to bones named as the canonical skeleton,
  in the master's rest pose; the runtime rebinds it to the body's skeleton by bone name (vests,
  belts, coats - anything that bends with the torso or legs).
- Optional `hides`: names of body regions the gear covers (for future culling), `variants`: look
  name -> texture override folder.
- Gear built on the body itself instead of fitted from a Meshy model: the Warden's greatcoat
  (scripts/blender/build_coat.py) and the PMC backpack's shoulder straps
  (scripts/blender/build_straps.py: laid over the plate carrier, skinned like it).

## Character `<id>.json`
```json
{ "id": "vanta", "look": "vanta", "gear": ["helmets/vanta_helmet", "vests/vanta_vest"] }
```

## Animation
One animation system: the game's procedural Humanoid (src/targets/Humanoid.ts) poses, hit-tests and
ragdolls every body; src/characters/MasterCharacter.ts retargets its parts onto the canonical
skeleton each frame (constant offsets from the "hanging" pose), then the weapon hold (IK, fingers,
twist) and writes the solved arms back to the Humanoid's arm parts, so hitboxes are the arms drawn.
An arm that changes hands - IK on the gun ↔ following its part (the far switch, a hand to the
magazine, a death) - eases from its last drawn pose over 0.2 s instead of snapping.
No per-faction clips. animations/humanoid/ holds lab test clips only; a clip set, if it ever comes,
is authored on this same skeleton and drives the same retarget.

## Not done on purpose
- The cleanup's inner-arm seam step stays off: re-enabling it changes the mesh, which re-runs the
  UVs and invalidates every look and every gear fit for a cosmetic seam under the sleeve.
- Hold frames: the AK-47 has its lab data (masterRig.json `weapons.ak47`); every other gun the
  game hands a soldier has frames fitted on the drawn gun (`game.grip.fit`, soldier-lab.html
  `__slm.fit(i)`, src/dev/masterGripFit.ts); the rules are only the fallback for a new gun. The
  finger poses stay the shared library's, so on grips far from the AK's shape (the SVD's thumbhole
  stock, the PPSh's and Kar98k's wooden wrists, the pistol) a finger or the thumb can sit up to
  ~1-2 cm off; per-gun finger curl would be the next step.

## Rules
- Weapon holds: right hand owns the weapon via RightHandWeaponSocket, left hand two-bone IK, twist
  solver, library grip poses - all numbers in `src/characters/master/masterRig.json`.
- A new faction = a new look + a gear list. If it needs code or an offset that only it uses, the
  pipeline has failed - fix the asset or the shared data instead.
