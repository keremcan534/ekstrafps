import type { Input } from '../core/Input';
import { playerConfig } from '../player/PlayerConfig';

export interface TouchActions {
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

/**
 * Mobile controls, modelled on the big mobile shooters (CoD Mobile / PUBG Mobile):
 *
 *  - Left half: floating move stick. Its resting "ghost" stays visible; touching
 *    anywhere on the left re-centres it under the thumb. Push up past the ring
 *    onto the lock icon to lock sprint (keeps running after you let go; touch the
 *    stick again to stop).
 *  - Right half: drag to look, with acceleration (slow drags = fine aim, fast
 *    flicks = big turns).
 *  - FIRE (right) doubles as a look pad while held; a second FIRE on the left.
 *  - ADS, RELOAD, JUMP, CROUCH, fire MODE; tap the weapon card to swap weapons.
 *  - USE appears only when something can be bought/used, with its label.
 *  - Tap the minimap for the full map. Lab-only buttons are hidden in Survival.
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
  private names: string[] = [];
  private lastUse = '';

  constructor(parent: HTMLElement, private input: Input, weaponNames: string[], actions: TouchActions, survival = false) {
    this.names = weaponNames;
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

    // Fire buttons double as look pads while held.
    this.fireButton('btn btn-fire', '');
    this.fireButton('btn btn-fire-left', '');

    this.adsBtn = this.button('btn btn-ads', '◎', () => {
      input.adsHeld = !input.adsHeld;
      this.adsBtn.classList.toggle('on', input.adsHeld);
    });
    this.button('btn btn-jump', '⤒', () => (input.jumpPressed = true));
    this.crouchBtn = this.button('btn btn-crouch', '⤓', () => {
      input.touchCrouch = !input.touchCrouch;
      this.crouchBtn.classList.toggle('on', input.touchCrouch);
    });
    this.button('btn btn-reload', '↻', () => (input.reloadPressed = true));
    this.button('btn btn-mode', 'MODE', actions.onFireMode);

    // Weapon card: current weapon; tap to swap to the other one.
    this.weaponCard = el('weapon-card', this.root);
    this.weaponCard.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.cyclePressed = 1;
      this.weaponCard.classList.add('pressed');
      setTimeout(() => this.weaponCard.classList.remove('pressed'), 120);
    });

    const dev = new URLSearchParams(location.search).has('dev');
    if (!survival) {
      this.holdButton('btn btn-lean-l', '', (down) => (input.touchLean = down ? -1 : 0));
      this.holdButton('btn btn-lean-r', '', (down) => (input.touchLean = down ? 1 : 0));
      // Sixteen slot buttons don't fit a phone: the weapon card cycles (tap) instead.
      if (dev) {
        const slots = el('slots', this.root);
        weaponNames.forEach((name, i) => {
          this.slotBtns.push(this.button('btn btn-slot', name, () => (input.slotPressed = i), slots));
        });
      }
    }

    if (actions.onUse) {
      this.useBtn = this.button('btn btn-use', 'USE', actions.onUse);
      this.useBtn.style.display = 'none';
    }
    if (actions.onMap) this.button('btn btn-small btn-map', 'MAP', actions.onMap);
    // Pause (the settings menu); the tuning panel with ?dev.
    this.button('btn btn-small btn-tune', dev ? '⚙' : '❚❚', actions.onTune);
    if (!survival && dev) {
      this.button('btn btn-small btn-debug', 'DBG', actions.onDebug);
      const rays = this.button('btn btn-small btn-rays', 'RAY', () => rays.classList.toggle('on', actions.onRays()));
      const laser = this.button('btn btn-small btn-laser', 'LSR', () => laser.classList.toggle('on', actions.onLaser()));
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
      const other = owned && owned.length > 1 ? owned.find((i) => i !== slot) : undefined;
      this.weaponCard.innerHTML = `<b>${this.names[slot] ?? ''}</b>${other !== undefined ? `<span>⇄ ${this.names[other]}</span>` : ''}`;
      this.weaponCard.style.display = owned && owned.length < 2 ? 'none' : '';
      if (!owned) this.weaponCard.innerHTML = `<b>${this.names[slot] ?? ''}</b><span>TAP: NEXT ▸</span>`;
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
    b.textContent = label;
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

  /** Button that reports press and release (lean). */
  private holdButton(cls: string, label: string, onChange: (down: boolean) => void): void {
    const b = el(cls, this.root);
    b.textContent = label;
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

  private fireButton(cls: string, label: string): void {
    const b = el(cls, this.root);
    b.textContent = label;
    el('fire-icon', b);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(b, e.pointerId);
      b.classList.add('pressed');
      this.input.pressFire(true);
      this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    });
    b.addEventListener('pointermove', (e) => this.look(e));
    const up = (e: PointerEvent) => {
      b.classList.remove('pressed');
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
