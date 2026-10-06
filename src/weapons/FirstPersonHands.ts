import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import config from '../config/hands.json';
import { orientMatrix, poseQuaternion, type ViewOrientation } from './ViewProfile';
import type { WeaponRig } from './WeaponModels';

/**
 * First-person hands: one gloved arm per side (public/hands/<side>.glb, made with
 * scripts/meshy-hands.mjs), set in src/config/hands.json, the one place they're placed:
 *
 *   orientation  model → hand space: origin on the grip point (where the palm closes on the
 *                weapon), -Z along the weapon, +Y up, the forearm running back along +Z.
 *   pose         how the hand sits on a weapon (deg [pitch, yaw, roll], weapon space): the
 *                forearm angled down and out toward the shoulder.
 *   mirror       the model is the other hand: mirrored (one glove model makes both hands).
 *   sleeve       the arm carried on past the model's short cuff, off the screen (hand space,
 *                along +Z from `start`, `radius` m): no cut-off arm in view.
 *
 * A weapon with a view profile carries the IK points (gripRight / gripLeft) the hands hang
 * on; the reload and bolt animations move those points, so the hands follow. Weapons on the
 * old placement have no reliable grip points and stay without hands.
 */
export interface HandConfig {
  file: string;
  mirror?: boolean;
  orientation: ViewOrientation;
  pose: [number, number, number];
  sleeve?: { start: number; length: number; radius: number; color: string };
}
export type Side = 'right' | 'left';
const SIDES: Side[] = ['right', 'left'];
const CONFIG = config as unknown as Record<Side, HandConfig>;

const models: Record<Side, THREE.Object3D | null> = { right: null, left: null };

/** The hand placement (the calibration page edits it live; the game only reads it). */
export const handConfig = (): Record<Side, HandConfig> => CONFIG;

const sleeves = new Map<string, THREE.MeshStandardMaterial>();
const sleeveMaterial = (color: string) => {
  let m = sleeves.get(color);
  if (!m) sleeves.set(color, (m = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, side: THREE.DoubleSide })));
  return m;
};

/** Load both hands (a missing one is skipped). Never rejects. */
export async function loadHands(): Promise<void> {
  await Promise.all(
    SIDES.map(async (side) => {
      try {
        const gltf = await new GLTFLoader().loadAsync(CONFIG[side].file);
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.frustumCulled = false;
          for (const mt of ([] as THREE.Material[]).concat(m.material) as THREE.MeshStandardMaterial[]) {
            mt.side = THREE.FrontSide;
            // Meshy finishes come out glossy and carry baked light in "emissive": a cloth glove is neither.
            mt.roughness = Math.max(mt.roughness, 0.85);
            mt.metalness = 0;
            if (mt.emissiveMap) {
              mt.emissiveMap = null;
              mt.emissive.setRGB(0, 0, 0);
            }
            for (const t of [mt.map, mt.normalMap, mt.roughnessMap]) if (t) t.anisotropy = 8;
          }
        });
        models[side] = gltf.scene;
      } catch {
        models[side] = null;
      }
    }),
  );
}

/** Hang the hands on a profiled weapon's grip points (replacing any from before). */
export function dressHands(rig: WeaponRig): void {
  for (const side of SIDES) {
    const node = side === 'right' ? rig.rightHand : rig.leftHand;
    for (const c of [...node.children]) if (c.userData.fpHand) c.removeFromParent();
    const model = models[side];
    if (!model) continue;
    const c = CONFIG[side];
    const hand = new THREE.Group();
    hand.name = `${side}Hand`;
    hand.userData.fpHand = true;
    poseQuaternion(c.pose, hand.quaternion);
    const arm = model.clone(true);
    arm.matrixAutoUpdate = false;
    orientMatrix(c.orientation, arm.matrix);
    if (c.mirror) arm.matrix.premultiply(new THREE.Matrix4().makeScale(-1, 1, 1));
    hand.add(arm);
    if (c.sleeve) {
      // A tapered tube on the forearm's axis (it runs through the model's origin, along +Z).
      const sl = c.sleeve;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(sl.radius, sl.radius * 1.15, sl.length, 14, 1, true), sleeveMaterial(sl.color));
      tube.rotation.x = Math.PI / 2;
      const o = c.orientation.position;
      tube.position.set(c.mirror ? -o[0] : o[0], o[1], o[2] + sl.start + sl.length / 2);
      tube.frustumCulled = false;
      hand.add(tube);
    }
    node.add(hand);
    node.visible = true;
  }
}
