import * as THREE from 'three';

const base = THREE.Object3D.prototype.updateMatrixWorld;

/**
 * The renderer's per-frame matrix pass (scene.updateMatrixWorld) walks every
 * object, hidden or not: the fifteen weapons you aren't holding (~1300 parts)
 * and the pooled, hidden squads cost as much CPU as the visible scene. This
 * pass skips hidden subtrees, which aren't drawn. A hidden object is flagged so
 * its subtree is brought up to date the frame it shows again. Code that needs a
 * hidden object's matrices updates them itself (getWorldPosition, the rigs'
 * own updateMatrixWorld calls) as before.
 */
export function skipHiddenMatrices(scene: THREE.Object3D): void {
  scene.updateMatrixWorld = function (force = false) {
    updateVisibleMatrices(this, force);
  };
}

/** updateMatrixWorld for `o` and its visible descendants (hidden ones are flagged to catch up when shown). */
export function updateVisibleMatrices(o: THREE.Object3D, force: boolean): void {
  // Same rules as Object3D.updateMatrixWorld: an object with matrixWorldAutoUpdate off
  // keeps the matrixWorld it was given (ragdoll bones are written from the physics
  // bodies), but its children are still visited.
  if (o.matrixAutoUpdate) o.updateMatrix();
  if (o.matrixWorldNeedsUpdate || force) {
    if (o.matrixWorldAutoUpdate) {
      if (o.parent === null) o.matrixWorld.copy(o.matrix);
      else o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
    }
    o.matrixWorldNeedsUpdate = false;
    force = true;
  }
  const children = o.children;
  for (let i = 0, n = children.length; i < n; i++) {
    const c = children[i];
    if (!c.visible) {
      c.matrixWorldNeedsUpdate = true;
      continue;
    }
    // Classes with their own pass (skinned meshes keep their bind matrix, cameras their inverse): theirs.
    if (Object.getPrototypeOf(c).updateMatrixWorld !== base) c.updateMatrixWorld(force);
    else updateVisibleMatrices(c, force);
  }
}
