import type { Input } from '../core/Input';
import { playerConfig } from '../player/PlayerConfig';

export interface TouchActions {
  onTune(): void;
  onDebug(): void;
}

const DEADZONE = 0.12;
const JOY_RADIUS = 62;

/**
 * Mobile controls (landscape):
 *  - Left half: floating move stick (push to the top edge = sprint)
 *  - Right half: drag to look
 *  - FIRE (right, also a look pad while held) + secondary FIRE on the left
 *  - ADS toggle, JUMP, CROUCH toggle, RELOAD, weapon slots 1/2/3
 * Everything writes into the shared Input, exactly like keyboard/mouse.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private joyBase: HTMLDivElement;
  private joyKnob: HTMLDivElement;
  private joyId = -1;
  private joyOrigin = { x: 0, y: 0 };
  private lookIds = new Map<number, { x: number; y: number }>();
  private adsBtn!: HTMLDivElement;
  private crouchBtn!: HTMLDivElement;
  private slotBtns: HTMLDivElement[] = [];

  constructor(parent: HTMLElement, private input: Input, actions: TouchActions) {
    this.root = el('touch-root', parent);
    const zone = el('touch-zone', this.root);
    zone.addEventListener('pointerdown', this.onZoneDown);
    zone.addEventListener('pointermove', this.onZoneMove);
    zone.addEventListener('pointerup', this.onZoneUp);
    zone.addEventListener('pointercancel', this.onZoneUp);

    this.joyBase = el('joy-base', this.root);
    this.joyKnob = el('joy-knob', this.joyBase);

    // Fire buttons double as look pads while held.
    this.fireButton('btn btn-fire', 'FIRE');
    this.fireButton('btn btn-fire-left', 'FIRE');

    this.adsBtn = this.button('btn btn-ads', 'ADS', () => {
      input.adsHeld = !input.adsHeld;
      this.adsBtn.classList.toggle('on', input.adsHeld);
    });
    this.button('btn btn-jump', 'JUMP', () => (input.jumpPressed = true));
    this.crouchBtn = this.button('btn btn-crouch', 'CROUCH', () => {
      input.touchCrouch = !input.touchCrouch;
      this.crouchBtn.classList.toggle('on', input.touchCrouch);
    });
    this.button('btn btn-reload', 'R', () => (input.reloadPressed = true));
    const slots = el('slots', this.root);
    ['AR', 'PISTOL', 'SHOTGUN'].forEach((name, i) => {
      this.slotBtns.push(this.button('btn btn-slot', name, () => (input.slotPressed = i), slots));
    });
    this.button('btn btn-small btn-tune', '⚙', actions.onTune);
    this.button('btn btn-small btn-debug', 'DBG', actions.onDebug);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  /** Keep the ADS / slot highlights in sync with gameplay (e.g. ADS dropped on reload). */
  sync(adsActive: boolean, slot: number): void {
    this.adsBtn.classList.toggle('on', adsActive);
    this.slotBtns.forEach((b, i) => b.classList.toggle('on', i === slot));
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

  private fireButton(cls: string, label: string): void {
    const b = el(cls, this.root);
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(b, e.pointerId);
      b.classList.add('pressed');
      this.input.pressFire(true);
      this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
      this.joyOrigin = { x: e.clientX, y: e.clientY };
      this.joyBase.style.display = 'block';
      this.joyBase.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.joyKnob.style.transform = 'translate(-50%, -50%)';
    } else {
      this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  };

  private onZoneMove = (e: PointerEvent): void => {
    if (e.pointerId === this.joyId) {
      let dx = e.clientX - this.joyOrigin.x;
      let dy = e.clientY - this.joyOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > JOY_RADIUS) {
        dx = (dx / len) * JOY_RADIUS;
        dy = (dy / len) * JOY_RADIUS;
      }
      this.joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
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
      // Push the stick to the top edge to sprint.
      this.input.touchSprint = y > 0.85 && len >= JOY_RADIUS * 0.95;
      this.joyBase.classList.toggle('sprint', this.input.touchSprint);
      return;
    }
    this.look(e);
  };

  private onZoneUp = (e: PointerEvent): void => {
    if (e.pointerId === this.joyId) {
      this.joyId = -1;
      this.joyBase.style.display = 'none';
      this.input.setTouchMove(0, 0, false);
      this.input.touchSprint = false;
      return;
    }
    this.lookIds.delete(e.pointerId);
  };

  private look(e: PointerEvent): void {
    const last = this.lookIds.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last.x = e.clientX;
    last.y = e.clientY;
    const s = playerConfig.touchSensitivity;
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
