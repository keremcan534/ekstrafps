import './skills.css';
import { MAX_LEVEL, SKILLS, pointsToNext, skillLevel, type SkillId } from '../game/Skills';
import { loadProfile } from '../game/Progress';

/**
 * How skills look, wherever they show: line icons, the ten-segment level track, and the
 * SKILLS panel of the main menu. The end-of-raid report (RaidReport.ts) uses the same
 * pieces, so a level reads the same in both places.
 */

/** Line icons (24 px grid, stroke = currentColor). */
export const SKILL_ICON: Record<SkillId, string> = {
  endurance: '<svg viewBox="0 0 24 24"><path d="M2 13h4l2.2-5.5L11.5 18l3-8.5 1.8 3.5H22"/></svg>',
  recoil: '<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="6"/><path d="M12 6V2M9.5 4.5 12 2l2.5 2.5M12 11v1.5M12 15.5V17M9 14h1.5M13.5 14H15"/></svg>',
  reload: '<svg viewBox="0 0 24 24"><path d="M9 2h6l-.6 4.5 1.6 15H8l1.6-15z"/><path d="M10.6 9.5h2.8M10.4 12.5h3.2M10.2 15.5h3.6"/></svg>',
  medic: '<svg viewBox="0 0 24 24"><path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z"/></svg>',
};

/** Points where `level` starts. */
const startOf = (level: number): number => {
  let p = 0;
  for (let i = 0; i < level; i++) p += pointsToNext(i);
  return p;
};

/**
 * The level track: ten segments, one per level. Each carries how full it was (`--a`) and
 * is now (`--b`), so the report can draw this raid's gain in red on top of the old fill.
 */
export function pipsHtml(before: number, after = before): string {
  let html = '';
  for (let i = 0; i < MAX_LEVEL; i++) {
    const s = startOf(i);
    const len = pointsToNext(i);
    const f = (v: number) => Math.max(0, Math.min(1, (v - s) / len)) * 100;
    html += `<i style="--a:${f(before).toFixed(1)}%;--b:${f(after).toFixed(1)}%"></i>`;
  }
  return `<span class="sk-pips">${html}</span>`;
}

/** Sum of all skill levels (shown as SKILL RANK). */
export const skillRank = (points: Partial<Record<SkillId, number>>): number =>
  SKILLS.reduce((n, s) => n + skillLevel(points[s.id] ?? 0).level, 0);

/** The SKILLS panel body (main menu): one card per skill, what it gives now and next. */
export function skillsPanelHtml(): string {
  const p = loadProfile();
  const last = new Map((p.lastSkills ?? []).map((g) => [g.id, g.gained]));
  const cards = SKILLS.map((sk) => {
    const pts = p.skills?.[sk.id] ?? 0;
    const l = skillLevel(pts);
    const maxed = l.level >= MAX_LEVEL;
    const gain = last.get(sk.id) ?? 0;
    return `<div class="sk-card${maxed ? ' max' : ''}">
      <i class="sk-icon">${SKILL_ICON[sk.id]}</i>
      <div class="sk-name">${sk.name}</div>
      <div class="sk-lv"><b>${l.level}</b><span>/ ${MAX_LEVEL}</span></div>
      ${pipsHtml(pts)}
      <div class="sk-prog">${maxed ? 'MAX LEVEL' : `${l.into} / ${l.need} TO LV ${l.level + 1}`}${gain ? `<em>LAST RAID +${gain}</em>` : ''}</div>
      <div class="sk-fx"><em>NOW</em><span>${l.level ? sk.effect(l.level / MAX_LEVEL) : 'No bonus yet'}</span></div>
      ${maxed ? '' : `<div class="sk-fx next"><em>LV ${l.level + 1}</em><span>${sk.effect((l.level + 1) / MAX_LEVEL)}</span></div>`}
      <div class="sk-how">${sk.how}</div>
    </div>`;
  }).join('');
  return `<div class="sk-top"><div><b>SKILL RANK ${skillRank(p.skills ?? {})}</b><span>/ ${SKILLS.length * MAX_LEVEL}</span></div>
    <p>Skills grow by doing, never bought. A raid's points bank when it ends: in full when you extract, half if you're killed. Every level is small; ten of them are felt.</p></div>
    <div class="sk-grid">${cards}</div>`;
}
