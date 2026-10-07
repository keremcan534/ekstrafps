import * as THREE from 'three';
import { DEG, clamp } from '../../core/math';
import { feel } from '../../config/Feel';
import { skillFx } from '../../game/Skills';
import type { WeaponData } from '../WeaponData';
import type { AmmoData } from '../AmmoData';
import { TarkovRecoil } from '../TarkovRecoil';

/**
 * The weapon's side of recoil: Escape from Tarkov's model (TarkovRecoil) with each weapon's
 * own Tarkov numbers. The hands' turn is split: the share the view carries goes to the
 * camera (RecoilSystem reads `tarkov.cam`), the rest turns the gun on screen about the
 * shoulder, so the muzzle (and every bullet) points by the whole turn; the per-shot curves'
 * flip, swing and roll go on top. The rearward kick and the curves' moves drive the position.
 */
export class RecoilLayer {
  /** Rotation (rad: x climb, y sideways, z roll) and position (m) this frame. */
  readonly rr = new THREE.Vector3();
  readonly rp = new THREE.Vector3();
  readonly tarkov = new TarkovRecoil();
  private weaponId = '';
  private side = 1;

  /** One shot. `side`: the shoulder (1 right, −1 left). */
  kick(data: WeaponData, ammo: AmmoData, crouching: boolean, ads: number, side: number): void {
    if (data.id !== this.weaponId) {
      this.weaponId = data.id;
      this.tarkov.setWeapon(data.id, data.fireRate);
    }
    this.side = side;
    this.tarkov.fire(feel.recoilScale * ammo.recoilModifier * skillFx.recoil, ads, crouching);
  }

  update(dt: number, ads: number): void {
    const t = this.tarkov;
    t.aim = ads;
    t.update(dt);
    const c = t.curveRot;
    this.rr.set(
      clamp(t.hand.x - t.cam.x + c.x, -20, 20) * DEG,
      clamp(-(t.hand.y - t.cam.y + c.y) * this.side, -15, 15) * DEG,
      clamp(-c.z * this.side, -10, 10) * DEG,
    );
    this.rp.set(t.curvePos.x * this.side, t.curvePos.y, t.back + t.curvePos.z);
  }

  reset(): void {
    this.tarkov.reset();
    this.weaponId = '';
    this.rr.set(0, 0, 0);
    this.rp.set(0, 0, 0);
  }
}
