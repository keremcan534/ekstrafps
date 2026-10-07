import { feel } from '../config/Feel';

/**
 * The Warden in the main menu, heard: his respirator breathing while he stands in the
 * forest (cut dead the moment he's gone, so the silence is what you notice), a low sting
 * when he's back, and now and then a line over the radio, subtitled. Its own small audio
 * graph (like MenuMusic), outside the game's mix; nothing plays until the page may play
 * sound (first click or key). Lines: scripts/voice/warden_menu_lines.txt (ElevenLabs,
 * the commander's voice), breathing and sting: scripts/gen-menu-sfx.mjs.
 */

export type WardenPlate = 'stand' | 'aim' | 'gone';

const LINES = {
  early: "You're early.",
  still: 'Still here.',
  ends: 'I have seen how this ends.',
  notyet: "Don't go in there. Not yet.",
  warm: "Stay where it's warm.",
  minus30: 'Minus thirty. Now we can talk.',
  seventyone: 'Seventy-one percent.',
  door: 'I closed that door for you.',
  standing: 'I know where you will be standing.',
  back: 'You came back. I knew you would.',
  proceed: 'Proceed.',
} as const;
type Line = keyof typeof LINES;

/** What he may say, by what's on screen ('seventyone' kept rare). */
const POOLS: Record<WardenPlate, Line[]> = {
  stand: ['warm', 'minus30', 'ends', 'warm', 'minus30', 'ends', 'seventyone'],
  aim: ['notyet', 'door', 'standing'],
  gone: ['still', 'standing', 'ends', 'still'],
};
/** Chance a beat brings a line, and the quiet kept between lines (s). */
const SPEAK = 0.4;
const GAP = 40;
/** Breathing level while he's there (aiming: a little closer). */
const BREATH = { stand: 0.5, aim: 0.62 };

export class MenuWardenVoice {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private breathGain!: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private plate: WardenPlate = 'stand';
  private active = false;
  private lastLine = -Infinity;
  private bags = new Map<WardenPlate, Line[]>();
  private sub: HTMLDivElement;
  private subTimer = 0;
  private greeted = false;

