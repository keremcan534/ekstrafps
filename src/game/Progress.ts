/**
 * Career progression across games: XP (levels) and Vanta Credits (VC), kept in
 * the browser. A raid tracks what *you* did (not your AI squad); the end screen
 * turns it into XP and credits:
 *
 *   XP   kills (robot 15, salvager 50, rival operator 60, SABLE 90,
 *        The Choir 120, The Warden 400, +10 per headshot kill) + 10 per minute alive
 *        − 100 per civilian you killed
 *        + placement (4 Teams: 600 / 350 / 200 / 100)
 *        × fate: extracted ×1.5, killed in action ×0.75 (Survival: ×1)
 *   VC   XP / 5, plus 10 % of the cash you carry out (extracted only)
 *
 * Credits buy permanent unlocks in the ARMORY (main menu): a starting sidearm
 * and perks. Levels gate them. Skills grow alongside (Skills.ts); the end screen is
 * src/ui/RaidReport.ts.
 */

import { applySkills, settleSkills, skillRaid, type SkillGain, type SkillId } from './Skills';

export type PerkId = 'pockets' | 'plates' | 'scavenger';

export interface Unlock {
  id: string;
  name: string;
  text: string;
  level: number;
  cost: number;
}

export const SIDEARMS: (Unlock & { weapon: string })[] = [
  { id: 'heavy_pistol', weapon: 'heavy_pistol', name: 'M1911', text: 'Nine big rounds. The standard issue.', level: 1, cost: 0 },
];

export const PERKS: (Unlock & { id: PerkId })[] = [
  { id: 'pockets', name: 'DEEP POCKETS', text: 'Start every raid with $300 more.', level: 2, cost: 600 },
  { id: 'plates', name: 'PLATE CARRIER', text: 'Start with half a set of armor plates.', level: 4, cost: 900 },
  { id: 'scavenger', name: 'SCAVENGER', text: '+10 % cash from every hit and kill.', level: 6, cost: 1400 },
];

export interface Profile {
  xp: number;
  credits: number;
  raids: number;
  extractions: number;
  kills: number;
  owned: string[];
  sidearm: string;
  /** Equipped perks (one slot, two from level 8). */
  perks: PerkId[];
  /** Banked skill points (Skills.ts). */
  skills: Partial<Record<SkillId, number>>;
  /** What the last raid added to each skill (the SKILLS panel shows it). */
  lastSkills?: { id: SkillId; gained: number }[];
}

const KEY = 'site9.profile';

export function loadProfile(): Profile {
  const d: Profile = { xp: 0, credits: 0, raids: 0, extractions: 0, kills: 0, owned: ['heavy_pistol'], sidearm: 'heavy_pistol', perks: [], skills: {} };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Profile>) };
  } catch {
    return d;
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: progress lasts for this session */
  }
}

/** XP needed to go from `level` to the next one. */
export const xpToNext = (level: number): number => 800 + 200 * (level - 1);

export function levelOf(xp: number): { level: number; into: number; need: number } {
  let level = 1;
  let left = xp;
  while (left >= xpToNext(level)) {
    left -= xpToNext(level);
    level++;
  }
  return { level, into: left, need: xpToNext(level) };
}

export const perkSlots = (level: number): number => (level >= 8 ? 2 : 1);

/** What you did this raid (only your own hits count). */
export const raid = {
  robots: 0,
  soldiers: 0,
  bd: 0,
  warden: 0,
  salvage: 0,
  choir: 0,
  civilians: 0,
  headshots: 0,
  /** Seconds you were alive (and not in the menu). */
  alive: 0,
  reset(): void {
    this.robots = this.soldiers = this.bd = this.warden = this.salvage = this.choir = this.civilians = this.headshots = 0;
    this.alive = 0;
    skillRaid.reset();
    // This raid plays with the skills banked so far.
    applySkills(loadProfile().skills);
  },
};

/** Was this hit fired by you (not an AI teammate, not an enemy)? */
export const byPlayer = (hit: { hostile: boolean; ally: boolean; team: string; weaponId: string }): boolean =>
  !hit.hostile && !hit.ally && hit.team === 'alpha' && hit.weaponId !== 'melee' && hit.weaponId !== 'bleed';

export interface RaidResult {
  mode: 'teams' | 'solo';
  /** 4 Teams: 1..4 by score. */
  place?: number;
  fate: 'extracted' | 'kia' | 'survival';
  /** Cash in your wallet at the end. */
  cash: number;
}

export interface Payout {
  /** XP lines (label, amount); negative for penalties. */
  lines: [string, number][];
  mult: number;
  xp: number;
  credits: number;
  /** VC from the cash you carried out (extracted only; part of `credits`). */
  carried: number;
  fate: RaidResult['fate'];
  mode: RaidResult['mode'];
  place?: number;
  cash: number;
  before: { level: number; into: number; need: number };
  after: { level: number; into: number; need: number };
  profile: Profile;
  /** Skill points banked this raid. */
  skills: SkillGain[];
}

/** Turn the raid into XP and credits, bank them, and return the breakdown (RaidReport shows it). */
export function settleRaid(r: RaidResult): Payout {
  const lines: [string, number][] = [];
  const add = (label: string, n: number) => {
    if (n > 0) lines.push([label, Math.round(n)]);
  };
  add(`Robots destroyed ×${raid.robots}`, raid.robots * 15);
  add(`Rival operators ×${raid.soldiers}`, raid.soldiers * 60);
  add(`Salvagers ×${raid.salvage}`, raid.salvage * 50);
  add(`SABLE ×${raid.bd}`, raid.bd * 90);
  add(`The Choir ×${raid.choir}`, raid.choir * 120);
  add('The Warden', raid.warden * 400);
  add(`Headshot kills ×${raid.headshots}`, raid.headshots * 10);
  add(`Time alive ${Math.floor(raid.alive / 60)} min`, Math.floor(raid.alive / 60) * 10);
  if (r.place) add(`Placed #${r.place}`, [600, 350, 200, 100][r.place - 1] ?? 0);
  const mult = r.fate === 'extracted' ? 1.5 : r.fate === 'kia' ? 0.75 : 1;
  if (raid.civilians) lines.push([`Civilians killed ×${raid.civilians}`, -100 * raid.civilians]);
  const base = Math.max(0, lines.reduce((s, [, n]) => s + n, 0));
  const xp = Math.round(base * mult);
  const carried = r.fate === 'extracted' ? Math.round(r.cash * 0.1) : 0;
  const credits = Math.round(xp / 5) + carried;

  const p = loadProfile();
  const before = levelOf(p.xp);
  p.xp += xp;
  p.credits += credits;
  p.raids++;
  if (r.fate === 'extracted') p.extractions++;
  p.kills += raid.robots + raid.soldiers + raid.bd + raid.warden + raid.salvage + raid.choir;
  const skills = settleSkills(p.skills, r.fate);
  p.lastSkills = skills.map((g) => ({ id: g.id, gained: g.gained }));
  saveProfile(p);
  return { lines, mult, xp, credits, carried, fate: r.fate, mode: r.mode, place: r.place, cash: r.cash, before, after: levelOf(p.xp), profile: p, skills };
}
