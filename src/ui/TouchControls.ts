import type { Input } from '../core/Input';
import { playerConfig } from '../player/PlayerConfig';

export interface TouchActions {
  /** Pause (the settings menu). */
  onPause(): void;
  /** Developer tuning panel (?dev drawer). */
  onTune(): void;
  onDebug(): void;
  /** Toggle debug aim rays; returns the new state. */
  onRays(): boolean;
  /** Toggle the test laser; returns the new state. */
  onLaser(): boolean;
  onFireMode(): void;
  onUse?(): void;
  onMap?(): void;
}

const DEADZONE = 0.1;
const JOY_RADIUS = 64;
/** How far a held fire button drifts with the thumb (HUD px). */
const FLOAT = 36;

/** Compact tactical icons (stroke = currentColor). */
const svg = (body: string, size = 24): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  fire: svg('<path d="M9 21h6M10 21V9l2-5 2 5v12M10 13h4"/>', 30),
  ads: svg('<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  reload: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>'),
  jump: svg('<path d="M6 15l6-6 6 6"/><path d="M6 20l6-6 6 6" opacity=".45"/>'),
  crouch: svg('<path d="M6 9l6 6 6-6"/><path d="M5 20h14"/>'),
  leanL: svg('<path d="M14 6l-6 6 6 6"/><path d="M19 4v16" opacity=".45"/>', 20),
  leanR: svg('<path d="M10 6l6 6-6 6"/><path d="M5 4v16" opacity=".45"/>', 20),
  pause: svg('<path d="M9 6v12M15 6v12"/>', 18),
};

/**
 * Mobile controls, built on the ergonomics of the big mobile shooters (a clear
 * right side for aiming, the thumbs' arcs for the buttons), in our own look:
 *
 *  - Left half: floating move stick. Its resting "ghost" stays visible; touching
 *    anywhere on the left re-centres it under the thumb. Push up past the ring
 *    onto the lock icon to lock sprint (keeps running after you let go; touch the
 *    stick again to stop).
 *  - Right half: drag to look, with acceleration (slow drags = fine aim, fast
 *    flicks = big turns).
 *  - FIRE: press fires, hold keeps firing, drag while holding aims; the finger is
 *    captured, so leaving the button never stops the burst. ADS toggles and aims
 *    the same way. A left FIRE for claw grips (off in the two-thumb preset).
 *  - RELOAD, JUMP, CROUCH, small LEAN icons; the weapon strip swaps weapons, its
 *    mode chip changes fire mode. USE appears only next to something usable.
 *  - Tap the minimap for the full map. ?dev: debug tools in a DEV drawer.
 *
 * Where each control sits, its size, opacity and touch area: src/ui/HudLayout.ts.
 */

/** The HUD's zoom on phones (--ui-zoom, see main.ts): pointer coordinates are in screen pixels. */
const uiZoom = (): number => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;

export class TouchControls {
  readonly root: HTMLDivElement;
  private joyBase: HTMLDivElement;
  private joyKnob: HTMLDivElement;
  private joyLock: HTMLDivElement;
  private joyId = -1;
  private joyOrigin = { x: 0, y: 0 };
  /** --ui-zoom, read once per stick touch (reading it per move forces a style recalc). */
  private joyZoom = 1;
  /** Stick visuals from the last move, applied once per rendered frame in sync(). */
  private joyView = { dx: 0, dy: 0, overLock: false, sprint: false, dirty: false };
  private sprintLocked = false;
  private lookIds = new Map<number, { x: number; y: number; t: number }>();
  private adsBtn!: HTMLDivElement;
  private crouchBtn!: HTMLDivElement;
  private useBtn: HTMLDivElement | null = null;
  private weaponCard: HTMLDivElement;
  private slotBtns: HTMLDivElement[] = [];
  private ownedKey = '';
  private lastUse = '';

