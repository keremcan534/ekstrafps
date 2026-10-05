import './dossier.css';
import { DOSSIER_ENTRIES, type DossierEntry } from './DossierData';

/**
 * The personnel & threat archive (main menu → DOSSIER): one file per force on Site-9.
 *
 * A projector-lit photo archive: the forces down the left, the open file over the dark
 * half of the photograph (status, threat, profile, known personnel, the write-up, a
 * radio intercept), the photo on the right. Each file's photos take turns, every cut a
 * signal glitch — slices torn sideways, the colour channels split, static — never a
 * bright flash. Photos: public/dossier/<id>.jpg (a silhouette until one exists).
 */

type Sound = (name: string, volume?: number) => void;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const GLYPHS = '█▓▒░#%&@$*+=?/\\<>[]{}ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
/** Seconds each photo holds before the next cuts in. */
const PHOTO_HOLD = 6.5;

/** Text with [[redacted]] spans: blacked out, decrypted a beat after the file opens. */
const redact = (s: string) => esc(s).replace(/\[\[(.+?)\]\]/g, (_m, t: string) => `<span class="dos-redact" data-t="${t}">${'█'.repeat(t.replace(/^!/, '').length)}</span>`);

/** Which photos exist (checked once each). */
const photoOk = new Map<string, Promise<boolean>>();
function hasPhoto(id: string): Promise<boolean> {
  let p = photoOk.get(id);
  if (!p) {
    p = new Promise((res) => {
      const img = new Image();
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = `dossier/${id}.jpg`;
    });
    photoOk.set(id, p);
  }
  return p;
}

export class Dossier {
  readonly root: HTMLDivElement;
  private index = 0;
  private open_ = false;
  private q = <T extends Element = HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
  private shots: HTMLDivElement[] = [];
  private front = 0;
  private timers: number[] = [];
  private photoTimer = 0;
  /** The current file's photos that exist, and which one is up. */
  private photos: string[] = [];
  private photo = 0;
  private onKey = (e: KeyboardEvent) => this.key(e);
  private onMove = (e: PointerEvent) => this.parallax(e);
  private clock = 0;

