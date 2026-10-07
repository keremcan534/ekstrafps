import type { HumanoidSkin } from './Humanoid';
import { loadModelBody, skinFromModel, type Girth, type ModelBody } from './ModelBody';

/**
 * Which faction wears which model (public/chars, packed by scripts/pack-character.mjs:
 * <name>.glb for desktop, m/<name>.glb for phones). A faction without a file keeps its
 * procedural body. `?charmodel=<url>` puts one model on everyone (testing an import).
 */
const FILES: Record<string, string> = {
  bd: 'sable',
  bdboss: 'warden',
  vanta: 'vanta',
  bravo: 'rival_tan',
  charlie: 'rival_green',
  delta: 'rival_grey',
  salvage: 'salvager',
  choir: 'choir',
  staff: 'staff',
  robot: 'robot_walker',
};

/** Standing height per file when it isn't a person's 1.78 m. */
const HEIGHTS: Record<string, number> = { robot_walker: 1.85, warden: 1.86 };
/**
 * Width × depth (× limb depth) for a model that came out too slight: the Warden's greatcoat
 * read as a stick figure; the box walker came out of Meshy 24 cm deep through the chest.
 */
const GIRTH: Record<string, Girth> = { warden: [1.3, 1.25], robot_walker: [1, 1.45, 1] };
/** Machines: hard plates on hinges, every vertex on one part (no rubbery elbows and knees). */
const RIGID = new Set(['robot_walker']);
/** Factions that carry guns: their models' hands are folded away, the hands are gloves on the gun (Soldier). */
const GUN_CARRIERS = new Set(['bd', 'bdboss', 'vanta', 'bravo', 'charlie', 'delta', 'salvage']);

const bodies = new Map<string, ModelBody>();
/** Far-away versions (public/chars/lod, same skeleton): their geometry only. */
const lods = new Map<string, ModelBody>();

/** Load every faction model that exists (missing ones are skipped quietly). Never rejects. */
export async function loadCharacterModels(mobile: boolean): Promise<void> {
  const test = new URLSearchParams(location.search).get('charmodel');
  const byFile = new Map<string, Promise<ModelBody | null>>();
  const load = (url: string, height?: number, girth?: Girth, rigid?: boolean, hideHands = false) => {
    const key = `${url}|${hideHands}`;
    let p = byFile.get(key);
    if (!p) {
      p = loadModelBody(url, height, girth, rigid, hideHands).catch((e) => {
        if (test) console.warn(`character model ${url} failed`, e);
        return null;
      });
      byFile.set(key, p);
    }
    return p;
  };
  await Promise.all(
    Object.entries(FILES).map(async ([palette, file]) => {
      const url = test ?? `${mobile ? 'chars/m' : 'chars'}/${file}.glb`;
      const [body, lod] = await Promise.all([
        load(url, HEIGHTS[file], GIRTH[file], RIGID.has(file), GUN_CARRIERS.has(palette)),
        test ? null : load(`chars/lod/${file}.glb`, HEIGHTS[file], GIRTH[file], RIGID.has(file), GUN_CARRIERS.has(palette)),
      ]);
      if (body) bodies.set(palette, body);
      // Only if it weighs the same parts in the same order (a mismatched one would tear the mesh).
      if (body && lod && lod.slots.join() === body.slots.join()) lods.set(palette, lod);
    }),
  );
}

/** The loaded model for `palette` (null when it has none). */
export function modelBody(palette: string): ModelBody | null {
  return bodies.get(palette) ?? null;
}

/** The faction's model skin if one is loaded, else `base` unchanged. */
export function withModel(palette: string, base: HumanoidSkin): HumanoidSkin {
  const body = bodies.get(palette);
  if (!body) return base;
  const skin = skinFromModel(body, base);
  const lod = lods.get(palette);
  if (lod && skin.body) skin.body.lod = lod.geometry;
  return skin;
}
