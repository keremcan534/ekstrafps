/**
 * Phone HUD layout: where each control sits, its size, opacity, whether it shows
 * and how far its invisible touch area reaches past what you see. Three presets
 * (two thumbs, three fingers, four-finger claw) plus the player's own changes from
 * the editor (Settings → Controls → CUSTOMIZE HUD), saved per device.
 *
 * Positions are a control's centre in HUD pixels (the phone HUD is laid out 640 px
 * tall and zoomed to the screen): an anchor (0 / 0.5 / 1 of the width and height)
 * plus an offset from it, so a cluster keeps its shape on any screen.
 */
export interface HudItem {
  /** Anchor as a share of the HUD's width / height (0, 0.5, 1). */
  ax?: number;
  ay?: number;
  /** Centre offset from the anchor (HUD px). */
  x?: number;
  y?: number;
  /** Size (× the button size slider for buttons). */
  s?: number;
  /** Opacity (× the opacity slider). */
  o?: number;
  hide?: boolean;
  /** Invisible touch area past the visible button (HUD px). */
  pad?: number;
}

export type HudPreset = 'standard' | 'tactical' | 'claw';

export interface HudLayoutData {
  v: 2;
  preset: HudPreset;
  /** All buttons (0.6-1.4). */
  size: number;
  /** All touch controls (0.3-1). */
  opacity: number;
  /** The player's changes on top of the preset. */
  items: Record<string, HudItem>;
  /** A held fire button drifts with the thumb (COD Mobile style). */
  floatFire: boolean;
}

interface Control {
  key: string;
  sel: string;
  name: string;
  /** The button size slider applies. */
  button: boolean;
  /** Can be switched off (the stick, FIRE and pause can't). */
  hideable: boolean;
  /** Default touch padding (HUD px). */
  pad: number;
}

const C = (key: string, sel: string, name: string, button = true, hideable = true, pad = 12): Control => ({ key, sel, name, button, hideable, pad });

/** Everything the editor can move. Selectors are inside .ui-layer. */
const CONTROLS: Control[] = [
  C('stick', '.joy-base', 'MOVE STICK', false, false, 0),
  C('fire', '.btn-fire', 'FIRE', true, false, 22),
  C('fireL', '.btn-fire-left', 'LEFT FIRE', true, true, 18),
  C('ads', '.btn-ads', 'AIM (ADS)', true, true, 14),
  C('reload', '.btn-reload', 'RELOAD'),
  C('jump', '.btn-jump', 'JUMP'),
  C('crouch', '.btn-crouch', 'CROUCH'),
  C('leanL', '.btn-lean-l', 'LEAN LEFT', true, true, 8),
  C('leanR', '.btn-lean-r', 'LEAN RIGHT', true, true, 8),
  C('weapon', '.touch-root .ammo', 'WEAPON / AMMO', false, false, 6),
  C('use', '.btn-use', 'USE / BUY', true, true, 10),
  C('pause', '.btn-tune', 'PAUSE', true, false, 8),
  C('map', '.btn-map', 'MAP BUTTON', true, true, 8),
  C('flash', '.flash-btn', 'FLASHLIGHT', true, true, 8),
  C('squad', '.squad-btn', 'SQUAD ORDERS', true, true, 8),
  C('build', '.build-btn', 'BUILD', true, true, 8),
  C('minimap', '.minimap', 'MINIMAP', false, true, 0),
  C('team', '.squad-panel', 'SQUAD LIST', false, true, 0),
  C('hp', '.hp', 'HEALTH', false, false, 0),
];

/** Bottom-right cluster shared by the presets (HUD px from the bottom-right corner). */
const BR = (x: number, y: number): HudItem => ({ ax: 1, ay: 1, x, y });

const STANDARD: Record<string, HudItem> = {
  stick: { ax: 0, ay: 1, x: 200, y: -175 },
  fire: BR(-170, -185),
  reload: BR(-92, -300),
  ads: BR(-300, -255),
  leanL: BR(-372, -330),
  leanR: BR(-308, -350),
  jump: BR(-66, -150),
  crouch: BR(-150, -62),
  use: BR(-330, -130),
  weapon: { ax: 0.5, ay: 1, x: 0, y: -30 },
  fireL: { ax: 0, ay: 0.5, x: 92, y: 10, hide: true },
  map: { ax: 0, ay: 0, x: 60, y: 30, hide: true },
  pause: { ax: 1, ay: 0, x: -180, y: 34 },
  flash: { ax: 1, ay: 0, x: -180, y: 122 },
  squad: { ax: 1, ay: 0, x: -180, y: 174 },
  build: { ax: 1, ay: 0, x: -180, y: 226 },
};

