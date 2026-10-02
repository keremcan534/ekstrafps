/**
 * Extraction UI: the 5-second countdown in the zone (seconds.milliseconds), the
 * cinematic letterbox, the white flash and the EXTRACTED title screen.
 */

const el = (cls: string, parent: HTMLElement, html = '') => {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  parent.appendChild(d);
  return d;
};

export interface ExtractStats {
  site: string;
  score: number;
  kills: number;
  time: number;
  squad: number;
}

export class ExtractUI {
  private count: HTMLDivElement;
  private digits: HTMLDivElement;
  private bar: HTMLDivElement;
  private site: HTMLDivElement;
  private bars: HTMLDivElement;
  private flash: HTMLDivElement;
  private screen: HTMLDivElement;
  private shown = '';

  constructor(parent: HTMLElement) {
    this.count = el('ex-count glass', parent, '<div class="ex-label">EXTRACTING</div><div class="ex-digits">05.000</div><div class="ex-site"></div><div class="ex-bar"><i></i></div>');
    this.digits = this.count.querySelector('.ex-digits')!;
    this.bar = this.count.querySelector('.ex-bar i')!;
    this.site = this.count.querySelector('.ex-site')!;
    this.bars = el('ex-letterbox', document.body, '<i></i><i></i>');
    this.flash = el('ex-flash', document.body);
    this.screen = el('ex-screen', document.body);
  }

  /** Countdown (seconds left) or null to hide. */
  countdown(left: number | null, site = ''): void {
    if (left === null) {
      if (this.shown) this.count.classList.remove('show');
      this.shown = '';
      return;
    }
    const txt = Math.max(0, left).toFixed(3).padStart(6, '0');
    if (txt === this.shown) return;
    this.shown = txt;
    this.count.classList.add('show');
    this.digits.textContent = txt;
    this.site.textContent = site;
    this.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, 1 - left / 5)).toFixed(3)})`;
    this.count.classList.toggle('hot', left < 1.5);
  }

  letterbox(on: boolean): void {
    this.bars.classList.toggle('show', on);
  }

  whiteFlash(): void {
    this.flash.classList.remove('go');
    void this.flash.offsetWidth;
    this.flash.classList.add('go');
  }

  extracted(s: ExtractStats, onContinue: () => void): void {
    const mm = `${Math.floor(s.time / 60)}:${String(Math.floor(s.time % 60)).padStart(2, '0')}`;
    this.screen.innerHTML = `
      <div class="ex-shock"></div>
      <div class="ex-kicker"><i></i>${s.site} · EXFIL CONFIRMED<i></i></div>
      <div class="ex-title">${'EXTRACTED'.split('').map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>
      <div class="ex-rule"></div>
      <div class="ex-stats">
        <div class="glass"><em>SCORE</em><b>${s.score.toLocaleString('en-US')}</b></div>
        <div class="glass"><em>KILLS</em><b>${s.kills}</b></div>
        <div class="glass"><em>TIME</em><b>${mm}</b></div>
        <div class="glass"><em>SQUAD OUT</em><b>${s.squad}/4</b></div>
      </div>
      <button class="gbtn primary ex-continue"><span class="gbtn-label">CONTINUE</span><span class="gbtn-shine"></span></button>`;
    this.screen.classList.add('show');
    this.screen.querySelector('.ex-continue')!.addEventListener('click', () => {
      this.screen.classList.remove('show');
      onContinue();
    });
  }
}