  constructor(parent: HTMLElement, private onClose: () => void, private sound: Sound = () => {}) {
    this.root = document.createElement('div');
    this.root.className = 'dossier';
    this.root.innerHTML = `
      <div class="dos-stage">
        <div class="dos-shot"></div><div class="dos-shot"></div>
        <div class="dos-leak"></div><div class="dos-scratch"></div><div class="dos-vignette"></div>
        <div class="dos-grain"></div><div class="dos-scan"></div><div class="dos-tear"></div>
      </div>
      <div class="dos-stamp"><span></span></div>
      <header class="dos-head">
        <div class="dos-brand"><i class="dos-rec"></i>VANTA DYNAMICS <b>·</b> THREAT ARCHIVE</div>
        <div class="dos-title">Select File</div>
        <div class="dos-meta"><span class="dos-clock">--:--:--</span><span>SITE-9 · CLEARANCE IV</span><span class="dos-count"></span></div>
        <button class="dos-x" aria-label="Back">✕</button>
      </header>
      <nav class="dos-list"></nav>
      <article class="dos-file">
        <div class="dos-fileno"></div>
        <h2 class="dos-name"></h2>
        <div class="dos-call"></div>
        <div class="dos-tags"></div>
        <div class="dos-grid">
          <div class="dos-threat"><label>Threat</label><div class="dos-pips"></div></div>
          <div class="dos-facts"></div>
        </div>
        <div class="dos-stats"></div>
        <div class="dos-scroll">
          <section class="dos-bio"></section>
          <section class="dos-people"><label>Known personnel</label><ul></ul></section>
          <section class="dos-notes"><label>Field notes</label><p></p></section>
          <section class="dos-kit"><label>Known equipment</label><div></div></section>
        </div>
        <blockquote class="dos-quote"><i class="dos-wave"><b></b><b></b><b></b><b></b><b></b><b></b><b></b></i><span></span></blockquote>
      </article>
      <div class="dos-cap"></div>
      <footer class="dos-foot">
        <div class="dos-strip"></div>
        <div class="dos-ruler"><div class="dos-marker"></div></div>
        <div class="dos-hints"><span><kbd>↑</kbd><kbd>↓</kbd> File</span><span><kbd>←</kbd><kbd>→</kbd> Photo</span><button class="dos-back"><kbd>Esc</kbd> Back</button></div>
      </footer>
      <div class="dos-boot"><pre></pre></div>`;
    parent.appendChild(this.root);
    this.shots = [...this.root.querySelectorAll<HTMLDivElement>('.dos-shot')];
    for (const b of [this.q('.dos-back'), this.q('.dos-x')]) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
      });
    }
    this.buildList();
    this.buildRuler();
    this.q<HTMLDivElement>('.dos-grain').style.backgroundImage = `url(${noiseTile()})`;
    // Swipe on the photo: next / previous photo (phones).
    let sx = 0;
    const stage = this.q('.dos-stage');
    this.root.addEventListener('touchstart', (e) => (sx = e.touches[0].clientX), { passive: true });
    this.root.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 60 && !(e.target as HTMLElement).closest('.dos-list, .dos-file')) this.step(dx < 0 ? 1 : -1);
    });
    void stage;
  }

  get open(): boolean {
    return this.open_;
  }

  show(): void {
    this.open_ = true;
    this.root.classList.add('in');
    this.root.classList.remove('ready');
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointermove', this.onMove);
    this.sound('bd.encounter', 0.4);
    this.boot();
    this.tickClock();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.classList.remove('in', 'ready');
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pointermove', this.onMove);
    this.clearTimers();
    cancelAnimationFrame(this.clock);
    this.sound('ui.firemode', 0.5);
    this.onClose();
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    clearTimeout(this.photoTimer);
  }

  // ---------------------------------------------------------------- building

  private buildList(): void {
    const list = this.q('.dos-list');
    DOSSIER_ENTRIES.forEach((en, i) => {
      const row = document.createElement('button');
      row.className = 'dos-row';
      row.dataset.i = String(i);
      row.innerHTML = `<i class="dos-flag" style="--f0:${en.flag[0]};--f1:${en.flag[1]}"></i><span>${esc(en.name)}</span><em>${esc(en.status)}</em>`;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(i);
      });
      row.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.select(i);
      });
      list.appendChild(row);
    });
  }

  private buildRuler(): void {
    const ruler = this.q('.dos-ruler');
    DOSSIER_ENTRIES.forEach((en, i) => {
      const t = document.createElement('button');
      t.className = 'dos-tick';
      t.dataset.i = String(i);
      t.textContent = en.name;
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(i);
      });
      ruler.appendChild(t);
    });
  }

  /** "Access granted" teletype, then the archive flickers up. Any key / tap skips it. */
  private boot(): void {
    const pre = this.q('.dos-boot pre');
    const lines = [
      'VANTA DYNAMICS // SECURE ARCHIVE NODE 7',
      'LINK ............................ ESTABLISHED',
      'CLEARANCE ....................... LEVEL IV',
      `INDEXING ${DOSSIER_ENTRIES.length} FILES ....................... OK`,
      'WARNING: CONTENTS CLASSIFIED. UNAUTHORISED ACCESS IS A TERMINATION OFFENCE.',
      '',
      'ACCESS GRANTED_',
    ];
    pre.textContent = '';
    let k = 0;
    const step = () => {
      if (!this.open_) return;
      if (k < lines.length) {
        pre.textContent += lines[k++] + '\n';
        this.sound('ui.firemode', 0.15);
        this.timers.push(window.setTimeout(step, 80));
      } else this.timers.push(window.setTimeout(() => this.ready(), 240));
    };
    step();
    this.q('.dos-boot').addEventListener('pointerdown', () => this.ready(), { once: true });
  }

  private ready(): void {
    if (!this.open_ || this.root.classList.contains('ready')) return;
    this.root.classList.add('ready');
    this.select(this.index, true);
  }

  private tickClock(): void {
    const el = this.q('.dos-clock');
    const run = () => {
      if (!this.open_) return;
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}:${p(Math.floor(d.getMilliseconds() / 40))}`;
      this.clock = requestAnimationFrame(run);
    };
    run();
  }

  // ---------------------------------------------------------------- input

  private key(e: KeyboardEvent): void {
    const k = e.code;
    if (!this.root.classList.contains('ready')) {
      if (k === 'Escape') this.close();
      else this.ready();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const n = DOSSIER_ENTRIES.length;
    if (k === 'ArrowDown' || k === 'KeyS') this.select((this.index + 1) % n);
    else if (k === 'ArrowUp' || k === 'KeyW') this.select((this.index - 1 + n) % n);
    else if (k === 'ArrowRight' || k === 'KeyD') this.step(1);
    else if (k === 'ArrowLeft' || k === 'KeyA') this.step(-1);
    else if (k === 'Escape' || k === 'Backspace') this.close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** The photo and the file drift against each other with the mouse. */
  private parallax(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    this.root.style.setProperty('--px', (e.clientX / innerWidth - 0.5).toFixed(3));
    this.root.style.setProperty('--py', (e.clientY / innerHeight - 0.5).toFixed(3));
  }

  // ---------------------------------------------------------------- a file

  private select(i: number, force = false): void {
    if (i < 0 || (i === this.index && !force)) return;
    this.index = i;
    this.clearTimers();
    const en = DOSSIER_ENTRIES[i];
    this.root.style.setProperty('--accent', en.accent);
    this.sound('ui.firemode', 0.4);

    // List, counter, ruler.
    this.root.querySelectorAll<HTMLElement>('.dos-row').forEach((r) => r.classList.toggle('on', Number(r.dataset.i) === i));
    this.root.querySelector<HTMLElement>(`.dos-row[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    this.q('.dos-count').textContent = `FILE ${String(i + 1).padStart(2, '0')} / ${DOSSIER_ENTRIES.length}`;
    const ticks = [...this.root.querySelectorAll<HTMLElement>('.dos-tick')];
    ticks.forEach((t) => t.classList.toggle('on', Number(t.dataset.i) === i));
    const tick = ticks[i];
    if (tick) {
      const marker = this.q<HTMLElement>('.dos-marker');
      marker.style.left = `${tick.offsetLeft}px`;
      marker.style.width = `${tick.offsetWidth}px`;
    }

    this.fill(en);

    // Photos: the ones that exist, in order; the first cuts in now.
    this.photos = [];
    this.photo = 0;
    this.strip(en);
    this.cut(null);
    const want = i;
    void Promise.all(en.photos.map(hasPhoto)).then((ok) => {
      if (this.index !== want || !this.open_) return;
      this.photos = en.photos.filter((_, k) => ok[k]);
      this.strip(en);
      this.cut(this.photos[0] ?? null);
    });
  }

  /** The file's text. */
  private fill(en: DossierEntry): void {
    this.q('.dos-fileno').innerHTML = `<span>FILE № ${esc(en.file)}</span><span>${esc(en.year)}</span>`;
    this.typewrite(this.q('.dos-name'), en.name, 34);
    this.q('.dos-call').innerHTML = `${esc(en.role)} <b>·</b> ${esc(en.place)}`;
    this.q('.dos-tags').innerHTML = [`<span class="st st-${en.status.toLowerCase()}">${esc(en.status)}</span>`, ...en.tags.map((t) => `<span>${esc(t)}</span>`)].join('');
    this.q('.dos-pips').innerHTML = Array.from({ length: 5 }, (_, k) => `<i class="${k < en.threat ? 'on' : ''}" style="--d:${k * 70}ms"></i>`).join('');
    this.q('.dos-facts').innerHTML = en.facts.map(([k, v]) => `<div><label>${esc(k)}</label><span>${redact(v)}</span></div>`).join('');
    this.q('.dos-stats').innerHTML = en.stats
      .map(([k, v], n) => `<div class="dos-stat"><label>${esc(k)}</label><i><b style="--v:${v}%;--d:${120 + n * 90}ms"></b></i><span>${v}</span></div>`)
      .join('');
    this.q('.dos-bio').innerHTML = en.bio.map((p) => `<p>${redact(p)}</p>`).join('');
    this.q('.dos-people ul').innerHTML = en.people.map(([n, d]) => `<li><b>${esc(n)}</b> — ${esc(d)}</li>`).join('');
    this.q('.dos-notes p').innerHTML = redact(en.notes);
    this.q('.dos-kit div').innerHTML = en.kit.map((k) => `<span>${esc(k)}</span>`).join('');
    this.q('.dos-quote span').innerHTML = `“${esc(en.quote)}”`;
    this.q<HTMLElement>('.dos-scroll').scrollTop = 0;
    this.retrigger('.dos-file', 'enter');
    this.timers.push(window.setTimeout(() => this.decrypt(), 900));

    const stamp = this.q('.dos-stamp');
    stamp.querySelector('span')!.textContent = en.stamp;
    stamp.className = `dos-stamp s-${en.stance}`;
    this.timers.push(window.setTimeout(() => {
      stamp.classList.add('slam');
      this.sound('reload.rifle.boltforward', 0.5);
    }, 420));

    const cap = this.q('.dos-cap');
    cap.classList.remove('in');
    void cap.offsetWidth;
    cap.innerHTML = `<b>${esc(en.name)}</b><span>${esc(en.place)} — ${esc(en.year)}</span>`;
    cap.classList.add('in');
  }

  /** The film strip: this file's photos (tap one to cut to it). */
  private strip(en: DossierEntry): void {
    const strip = this.q('.dos-strip');
    strip.innerHTML = '';
    const list = this.photos.length ? this.photos : en.photos.slice(0, 1);
    list.forEach((id, k) => {
      const fr = document.createElement('button');
      fr.className = `dos-frame${k === this.photo ? ' on' : ''}`;
      fr.appendChild(portrait(id, 'dos-timg'));
      fr.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.photos.length) return;
        this.photo = k;
        this.cut(this.photos[k]);
      });
      strip.appendChild(fr);
    });
  }

  /** Next / previous photo of this file. */
  private step(dir: number): void {
    if (this.photos.length < 2) return;
    this.photo = (this.photo + dir + this.photos.length) % this.photos.length;
    this.cut(this.photos[this.photo]);
  }

  /** Cut to a photo (null: the silhouette) through a signal glitch; schedule the next. */
  private cut(id: string | null): void {
    clearTimeout(this.photoTimer);
    this.front = 1 - this.front;
    const next = this.shots[this.front];
    const prev = this.shots[1 - this.front];
    next.innerHTML = '';
    next.appendChild(id ? portrait(id, 'dos-img', true) : silhouette());
    prev.classList.remove('on');
    next.classList.remove('on');
    void next.offsetWidth;
    next.classList.add('on');
    this.retrigger('.dos-stage', 'glitch');
    this.sound('ui.hit', 0.25);
    this.root.querySelectorAll<HTMLElement>('.dos-frame').forEach((fr, k) => fr.classList.toggle('on', k === this.photo));
    if (this.photos.length > 1) {
      this.photoTimer = window.setTimeout(() => this.step(1), PHOTO_HOLD * 1000);
    }
  }

  private retrigger(sel: string, cls: string): void {
    const el = this.q(sel);
    el.classList.remove(cls);
    void (el as HTMLElement).offsetWidth;
    el.classList.add(cls);
  }

  /** Letters land one by one, the next few scrambling ahead of them. */
  private typewrite(el: HTMLElement, text: string, ms: number): void {
    let k = 0;
    const run = () => {
      if (!this.open_) return;
      const ahead = Array.from({ length: Math.min(3, text.length - k) }, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]).join('');
      el.textContent = text.slice(0, k) + ahead;
      if (k++ < text.length) this.timers.push(window.setTimeout(run, ms));
      else el.textContent = text;
    };
    run();
  }

  /** Redacted spans: noise, then the real words ([[!...]] stays blacked out). */
  private decrypt(): void {
    const spans = [...this.root.querySelectorAll<HTMLElement>('.dos-redact')];
    spans.forEach((sp, n) => {
      const t = sp.dataset.t ?? '';
      if (t.startsWith('!')) return;
      let k = 0;
      const run = () => {
        if (!this.open_) return;
        sp.textContent = t.slice(0, k) + Array.from({ length: t.length - k }, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]).join('');
        if (k++ < t.length) this.timers.push(window.setTimeout(run, 22));
        else {
          sp.textContent = t;
          sp.classList.add('open');
        }
      };
      this.timers.push(window.setTimeout(run, n * 240));
    });
  }
}

/** A photo (with two ghost copies for the glitch's colour split). */
function portrait(id: string, cls: string, ghosts = false): HTMLElement {
  const box = document.createElement('div');
  box.className = `${cls} dos-empty`;
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.onload = () => {
    box.classList.remove('dos-empty');
    box.appendChild(img);
    if (ghosts) {
      for (const g of ['dos-ghost-r', 'dos-ghost-c']) {
        const c = img.cloneNode() as HTMLImageElement;
        c.className = g;
        box.appendChild(c);
      }
    }
  };
  img.src = `dossier/${id}.jpg`;
  return box;
}

function silhouette(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'dos-img dos-empty';
  return box;
}

/** 160 px of monochrome noise as a data URL (the grain layer). */
function noiseTile(): string {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d')!;
  const d = g.createImageData(160, 160);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 46;
  }
  g.putImageData(d, 0, 0);
  return c.toDataURL();
}

export type { DossierEntry };
