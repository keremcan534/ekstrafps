import './dossier.css';

/**
 * Character dossier (main menu → DOSSIER), laid out like an old war-game mission select:
 * the roster on the left with faction flags, a big grainy sepia portrait on the right,
 * name and posting in the corner, the factions as a timeline along the bottom.
 *
 * Portraits are photos: public/dossier/<id>.jpg (any size; framed and toned here).
 * Until one exists, a silhouette stands in.
 */

interface Faction {
  id: string;
  name: string;
  /** Flag: field colour, band colour. */
  flag: [string, string];
}

interface Entry {
  id: string;
  faction: string;
  name: string;
  /** Rank / role, then where they're posted (the caption's second line). */
  role: string;
  place: string;
  bio: string;
}

const FACTIONS: Faction[] = [
  { id: 'sable', name: 'SABLE', flag: ['#121212', '#d4231b'] },
  { id: 'vanta', name: 'Vanta', flag: ['#1d4f9c', '#e6f0ff'] },
  { id: 'bravo', name: 'Bravo', flag: ['#ffa040', '#2a1a0a'] },
  { id: 'charlie', name: 'Charlie', flag: ['#9dff4a', '#16240a'] },
  { id: 'delta', name: 'Delta', flag: ['#d06aff', '#1e0f26'] },
  { id: 'machines', name: 'Machines', flag: ['#2a2a2e', '#ff0a2a'] },
  { id: 'salvage', name: 'Salvagers', flag: ['#c8a070', '#3a2a14'] },
  { id: 'choir', name: 'The Choir', flag: ['#0a0506', '#a01020'] },
  { id: 'staff', name: 'Lab Staff', flag: ['#e8f0f8', '#5f86b8'] },
];