export const HUD_PRESETS: Record<HudPreset, { name: string; text: string; items: Record<string, HudItem> }> = {
  standard: { name: 'STANDARD', text: '2 thumbs: move left, aim and fire right', items: STANDARD },
  tactical: {
    name: 'TACTICAL',
    text: '3 fingers: left index fires, right thumb aims',
    items: { ...STANDARD, fireL: { ax: 0, ay: 0.5, x: 96, y: -10 } },
  },
  claw: {
    name: 'PRO CLAW',
    text: '4 fingers: index fingers fire, aim, jump and crouch up top',
    items: {
      ...STANDARD,
      fireL: { ax: 0, ay: 0.5, x: 96, y: -10 },
      ads: { ax: 1, ay: 0, x: -200, y: 305 },
      jump: { ax: 1, ay: 0, x: -80, y: 290 },
      crouch: { ax: 1, ay: 0, x: -62, y: 380 },
      leanL: { ax: 1, ay: 0, x: -300, y: 275 },
      leanR: { ax: 1, ay: 0, x: -300, y: 338 },
      reload: BR(-300, -175),
      use: BR(-330, -80),
    },
  },
};

const KEY = 'site9.hud';

export function loadHudLayout(): HudLayoutData {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<HudLayoutData>;
    const preset = d.preset && d.preset in HUD_PRESETS ? d.preset : 'standard';
    // Version 1 kept offsets from the old stylesheet layout: those don't carry over.
    return { v: 2, preset, size: d.size ?? 1, opacity: d.opacity ?? 1, items: d.v === 2 ? (d.items ?? {}) : {}, floatFire: d.floatFire ?? true };
  } catch {
    return { v: 2, preset: 'standard', size: 1, opacity: 1, items: {}, floatFire: true };
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
const itemOf = (d: HudLayoutData, key: string): HudItem => ({ ...HUD_PRESETS[d.preset].items[key], ...d.items[key] });

/** Put the layout on the HUD (again after a change or a resize). */
export function applyHudLayout(d: HudLayoutData): void {
  const root = ui();
  if (!root) return;
  const z = zoom();
  const W = innerWidth / z;
  const H = innerHeight / z;
  document.documentElement.style.setProperty('--hud-alpha', String(d.opacity));
  document.documentElement.dataset.floatFire = d.floatFire ? '1' : '0';
  for (const c of CONTROLS) {
    const it = itemOf(d, c.key);
    const placed = it.ax !== undefined && it.ay !== undefined && it.x !== undefined && it.y !== undefined;
    const cx = placed ? it.ax! * W + it.x! : 0;
    const cy = placed ? it.ay! * H + it.y! : 0;
    for (const el of root.querySelectorAll<HTMLElement>(c.sel)) {
      const st = el.style;
      if (c.key === 'stick') {
        // The stick floats under the thumb; this is where it rests.
        st.setProperty('--jx', placed ? `${cx.toFixed(1)}px` : '');
        st.setProperty('--jy', placed ? `${cy.toFixed(1)}px` : '');
      } else if (placed) {
        st.left = `${cx.toFixed(1)}px`;
        st.top = `${cy.toFixed(1)}px`;
        st.right = st.bottom = 'auto';
        st.margin = '0';
        st.translate = '-50% -50%';
      } else {
        st.left = st.top = st.right = st.bottom = st.margin = st.translate = '';
      }
      const s = (c.button ? d.size : 1) * (it.s ?? 1);
      st.scale = Math.abs(s - 1) > 0.005 ? s.toFixed(3) : '';
      st.setProperty('--o', String(it.o ?? 1));
      st.setProperty('--pad', `${it.pad ?? c.pad}px`);
      el.classList.toggle('hud-off', !!it.hide && c.hideable);
    }
  }
}

/**
 * The editor: the HUD over a dim screen, every control outlined with its touch area.
 * Drag to move, tap to select; the bar sizes / fades / hides / pads the selected
 * control, switches presets and sets size and opacity for everything. DONE saves.
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
  const els = (c: Control): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(c.sel)].filter((e) => e.getClientRects().length > 0);
  const control = (key: string) => CONTROLS.find((c) => c.key === key)!;
  const mark = () => {
    for (const c of CONTROLS) for (const e of els(c)) {
      e.classList.add('hud-item');
      e.classList.toggle('hud-sel', c.key === sel);
    }
  };
  const own = (key: string) => (d.items[key] ??= {});
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const range = (a: string, min: number, max: number, step: number, v: number, label: string) =>
    `<label><em>${label}</em><input type="range" data-a="${a}" min="${min}" max="${max}" step="${step}" value="${v}"><output>${a === 'pad' ? `${Math.round(v)}` : pct(v)}</output></label>`;

  const draw = () => {
    const c = control(sel);
    const it = itemOf(d, sel);
    const presets = (Object.keys(HUD_PRESETS) as HudPreset[])
      .map((p) => `<button data-a="preset" data-p="${p}" class="${d.preset === p ? 'on' : ''}">${HUD_PRESETS[p].name}</button>`)
      .join('');
    bar.innerHTML = `<div class="hud-edit-row"><b>HUD</b>${presets}<button data-a="flip" title="Move this bar">⇵</button><button data-a="reset">RESET</button><button data-a="done" class="primary">DONE</button></div>
      <div class="hud-edit-row"><em class="hud-edit-name">${c.name}</em>
        <button data-a="minus">−</button><output>${pct(it.s ?? 1)}</output><button data-a="plus">+</button>
        ${c.hideable ? `<button data-a="hide" class="${it.hide ? '' : 'on'}">${it.hide ? 'HIDDEN' : 'SHOWN'}</button>` : ''}</div>
      <div class="hud-edit-row">${range('o', 0.2, 1, 0.05, it.o ?? 1, 'OPACITY')}${c.pad || c.button ? range('pad', 0, 40, 2, it.pad ?? c.pad, 'TOUCH AREA') : ''}</div>
      <div class="hud-edit-row">${range('size', 0.6, 1.4, 0.05, d.size, 'ALL BUTTONS')}${range('opacity', 0.3, 1, 0.05, d.opacity, 'ALL OPACITY')}</div>`;
  };
  const refresh = () => {
    applyHudLayout(d);
    mark();
    draw();
  };

  bar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    const a = b?.dataset.a;
    if (a === 'minus' || a === 'plus') {
      const it = own(sel);
      const s = itemOf(d, sel).s ?? 1;
      it.s = Math.min(1.8, Math.max(0.5, Math.round((s + (a === 'plus' ? 0.1 : -0.1)) * 100) / 100));
    } else if (a === 'hide') {
      own(sel).hide = !itemOf(d, sel).hide;
    } else if (a === 'preset') {
      d.preset = b!.dataset.p as HudPreset;
      d.items = {};
    } else if (a === 'reset') {
      d.preset = 'standard';
      d.size = d.opacity = 1;
      d.items = {};
    } else if (a === 'flip') {
      bar.classList.toggle('bottom');
      return;
    } else if (a === 'done') return finish();
    else return;
    refresh();
  });
  bar.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const v = Number(t.value);
    const a = t.dataset.a;
    if (a === 'size') d.size = v;
    else if (a === 'opacity') d.opacity = v;
    else if (a === 'o') own(sel).o = v;
    else if (a === 'pad') own(sel).pad = v;
    else return;
    t.nextElementSibling!.textContent = a === 'pad' ? `${Math.round(v)}` : pct(v);
    applyHudLayout(d);
  });

  // Drags: in the capture phase on the window, so no control underneath reacts.
  let drag: { id: number; key: string; x0: number; y0: number; cx: number; cy: number; hw: number; hh: number; z: number } | null = null;
  const down = (e: PointerEvent) => {
    if (bar.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // The smallest control under the finger (the stick's ring is big).
    let best: { key: string; r: DOMRect } | null = null;
    for (const c of CONTROLS) for (const el of els(c)) {
      const r = el.getBoundingClientRect();
      const pad = 6;
      if (e.clientX < r.left - pad || e.clientX > r.right + pad || e.clientY < r.top - pad || e.clientY > r.bottom + pad) continue;
      if (!best || r.width * r.height < best.r.width * best.r.height) best = { key: c.key, r };
    }
    if (!best) return;
    sel = best.key;
    const z = zoom();
    const r = best.r;
    drag = { id: e.pointerId, key: sel, x0: e.clientX, y0: e.clientY, cx: (r.left + r.width / 2) / z, cy: (r.top + r.height / 2) / z, hw: r.width / 2 / z, hh: r.height / 2 / z, z };
    refresh();
  };
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const W = innerWidth / drag.z;
    const H = innerHeight / drag.z;
    // New centre, kept on the screen; anchored to the nearest third so it holds its place on other screens.
    const cx = Math.min(W - drag.hw, Math.max(drag.hw, drag.cx + (e.clientX - drag.x0) / drag.z));
    const cy = Math.min(H - drag.hh, Math.max(drag.hh, drag.cy + (e.clientY - drag.y0) / drag.z));
    const ax = cx < W / 3 ? 0 : cx > (2 * W) / 3 ? 1 : 0.5;
    const ay = cy < H / 3 ? 0 : cy > (2 * H) / 3 ? 1 : 0.5;
    Object.assign(own(drag.key), { ax, ay, x: Math.round(cx - ax * W), y: Math.round(cy - ay * H) });
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
    for (const [k, v] of Object.entries(d.items)) if (!Object.keys(v).length) delete d.items[k];
    saveHudLayout(d);
    for (const e of root!.querySelectorAll('.hud-item')) e.classList.remove('hud-item', 'hud-sel');
    document.body.classList.remove('hud-editing');
    bar.remove();
    onDone();
  }

  refresh();
}
