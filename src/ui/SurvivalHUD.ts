const div = (cls: string, parent: HTMLElement) => {
  const d = document.createElement('div');
  d.className = cls;
  parent.appendChild(d);
  return d;
};

/** Phones: point credits within this window share one popup. */
const COALESCE_MS = 300;
/** Largest teammate share of an ordinary hit/kill (TEAM_SHARE 0.15 of 10/60); your own hit pays 10. */
const PASSIVE_SHARE = 9;

/**
 * Survival HUD: points (with +/- popups), threat level, robots active,
 * the interaction prompt ("[F] Buy AK-47 — $1400") and the game-over screen.
 */
export class SurvivalHUD {
  private pointsEl: HTMLDivElement;
  private popups: HTMLDivElement;
  private roundEl: HTMLDivElement;
  private remainEl: HTMLDivElement;
  private prompt: HTMLDivElement;
  private banner: HTMLDivElement;
  private over: HTMLDivElement;
  private lastPrompt = '';
  /** Phones: reused +/- popups (restarted with Element.animate instead of a node per credit). */
  private pops: { el: HTMLDivElement; anim: Animation | null; start: number; sum: number }[] = [];
  private popIndex = 0;

  constructor(parent: HTMLElement, private touch: boolean) {
    this.pointsEl = div('sv-points', parent);
    this.popups = div('sv-popups', parent);
    // Phones only; desktop keeps a node per credit (setPoints).
    for (let i = 0; touch && i < 4; i++) {
      const el = div('sv-pop', this.popups);
      // The CSS keyframes would run once on creation; the script animation replaces them.
      el.style.animation = 'none';
      el.style.opacity = '0';
      this.pops.push({ el, anim: null, start: -Infinity, sum: 0 });
    }
    this.roundEl = div('sv-round', parent);
    this.remainEl = div('sv-remain', parent);
    this.prompt = div('sv-prompt', parent);
    this.banner = div('sv-banner', parent);
    this.over = div('sv-over', parent);
  }

  setPoints(points: number, delta = 0): void {
    const text = `$ ${points}`;
    if (this.pointsEl.textContent !== text) this.pointsEl.textContent = text;
    if (!delta) return;
    if (!this.touch) {
      // Desktop: every credit gets its own rising popup (CSS svPop).
      const p = div(`sv-pop ${delta > 0 ? 'plus' : 'minus'}`, this.popups);
      p.textContent = `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`;
      p.style.left = `${Math.random() * 40}px`;
      setTimeout(() => p.remove(), 900);
      return;
    }
    // Phones: teammates' passive shares of ordinary hits/kills only move the total
    // (larger shares - head kills, drops, awards - still pop; the wallet has no "passive" flag).
    if (Math.abs(delta) <= PASSIVE_SHARE) return;
    const now = performance.now();
    const cur = this.pops[this.popIndex];
    if (cur.anim && now - cur.start < COALESCE_MS && (delta > 0) === (cur.sum > 0)) {
      // Same burst: grow the popup that is already rising.
      cur.sum += delta;
      cur.el.textContent = `${cur.sum > 0 ? '+' : '−'}${Math.abs(cur.sum)}`;
      return;
    }
    this.popIndex = (this.popIndex + 1) % this.pops.length;
    const p = this.pops[this.popIndex];
    p.sum = delta;
    p.start = now;
    p.el.className = `sv-pop ${delta > 0 ? 'plus' : 'minus'}`;
    p.el.textContent = `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`;
    p.el.style.left = `${Math.random() * 40}px`;
    p.anim?.cancel();
    p.anim = p.el.animate(
      [
        { transform: 'translateY(0)', opacity: 1, easing: 'ease-out' },
        { transform: 'translateY(-34px)', opacity: 0 },
      ],
      { duration: 900, fill: 'forwards' },
    );
  }

  /** Threat level (grows with time and opened zones). */
  setRound(n: number): void {
    const t = n > 0 ? String(n) : '';
    if (this.roundEl.textContent !== t) this.roundEl.textContent = t;
  }

  /** The director sends a mob. */
  horde(): void {
    this.showBanner('THEY ARE COMING', 'round');
  }

  private bannerId = 0;
  showBanner(text: string, cls: string): void {
    this.banner.textContent = text;
    this.banner.className = `sv-banner show ${cls}`;
    const id = ++this.bannerId;
    setTimeout(() => {
      if (id === this.bannerId) this.banner.classList.remove('show');
    }, 2600);
  }

  setRemaining(n: number): void {
    const t = n > 0 ? `${n} robot${n === 1 ? '' : 's'} hunting` : 'quiet';
    if (this.remainEl.textContent !== t) this.remainEl.textContent = t;
  }

  setPrompt(label: string, cost: number, affordable: boolean): void {
    const key = label ? `${label}|${cost}|${affordable}` : '';
    if (key === this.lastPrompt) return;
    this.lastPrompt = key;
    if (!label) {
      this.prompt.classList.remove('show');
      return;
    }
    const k = this.touch ? 'USE' : 'F';
    this.prompt.innerHTML = `<span class="sv-key">${k}</span> ${label} <span class="sv-cost ${affordable ? '' : 'no'}">$ ${cost}</span>`;
    this.prompt.classList.add('show');
  }

  /** Not enough points: shake the prompt. */
  flashPrompt(): void {
    this.prompt.classList.remove('deny');
    void this.prompt.offsetWidth;
    this.prompt.classList.add('deny');
  }

  gameOver(seconds: number, kills: number, points: number, report = ''): void {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    this.over.innerHTML = `<div class="sv-over-title">GAME OVER</div>
      <div class="sv-over-sub">Survived ${m}:${s} · ${kills} robots destroyed · $ ${points}</div>
      ${report}
      <button class="sv-restart">PLAY AGAIN</button>`;
    this.over.classList.add('show');
    this.over.querySelector('button')!.addEventListener('click', () => location.reload());
  }
}
