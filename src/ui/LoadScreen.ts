/**
 * The loading screen: up while the game boots (physics, map, shaders) and, on phones,
 * while a match deploys. The work it covers blocks the main thread for seconds, so it
 * holds still except for its bar, which is a transform animation (the compositor keeps
 * it moving even while the page itself can't paint).
 */
export class LoadScreen {
  readonly el: HTMLDivElement;
  private msg: HTMLElement;
  private timer = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'load-screen';
    this.el.innerHTML = `
      <div class="ld-bg"></div>
      <div class="ld-box">
        <h1 class="ld-title">SITE<span>-</span>9</h1>
        <div class="ld-bar"><i></i></div>
        <div class="ld-msg">Loading…</div>
      </div>`;
    // Relative to the page (the desktop and Android builds load from a file / app origin).
    this.el.querySelector<HTMLElement>('.ld-bg')!.style.backgroundImage = 'url(menu/steppe.webp)';
    this.msg = this.el.querySelector('.ld-msg')!;
    parent.appendChild(this.el);
  }

  status(text: string): void {
    this.msg.textContent = text;
  }

  show(text: string): void {
    window.clearTimeout(this.timer);
    this.status(text);
    this.el.classList.remove('out', 'gone');
  }

  hide(): void {
    this.el.classList.add('out');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.add('gone'), 450);
  }
}

/** Resolve after `n` frames have actually been drawn (rAF fires only once a frame is done). */
export function afterFrames(n: number): Promise<void> {
  return new Promise((done) => {
    const step = () => (--n <= 0 ? done() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}
