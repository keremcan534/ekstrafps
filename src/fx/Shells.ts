import * as THREE from 'three';
import { RAPIER, GROUPS, type Physics } from '../core/Physics';
import { shellMaterials } from '../weapons/WeaponModels';

type ShellType = 'rifle' | 'pistol' | 'shotgun';

interface Shell {
  body: RAPIER.RigidBody;
  type: ShellType;
  index: number;
  age: number;
  active: boolean;
  clinked: boolean;
}

const LIFETIME = 3.5;
const SHAPES: Record<ShellType, { r: number; len: number; mat: THREE.Material; density: number }> = {
  rifle: { r: 0.0055, len: 0.045, mat: shellMaterials.brass, density: 8000 },
  pistol: { r: 0.0065, len: 0.025, mat: shellMaterials.brass, density: 8000 },
  shotgun: { r: 0.0105, len: 0.07, mat: shellMaterials.red, density: 1500 },
};

/**
 * Pooled physical shell casings. Real Rapier bodies (they bounce off floors and
 * props) but drawn with one InstancedMesh per casing type. Fixed pool, no
 * allocation per shot; the oldest shell is recycled when the pool is full.
 */
export class Shells {
  readonly group = new THREE.Group();
  private pools: Record<ShellType, Shell[]> = { rifle: [], pistol: [], shotgun: [] };
  private meshes = {} as Record<ShellType, THREE.InstancedMesh>;
  private cursor: Record<ShellType, number> = { rifle: 0, pistol: 0, shotgun: 0 };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  /** Called the first time a shell lands, with its position (for clink audio). */
  onClink: ((type: ShellType, pos: THREE.Vector3) => void) | null = null;

  /** @param ccd Continuous collision (desktop): phones skip it, a casing's few cm per step don't tunnel through floors. */
  constructor(physics: Physics, perType: number, ccd = true) {
    for (const type of Object.keys(SHAPES) as ShellType[]) {
      const s = SHAPES[type];
      const geo = new THREE.CylinderGeometry(s.r, s.r, s.len, 8);
      geo.rotateX(Math.PI / 2);
      const mesh = new THREE.InstancedMesh(geo, s.mat, perType);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      for (let i = 0; i < perType; i++) {
        mesh.setMatrixAt(i, this.zero);
        const body = physics.world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(ccd).setLinearDamping(0.3).setAngularDamping(0.6).setEnabled(false),
        );
        physics.world.createCollider(
          RAPIER.ColliderDesc.cuboid(s.r, s.r, s.len / 2)
            .setDensity(s.density)
            .setRestitution(0.35)
            .setFriction(0.6)
            .setCollisionGroups(GROUPS.shell),
          body,
        );
        this.pools[type].push({ body, type, index: i, age: 0, active: false, clinked: false });
      }
      this.meshes[type] = mesh;
      this.group.add(mesh);
    }
  }

  eject(type: ShellType, pos: THREE.Vector3, vel: THREE.Vector3, rot: THREE.Quaternion): void {
    const pool = this.pools[type];
    const shell = pool[this.cursor[type]];
    this.cursor[type] = (this.cursor[type] + 1) % pool.length;
    const b = shell.body;
    b.setEnabled(true);
    b.setTranslation(pos, true);
    b.setRotation(rot, true);
    b.setLinvel(vel, true);
    b.setAngvel({ x: (Math.random() - 0.5) * 30, y: (Math.random() - 0.5) * 30, z: (Math.random() - 0.5) * 30 }, true);
    shell.age = 0;
    shell.active = true;
    shell.clinked = false;
  }

  update(dt: number): void {
    for (const type of Object.keys(this.pools) as ShellType[]) {
      const mesh = this.meshes[type];
      let dirty = false;
      for (const s of this.pools[type]) {
        if (!s.active) continue;
        s.age += dt;
        dirty = true;
        if (s.age > LIFETIME) {
          s.active = false;
          s.body.setEnabled(false);
          mesh.setMatrixAt(s.index, this.zero);
          continue;
        }
        const t = s.body.translation();
        const r = s.body.rotation();
        this.p.set(t.x, t.y, t.z);
        this.q.set(r.x, r.y, r.z, r.w);
        // Shrink away during the last 0.3s instead of popping.
        const fade = Math.min(1, (LIFETIME - s.age) / 0.3);
        this.m.compose(this.p, this.q, this.one.setScalar(fade));
        mesh.setMatrixAt(s.index, this.m);
        if (!s.clinked && s.age > 0.12) {
          const v = s.body.linvel();
          if (v.y > -0.5 && Math.abs(v.y) < 1.5 && s.age > 0.25) {
            s.clinked = true;
            this.onClink?.(type, this.p);
          }
        }
      }
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
