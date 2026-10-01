import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Collects primitive pieces and merges them into one mesh per material.
 * Keeps draw calls low (important on mobile) while letting us author
 * geometry as simple boxes and cylinders.
 */
export class MeshBuilder {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();

  /** @param worldUV project UVs from world position (1 UV unit = 1 m) so grid textures keep scale. */
  constructor(private worldUV = false) {}

  box(material: THREE.Material, size: [number, number, number], pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]): this {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    return this.add(material, g, pos, rot);
  }

  cylinder(material: THREE.Material, radius: number, height: number, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], segments = 16): this {
    return this.add(material, new THREE.CylinderGeometry(radius, radius, height, segments), pos, rot);
  }

  add(material: THREE.Material, geo: THREE.BufferGeometry, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): this {
    this.e.set(rot[0], rot[1], rot[2]);
    this.q.setFromEuler(this.e);
    this.m.compose(this.p.set(...pos), this.q, this.s.set(...scale));
    geo.applyMatrix4(this.m);
    if (this.worldUV) projectWorldUVs(geo);
    // Merging requires identical attribute sets.
    if (geo.index) geo = geo.toNonIndexed();
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    }
    let list = this.parts.get(material);
    if (!list) this.parts.set(material, (list = []));
    list.push(geo);
    return this;
  }

  build(parent: THREE.Object3D, opts: { castShadow?: boolean; receiveShadow?: boolean } = {}): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [material, geos] of this.parts) {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = opts.castShadow ?? true;
      mesh.receiveShadow = opts.receiveShadow ?? true;
      parent.add(mesh);
      meshes.push(mesh);
      for (const g of geos) g.dispose();
    }
    this.parts.clear();
    return meshes;
  }
}

function projectWorldUVs(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  if (!uv) return;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (ny >= nx && ny >= nz) uv.setXY(i, x, z);
    else if (nx >= nz) uv.setXY(i, z, y);
    else uv.setXY(i, x, y);
  }
  uv.needsUpdate = true;
}
