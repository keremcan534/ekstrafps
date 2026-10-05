import './dossier.css';
import { DOSSIER_ENTRIES, type DossierEntry } from './DossierData';
import { DossierSfx } from './DossierSfx';
import { emblem } from './DossierEmblems';

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
/** Seconds each photo holds before the next cuts in. */
const PHOTO_HOLD = 6.5;

/** [[!text]]: blacked out for good. [[text]]: an analyst's red-pencil underline. */
const redact = (s: string) =>
  esc(s).replace(/\[\[(.+?)\]\]/g, (_m, t: string) =>
    t.startsWith('!') ? `<span class="dos-redact">${'█'.repeat(t.length - 1)}</span>` : `<span class="dos-pencil">${t}</span>`);
const THREAT = ['', 'MINIMAL', 'LOW', 'MODERATE', 'HIGH', 'EXTREME'];

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
  private sfx = new DossierSfx();

  constructor(parent: HTMLElement, private onClose: () => void, private sound: Sound = () => {}) {
    this.root = document.createElement('div');
    this.root.className = 'dossier';
    this.root.innerHTML = `
      <div class="dos-stage">
        <div class="dos-shot"></div><div class="dos-shot"></div>
        <div class="dos-leak"></div><div class="dos-scratch"></div><div class="dos-vignette"></div>
        <div class="dos-grain"></div><div class="dos-scan"></div><div class="dos-tear"></div>
      </div>
      <header class="dos-head">
        <div class="dos-brand"><i class="dos-rec"></i>VANTA DYNAMICS <b>·</b> THREAT ARCHIVE</div>
        <div class="dos-title">Select File</div>
        <div class="dos-meta"><span class="dos-clock">--:--:--</span><span>SITE-9 · CLEARANCE IV</span><span class="dos-count"></span></div>
        <button class="dos-x" aria-label="Back">✕</button>
      </header>
      <nav class="dos-list"></nav>
      <article class="dos-file">
        <div class="dos-paper">
          <div class="dos-stamp"><span></span></div>
          <div class="dos-letterhead">VANTA DYNAMICS — INTERNAL SECURITY DIVISION<br>INTELLIGENCE SUMMARY</div>
          <div class="dos-fileline"><span class="dos-fileno"></span><span class="dos-date"></span></div>
          <table class="dos-fields"></table>
          <div class="dos-body"></div>
          <div class="dos-dist">DISTRIBUTION: CLEARANCE IV ONLY — DO NOT COPY — PAGE 1 OF 1</div>
        </div>
      </article>
      <div class="dos-cap"></div>
      <footer class="dos-foot">
        <div class="dos-strip"></div>
        <div class="dos-hints"><span><kbd>↑</kbd><kbd>↓</kbd> File</span><span><kbd>←</kbd><kbd>→</kbd> Photo</span><button class="dos-back"><kbd>Esc</kbd> Back</button></div>
      </footer>
`;
    parent.appendChild(this.root);
    this.shots = [...this.root.querySelectorAll<HTMLDivElement>('.dos-shot')];
    for (const b of [this.q('.dos-back'), this.q('.dos-x')]) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
      });
    }
    this.buildList();
    const noise = `url(${noiseTile()})`;
    this.q<HTMLDivElement>('.dos-grain').style.backgroundImage = noise;
    this.root.style.setProperty('--noise', noise); // paper fibres
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
    this.sound('bd.encounter', 0.3);
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    this.q('.dos-clock').textContent = `${p2(d.getHours())}:${p2(d.getMinutes())} LOCAL`;
    this.ready();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.classList.remove('in', 'ready');
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pointermove', this.onMove);
    this.clearTimers();
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
    list.insertAdjacentHTML('beforeend', `<div class="dos-index">FILE INDEX <span>${DOSSIER_ENTRIES.length} FILES</span></div>`);
    DOSSIER_ENTRIES.forEach((en, i) => {
      const row = document.createElement('button');
      row.className = 'dos-row';
      row.dataset.i = String(i);
      row.style.setProperty('--row-accent', en.accent);
      row.innerHTML = `<i class="dos-emblem">${emblem(en.id)}</i><span>${esc(en.name)}</span><em class="st-${en.stance}">${esc(en.status)}</em><small>${esc(en.role)}</small>`;
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

  private ready(): void {
    if (!this.open_ || this.root.classList.contains('ready')) return;
    this.root.classList.add('ready');
    this.select(this.index, true);
  }

  // ---------------------------------------------------------------- input

  private key(e: KeyboardEvent): void {
    const k = e.code;
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
    this.sfx.select();

    // List, counter.
    this.root.querySelectorAll<HTMLElement>('.dos-row').forEach((r) => r.classList.toggle('on', Number(r.dataset.i) === i));
    this.root.querySelector<HTMLElement>(`.dos-row[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    this.q('.dos-count').textContent = `FILE ${String(i + 1).padStart(2, '0')} / ${DOSSIER_ENTRIES.length}`;

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

  /** The file, typed up as an intelligence summary. */
  private fill(en: DossierEntry): void {
    this.q('.dos-fileno').textContent = `FILE No. ${en.file}`;
    this.q('.dos-date').textContent = en.date;
    const rows: [string, string][] = [
      ['SUBJECT', en.name.toUpperCase()],
      ['DESIGNATION', en.role],
      ['LOCATION', en.place],
      ['STATUS', en.status],
      ['ASSESSED THREAT', `${THREAT[en.threat]} (${en.threat}/5)`],
      ['SOURCE / CREDIBILITY', en.source],
      ...en.facts.map(([k, v]) => [k.toUpperCase(), v] as [string, string]),
    ];
    this.q('.dos-fields').innerHTML = rows.map(([k, v]) => `<tr><th>${esc(k)}:</th><td>${redact(v)}</td></tr>`).join('');
    const people = en.people.map(([n, d], k) => `<p class="dos-item">${'abcdefgh'[k]}. <b>${esc(n)}</b> — ${esc(d)}</p>`).join('');
    this.q('.dos-body').innerHTML =
      `<h4>1. SUMMARY</h4>${en.bio.map((p) => `<p>${redact(p)}</p>`).join('')}` +
      `<h4>2. KNOWN PERSONNEL</h4>${people}` +
      `<h4>3. ASSESSMENT</h4><p>${redact(en.notes)}</p>` +
      `<h4>4. EQUIPMENT</h4><p>${en.kit.map(esc).join('; ')}.</p>` +
      `<h4>5. INTERCEPT</h4><p class="dos-intercept">“${esc(en.quote)}”<br><small>— radio intercept, Site-9 band, ${esc(en.date)}</small></p>`;
    this.q<HTMLElement>('.dos-file').scrollTop = 0;

    const stamp = this.q('.dos-stamp');
    stamp.querySelector('span')!.textContent = en.stamp;
    stamp.className = `dos-stamp s-${en.stance}`;


    this.q('.dos-cap').innerHTML = `<b>${esc(en.name)}</b><span>${esc(en.place)} — ${esc(en.year)}</span>`;
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
    this.sfx.cut();
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
