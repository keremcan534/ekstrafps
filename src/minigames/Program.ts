import type { Chip } from './chip';
import type { Screen } from './pixel';

export type Button = 'left' | 'right' | 'up' | 'down' | 'a';

/** The terminal's controls: what is held now, and what was pressed this frame. */
export class Pad {
  private down = new Set<Button>();
  private fresh = new Set<Button>();

  press(b: Button): void {
    if (!this.down.has(b)) this.fresh.add(b);
    this.down.add(b);
  }

  release(b: Button): void {
    this.down.delete(b);
  }

  held(b: Button): boolean {
    return this.down.has(b);
  }

  /** Pressed this frame (edge). */
  hit(b: Button): boolean {
    return this.fresh.has(b);
  }

  /** -1 / 0 / 1 on an axis. */
  axis(neg: Button, pos: Button): number {
    return (this.held(pos) ? 1 : 0) - (this.held(neg) ? 1 : 0);
  }

  endFrame(): void {
    this.fresh.clear();
  }

  clear(): void {
    this.down.clear();
    this.fresh.clear();
  }
}

export interface Ctx {
  chip: Chip;
  pad: Pad;
}

/** One running program. */
export interface Program {
  update(dt: number): void;
  draw(s: Screen): void;
  /** True once it has finished; the terminal then shows `ending`. */
  done: boolean;
  /** The end card, typed out line by line after the program. */
  ending: string[];
}

export interface ProgramInfo {
  id: string;
  /** As listed on the terminal. */
  title: string;
  /** One line under the title in the list. */
  blurb: string;
  /** The tape label's year. */
  year: string;
  make(ctx: Ctx): Program;
}
