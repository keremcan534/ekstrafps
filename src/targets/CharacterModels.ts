import type { HumanoidSkin } from './Humanoid';
import { loadModelBody, skinFromModel, type ModelBody } from './ModelBody';

/**
 * Which faction wears which model (public/chars, packed by scripts/pack-character.mjs:
 * <name>.glb for desktop, m/<name>.glb for phones). A faction without a file keeps its
 * procedural body. `?charmodel=<url>` puts one model on everyone (testing an import).
 */
const FILES: Record<string, string> = {
  bd: 'sable',
  bdboss: 'warden',
  vanta: 'vanta',
  bravo: 'rival',
  charlie: 'rival',
  delta: 'rival',
  salvage: 'salvager',
};

const bodies = new Map<string, ModelBody>();

/** Load every faction model that exists (missing ones are skipped quietly). Never rejects. */
export async function loadCharacterModels(mobile: boolean): Promise<void> {
  const test = new URLSearchParams(location.search).get('charmodel');
  const byFile = new Map<string, Promise<ModelBody | null>>();
  const load = (url: string) => {
    let p = byFile.get(url);
    if (!p) {
      p = loadModelBody(url).catch((e) => {
        if (test) console.warn(`character model ${url} failed`, e);
        return null;
      });
      byFile.set(url, p);
    }
    return p;
  };
  await Promise.all(
    Object.entries(FILES).map(async ([palette, file]) => {
      const url = test ?? `${mobile ? 'chars/m' : 'chars'}/${file}.glb`;
      const body = await load(url);
      if (body) bodies.set(palette, body);
    }),
  );
}

/** The faction's model skin if one is loaded, else `base` unchanged. */
export function withModel(palette: string, base: HumanoidSkin): HumanoidSkin {
  const body = bodies.get(palette);
  return body ? skinFromModel(body, base) : base;
}
