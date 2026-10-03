/**
 * Phone HUD layout: button size, opacity and where each control sits, as the
 * player set them (Settings → Controls → CUSTOMIZE HUD). Applied on top of the
 * stylesheet's layout with the individual `translate` / `scale` properties, so
 * the buttons' own transforms (pressed, the floating stick) still work.
 */
export interface HudLayoutData {
  /** All touch buttons (0.6-1.4). */
  size: number;
  /** Touch controls' opacity (0.3-1). */
  opacity: number;
  /** Per control: offset from its default spot (UI px) and its own size on top of `size`. */
  items: Record<string, { x: number; y: number; s: number }>;
}

/** [key, selector inside .ui-layer, name, takes the global button size]. The stick moves but keeps its size (its radius is an input size). */
const ITEMS: [string, string, string, boolean][] = [
  ['stick', '.joy-base', 'MOVE STICK', false],
  ['fire', '.btn-fire', 'FIRE', true],
  ['fireL', '.btn-fire-left', 'LEFT FIRE', true],
  ['ads', '.btn-ads', 'AIM', true],
  ['reload', '.btn-reload', 'RELOAD', true],
  ['jump', '.btn-jump', 'JUMP', true],
  ['crouch', '.btn-crouch', 'CROUCH', true],
  ['mode', '.btn-mode', 'FIRE MODE', true],
  ['weapon', '.weapon-card', 'WEAPON', true],
  ['leanL', '.btn-lean-l', 'LEAN LEFT', true],
  ['leanR', '.btn-lean-r', 'LEAN RIGHT', true],
  ['use', '.btn-use', 'USE / BUY', true],
  ['pause', '.btn-tune', 'PAUSE', true],
  ['map', '.btn-map', 'MAP', true],
  ['ammo', '.ammo', 'AMMO', false],
  ['minimap', '.minimap', 'MINIMAP', false],
];

const KEY = 'site9.hud';
const DEFAULTS: HudLayoutData = { size: 1, opacity: 1, items: {} };

export function loadHudLayout(): HudLayoutData {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<HudLayoutData>;
    return { size: d.size ?? 1, opacity: d.opacity ?? 1, items: d.items ?? {} };
  } catch {
    return { ...DEFAULTS, items: {} };
  }
}

export function saveHudLayout(d: HudLayoutData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* storage blocked: lasts for this session */
  }
}

const ui = (): HTMLElement | null => document.querySelector<HTMLElement>('.ui-layer');
const zoom = (): number => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;

/** Put the saved layout on the HUD (call again after a change). */
export function applyHudLayout(d: HudLayoutData): void {
  const root = ui();
  if (!root) return;
  document.documentElement.style.setProperty('--hud-alpha', String(d.opacity));
  for (const [key, sel, , sized] of ITEMS) {
    const it = d.items[key];
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      el.style.translate = it && (it.x || it.y) ? `${it.x.toFixed(1)}px ${it.y.toFixed(1)}px` : '';
      const s = (sized ? d.size : 1) * (it?.s ?? 1);
      el.style.scale = Math.abs(s - 1) > 0.005 ? s.toFixed(3) : '';
    }
  }
}

/**
 * The layout editor: the HUD over a dim screen, every control outlined. Drag a
 * control to move it, tap one to select it and size it; sliders for all buttons'
 * size and opacity; RESET puts back the stylesheet's layout. DONE saves.
 */