const ENTRIES: Entry[] = [
  { id: 'warden', faction: 'sable', name: 'The Warden', role: 'SABLE Commander', place: 'Site-9, Sector Zero', bio: 'Nobody has seen his face. He counts the dead out loud and never loses the count.' },
  { id: 'gravel', faction: 'sable', name: "Ilya 'Gravel' Marek", role: 'SABLE Breacher', place: 'Site-9 Container Yard', bio: 'First through the door, last to stop shooting.' },
  { id: 'hush', faction: 'sable', name: "Dana 'Hush' Kessler", role: 'SABLE Marksman', place: 'Site-9 Container Yard', bio: 'Suppressed rifle, night vision, no witnesses.' },
  { id: 'pike', faction: 'vanta', name: "Aaron 'Pike' Mercer", role: 'Vanta Contractor, Pointman', place: 'Site-9, Arrival Lobby', bio: 'Signed the contract for the money. Stayed for the people beside him.' },
  { id: 'anvil', faction: 'vanta', name: "Yusuf 'Anvil' Demir", role: 'Vanta Contractor, Rifleman', place: 'Site-9, Arrival Lobby', bio: 'Carries the heavy rifle and the squad when it counts.' },
  { id: 'glass', faction: 'vanta', name: "Lena 'Glass' Okafor", role: 'Vanta Contractor, Marksman', place: 'Site-9, Atrium', bio: 'Reads a room through a scope before anyone walks into it.' },
  { id: 'rossi', faction: 'bravo', name: 'Sgt. Viktor Rossi', role: 'Bravo Team Lead', place: 'Site-9, Hangar', bio: 'Disciplined, patient, and always two corners ahead of you.' },
  { id: 'quinn', faction: 'charlie', name: 'Mara Quinn', role: 'Charlie Pointwoman', place: 'Site-9, Barracks', bio: 'Charlie hits first and asks nothing. She leads the charge.' },
  { id: 'varga', faction: 'delta', name: 'Tomas Varga', role: 'Delta Breacher', place: 'Site-9, Power Plant', bio: 'A shotgun, a short temper, and a long memory.' },
  { id: 'walker', faction: 'machines', name: 'Assembly Unit K-7', role: 'Walker-class Robot', place: 'Site-9 Assembly Line', bio: 'Built to carry parts. Now it carries out its last order: clear the floor.' },
  { id: 'brute', faction: 'machines', name: 'Loader B-12', role: 'Brute-class Robot', place: 'Site-9 Assembly Line', bio: 'Shrugs off a magazine. Bring two.' },
  { id: 'rook', faction: 'salvage', name: "'Rook'", role: 'Salvager Boss', place: 'Site-9, Garden Court', bio: 'Whatever is left in the labs is his, and he means to collect.' },
  { id: 'fedor', faction: 'salvage', name: 'Old Fedor', role: 'Salvager, Sharpshooter', place: 'Site-9, Garden Court', bio: 'An old bolt-action and older habits.' },
  { id: 'cantor', faction: 'choir', name: 'The Cantor', role: 'Choir, Blade', place: 'Site-9, the dark', bio: 'Sings to the machines. Comes for you when the lights die.' },
  { id: 'wren', faction: 'choir', name: 'Sister Wren', role: 'Choir', place: 'Site-9, the dark', bio: 'Whispers in the vents. Keep your flashlight on her.' },
  { id: 'arslan', faction: 'staff', name: 'Dr. Elif Arslan', role: 'Robotics Lead', place: 'Site-9 Laboratories', bio: 'Wrote the code the machines run on. Hiding from what it became.' },
  { id: 'hale', faction: 'staff', name: 'Sam Hale', role: 'Lab Technician', place: 'Site-9 Laboratories', bio: 'Still has the keycards. Still hasn’t found the way out.' },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class Dossier {
  readonly root: HTMLDivElement;
  private index = 0;
  private open_ = false;
  private list: HTMLDivElement;
  private shots: HTMLDivElement;
  private layers: HTMLDivElement[] = [];
  private front = 0;
  private cap: HTMLDivElement;
  private counter: HTMLSpanElement;
  private thumbs: HTMLDivElement;
  private ruler: HTMLDivElement;
  private onKey = (e: KeyboardEvent) => this.key(e);

  constructor(parent: HTMLElement, private onClose: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'dossier';
    this.root.innerHTML = `
      <div class="dos-head"><span class="dos-title">Select Operative</span><span class="dos-count"></span></div>
      <div class="dos-shots"><div class="dos-shot"></div><div class="dos-shot"></div><div class="dos-vignette"></div><div class="dos-grain"></div></div>
      <div class="dos-list"></div>
      <div class="dos-cap"></div>
      <div class="dos-foot">
        <div class="dos-thumbs"></div>
        <div class="dos-ruler"></div>
        <div class="dos-hints"><span><kbd>↑</kbd><kbd>↓</kbd> Select</span><button class="dos-back"><kbd>Esc</kbd> Back</button></div>
      </div>`;
    parent.appendChild(this.root);
    this.list = this.root.querySelector('.dos-list')!;
    this.shots = this.root.querySelector('.dos-shots')!;
    this.layers = [...this.shots.querySelectorAll<HTMLDivElement>('.dos-shot')];
    this.cap = this.root.querySelector('.dos-cap')!;
    this.counter = this.root.querySelector('.dos-count')!;
    this.thumbs = this.root.querySelector('.dos-thumbs')!;
    this.ruler = this.root.querySelector('.dos-ruler')!;
    this.root.querySelector('.dos-back')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });
    ENTRIES.forEach((en, i) => {
      const f = FACTIONS.find((x) => x.id === en.faction)!;
      const row = document.createElement('button');
      row.className = 'dos-row';
      row.innerHTML = `<i class="dos-flag" style="--f0:${f.flag[0]};--f1:${f.flag[1]}"></i><span>${esc(en.name)}</span>`;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(i);
      });
      row.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.select(i);
      });
      this.list.appendChild(row);
    });
    FACTIONS.forEach((f) => {
      const t = document.createElement('button');
      t.className = 'dos-tick';
      t.textContent = f.name;
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(ENTRIES.findIndex((x) => x.faction === f.id));
      });
      this.ruler.appendChild(t);
    });
    // Film grain: one noise tile, shifted every frame by CSS.
    const grain = this.root.querySelector<HTMLDivElement>('.dos-grain')!;
    grain.style.backgroundImage = `url(${noiseTile()})`;
  }

  get open(): boolean {
    return this.open_;
  }

  show(): void {
    this.open_ = true;
    this.root.classList.add('in');
    window.addEventListener('keydown', this.onKey, true);
    this.select(this.index, true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.classList.remove('in');
    window.removeEventListener('keydown', this.onKey, true);
    this.onClose();
  }

  private key(e: KeyboardEvent): void {
    const k = e.code;
    if (k === 'ArrowDown' || k === 'KeyS') this.select((this.index + 1) % ENTRIES.length);
    else if (k === 'ArrowUp' || k === 'KeyW') this.select((this.index - 1 + ENTRIES.length) % ENTRIES.length);
    else if (k === 'Escape' || k === 'Backspace') this.close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private select(i: number, force = false): void {
    if (i < 0) return;
    if (i === this.index && !force) return;
    this.index = i;
    const en = ENTRIES[i];
    const f = FACTIONS.find((x) => x.id === en.faction)!;
    this.list.querySelectorAll('.dos-row').forEach((r, k) => r.classList.toggle('on', k === i));
    this.list.children[i]?.scrollIntoView({ block: 'nearest' });
    this.counter.textContent = `Dossier ${String(i + 1).padStart(2, '0')} / ${ENTRIES.length}`;
    // Portrait: crossfade to the new photo (silhouette until one exists).
    this.front = 1 - this.front;
    const next = this.layers[this.front];
    const prev = this.layers[1 - this.front];
    next.innerHTML = '';
    next.appendChild(portrait(en.id, 'dos-img'));
    next.classList.remove('on');
    void next.offsetWidth;
    next.classList.add('on');
    prev.classList.remove('on');
    this.cap.classList.remove('in');
    void this.cap.offsetWidth;
    this.cap.innerHTML = `<b>${esc(en.name)}</b><span>${esc(en.role)}</span><span>${esc(en.place)} — ${esc(f.name)}</span><em>${esc(en.bio)}</em>`;
    this.cap.classList.add('in');
    // The faction's people as small frames; the ruler marks the faction.
    this.thumbs.innerHTML = '';
    for (const [k, other] of ENTRIES.entries()) {
      if (other.faction !== en.faction) continue;
      const fr = document.createElement('button');
      fr.className = `dos-thumb${k === i ? ' on' : ''}`;
      fr.appendChild(portrait(other.id, 'dos-timg'));
      fr.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(k);
      });
      this.thumbs.appendChild(fr);
    }
    [...this.ruler.children].forEach((t, k) => t.classList.toggle('on', FACTIONS[k].id === en.faction));
  }
}

/** A photo, or the silhouette when the file isn't there yet. */
function portrait(id: string, cls: string): HTMLElement {
  const box = document.createElement('div');
  box.className = `${cls} dos-empty`;
  const img = new Image();
  img.alt = '';
  img.onload = () => {
    box.classList.remove('dos-empty');
    box.appendChild(img);
  };
  img.src = `dossier/${id}.jpg`;
  return box;
}

/** 128 px of monochrome noise as a data URL (the grain layer). */
function noiseTile(): string {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const d = g.createImageData(128, 128);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 38;
  }
  g.putImageData(d, 0, 0);
  return c.toDataURL();
}
