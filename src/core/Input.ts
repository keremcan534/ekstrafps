/**
 * Unified input state. Keyboard/mouse (desktop) and touch controls (mobile) both
 * write into the same fields, so gameplay code never cares where input came from.
 *
 * Edge-triggered flags (`*Pressed`) are cleared by `endFrame()`.
 */
export class Input {
  // Continuous
  moveX = 0; // -1 left .. 1 right
  moveY = 0; // -1 back .. 1 forward
  fireHeld = false;
  adsHeld = false;
  sprintHeld = false;
  crouchHeld = false;

  // Look delta accumulated this frame, already in radians.
  lookYaw = 0;
  lookPitch = 0;
  /** True when the look delta this frame came from touch (aim assist only applies to touch). */
  lookFromTouch = false;
  /** -1 lean left .. 1 lean right (Q / E held, or touch lean buttons). */
  leanAxis = 0;
  touchLean = 0;

  // Edges
  firePressed = false;
  jumpPressed = false;
  reloadPressed = false;
  slotPressed = -1;
  cyclePressed = 0;

  /** Desktop mouse sensitivity, radians per pixel. */
  mouseSensitivity = 0.0022;

  pointerLocked = false;
  /**
   * The browser refused pointer lock (embedded browsers, some security settings).
   * The lab then runs in "free mouse" mode: plain mouse movement looks around,
   * clicks still fire/aim. Never leaves the player with dead controls.
   */
  lockFailed = false;
  onLockFailed: (() => void) | null = null;
  /** A lock request was refused although locking works here (e.g. right after Esc): just retry on the next click. */
  onLockRefused: (() => void) | null = null;
  /** Pointer lock has worked at least once in this session. */
  private everLocked = false;
  private failures = 0;
  private keys = new Set<string>();
  private touchMoveX = 0;
  private touchMoveY = 0;
  private touchMoveActive = false;

  /** Callbacks for UI toggles (debug HUD, tuning panel...). */
  onKey: ((code: string) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', () => this.releaseAll());
    canvas.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('wheel', this.handleWheel, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockerror', () => this.markLockFailed());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (this.pointerLocked) {
        this.lockFailed = false;
        this.everLocked = true;
        this.failures = 0;
      }
      if (!this.pointerLocked) {
        this.fireHeld = false;
        this.adsHeld = false;
      }
    });
  }

  /** Mouse input is live: either locked, or running in free-mouse fallback. */
  get mouseActive(): boolean {
    return this.pointerLocked || this.lockFailed;
  }

  requestPointerLock(): void {
    if (document.pointerLockElement === this.canvas) return;
    if (typeof this.canvas.requestPointerLock !== 'function') return this.markLockFailed();
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => this.markLockFailed());
    } catch {
      this.markLockFailed();
    }
    // Some browsers neither lock nor report an error: fall back if nothing happened.
    setTimeout(() => {
      if (!this.pointerLocked && document.pointerLockElement !== this.canvas) this.markLockFailed();
    }, 600);
  }

  private markLockFailed(): void {
    if (this.lockFailed || this.pointerLocked) return;
    // Chromium refuses a re-lock for ~1 s after the player exits with Esc. That is
    // not "unsupported": keep real mouse look and retry on the next click.
    if (this.everLocked) {
      this.onLockRefused?.();
      return;
    }
    // Never locked: only fall back to free-mouse look after repeated refusals.
    if (++this.failures < 2) {
      this.onLockRefused?.();
      return;
    }
    this.lockFailed = true;
    this.onLockFailed?.();
  }

  // --- Touch API (called by TouchControls) ---
  setTouchMove(x: number, y: number, active: boolean): void {
    this.touchMoveX = x;
    this.touchMoveY = y;
    this.touchMoveActive = active;
  }

  addTouchLook(yaw: number, pitch: number): void {
    this.lookYaw += yaw;
    this.lookPitch += pitch;
    this.lookFromTouch = true;
  }

  /** Recompute continuous movement from keyboard + touch each frame. */
  beginFrame(): void {
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.touchMoveActive) {
      x += this.touchMoveX;
      y += this.touchMoveY;
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.moveX = x;
    this.moveY = y;
    this.sprintHeld = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSprint;
    this.crouchHeld = this.keys.has('KeyC') || this.touchCrouch;
    this.leanAxis = (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0) + this.touchLean;
    this.leanAxis = Math.max(-1, Math.min(1, this.leanAxis));
  }

  touchSprint = false;
  touchCrouch = false;

  endFrame(): void {
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookFromTouch = false;
    this.firePressed = false;
    this.jumpPressed = false;
    this.reloadPressed = false;
    this.slotPressed = -1;
    this.cyclePressed = 0;
  }

  pressFire(down: boolean): void {
    if (down && !this.fireHeld) this.firePressed = true;
    this.fireHeld = down;
  }

  private releaseAll(): void {
    this.keys.clear();
    this.fireHeld = false;
    this.adsHeld = false;
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'Tab') e.preventDefault();
    if (e.repeat) return;
    this.keys.add(e.code);
    switch (e.code) {
      case 'Space':
        this.jumpPressed = true;
        break;
      case 'KeyR':
        this.reloadPressed = true;
        break;
      default:
        if (e.code.startsWith('Digit')) {
          const n = Number(e.code.slice(5));
          if (n >= 1 && n <= 9) this.slotPressed = n - 1;
          else if (n === 0) this.slotPressed = 9;
        }
    }
    this.onKey?.(e.code);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.mouseActive) {
      this.requestPointerLock();
      return;
    }
    if (e.button === 0) this.pressFire(true);
    if (e.button === 2) this.adsHeld = true;
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.pressFire(false);
    if (e.button === 2) this.adsHeld = false;
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.mouseActive) return;
    // Ignore absurd spikes some browsers emit when pointer lock engages.
    if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
    this.lookYaw -= e.movementX * this.mouseSensitivity;
    this.lookPitch -= e.movementY * this.mouseSensitivity;
  };

  private handleWheel = (e: WheelEvent): void => {
    if (!this.mouseActive) return;
    this.cyclePressed = e.deltaY > 0 ? 1 : -1;
  };
}
