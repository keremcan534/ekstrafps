export interface TeamRow {
  id: string;
  name: string;
  color: string;
}

const div = (cls: string, parent: HTMLElement) => {
  const d = document.createElement('div');
  d.className = cls;
  parent.appendChild(d);
  return d;
};

/**
 * Team race HUD: one chip per team (colour, name, score, members alive), the
 * next raid threshold, a small kill feed and the end-of-match screen.
 */
export class Scoreboard {
  private root: HTMLDivElement;
  private chips = new Map<string, { el: HTMLDivElement; score: HTMLSpanElement; alive: HTMLSpanElement; last: string }>();
  private note: HTMLDivElement;
  private feed: HTMLDivElement;
  private end: HTMLDivElement;
  private hold: HTMLDivElement;
  private holdFill: HTMLElement;
  private holdKey = '';
  private noteKey: string | null = null;

  constructor(parent: HTMLElement, private teams: TeamRow[]) {
    this.root = div('scoreboard', parent);
    for (const t of teams) {
      const el = div('sb-chip', this.root);
      el.style.borderColor = t.color;
      const name = document.createElement('b');
      name.textContent = t.name;
      name.style.color = t.color;
      const score = document.createElement('span');
      score.className = 'sb-score';
      const alive = document.createElement('span');
      alive.className = 'sb-alive';
      el.append(name, score, alive);
      this.chips.set(t.id, { el, score, alive, last: '' });
    }
    this.note = div('sb-note', parent);
    this.feed = div('killfeed', parent);
    this.end = div('match-end', parent);
    this.hold = div('revive-bar extract-bar', parent);
    // Built once; setHold only moves the fill.
    this.hold.textContent = 'EXTRACTING';
    this.holdFill = document.createElement('i');
    this.hold.appendChild(this.holdFill);
  }

  /** Extraction progress (0..1) or null to hide. */
  setHold(p: number | null): void {
    const key = p === null ? '' : p.toFixed(2);
    if (key === this.holdKey) return;
    this.holdKey = key;
    this.hold.classList.toggle('show', p !== null);
    if (p !== null) this.holdFill.style.transform = `scaleX(${key})`;
  }

  update(scores: Map<string, number>, alive: Map<string, number>, nextRaid: number | null, leader: string | null, clock = '', urgent = false): void {
    for (const t of this.teams) {
      const c = this.chips.get(t.id)!;
      const key = `${scores.get(t.id) ?? 0}|${alive.get(t.id) ?? 0}|${leader === t.id}`;
      if (key === c.last) continue;
      c.last = key;
      c.score.textContent = String(scores.get(t.id) ?? 0);
      const a = alive.get(t.id) ?? 0;
      c.alive.textContent = a > 0 ? '●'.repeat(Math.min(5, a)) : '✕';
      c.el.classList.toggle('lead', leader === t.id);
      c.el.classList.toggle('wiped', a === 0);
    }
    const n = [clock, nextRaid ? `RAID AT ${nextRaid}` : ''].filter(Boolean).join(' · ');
    const noteKey = `${n}|${urgent}`;
    if (noteKey === this.noteKey) return;
    this.noteKey = noteKey;
    if (this.note.textContent !== n) this.note.textContent = n;
    this.note.classList.toggle('urgent', urgent);
  }

  /** "Bravo · Volkov ✕ Charlie" style feed line. */
  feedLine(html: string): void {
    const line = div('kf-line', this.feed);
    line.innerHTML = html;
    setTimeout(() => line.remove(), 5000);
    while (this.feed.children.length > 5) this.feed.firstChild?.remove();
  }

  showEnd(winner: TeamRow, youWon: boolean, scores: Map<string, number>, tags?: Map<string, string>, sub = '', report = ''): void {
    this.setHold(null);
    const rows = [...this.teams]
      .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
      .map((t) => {
        const tag = tags?.get(t.id);
        return `<div class="me-row"><b style="color:${t.color}">${t.name}</b>${tag ? `<em class="${tag === 'EXTRACTED' ? 'ok' : 'bad'}">${tag}</em>` : ''}<span>${scores.get(t.id) ?? 0}</span></div>`;
      })
      .join('');
    this.end.innerHTML = `<div class="me-title ${youWon ? 'win' : 'lose'}">${youWon ? 'VICTORY' : `${winner.name.toUpperCase()} WINS`}</div>${sub ? `<div class="me-sub">${sub}</div>` : ''}${rows}${report}<button class="sv-restart">PLAY AGAIN</button>`;
    this.end.classList.add('show');
    this.end.querySelector('button')!.addEventListener('click', () => location.reload());
  }
}
