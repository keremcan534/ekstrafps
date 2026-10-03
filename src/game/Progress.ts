/**
 * Career progression across games: XP (levels) and Vanta Credits (VC), kept in
 * the browser. A raid tracks what *you* did (not your AI squad); the end screen
 * turns it into XP and credits:
 *
 *   XP   kills (robot 15, brute 45, rival operator 60, Black Division 90,
 *        The Warden 400, +10 per headshot kill) + 10 per minute alive
 *        + placement (4 Teams: 600 / 350 / 200 / 100)
 *        × fate: extracted ×1.5, killed in action ×0.75 (Survival: ×1)
 *   VC   XP / 5, plus 10 % of the cash you carry out (extracted only)
 *
 * Credits buy permanent unlocks in the ARMORY (main menu): a starting sidearm
 * and perks. Levels gate them.
 */

export type PerkId = 'pockets' | 'plates' | 'scavenger';

export interface Unlock {
  id: string;
  name: string;
  text: string;
  level: number;
  cost: number;
}

export const SIDEARMS: (Unlock & { weapon: string })[] = [
  { id: 'heavy_pistol', weapon: 'heavy_pistol', name: 'HX-50 HEAVY PISTOL', text: 'Nine big rounds. The standard issue.', level: 1, cost: 0 },
  { id: 'glock18', weapon: 'glock18', name: 'G18C MACHINE PISTOL', text: 'Full auto 9 mm, 33 rounds: robots up close melt.', level: 2, cost: 400 },
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
}

const KEY = 'site9.profile';

export function loadProfile(): Profile {
  const d: Profile = { xp: 0, credits: 0, raids: 0, extractions: 0, kills: 0, owned: ['heavy_pistol'], sidearm: 'heavy_pistol', perks: [] };
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
  brutes: 0,
  soldiers: 0,
  bd: 0,
  warden: 0,
  headshots: 0,
  /** Seconds you were alive (and not in the menu). */
  alive: 0,
  reset(): void {
    this.robots = this.brutes = this.soldiers = this.bd = this.warden = this.headshots = 0;
    this.alive = 0;
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
  lines: [string, number][];
  mult: number;
  xp: number;
  credits: number;
  before: { level: number; into: number; need: number };
  after: { level: number; into: number; need: number };
  profile: Profile;
}

/** Turn the raid into XP and credits, bank them, and return the breakdown. */
export function settleRaid(r: RaidResult): Payout {
  const lines: [string, number][] = [];
  const add = (label: string, n: number) => {
    if (n > 0) lines.push([label, Math.round(n)]);
  };
  add(`Robots destroyed ×${raid.robots}`, raid.robots * 15);
  add(`Brutes destroyed ×${raid.brutes}`, raid.brutes * 45);
  add(`Rival operators ×${raid.soldiers}`, raid.soldiers * 60);
  add(`Black Division ×${raid.bd}`, raid.bd * 90);
  add('The Warden', raid.warden * 400);
  add(`Headshot kills ×${raid.headshots}`, raid.headshots * 10);
  add(`Time alive ${Math.floor(raid.alive / 60)} min`, Math.floor(raid.alive / 60) * 10);
  if (r.place) add(`Placed #${r.place}`, [600, 350, 200, 100][r.place - 1] ?? 0);
  const mult = r.fate === 'extracted' ? 1.5 : r.fate === 'kia' ? 0.75 : 1;
  const base = lines.reduce((s, [, n]) => s + n, 0);
  const xp = Math.round(base * mult);
  const carried = r.fate === 'extracted' ? Math.round(r.cash * 0.1) : 0;
  const credits = Math.round(xp / 5) + carried;
  if (carried) lines.push([`Cash carried out ($${r.cash} → 10 %)`, carried]);

  const p = loadProfile();
  const before = levelOf(p.xp);
  p.xp += xp;
  p.credits += credits;
  p.raids++;
  if (r.fate === 'extracted') p.extractions++;
  p.kills += raid.robots + raid.brutes + raid.soldiers + raid.bd + raid.warden;
  saveProfile(p);
  return { lines, mult, xp, credits, before, after: levelOf(p.xp), profile: p };
}

/** End-screen block for a payout (HTML). */
export function payoutHtml(pay: Payout): string {
  const rows = pay.lines.map(([l, n]) => `<div class="pr-row"><span>${l}</span><b>${l.startsWith('Cash') ? `+${n} VC` : `+${n}`}</b></div>`).join('');
  const multTxt = pay.mult === 1.5 ? '×1.5 EXTRACTED' : pay.mult === 0.75 ? '×0.75 KILLED IN ACTION' : '';
  const up = pay.after.level > pay.before.level;
  const pct = (pay.after.into / pay.after.need) * 100;
  return `<div class="pr">
    <div class="pr-head">OPERATION REPORT</div>
    ${rows}
    ${multTxt ? `<div class="pr-row mult"><span>${multTxt}</span><b></b></div>` : ''}
    <div class="pr-total"><span>+${pay.xp} XP</span><span>+${pay.credits} VC</span></div>
    <div class="pr-level ${up ? 'up' : ''}"><b>LEVEL ${pay.after.level}${up ? ' · LEVEL UP' : ''}</b><i style="--p:${pct.toFixed(1)}%"></i><em>${pay.after.into} / ${pay.after.need} XP · ${pay.profile.credits} VC banked</em></div>
  </div>`;
}
