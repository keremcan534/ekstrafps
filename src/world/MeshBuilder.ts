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
    if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
    let list = this.parts.get(material);
    if (!list) this.parts.set(material, (list = []));
    list.push(geo);
    return this;
  }

  /** Hand the collected geometry over (per material) instead of building meshes. */
  take(): Map<THREE.Material, THREE.BufferGeometry[]> {
    const out = this.parts;
    this.parts = new Map();
    return out;
  }

  /**
   * @param opts.merge a vertex-coloured material: every plain (untextured, opaque,
   *   non-emissive) standard material is folded into it as vertex colours, so a
   *   multi-material model costs one draw call (+ one per remaining material).
   */
  build(parent: THREE.Object3D, opts: { castShadow?: boolean; receiveShadow?: boolean; merge?: THREE.MeshStandardMaterial } = {}): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    if (opts.merge) {
      const plain: THREE.BufferGeometry[] = [];
      for (const [material, geos] of [...this.parts]) {
        const m = material as THREE.MeshStandardMaterial;
        const emissive = m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) * (m.emissiveIntensity ?? 1) > 0.001;
        if (!m.isMeshStandardMaterial || m.map || m.transparent || emissive) continue;
        for (const g of geos) {
          const n = g.getAttribute('position').count;
          const col = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) {
            col[i * 3] = m.color.r;
            col[i * 3 + 1] = m.color.g;
            col[i * 3 + 2] = m.color.b;
          }
          g.setAttribute('color', new THREE.BufferAttribute(col, 3));
          plain.push(g);
        }
        this.parts.delete(material);
      }
      if (plain.length) this.parts.set(opts.merge, plain);
    }
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

/**
 * Collapse a static model (many small meshes) into one mesh per material, baked in
 * the root's space. Used for decorative copies of weapon models on walls.
 */
export function mergeStatic(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    let p: THREE.Object3D | null = m;
    while (p && p !== root) {
      if (!p.visible) return;
      p = p.parent;
    }
    let g = m.geometry.clone();
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const mat = m.material as THREE.Material;
    byMat.set(mat, [...(byMat.get(mat) ?? []), g]);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
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
