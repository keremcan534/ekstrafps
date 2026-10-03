import type { Bot } from './Bot';
import type { AudioSystem } from '../audio/AudioSystem';

type Line = 'see_enemy' | 'contact' | 'flanking' | 'moving' | 'reloading' | 'target_down' | 'man_down' | 'lost_visual' | 'hit' | 'spread_out';

/** Decisions that get a callout when a bot switches into them. */
const ON_DECISION: Partial<Record<string, Line>> = {
  FLANK: 'flanking',
  PUSH: 'moving',
  REPOSITION: 'moving',
  RELOAD: 'reloading',
  SEARCH: 'lost_visual',
  SUPPRESS: 'contact',
};

interface Seen {
  decision: string;
  alive: boolean;
  hurtAt: number;
  vis: boolean;
}

/**
 * Squads that sound like squads: the Black Division sting when two squads first meet,
 * and radio callouts (the SABLE voice pack) when bots spot, flank, push, reload, lose
 * sight, get hit, lose a man or drop one. One voice per team at a time; no line spam.
 */
export class SquadVoice {
  private seen = new Map<Bot, Seen>();
  private botAt = new Map<Bot, number>();
  private teamAt = new Map<string, number>();
  private lineAt = new Map<string, number>();
  /** Last moment any two squads had eyes on each other (the sting comes after a lull). */
  private lastContact = -1e9;

  constructor(private audio: AudioSystem) {}

  update(now: number, bots: Iterable<Bot>): void {
    const all = [...bots];
    let contact = false;
    for (const b of all) {
      const s = b.agent.soldier;
      const prev = this.seen.get(b);
      const alive = s.alive;
      // Eyes on a person (another squad or the player), not a robot.
      const vis = !!(b.target && b.target.visible && b.target.target.kind !== 'robot');
      const cur: Seen = { decision: b.decision, alive, hurtAt: b.hurtAt, vis };
      this.seen.set(b, cur);
      if (!prev) continue;
      if (prev.alive && !alive) {
        // A man down: his squad calls it, the other side cheers it.
        const mate = all.find((m) => m !== b && m.team === b.team && m.agent.soldier.alive);
        if (mate) this.say(mate, 'man_down', now, true);
        const foe = all.find((m) => m.team !== b.team && m.agent.soldier.alive && m.target?.target === b.agent.self);
        if (foe) this.say(foe, 'target_down', now, true);
        continue;
      }
      if (!alive) continue;
      if (vis) contact = true;
      if (vis && !prev.vis) {
        // Squads meeting after a quiet spell: the encounter sting, and the spotter calls it.
        if (now - this.lastContact > 20) {
          this.audio.play('bd.encounter');
          this.say(b, 'see_enemy', now, true);
          const lead = all.find((m) => m !== b && m.team === b.team && m.agent.soldier.alive);
          if (lead) setTimeout(() => this.say(lead, 'spread_out', now + 1.6), 1600);
        } else this.say(b, 'contact', now);
      }
      if (cur.hurtAt > prev.hurtAt && Math.random() < 0.45) this.say(b, 'hit', now);
      if (cur.decision !== prev.decision) {
        const line = ON_DECISION[cur.decision];
        if (line) this.say(b, line, now);
      }
    }
    if (contact) this.lastContact = now;
  }

  private say(b: Bot, line: Line, now: number, urgent = false): void {
    const s = b.agent.soldier;
    if (!s.alive) return;
    const team = b.team;
    // One voice per team on the radio; the same call not over and over.
    if (now - (this.teamAt.get(team) ?? -1e9) < (urgent ? 0.6 : 1.4)) return;
    if (now - (this.botAt.get(b) ?? -1e9) < 3.5) return;
    if (!urgent && now - (this.lineAt.get(`${team}:${line}`) ?? -1e9) < 7) return;
    this.teamAt.set(team, now);
    this.botAt.set(b, now);
    this.lineAt.set(`${team}:${line}`, now);
    this.audio.play(`bd.${line}`, { position: s.headPos, pitch: s.voicePitch * 0.88, volume: 1.4 });
  }
}