  constructor(parent: HTMLElement, private input: Input, weaponNames: string[], actions: TouchActions, survival = false) {
    this.root = el(`touch-root${survival ? ' survival' : ''}`, parent);
    const zone = el('touch-zone', this.root);
    zone.addEventListener('pointerdown', this.onZoneDown);
    zone.addEventListener('pointermove', this.onZoneMove);
    zone.addEventListener('pointerup', this.onZoneUp);
    zone.addEventListener('pointercancel', this.onZoneUp);

    this.joyBase = el('joy-base idle', this.root);
    this.joyKnob = el('joy-knob', this.joyBase);
    this.joyLock = el('joy-lock', this.joyBase);
    this.joyLock.textContent = '⇧';
    this.resetJoy();

    // FIRE: press fires, hold keeps firing, drag while holding aims (the button stays put;
    // the finger is captured, so sliding off it never stops the burst). A left FIRE for
    // claw grips (hidden in the two-thumb preset).
    this.fireButton('btn btn-fire', ICON.fire);
    this.fireButton('btn btn-fire-left', ICON.fire);

    // ADS: tap toggles; drag on it aims too.
    this.adsBtn = this.lookButton('btn btn-ads', ICON.ads, () => {
      input.adsHeld = !input.adsHeld;
      this.adsBtn.classList.toggle('on', input.adsHeld);
    });
    this.button('btn btn-jump', ICON.jump, () => (input.jumpPressed = true));
    this.crouchBtn = this.button('btn btn-crouch', ICON.crouch, () => {
      input.touchCrouch = !input.touchCrouch;
      this.crouchBtn.classList.toggle('on', input.touchCrouch);
    });
    this.button('btn btn-reload', ICON.reload, () => (input.reloadPressed = true));
    this.holdButton('btn btn-lean-l', ICON.leanL, (down) => (input.touchLean = down ? -1 : 0));
    this.holdButton('btn btn-lean-r', ICON.leanR, (down) => (input.touchLean = down ? 1 : 0));

    // Weapon + ammo: the HUD's ammo readout, moved in here and made touchable.
    // Tap the fire-mode chip to change it, anywhere else to swap weapons.
    this.weaponCard = parent.querySelector<HTMLDivElement>('.ammo') ?? el('ammo', this.root);
    this.root.appendChild(this.weaponCard);
    this.weaponCard.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if ((e.target as HTMLElement).closest('.ammo-mode')) actions.onFireMode();
      else input.cyclePressed = 1;
      this.weaponCard.classList.add('pressed');
      setTimeout(() => this.weaponCard.classList.remove('pressed'), 120);
    });

    if (actions.onUse) {
      this.useBtn = this.button('btn btn-use', 'USE', actions.onUse);
      this.useBtn.style.display = 'none';
    }
    // Map: the minimap opens it (this button is off in every preset; the editor can show it).
    if (actions.onMap) this.button('btn btn-small btn-map', 'MAP', actions.onMap);
    this.button('btn btn-small btn-tune', ICON.pause, actions.onPause);

    // ?dev: the debug tools live in a drawer, out of the normal HUD.
    if (new URLSearchParams(location.search).has('dev')) {
      const drawer = el('dev-drawer', this.root);
      this.button('btn btn-small btn-dev', 'DEV', () => drawer.classList.toggle('open'));
      this.button('btn btn-small', 'TUNE', actions.onTune, drawer);
      this.button('btn btn-small', 'DBG', actions.onDebug, drawer);
      const rays = this.button('btn btn-small', 'RAY', () => rays.classList.toggle('on', actions.onRays()), drawer);
      const laser = this.button('btn btn-small', 'LSR', () => laser.classList.toggle('on', actions.onLaser()), drawer);
      if (!survival) {
        const slots = el('slots', drawer);
        weaponNames.forEach((name, i) => {
          this.slotBtns.push(this.button('btn btn-slot', name, () => (input.slotPressed = i), slots));
        });
      }
    }
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  /** Keep ADS / weapon card / slots in sync with gameplay (e.g. ADS dropped on reload). */
  sync(adsActive: boolean, slot: number, owned: number[] | null = null): void {
    this.flushJoy();
    this.adsBtn.classList.toggle('on', adsActive);
    const key = `${owned ? owned.join(',') : 'all'}|${slot}`;
    if (key !== this.ownedKey) {
      this.ownedKey = key;
      // A swap mark on the readout when tapping it changes weapons.
      this.weaponCard.classList.toggle('can-swap', !owned || owned.length > 1);
    }
    this.slotBtns.forEach((b, i) => b.classList.toggle('on', i === slot));
  }

  /** Contextual USE button: shows what tapping it does (null hides it). */
  setUse(label: string | null, cost = 0, affordable = true): void {
    if (!this.useBtn) return;
    const key = label ? `${label}|${cost}|${affordable}` : '';
    if (key === this.lastUse) return;
    this.lastUse = key;
    if (!label) {
      this.useBtn.style.display = 'none';
      return;
    }
    this.useBtn.style.display = '';
    this.useBtn.innerHTML = `<span>${label}</span><b class="${affordable ? '' : 'no'}">$ ${cost}</b>`;
  }

  /**
   * Pointer moves arrive at up to 240 Hz (more than the frame rate): the stick only
   * writes the DOM here, once per rendered frame, so skipped frames commit nothing.
   */
  private flushJoy(): void {
    const v = this.joyView;
    if (!v.dirty) return;
    v.dirty = false;
    this.joyBase.classList.toggle('lock-hover', v.overLock);
    this.joyBase.classList.toggle('sprint', v.sprint);
    this.joyKnob.style.transform = `translate(calc(-50% + ${v.dx}px), calc(-50% + ${v.dy}px))`;
  }

  private resetJoy(): void {
    this.joyBase.classList.add('idle');
    this.joyBase.style.transform = '';
    this.joyKnob.style.transform = 'translate(-50%, -50%)';
  }

  private button(cls: string, label: string, onPress: () => void, parent: HTMLElement = this.root): HTMLDivElement {
    const b = el(cls, parent);
    b.innerHTML = label;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.classList.add('pressed');
      onPress();
    });
    const up = () => b.classList.remove('pressed');
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
    return b;
  }

  /** Tap action + look pad while held (ADS): a drag on it aims like the right side of the screen. */
  private lookButton(cls: string, icon: string, onPress: () => void): HTMLDivElement {
    const b = el(cls, this.root);
    b.innerHTML = icon;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(b, e.pointerId);
      b.classList.add('pressed');
      onPress();
      this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    });
    b.addEventListener('pointermove', (e) => this.look(e));
    const up = (e: PointerEvent) => {
      b.classList.remove('pressed');
      this.lookIds.delete(e.pointerId);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    return b;
  }

  /** Button that reports press and release (lean). */
  private holdButton(cls: string, label: string, onChange: (down: boolean) => void): void {
    const b = el(cls, this.root);
    b.innerHTML = label;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(b, e.pointerId);
      b.classList.add('pressed');
      onChange(true);
    });
    const up = () => {
      b.classList.remove('pressed');
      onChange(false);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  private fireButton(cls: string, icon: string): void {
    const b = el(cls, this.root);
    b.innerHTML = icon;
    // Floating fire (Settings → Controls, on by default): while held, the button drifts
    // with the thumb (up to FLOAT px) so it stays under it as you drag to aim.
    let fx = 0;
    let fy = 0;
    let zoom = 1;
    let float = false;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(b, e.pointerId);
      b.classList.add('pressed');
      this.input.pressFire(true);
      this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      fx = e.clientX;
      fy = e.clientY;
      zoom = uiZoom();
      float = document.documentElement.dataset.floatFire !== '0';
    });
    b.addEventListener('pointermove', (e) => {
      this.look(e);
      if (!float || !this.lookIds.has(e.pointerId)) return;
      let dx = (e.clientX - fx) / zoom;
      let dy = (e.clientY - fy) / zoom;
      const len = Math.hypot(dx, dy);
      if (len > FLOAT) {
        dx *= FLOAT / len;
        dy *= FLOAT / len;
      }
      b.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(0.94)`;
    });
    const up = (e: PointerEvent) => {
      b.classList.remove('pressed');
      b.style.transform = '';
      this.lookIds.delete(e.pointerId);
      // Only release fire if no other fire button is held.
      if (![...this.root.querySelectorAll('.btn-fire.pressed, .btn-fire-left.pressed')].length) this.input.pressFire(false);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  private onZoneDown = (e: PointerEvent): void => {
    e.preventDefault();
    capture(e.target as HTMLElement, e.pointerId);
    if (e.clientX < window.innerWidth * 0.45 && this.joyId === -1) {
      this.joyId = e.pointerId;
      // Touching the stick again cancels a sprint lock.
      if (this.sprintLocked) {
        this.sprintLocked = false;
        this.input.touchSprint = false;
        this.joyBase.classList.remove('locked');
      }
      this.joyOrigin = { x: e.clientX, y: e.clientY };
      this.joyBase.classList.remove('idle');
      const z = (this.joyZoom = uiZoom());
      this.joyBase.style.transform = `translate(${e.clientX / z}px, ${e.clientY / z}px)`;
      this.joyKnob.style.transform = 'translate(-50%, -50%)';
      this.joyView.dirty = false;
    } else {
      this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    }
  };

  private onZoneMove = (e: PointerEvent): void => {
    if (e.pointerId === this.joyId) {
      // In UI pixels (the HUD is zoomed on phones; the stick's radius is a UI size).
      const z = this.joyZoom;
      let dx = (e.clientX - this.joyOrigin.x) / z;
      let dy = (e.clientY - this.joyOrigin.y) / z;
      const len = Math.hypot(dx, dy);
      // Dragging well past the ring, upward, onto the lock = sprint lock.
      const overLock = dy < -JOY_RADIUS * 1.45 && Math.abs(dx) < JOY_RADIUS * 0.7;
      if (len > JOY_RADIUS) {
        dx = (dx / len) * JOY_RADIUS;
        dy = (dy / len) * JOY_RADIUS;
      }
      let x = dx / JOY_RADIUS;
      let y = -dy / JOY_RADIUS;
      const mag = Math.hypot(x, y);
      if (mag < DEADZONE) {
        x = 0;
        y = 0;
      } else {
        const k = (mag - DEADZONE) / (1 - DEADZONE) / mag;
        x *= k;
        y *= k;
      }
      this.input.setTouchMove(x, y, true);
      this.input.touchSprint = overLock || (y > 0.92 && len >= JOY_RADIUS * 0.98);
      this.sprintLocked = overLock;
      // Input above is immediate; the knob and its classes wait for the next frame.
      const v = this.joyView;
      v.dx = dx;
      v.dy = dy;
      v.overLock = overLock;
      v.sprint = this.input.touchSprint;
      v.dirty = true;
      return;
    }
    this.look(e);
  };

  private onZoneUp = (e: PointerEvent): void => {
    if (e.pointerId === this.joyId) {
      this.joyId = -1;
      // Land the last move first (sprint class), then the release overrides the knob.
      this.flushJoy();
      if (this.sprintLocked) {
        // Keep running forward until the stick is touched again.
        this.input.setTouchMove(0, 1, true);
        this.input.touchSprint = true;
        this.joyBase.classList.add('locked');
        this.joyBase.classList.remove('lock-hover');
        this.joyKnob.style.transform = `translate(-50%, calc(-50% - ${JOY_RADIUS}px))`;
        return;
      }
      this.input.setTouchMove(0, 0, false);
      this.input.touchSprint = false;
      this.joyBase.classList.remove('sprint');
      this.resetJoy();
      return;
    }
    this.lookIds.delete(e.pointerId);
  };

  private look(e: PointerEvent): void {
    const last = this.lookIds.get(e.pointerId);
    if (!last) return;
    const now = performance.now();
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    const dt = Math.max(1, now - last.t);
    last.x = e.clientX;
    last.y = e.clientY;
    last.t = now;
    // Acceleration: fine control for slow drags, fast turns for flicks.
    const speed = Math.hypot(dx, dy) / dt; // px per ms
    const accel = Math.min(2.4, 1 + Math.max(0, speed - 0.35) * 0.9);
    const s = playerConfig.touchSensitivity * accel;
    this.input.addTouchLook(-dx * s, -dy * s);
  }
}

/** Pointer capture keeps drags working when a finger slides off a control. */
function capture(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    /* pointer already gone (or synthetic) - dragging still works without capture */
  }
}

function el(className: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  parent.appendChild(d);
  return d;
}