export function editHudLayout(onDone: () => void): void {
  const root = ui();
  if (!root) return onDone();
  const d = loadHudLayout();
  document.body.classList.add('hud-editing');
  const bar = document.createElement('div');
  bar.className = 'hud-edit-bar';
  document.body.appendChild(bar);

  let sel = 'fire';
  const els = (key: string): HTMLElement[] => {
    const sel = ITEMS.find((i) => i[0] === key)?.[1];
    return sel ? [...root.querySelectorAll<HTMLElement>(sel)].filter((e) => e.getClientRects().length > 0) : [];
  };
  const mark = () => {
    for (const [key] of ITEMS) for (const e of els(key)) {
      e.classList.add('hud-item');
      e.classList.toggle('hud-sel', key === sel);
    }
  };
  const item = (key: string) => (d.items[key] ??= { x: 0, y: 0, s: 1 });
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const draw = () => {
    const name = ITEMS.find((i) => i[0] === sel)?.[2] ?? '';
    const s = d.items[sel]?.s ?? 1;
    bar.innerHTML = `<div class="hud-edit-row"><b>CUSTOMIZE HUD</b><span>Drag a control to move it · tap to select</span></div>
      <div class="hud-edit-row"><em>${name}</em>${sel === 'stick' ? '<span>moves only</span>' : `<button data-a="minus">−</button><output>${pct(s)}</output><button data-a="plus">+</button>`}</div>
      <label class="hud-edit-row"><em>ALL BUTTONS</em><input type="range" data-a="size" min="0.6" max="1.4" step="0.05" value="${d.size}"><output>${pct(d.size)}</output></label>
      <label class="hud-edit-row"><em>OPACITY</em><input type="range" data-a="opacity" min="0.3" max="1" step="0.05" value="${d.opacity}"><output>${pct(d.opacity)}</output></label>
      <div class="hud-edit-row"><button data-a="reset">RESET</button><button data-a="done" class="primary">DONE</button></div>`;
  };
  const refresh = () => {
    applyHudLayout(d);
    mark();
    draw();
  };

  bar.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'minus' || a === 'plus') {
      const it = item(sel);
      it.s = Math.min(1.8, Math.max(0.5, Math.round((it.s + (a === 'plus' ? 0.1 : -0.1)) * 100) / 100));
      refresh();
    } else if (a === 'reset') {
      d.size = 1;
      d.opacity = 1;
      d.items = {};
      refresh();
    } else if (a === 'done') finish();
  });
  bar.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.a === 'size') d.size = Number(t.value);
    else if (t.dataset.a === 'opacity') d.opacity = Number(t.value);
    else return;
    t.nextElementSibling!.textContent = pct(Number(t.value));
    applyHudLayout(d);
  });

  // Drags: in the capture phase on the window, so no button underneath fires.
  let drag: { id: number; key: string; x0: number; y0: number; ix: number; iy: number; minX: number; maxX: number; minY: number; maxY: number; z: number } | null = null;
  const down = (e: PointerEvent) => {
    if (bar.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // The smallest control under the finger (the stick's ring is big).
    let best: { key: string; r: DOMRect } | null = null;
    for (const [key] of ITEMS) for (const el of els(key)) {
      const r = el.getBoundingClientRect();
      const pad = 6;
      if (e.clientX < r.left - pad || e.clientX > r.right + pad || e.clientY < r.top - pad || e.clientY > r.bottom + pad) continue;
      if (!best || r.width * r.height < best.r.width * best.r.height) best = { key, r };
    }
    if (!best) return;
    sel = best.key;
    const it = item(sel);
    const z = zoom();
    // Keep the control on the screen.
    const r = best.r;
    drag = { id: e.pointerId, key: sel, x0: e.clientX, y0: e.clientY, ix: it.x, iy: it.y, minX: -r.left, maxX: innerWidth - r.right, minY: -r.top, maxY: innerHeight - r.bottom, z };
    refresh();
  };
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const dx = Math.min(drag.maxX, Math.max(drag.minX, e.clientX - drag.x0));
    const dy = Math.min(drag.maxY, Math.max(drag.minY, e.clientY - drag.y0));
    const it = item(drag.key);
    it.x = drag.ix + dx / drag.z;
    it.y = drag.iy + dy / drag.z;
    applyHudLayout(d);
  };
  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopImmediatePropagation();
    drag = null;
  };
  const block = (e: Event) => {
    if (!bar.contains(e.target as Node)) e.stopImmediatePropagation();
  };
  const opts = { capture: true, passive: false };
  window.addEventListener('pointerdown', down, opts);
  window.addEventListener('pointermove', move, opts);
  window.addEventListener('pointerup', up, opts);
  window.addEventListener('pointercancel', up, opts);
  window.addEventListener('touchstart', block, opts);
  window.addEventListener('click', block, opts);

  function finish(): void {
    window.removeEventListener('pointerdown', down, opts);
    window.removeEventListener('pointermove', move, opts);
    window.removeEventListener('pointerup', up, opts);
    window.removeEventListener('pointercancel', up, opts);
    window.removeEventListener('touchstart', block, opts);
    window.removeEventListener('click', block, opts);
    // Drop untouched entries.
    for (const [k, v] of Object.entries(d.items)) if (!v.x && !v.y && v.s === 1) delete d.items[k];
    saveHudLayout(d);
    for (const e of root!.querySelectorAll('.hud-item')) e.classList.remove('hud-item', 'hud-sel');
    document.body.classList.remove('hud-editing');
    bar.remove();
    onDone();
  }

  refresh();
}
