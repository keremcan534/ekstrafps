import type { TeamMatch } from '../game/TeamMatch';
import type { Survival } from '../game/Survival';

/** Shown or not (the lab panel and F6 flip it; ?watch turns it on). */
export const aiMonitor = { on: false };

const SAMPLE = 0.1;

/**
 * Live AI match stats: how much of the time the squads spend fighting each other
 * (vs robots), moving, how far apart the teams are, who died, what the supply drop is
 * doing and what each squad is up to. The same numbers the AI tuning is measured by.
 */
export class AIMonitor {
  private el: HTMLDivElement;
  private timer = 0;
  private renderTimer = 0;
  private time = 0;
  private samples = 0;
  private vsSoldier = 0;
  private vsRobot = 0;
  private moving = 0;
  private decisions = new Map<string, number>();
  private deaths = new Map<string, number>();
  private wasAlive = new Map<object, boolean>();

  constructor(ui: HTMLElement, private match: TeamMatch, private survival: Survival) {
    this.el = document.createElement('div');
    this.el.className = 'ai-monitor';
    ui.appendChild(this.el);
  }

  update(dt: number): void {
    this.el.style.display = aiMonitor.on ? '' : 'none';
    this.time += dt;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = SAMPLE;
      this.sample();
    }
    this.renderTimer -= dt;
    if (aiMonitor.on && this.renderTimer <= 0) {
      this.renderTimer = 0.5;
      this.render();
    }
  }

  private sample(): void {
    for (const t of this.match.teams) {
      for (const a of t.agents) {
        if (this.wasAlive.get(a) && !a.alive) this.deaths.set(t.def.id, (this.deaths.get(t.def.id) ?? 0) + 1);
        this.wasAlive.set(a, a.alive);
        if (!a.alive) continue;
        this.samples++;
        const tg = a.target;
        if (tg) {
          if (tg.kind === 'robot') this.vsRobot++;
          else this.vsSoldier++;
        }
        if (Math.hypot(a.soldier.vel.x, a.soldier.vel.z) > 0.5) this.moving++;
        const d = a.bot.decision;
        this.decisions.set(d, (this.decisions.get(d) ?? 0) + 1);
      }
    }
  }

  private render(): void {
    const pct = (x: number) => `${Math.round((x / Math.max(1, this.samples)) * 100)}%`;
    // Squad centres: how far apart the teams are (they meet → fights).
    const cents: [number, number][] = [];
    for (const t of this.match.teams) {
      const al = t.agents.filter((a) => a.alive);
      if (al.length) cents.push([al.reduce((s, a) => s + a.soldier.pos.x, 0) / al.length, al.reduce((s, a) => s + a.soldier.pos.z, 0) / al.length]);
    }
    let sum = 0;
    let n = 0;
    for (let i = 0; i < cents.length; i++) for (let j = i + 1; j < cents.length; j++) {
      sum += Math.hypot(cents[i][0] - cents[j][0], cents[i][1] - cents[j][1]);
      n++;
    }
    let nowSoldier = 0;
    let nowRobot = 0;
    const rows: string[] = [];
    for (const t of this.match.teams) {
      const al = t.agents.filter((a) => a.alive);
      const dec = new Map<string, number>();
      for (const a of al) {
        if (a.target) a.target.kind === 'robot' ? nowRobot++ : nowSoldier++;
        dec.set(a.bot.decision, (dec.get(a.bot.decision) ?? 0) + 1);
      }
      const what = [...dec].map(([d, k]) => (k > 1 ? `${d}×${k}` : d)).join(' ') || '—';
      const score = this.survival.score.get(t.def.id) ?? 0;
      rows.push(
        `<div class="aim-team"><b style="color:${t.def.color}">${t.def.name.toUpperCase()}</b><span>${al.length}/${t.agents.length}</span><span>${t.goalKind}</span><span>${score}</span><em>${what}</em></div>`,
      );
    }
    const di = this.match.drop.info;
    const name = (id: string) => this.match.teams.find((t) => t.def.id === id)?.def.name ?? (id === 'alpha' ? 'Vanta' : id);
    const drop =
      di.state === 'waiting'
        ? `next in ${Math.ceil(di.t)} s`
        : di.state === 'inbound'
          ? `${di.room} · lands in ${Math.ceil(di.t)} s`
          : `${di.room} · ${di.holder ? `${name(di.holder)} ${Math.round(di.hold * 100)}%` : 'nobody on it'} · ${Math.ceil(di.t)} s left`;
    const top = [...this.decisions].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d, k]) => `${d} ${pct(k)}`).join(' · ');
    const deaths = [...this.deaths].map(([t, k]) => `${name(t)} ${k}`).join(' · ') || 'none';
    const mm = `${(this.time / 60) | 0}:${String(Math.floor(this.time % 60)).padStart(2, '0')}`;
    this.el.innerHTML =
      `<div class="aim-head">AI MONITOR <span>${mm} · F6</span></div>` +
      `<div class="aim-row"><span>Fighting soldiers</span><b>${pct(this.vsSoldier)}</b><i>now ${nowSoldier}</i></div>` +
      `<div class="aim-row"><span>Fighting robots</span><b>${pct(this.vsRobot)}</b><i>now ${nowRobot}</i></div>` +
      `<div class="aim-row"><span>Moving</span><b>${pct(this.moving)}</b><i></i></div>` +
      `<div class="aim-row"><span>Team spread</span><b>${n ? Math.round(sum / n) : 0} m</b><i></i></div>` +
      `<div class="aim-line">Deaths: ${deaths}</div>` +
      `<div class="aim-line">Supply drop: ${drop}</div>` +
      rows.join('') +
      `<div class="aim-line aim-dec">${top}</div>`;
  }
}
