import './dossier.css';
import { DOSSIER_ENTRIES, type DossierEntry } from './DossierData';
import { DossierSfx } from './DossierSfx';
import { CORP_LOGO, PAPERCLIP, emblem } from './DossierEmblems';
import { makeGrime, raggedEdge } from './DossierGrime';

/**
 * The threat archive (main menu → DOSSIER): one file per force on Site-9, laid out
 * like a case on a desk in the dark.
 *
 *   left    the file index (insignia, name, status)
 *   centre  the typed intelligence summary on paper, an evidence photo clipped to it
 *   right   the photograph itself, clipped and taped, a note pencilled on it
 *   bottom  every file as a contact print; select / back, file n / 7
 *
 * Only the photo moves: a slow drift, and a signal-glitch cut between a file's photos.
 * Photos: public/dossier/<id>.jpg (a silhouette until one exists).
 */

type Sound = (name: string, volume?: number) => void;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** Seconds each photo holds before the next cuts in. */
const PHOTO_HOLD = 6.5;
const THREAT = ['', 'MINIMAL', 'LOW', 'MODERATE', 'HIGH', 'EXTREME'];

/** [[!text]]: blacked out for good. [[text]]: an analyst's red-pencil underline. */
const redact = (s: string) =>
  esc(s).replace(/\[\[(.+?)\]\]/g, (_m, t: string) =>
    t.startsWith('!') ? `<span class="dos-redact">${'█'.repeat(t.length - 1)}</span>` : `<span class="dos-pencil">${t}</span>`);

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
const firstPhoto = async (en: DossierEntry) => {
  for (const id of en.photos) if (await hasPhoto(id)) return id;
  return null;
};

export class Dossier {
  readonly root: HTMLDivElement;
  private index = 0;
  private open_ = false;
  private q = <T extends Element = HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
  private shots: HTMLDivElement[] = [];
  private front = 0;
  private photoTimer = 0;
  /** The current file's photos that exist, and which one is up. */
  private photos: string[] = [];
  private photo = 0;
  private onKey = (e: KeyboardEvent) => this.key(e);
  private sfx = new DossierSfx();

