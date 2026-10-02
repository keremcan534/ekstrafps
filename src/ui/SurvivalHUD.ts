const div = (cls: string, parent: HTMLElement) => {
  const d = document.createElement('div');
  d.className = cls;
  parent.appendChild(d);
  return d;
};

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

  constructor(parent: HTMLElement, private touch: boolean) {
    this.pointsEl = div('sv-points', parent);
    this.popups = div('sv-popups', parent);
    this.roundEl = div('sv-round', parent);
    this.remainEl = div('sv-remain', parent);
    this.prompt = div('sv-prompt', parent);
    this.banner = div('sv-banner', parent);
    this.over = div('sv-over', parent);
  }

  setPoints(points: number, delta = 0): void {
    this.pointsEl.textContent = `$ ${points}`;
    if (!delta) return;
    const p = div(`sv-pop ${delta > 0 ? 'plus' : 'minus'}`, this.popups);
    p.textContent = `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`;
    p.style.left = `${Math.random() * 40}px`;
    setTimeout(() => p.remove(), 900);
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

  gameOver(seconds: number, kills: number, points: number): void {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    this.over.innerHTML = `<div class="sv-over-title">GAME OVER</div>
      <div class="sv-over-sub">Survived ${m}:${s} · ${kills} robots destroyed · $ ${points}</div>
      <button class="sv-restart">PLAY AGAIN</button>`;
    this.over.classList.add('show');
    this.over.querySelector('button')!.addEventListener('click', () => location.reload());
  }
}
