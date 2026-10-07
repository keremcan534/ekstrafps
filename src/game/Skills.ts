/**
 * Skills that grow slowly by doing (Tarkov-style, kinder): every raid you earn points
 * in what you actually did, they bank at the end of the raid, and each level is a small,
 * felt edge (at most 15 % at level 10). Kept in the profile (Progress.ts).
 *
 *   ENDURANCE   fighting while aimed in            arm stamina lasts longer, comes back faster
 *   RECOIL      your hits on enemies (heads ×2)    less view climb per shot
 *   RELOADING   reloads (×2 when hurt in the last 6 s)  faster reloads
 *   FIELD MEDIC reviving teammates, med stations   faster revives, longer bleed-out
 *
 * Against grinding: inside one raid every skill's points saturate (SOFT_CAP), and only
 * meaningful context counts (aimed in *and* fighting, hits not shots). What you earned
 * banks in full when you extract, half when you're killed (Survival: 80 %). No decay.
 */

export type SkillId = 'endurance' | 'recoil' | 'reload' | 'medic';

export const MAX_LEVEL = 10;

export const SKILLS: { id: SkillId; name: string; how: string; effect: (f: number) => string }[] = [
  { id: 'endurance', name: 'ENDURANCE', how: 'Fight while aimed in', effect: (f) => `Arm stamina −${pct(0.15 * f)} drain, +${pct(0.15 * f)} recovery` },
  { id: 'recoil', name: 'RECOIL CONTROL', how: 'Land hits (headshots count double)', effect: (f) => `View climb −${pct(0.12 * f)}` },
  { id: 'reload', name: 'RELOADING', how: 'Reload, especially under fire', effect: (f) => `Reloads ${pct(0.12 * f)} faster` },
  { id: 'medic', name: 'FIELD MEDIC', how: 'Revive teammates, use medical stations', effect: (f) => `Revives ${pct(0.15 * f)} faster, bleed-out +${pct(0.15 * f)}` },
];

const pct = (v: number): string => `${Math.round(v * 100)} %`;

/** Points to go from `level` to the next (60 for the first, 420 for the last: ~2400 to max). */
export const pointsToNext = (level: number): number => 60 + 40 * level;

export function skillLevel(points: number): { level: number; into: number; need: number } {
  let level = 0;
  let left = points;
  while (level < MAX_LEVEL && left >= pointsToNext(level)) {
    left -= pointsToNext(level);
    level++;
  }
  return level >= MAX_LEVEL ? { level, into: 0, need: 0 } : { level, into: left, need: pointsToNext(level) };
}

/**
 * The skills' effects for the raid being played (set at its start from the profile; the
 * weapon, recoil and revive code read these). 1 = no change.
 */
export const skillFx = {
  staminaDrain: 1,
  staminaRecover: 1,
  recoil: 1,
  reload: 1,
  reviveTime: 1,
  bleedOut: 1,
};

/** Set the effects from banked points (raid start; also the menu after a payout). */
export function applySkills(points: Partial<Record<SkillId, number>>): void {
  const f = (id: SkillId) => skillLevel(points[id] ?? 0).level / MAX_LEVEL;
  skillFx.staminaDrain = 1 - 0.15 * f('endurance');
  skillFx.staminaRecover = 1 + 0.15 * f('endurance');
  skillFx.recoil = 1 - 0.12 * f('recoil');
  skillFx.reload = 1 - 0.12 * f('reload');
  skillFx.reviveTime = 1 - 0.15 * f('medic');
  skillFx.bleedOut = 1 + 0.15 * f('medic');
}

/** Raw points one raid can't usefully exceed: past it, more of the same earns less and less. */
const SOFT_CAP = 120;

/** What you did this raid, raw (reset with Progress.raid). */
export const skillRaid = {
  raw: { endurance: 0, recoil: 0, reload: 0, medic: 0 } as Record<SkillId, number>,
  /** Last time (raid seconds) you fired, and were hurt: "fighting" and "under fire". */
  shotAt: -99,
  hurtAt: -99,
  time: 0,
  reset(): void {
    for (const k of Object.keys(this.raw) as SkillId[]) this.raw[k] = 0;
    this.shotAt = this.hurtAt = -99;
    this.time = 0;
  },
  add(id: SkillId, n: number): void {
    this.raw[id] += n;
  },
};

/** Per-frame: aimed in while fighting trains endurance. */
export function tickSkills(dt: number, aimedIn: boolean): void {
  skillRaid.time += dt;
  if (aimedIn && skillRaid.time - skillRaid.shotAt < 4) skillRaid.add('endurance', dt);
}
export const skillShot = (): void => {
  skillRaid.shotAt = skillRaid.time;
};
export const skillHurt = (): void => {
  skillRaid.hurtAt = skillRaid.time;
};
/** A reload started: worth double with fresh damage on you. */
export const skillReload = (): void => skillRaid.add('reload', skillRaid.time - skillRaid.hurtAt < 6 ? 4 : 2);

export interface SkillGain {
  id: SkillId;
  name: string;
  gained: number;
  from: number;
  to: number;
}

/**
 * Bank this raid's points into `points` (mutates it) and say what changed. `fate`
 * scales them: extracted 1, survival 0.8, killed in action 0.5.
 */
export function settleSkills(points: Partial<Record<SkillId, number>>, fate: 'extracted' | 'kia' | 'survival'): SkillGain[] {
  const mult = fate === 'extracted' ? 1 : fate === 'kia' ? 0.5 : 0.8;
  const out: SkillGain[] = [];
  for (const s of SKILLS) {
    const raw = skillRaid.raw[s.id];
    // Saturating: the first points of a raid count fully, then each one less.
    const gained = Math.round(SOFT_CAP * (1 - Math.exp(-raw / SOFT_CAP)) * mult);
    if (gained <= 0) continue;
    const before = points[s.id] ?? 0;
    points[s.id] = before + gained;
    out.push({ id: s.id, name: s.name, gained, from: skillLevel(before).level, to: skillLevel(before + gained).level });
  }
  return out;
}
