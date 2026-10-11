import * as THREE from 'three';

/**
 * The lights under a scene, without walking the scene every frame. LightClip needs the
 * visible point / spot lights in three's own order each frame, and ViewLight every light now
 * and then; both used to traverse the whole scene (some 1-2k objects) to find a handful.
 *
 * Light membership only changes through Object3D.add / remove (attach, clear, clone and
 * removeFromParent all go through them), so those count a version whenever a subtree with a
 * light goes in or out, and the lists are rebuilt only then (a weapon swap adds no light: a few
 * times a match). The lists hold every light in depth-first order, the order traverse and the
 * renderer's own pass visit them; visibility is checked per light, up its parents.
 */
let version = 1;

const hasLight = (o: THREE.Object3D): boolean => {
  if ((o as THREE.Light).isLight) return true;
  for (const c of o.children) if (hasLight(c)) return true;
  return false;
};

const P = THREE.Object3D.prototype;
const add = P.add;
const remove = P.remove;
P.add = function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
  for (const o of objects) if (o && hasLight(o)) version++;
  return add.apply(this, objects);
};
P.remove = function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
  for (const o of objects) if (o && o.parent === this && hasLight(o)) version++;
  return remove.apply(this, objects);
};

interface Lists {
  v: number;
  all: THREE.Light[];
  points: THREE.PointLight[];
  spots: THREE.SpotLight[];
}
const cache = new WeakMap<THREE.Object3D, Lists>();

/** Every light under `root`, in traversal order (visible or not). */
export function sceneLights(root: THREE.Object3D): Lists {
  let l = cache.get(root);
  if (!l) cache.set(root, (l = { v: 0, all: [], points: [], spots: [] }));
  if (l.v !== version) {
    l.v = version;
    l.all.length = l.points.length = l.spots.length = 0;
    root.traverse((o) => {
      if (!(o as THREE.Light).isLight) return;
      l!.all.push(o as THREE.Light);
      if ((o as THREE.PointLight).isPointLight) l!.points.push(o as THREE.PointLight);
      else if ((o as THREE.SpotLight).isSpotLight) l!.spots.push(o as THREE.SpotLight);
    });
  }
  return l;
}

/** Shown: `o` and every parent up to `root` visible (what traverseVisible from `root` reaches). */
export function onStage(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return false;
}
