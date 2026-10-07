import './raid-report.css';
import type { Payout } from '../game/Progress';
import { MAX_LEVEL, SKILLS, skillLevel } from '../game/Skills';
import { SKILL_ICON, pipsHtml } from './SkillsUI';

/**
 * The end of a raid as an after-action report (4 Teams and Survival alike): a stamped
 * verdict, the standings, the ledger of what you earned and the skills that grew. Rows
 * come in one after another, totals count up, this raid's skill points fill in red.
 */

export interface ReportOptions {
  /** VICTORY, BRAVO WINS, GAME OVER… */
  title: string;
  tone: 'win' | 'lose';
  sub?: string;
  /** 4 Teams: best first. */
  standings?: { name: string; color: string; score: number; tag?: string; you?: boolean }[];
  /** Short facts under the title (time, kills, cash). */
  facts?: string[];
  pay: Payout;
}

const FATE: Record<Payout['fate'], { stamp: string; cls: string }> = {
  extracted: { stamp: 'EXTRACTED', cls: 'ok' },
  kia: { stamp: 'KILLED IN ACTION', cls: 'bad' },
  survival: { stamp: 'IN THE FIELD', cls: 'mid' },
};

export function showReport(host: HTMLElement, o: ReportOptions): void {
  const p = o.pay;
  const fate = p.mode === 'solo' ? { stamp: 'RUN ENDED', cls: 'mid' } : FATE[p.fate];
  let i = 0;
  const n = () => `style="--i:${i++}"`;

  const standings = o.standings?.length
    ? `<div class="ar-label" ${n()}>STANDINGS</div>
       <div class="ar-stand">${o.standings
         .map(
           (t, k) => `<div class="ar-team${t.you ? ' you' : ''}" ${n()}><em>${k + 1}</em><i style="background:${t.color}"></i><b>${t.name}</b><u class="${t.tag === 'EXTRACTED' ? 'ok' : 'bad'}">${t.tag ?? ''}</u><span>${t.score}</span></div>`,
         )
         .join('')}</div>`
    : '';

  const ledger = p.lines
    .map(([label, v]) => `<div class="ar-line${v < 0 ? ' neg' : ''}" ${n()}><span>${label}</span><i></i><b>${v > 0 ? '+' : ''}${v}</b></div>`)
    .join('');
  const mult = p.mult !== 1 ? `<div class="ar-line mult ${p.mult > 1 ? 'ok' : 'bad'}" ${n()}><span>${p.mult > 1 ? 'Extracted' : 'Killed in action'}</span><i></i><b>×${p.mult}</b></div>` : '';
  const up = p.after.level > p.before.level;
  const barFrom = up ? 0 : (p.before.into / p.before.need) * 100;
  const barTo = (p.after.into / p.after.need) * 100;

  const after = p.profile.skills ?? {};
  const gains = new Map(p.skills.map((g) => [g.id, g]));
  const skills = SKILLS.map((sk) => {
    const g = gains.get(sk.id);
    const now = after[sk.id] ?? 0;
    const was = now - (g?.gained ?? 0);
    const l = skillLevel(now);
    const lvUp = !!g && g.to > g.from;
    return `<div class="ar-skill${g ? ' grew' : ''}${lvUp ? ' up' : ''}" ${n()}>
      <i class="ar-sk-icon">${SKILL_ICON[sk.id]}</i>
      <div class="ar-sk-name"><b>${sk.name}</b><em>${lvUp ? `LV ${g!.from} → ${g!.to}` : `LV ${l.level}`}</em></div>
      <b class="ar-sk-gain">${g ? `+${g.gained}` : '—'}</b>
      ${pipsHtml(was, now)}
      ${lvUp ? `<div class="ar-sk-new"><em>LEVEL ${g!.to}</em>${sk.effect(g!.to / MAX_LEVEL)}</div>` : ''}
    </div>`;
  }).join('');
  const quiet = p.skills.length ? '' : `<div class="ar-note" ${n()}>No skill grew this raid: they train by fighting aimed in, landing hits, reloading and patching people up.</div>`;

  host.innerHTML = `<div class="ar">
    <div class="ar-dirt"></div>
    <header class="ar-head">
      <div class="ar-brand">VANTA DYNAMICS // AFTER-ACTION REPORT</div>
      <div class="ar-title ${o.tone}">${o.title}</div>
      ${o.sub ? `<div class="ar-sub">${o.sub}</div>` : ''}
      ${o.facts?.length ? `<div class="ar-facts">${o.facts.map((f) => `<span>${f}</span>`).join('')}</div>` : ''}
      <div class="ar-stamp ${fate.cls}">${fate.stamp}</div>
    </header>
    <div class="ar-body">
      <section class="ar-col">
        ${standings}
        <div class="ar-label" ${n()}>EARNINGS</div>
        <div class="ar-ledger">${ledger || `<div class="ar-line" ${n()}><span>Nothing this time</span><i></i><b>0</b></div>`}${mult}</div>
        <div class="ar-totals" ${n()}>
          <div><b data-to="${p.xp}">0</b><span>XP</span></div>
          <div><b data-to="${p.credits}">0</b><span>VC</span>${p.carried ? `<small>incl. ${p.carried} from $${p.cash} carried out</small>` : ''}</div>
        </div>
        <div class="ar-level${up ? ' up' : ''}" ${n()}>
          <div><b>LEVEL ${p.after.level}</b>${up ? '<em>LEVEL UP</em>' : ''}<span>${p.after.into} / ${p.after.need} XP</span></div>
          <i style="--from:${barFrom.toFixed(1)}%;--to:${barTo.toFixed(1)}%"></i>
          <small>${p.profile.credits} VC banked · spend them in the ARMORY</small>
        </div>
      </section>
      <section class="ar-col">
        <div class="ar-label" ${n()}>SKILLS</div>
        ${skills}
        ${quiet}
      </section>
    </div>
    <footer class="ar-foot" ${n()}>
      <button class="ar-btn primary" data-act="again">PLAY AGAIN</button>
      <button class="ar-btn" data-act="menu">MAIN MENU</button>
    </footer>
  </div>`;
  host.classList.add('show');

  host.querySelector('[data-act=again]')!.addEventListener('click', () => location.reload());
  host.querySelector('[data-act=menu]')!.addEventListener('click', () => {
    const q = new URLSearchParams(location.search);
    q.set('menu', '1');
    location.replace(`?${q.toString()}`);
  });

  // Start the reveal on the next frame (so the transitions run from their start values).
  const root = host.querySelector<HTMLElement>('.ar')!;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('go')));
  // Totals count up once their row is in.
  const step = 70;
  for (const el of root.querySelectorAll<HTMLElement>('[data-to]')) {
    const to = Number(el.dataset.to);
    const row = el.closest<HTMLElement>('[style*="--i"]');
    const delay = still ? 0 : Number(row?.style.getPropertyValue('--i') || 0) * step + 250;
    const dur = still ? 0 : 900;
    const t0 = performance.now() + delay;
    const tick = (now: number) => {
      const k = dur ? Math.min(1, Math.max(0, (now - t0) / dur)) : 1;
      el.textContent = `+${Math.round(to * (1 - Math.pow(1 - k, 3)))}`;
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
