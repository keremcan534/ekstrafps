import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Real props: CC0 models from Poly Haven (polyhaven.com), packed to GLB by gltf-transform
 * (quantized meshes, WebP): public/props ≤2.5k triangles and 512 textures, public/props/m
 * (phones) ≤800 triangles and 256 textures. Placement is synchronous (the map
 * builder adds colliders straight away from the sizes below); the meshes arrive with
 * load(), one InstancedMesh per (room group, prop, mesh part), so each room's props
 * cost a handful of draw calls and hide with the room.
 */

export type PropId =
  | 'barrel'
  | 'barrelRusty'
  | 'barrelPlastic'
  | 'crate'
  | 'ammoBox'
  | 'plasticCrate'
  | 'shelves'
  | 'desk'
  | 'chair'
  | 'trashbag'
  | 'extinguisher'
  | 'wetSign'
  | 'utilityBox'
  | 'medkit'
  | 'jerrycan'
  | 'container'
  | 'helicopter';

interface PropDef {
  file: string;
  /** Scale applied to the file (some are authored in other units). */
  scale: number;
  /** Size in metres after `scale` (x, y, z), base at y = 0, centred on x / z. */
  size: [number, number, number];
}

export const PROPS: Record<PropId, PropDef> = {
  barrel: { file: 'Barrel_01', scale: 1, size: [0.56, 0.88, 0.56] },
  barrelRusty: { file: 'barrel_03', scale: 1, size: [0.63, 0.93, 0.64] },
  barrelPlastic: { file: 'Barrel_02', scale: 1, size: [0.49, 0.88, 0.49] },
  crate: { file: 'wooden_crate_02', scale: 1, size: [0.53, 0.46, 1.17] },
  ammoBox: { file: 'ammo_box', scale: 1, size: [0.09, 0.18, 0.26] },
  plasticCrate: { file: 'plastic_crate_02', scale: 1, size: [0.51, 0.25, 0.41] },
  shelves: { file: 'steel_frame_shelves_01', scale: 0.1, size: [1.1, 2.14, 0.5] },
  desk: { file: 'metal_office_desk', scale: 1, size: [2.0, 0.79, 0.95] },
  chair: { file: 'SchoolChair_01', scale: 1, size: [0.57, 1.0, 0.68] },
  trashbag: { file: 'trashbag', scale: 1, size: [0.53, 0.58, 0.46] },
  extinguisher: { file: 'korean_fire_extinguisher_01', scale: 1, size: [0.28, 0.66, 0.37] },
  wetSign: { file: 'WetFloorSign_01', scale: 1, size: [0.3, 0.63, 0.36] },
  utilityBox: { file: 'utility_box_01', scale: 1, size: [0.52, 1.12, 0.43] },
  medkit: { file: 'medical_box', scale: 1, size: [0.53, 0.1, 0.35] },
  jerrycan: { file: 'metal_jerrycan_green', scale: 1, size: [0.37, 0.5, 0.17] },
  container: { file: 'industrial_pastic_container', scale: 1, size: [0.48, 0.42, 0.63] },
  // Meshy (scripts/pack-prop.mjs): a transport helicopter wreck, 15 m nose to tail.
  helicopter: { file: 'crashed_helicopter', scale: 7.9, size: [15, 4.23, 12.4] },
};

interface Batch {
  group: THREE.Object3D;
  id: PropId;
  matrices: THREE.Matrix4[];
}

export class PropKit {
  private batches = new Map<string, Batch>();
  private groupIds = new Map<THREE.Object3D, number>();

  constructor(private mobile: boolean) {}

  /**
   * Put a prop in `group` (world coordinates): base at `pos`, Euler `rot`, uniform `scale`
   * on top of the file's own.
   */
  place(group: THREE.Object3D, id: PropId, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], scale = 1): void {
    let gid = this.groupIds.get(group);
    if (gid === undefined) this.groupIds.set(group, (gid = this.groupIds.size));
    const key = `${gid}:${id}`;
    let b = this.batches.get(key);
    if (!b) this.batches.set(key, (b = { group, id, matrices: [] }));
    const s = PROPS[id].scale * scale;
    b.matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(s, s, s)));
  }

  /** Load every model in use and build the instanced meshes. Never rejects. */
  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const used = new Set([...this.batches.values()].map((b) => b.id));
    const parts = new Map<PropId, { geo: THREE.BufferGeometry; mat: THREE.Material }[]>();
    await Promise.all(
      [...used].map(async (id) => {
        try {
          // Relative to the page (the desktop and Android builds load from a file / app origin).
          const gltf = await loader.loadAsync(`${this.mobile ? 'props/m' : 'props'}/${PROPS[id].file}.glb`);
          gltf.scene.updateMatrixWorld(true);
          const list: { geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            // Bake the part's place in the model into its geometry (instances carry the rest).
            const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
            list.push({ geo, mat: m.material as THREE.Material });
          });
          parts.set(id, list);
        } catch (e) {
          console.warn(`prop ${id} unavailable, using a box`, e);
          const [x, y, z] = PROPS[id].size;
          const s = PROPS[id].scale;
          const geo = new THREE.BoxGeometry(x / s, y / s, z / s).translate(0, y / s / 2, 0);
          parts.set(id, [{ geo, mat: new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.8 }) }]);
        }
      }),
    );
    for (const b of this.batches.values()) {
      for (const { geo, mat } of parts.get(b.id) ?? []) {
        const inst = new THREE.InstancedMesh(geo, mat, b.matrices.length);
        b.matrices.forEach((m, i) => inst.setMatrixAt(i, m));
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        inst.castShadow = !this.mobile;
        inst.receiveShadow = true;
        b.group.add(inst);
      }
    }
  }
}