  constructor(parent: HTMLElement, private onClose: () => void, private sound: Sound = () => {}) {
    this.root = document.createElement('div');
    this.root.className = 'dossier';
    this.root.innerHTML = `
      <div class="dos-desk"></div>
      <header class="dos-head">
        <div class="dos-brand">VANTA DYNAMICS // THREAT ARCHIVE</div>
        <div class="dos-title">Select File</div>
      </header>
      <div class="dos-meta"><b>SITE-9</b><span>THREAT ARCHIVE</span><span class="dos-count"></span></div>
      <button class="dos-x" aria-label="Back">✕</button>
      <nav class="dos-list"></nav>
      <article class="dos-file">
        <div class="dos-paper">
          <div class="dos-letterhead"><b>VANTA DYNAMICS</b><span>INTERNAL SECURITY DIVISION</span><span>INTELLIGENCE SUMMARY</span></div>
          <i class="dos-logo">${CORP_LOGO}</i>
          <div class="dos-stamp"><span></span></div>
          <div class="dos-evidence"><i class="dos-clip">${PAPERCLIP}</i><div class="dos-evimg"></div></div>
          <table class="dos-fields"></table>
          <div class="dos-body"></div>
          <div class="dos-dist">DISTRIBUTION: CLEARANCE IV ONLY — DO NOT COPY</div>
        </div>
      </article>
      <figure class="dos-print">
        <div class="dos-photo">
          <div class="dos-shot"></div><div class="dos-shot"></div>
          <div class="dos-tear"></div><div class="dos-grain"></div>
          <div class="dos-note"></div>
          <div class="dos-conf">CONFIDENTIAL</div>
        </div>
        <i class="dos-clip dos-clip-print">${PAPERCLIP}</i>
        <i class="dos-tape"></i>
      </figure>
      <div class="dos-strip"></div>
      <footer class="dos-foot">
        <div class="dos-keys"><span><kbd>⏎</kbd> SELECT</span><button class="dos-back"><kbd>Esc</kbd> BACK</button></div>
        <div class="dos-pager"><span class="dos-count"></span><button class="dos-prev" aria-label="Previous file">‹</button><button class="dos-next" aria-label="Next file">›</button></div>
      </footer>
      <div class="dos-dirt"></div>`;
    parent.appendChild(this.root);
    this.shots = [...this.root.querySelectorAll<HTMLDivElement>('.dos-shot')];
    for (const b of [this.q('.dos-back'), this.q('.dos-x')]) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
      });
    }
    this.q('.dos-prev').addEventListener('click', (e) => {
      e.stopPropagation();
      this.select((this.index - 1 + DOSSIER_ENTRIES.length) % DOSSIER_ENTRIES.length);
    });
    this.q('.dos-next').addEventListener('click', (e) => {
      e.stopPropagation();
      this.select((this.index + 1) % DOSSIER_ENTRIES.length);
    });
    // The photo: tap / click for the next one; swipe on phones.
    const photo = this.q('.dos-photo');
    photo.addEventListener('click', (e) => {
      e.stopPropagation();
      this.step(1);
    });
    let sx = 0;
    photo.addEventListener('touchstart', (e) => (sx = e.touches[0].clientX), { passive: true });
    photo.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 50) this.step(dx < 0 ? 1 : -1);
    });
    this.root.style.setProperty('--noise', `url(${noiseTile()})`);
    // Grime: stains, scratches and dust painted once; a ragged edge on the paper.
    const grime = makeGrime();
    this.root.style.setProperty('--grime-desk', `url(${grime.desk})`);
    this.root.style.setProperty('--grime-paper', `url(${grime.paper})`);
    this.root.style.setProperty('--grime-photo', `url(${grime.photo})`);
    this.root.style.setProperty('--grime-screen', `url(${grime.screen})`);
    this.q<HTMLElement>('.dos-paper').style.clipPath = raggedEdge(26, 3.5);
    this.buildList();
    this.buildStrip();
  }

  get open(): boolean {
    return this.open_;
  }

  show(): void {
    this.open_ = true;
    this.root.classList.add('in');
    window.addEventListener('keydown', this.onKey, true);
    this.sound('bd.encounter', 0.3);
    this.select(this.index, true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.classList.remove('in');
    window.removeEventListener('keydown', this.onKey, true);
    clearTimeout(this.photoTimer);
    this.onClose();
  }

  // ---------------------------------------------------------------- building

  private buildList(): void {
    const list = this.q('.dos-list');
    DOSSIER_ENTRIES.forEach((en, i) => {
      const row = document.createElement('button');
      row.className = 'dos-row';
      row.dataset.i = String(i);
      row.innerHTML = `<i class="dos-emblem">${emblem(en.id)}</i><span>${esc(en.name)}</span><em class="st-${en.stance}">${esc(en.status)}</em>`;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(i);
      });
      list.appendChild(row);
    });
  }

  /** Every file as a contact print along the bottom. */
  private buildStrip(): void {
    const strip = this.q('.dos-strip');
    DOSSIER_ENTRIES.forEach((en, i) => {
      const card = document.createElement('button');
      card.className = 'dos-card';
      card.dataset.i = String(i);
      card.innerHTML = `<div class="dos-cimg dos-empty"></div><span>${esc(en.name)}</span>`;
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(i);
      });
      strip.appendChild(card);
      void firstPhoto(en).then((id) => {
        if (!id) return;
        const box = card.querySelector('.dos-cimg')!;
        box.classList.remove('dos-empty');
        box.innerHTML = `<img alt="" src="dossier/${id}.jpg" decoding="async">`;
      });
    });
  }

  // ---------------------------------------------------------------- input

  private key(e: KeyboardEvent): void {
    const k = e.code;
    const n = DOSSIER_ENTRIES.length;
    if (k === 'ArrowDown' || k === 'KeyS' || k === 'ArrowRight' || k === 'KeyD') this.select((this.index + 1) % n);
    else if (k === 'ArrowUp' || k === 'KeyW' || k === 'ArrowLeft' || k === 'KeyA') this.select((this.index - 1 + n) % n);
    else if (k === 'Enter' || k === 'Space') this.step(1);
    else if (k === 'Escape' || k === 'Backspace') this.close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ---------------------------------------------------------------- a file

  private select(i: number, force = false): void {
    if (i < 0 || (i === this.index && !force)) return;
    this.index = i;
    clearTimeout(this.photoTimer);
    const en = DOSSIER_ENTRIES[i];
    this.root.style.setProperty('--accent', en.accent);
    if (!force) this.sfx.select();
    this.root.querySelectorAll<HTMLElement>('.dos-row').forEach((r) => r.classList.toggle('on', Number(r.dataset.i) === i));
    this.root.querySelectorAll<HTMLElement>('.dos-card').forEach((c) => c.classList.toggle('on', Number(c.dataset.i) === i));
    this.root.querySelector<HTMLElement>(`.dos-card[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.root.querySelector<HTMLElement>(`.dos-row[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    const count = `FILE ${String(i + 1).padStart(2, '0')} / ${String(DOSSIER_ENTRIES.length).padStart(2, '0')}`;
    this.root.querySelectorAll('.dos-count').forEach((c) => (c.textContent = count));
    this.fill(en);

    // Photos: the ones that exist; the first cuts in now, the rest take turns.
    this.photos = [];
    this.photo = 0;
    this.cut(null);
    this.evidence(null);
    const want = i;
    void Promise.all(en.photos.map(hasPhoto)).then((ok) => {
      if (this.index !== want || !this.open_) return;
      this.photos = en.photos.filter((_, k) => ok[k]);
      this.cut(this.photos[0] ?? null);
      this.evidence(this.photos[1] ?? this.photos[0] ?? null);
    });
  }

  /** The file, typed up as an intelligence summary. */
  private fill(en: DossierEntry): void {
    const rows: [string, string][] = [
      ['FILE NO.', en.file],
      ['DATE', en.date],
      ['SUBJECT', en.name.toUpperCase()],
      ['DESIGNATION', en.role],
      ['LOCATION', en.place],
      ['STATUS', en.status],
      ['THREAT', `${THREAT[en.threat]} (${en.threat}/5)`],
      ['SOURCE', en.source],
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
    this.q<HTMLElement>('.dos-paper').scrollTop = 0;
    const stamp = this.q('.dos-stamp');
    stamp.querySelector('span')!.textContent = en.stamp;
    stamp.className = `dos-stamp s-${en.stance}`;
    // The pencilled note on the photo: where, and when.
    const [place, sub] = en.place.split(/,\s*/);
    this.q('.dos-note').innerHTML = [place, sub, en.year].filter(Boolean).map(esc).join('<br>');
  }

  /** The small evidence photo clipped to the paper. */
  private evidence(id: string | null): void {
    const box = this.q('.dos-evimg');
    box.innerHTML = id ? `<img alt="" src="dossier/${id}.jpg" decoding="async">` : '';
    box.classList.toggle('dos-empty', !id);
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
    next.appendChild(id ? portrait(id) : silhouette());
    prev.classList.remove('on');
    next.classList.remove('on');
    void next.offsetWidth;
    next.classList.add('on');
    if (id) {
      const ph = this.q('.dos-photo');
      ph.classList.remove('glitch');
      void ph.offsetWidth;
      ph.classList.add('glitch');
      if (this.photos.length > 1) this.sfx.cut();
    }
    if (this.photos.length > 1) this.photoTimer = window.setTimeout(() => this.step(1), PHOTO_HOLD * 1000);
  }
}

/** A photo (with two ghost copies for the glitch's colour split). */
function portrait(id: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'dos-img dos-empty';
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.onload = () => {
    box.classList.remove('dos-empty');
    box.appendChild(img);
    for (const g of ['dos-ghost-r', 'dos-ghost-c']) {
      const c = img.cloneNode() as HTMLImageElement;
      c.className = g;
      box.appendChild(c);
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

/** 160 px of monochrome noise as a data URL (grain, paper fibres). */
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