  constructor(
    parent: HTMLElement,
    private mobile: boolean,
    /** False while something sits over the stage (the dossier): no lines then. */
    private canSpeak: () => boolean = () => true,
  ) {
    this.sub = document.createElement('div');
    this.sub.className = 'subline menu-line';
    parent.appendChild(this.sub);
    // Browsers only let sound start from a gesture: the first click or key wakes it.
    const wake = () => {
      for (const ev of ['pointerup', 'keydown', 'touchend']) window.removeEventListener(ev, wake);
      void this.start();
    };
    for (const ev of ['pointerup', 'keydown', 'touchend']) window.addEventListener(ev, wake, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') void this.ctx.suspend();
      else if (this.active) void this.ctx.resume();
    });
  }

  private async start(): Promise<void> {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    // The mask: a little darker than the raw take.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    this.breathGain.connect(lp).connect(this.out);
    this.loading = this.load();
    await this.loading;
    const breath = this.buffers.get('breath');
    if (breath) {
      const src = ctx.createBufferSource();
      src.buffer = breath;
      src.loop = true;
      src.connect(this.breathGain);
      src.start(0, Math.random() * breath.duration);
    }
    this.level();
    this.presence(this.plate, true);
    if (this.active) this.welcome();
  }

  private async load(): Promise<void> {
    const ctx = this.ctx!;
    const voice = (id: string) => `audio/voice/warden_menu_${id}.${this.mobile ? 'mp3' : 'wav'}`;
    const files: [string, string][] = [
      ['breath', 'audio/menu/warden_breath.wav'],
      ['return', 'audio/menu/warden_return.wav'],
      ...(Object.keys(LINES) as Line[]).map((k): [string, string] => [k, voice(k)]),
    ];
    await Promise.all(
      files.map(async ([k, url]) => {
        try {
          let res = await fetch(url);
          // Phones: the .mp3 twin may not be encoded yet.
          if (!res.ok && url.endsWith('.mp3')) res = await fetch(url.replace(/\.mp3$/, '.wav'));
          if (!res.ok) return;
          this.buffers.set(k, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch {
          /* a missing sound only means a quieter menu */
        }
      }),
    );
  }

  /** Master volume (Settings), applied on every change of state. */
  private level(): void {
    if (this.ctx) this.out.gain.setTargetAtTime(this.active ? feel.masterVolume : 0, this.ctx.currentTime, 0.25);
  }

  /** The stage is up (true) or covered by a match / the pause screen (false). */
  setActive(on: boolean): void {
    this.active = on;
    if (!this.ctx) return;
    if (on) void this.ctx.resume();
    this.level();
    if (!on) this.hideSub();
  }

  /** What's on screen now. He's gone: the breathing stops dead, mid-breath. */
  presence(p: WardenPlate, instant = false): void {
    this.plate = p;
    if (!this.ctx) return;
    const g = this.breathGain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    if (p === 'gone') g.setTargetAtTime(0, t, 0.012);
    else g.setTargetAtTime(BREATH[p], t, instant ? 0.4 : 0.08);
  }

  /** Back from the empty field: the low sting under the cut. */
  returned(): void {
    this.play('return', { gain: 0.55 });
  }

  /** After each beat of the stage: sometimes a line, fitting what's on screen. */
  beat(): void {
    if (!this.ctx || !this.active || !this.canSpeak()) return;
    if (this.ctx.currentTime - this.lastLine < GAP || Math.random() > SPEAK) return;
    let bag = this.bags.get(this.plate);
    if (!bag?.length) this.bags.set(this.plate, (bag = shuffle(POOLS[this.plate])));
    // Not the same line twice running.
    this.say(bag.pop()!);
  }

  /** First time the menu is heard. */
  welcome(): void {
    if (this.greeted || !this.ctx || !this.loading) return;
    this.greeted = true;
    void this.loading.then(() => window.setTimeout(() => this.active && this.plate !== 'gone' && this.say('early'), 2600));
  }

  /** The stage is back after a match. */
  backFromMatch(): void {
    window.setTimeout(() => this.active && this.say('back'), 1800);
  }

  /** PLAY. */
  proceed(): void {
    this.say('proceed', true);
  }

  private say(line: Line, force = false): void {
    if (!this.ctx || (!force && !this.canSpeak())) return;
    const dur = this.play(line, { radio: true, far: this.plate === 'gone' });
    if (!dur) return;
    this.lastLine = this.ctx.currentTime + dur;
    this.sub.innerHTML = `<b>Warden:</b> ${LINES[line]}`;
    this.sub.style.setProperty('--dirt-at', `${Math.round(Math.random() * 100)}% ${Math.round(Math.random() * 100)}%`);
    this.sub.classList.add('show');
    window.clearTimeout(this.subTimer);
    this.subTimer = window.setTimeout(() => this.hideSub(), (dur + 1.4) * 1000);
  }

  private hideSub(): void {
    this.sub.classList.remove('show');
  }

  /**
   * One sound. Radio lines go through a band-limited, slightly driven channel with a cold
   * slap-back off the trees; from the empty field they come from further away.
   * Returns the duration (0 if it isn't loaded).
   */
  private play(id: string, o: { gain?: number; radio?: boolean; far?: boolean } = {}): number {
    const ctx = this.ctx;
    const buf = this.buffers.get(id);
    if (!ctx || !buf || ctx.state !== 'running') return 0;
    const t = ctx.currentTime + 0.05;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    if (!o.radio) {
      src.connect(g).connect(this.out);
      src.start(t);
      return buf.duration;
    }
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = o.far ? 420 : 300;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = o.far ? 2600 : 3600;
    const drive = ctx.createWaveShaper();
    drive.curve = softClip(2.2);
    src.connect(hp).connect(lp).connect(drive).connect(g);
    g.gain.value = (o.far ? 0.55 : 0.9) * (o.gain ?? 1);
    g.connect(this.out);
    // Slap-back echo, darker each repeat.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = o.far ? 0.27 : 0.19;
    const fb = ctx.createGain();
    fb.gain.value = o.far ? 0.42 : 0.28;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 1700;
    const wet = ctx.createGain();
    wet.gain.value = o.far ? 0.6 : 0.3;
    g.connect(delay).connect(dark).connect(fb).connect(delay);
    dark.connect(wet).connect(this.out);
    src.start(t);
    // Radio key-up and release clicks.
    this.click(t - 0.03, 0.22);
    this.click(t + buf.duration + 0.02, 0.15);
    return buf.duration;
  }

  /** A short band-passed noise tick (the radio keying). */
  private click(at: number, gain: number): void {
    const ctx = this.ctx!;
    const n = Math.round(ctx.sampleRate * 0.03);
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n * 0.18));
    const src = ctx.createBufferSource();
    src.buffer = b;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(bp).connect(g).connect(this.out);
    src.start(Math.max(ctx.currentTime, at));
  }
}

function softClip(k: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}

function shuffle<T>(a: T[]): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
