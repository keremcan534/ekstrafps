"""Final trailer assembly: edl.json (slots) + cut.json (which capture fills each slot)
+ the music edit + the game's logged sound events + designed SFX -> build/trailer.mp4

cut.json:  { "C01": {"src": "FC-pov", "at": 0.0, "speed": 1.0, "fx": "flashout"} , ... }
  src   capture folder in frames/ (a single shot id like A03, or a take camera like FC-pov)
  at    source time (seconds, the take's own clock) shown at the slot's in-point
  fx    optional: flashout (last frames burn to white), black, strobe, fadein
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy.signal import butter, lfilter, resample_poly

ROOT = Path(__file__).resolve().parents[1]
GAME = ROOT.parent
SR = 48000
FPS = 30
W, H = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (1280, 720)

edl = json.loads((ROOT / "edl.json").read_text())
cut = json.loads((ROOT / "cut.json").read_text())
SHOTS = {s[0]: s for s in edl["shots"]}


# ------------------------------------------------------------------ footage
class Source:
    cache = {}

    def __init__(self, name):
        self.name = name
        d = ROOT / "frames" / name
        self.files = sorted(d.glob("*.jpg"))
        take = name.split("-")[0]
        ev = ROOT / "build" / "events" / f"{take}.json"
        self.meta = json.loads(ev.read_text()) if ev.exists() else {"fps": 30, "handles": 0.25, "events": []}

    @classmethod
    def get(cls, name):
        if name not in cls.cache:
            cls.cache[name] = Source(name)
        return cls.cache[name]

    def _load(self, k):
        f = self.files[max(0, min(k, len(self.files) - 1))]
        im = Image.open(f).convert("RGB")
        return im if im.size == (W, H) else im.resize((W, H), Image.LANCZOS)

    def frame(self, t):
        fps = self.meta["fps"]
        if fps >= 2 * FPS:
            # 60 fps capture -> 30 fps delivery: blend the two sub-frames of each output
            # frame (a 360-degree shutter) for natural motion blur instead of judder.
            n = int(fps // FPS)
            k = int(round((t + self.meta["handles"]) * fps))
            ims = [np.asarray(self._load(k + i), np.float32) for i in range(n)]
            return Image.fromarray((sum(ims) / n).astype(np.uint8))
        return self._load(int(round((t + self.meta["handles"]) * fps)))


def font(size, bold=False):
    return ImageFont.truetype("C:/Windows/Fonts/bahnschrift.ttf", size)


# ------------------------------------------------------------------ motion graphics
def annotate(img, t, x, y, lines, color=(225, 228, 230)):
    """Hairline draws out, text types in, holds, retracts (t = seconds since start)."""
    d = ImageDraw.Draw(img, "RGBA")
    grow = min(1, t / 0.2)
    L = int(W * 0.09 * grow)
    a = int(255 * min(1, t / 0.15) * (1 if t < 1.6 else max(0, 1 - (t - 1.6) / 0.25)))
    if a <= 0:
        return
    d.line([(x, y), (x + L, y - L * 0.35)], fill=color + (a,), width=1)
    tx, ty = x + L + 8, y - L * 0.35 - 14
    f = font(max(12, H // 48))
    for i, line in enumerate(lines):
        n = int(len(line) * min(1, max(0, (t - 0.15 - i * 0.08) / 0.3)))
        d.text((tx, ty + i * (H // 40)), line[:n], font=f, fill=color + (int(a * (0.95 if i == 0 else 0.6)),))


def title_card(t, title, sub, line3):
    """Near-black brushed steel, dust, title revealed by a raking light sweep."""
    rng = np.random.default_rng(3)
    base = getattr(title_card, "_base", None)
    if base is None:
        n = rng.normal(0, 1, (H, W)).astype(np.float32)
        streak = np.cumsum(rng.normal(0, 1, (H, W)), axis=1).astype(np.float32)
        streak = (streak - streak.mean(1, keepdims=True)) / (streak.std() + 1e-6)
        base = 7 + 2.0 * n + 1.5 * streak
        title_card._base = base
    sweep = -0.3 + t * 0.45  # light position across the frame (0..1)
    xs = np.linspace(0, 1, W)[None, :]
    ys = np.linspace(0, 1, H)[:, None]
    light = np.exp(-((xs - sweep - (ys - 0.5) * 0.25) ** 2) / 0.02)
    lum = np.clip(base * (0.35 + 2.4 * light), 0, 255)
    img = Image.fromarray(np.stack([lum * 0.92, lum * 0.97, lum * 1.06], -1).clip(0, 255).astype(np.uint8))
    # Title: hidden in shadow, lit as the sweep passes, then stays readable.
    big = font(int(H * 0.115))
    layer = Image.new("L", (W, H), 0)
    dl = ImageDraw.Draw(layer)
    spaced = " ".join(title)
    tw = dl.textlength(spaced, font=big)
    dl.text(((W - tw) / 2, H * 0.40), spaced, font=big, fill=255)
    reveal = np.clip(light * 1.6 + min(1, max(0, t - 1.2) / 1.0) * 0.85, 0, 1)
    tl = np.asarray(layer, np.float32) / 255 * reveal
    glow = np.asarray(layer.filter(ImageFilter.GaussianBlur(H // 60)), np.float32) / 255 * reveal * 0.35
    arr = np.asarray(img, np.float32)
    arr = arr * (1 - tl[..., None]) + np.array([228, 230, 232]) * tl[..., None] + glow[..., None] * np.array([255, 140, 90]) * 0.25
    img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img, "RGBA")
    small = font(int(H * 0.028))
    if sub and t > 2.28:
        a = int(255 * min(1, (t - 2.28) / 0.5))
        s = "   ".join(sub.split(" "))
        d.text(((W - d.textlength(s, font=small)) / 2, H * 0.56), s, font=small, fill=(255, 74, 28, a))
    if line3 and t > 4.57:
        a = int(200 * min(1, (t - 4.57) / 0.6))
        s = "  ".join(line3)
        d.text(((W - d.textlength(s, font=small)) / 2, H * 0.80), s, font=small, fill=(200, 204, 208, a))
    # dust motes
    pts = rng.random((120, 2))
    for i, (px, py) in enumerate(pts):
        px = (px + t * 0.01 * (1 + i % 3)) % 1
        py = (py - t * 0.006) % 1
        b = int(30 + 60 * np.exp(-((px - sweep) ** 2) / 0.02))
        d.point((px * W, py * H), fill=(b, b, b, 255))
    return img


# ------------------------------------------------------------------ video
def render_video(out_video):
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    n = int(edl["duration"] * FPS)
    p = subprocess.Popen([exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
                          "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", str(out_video)], stdin=subprocess.PIPE)
    shots = edl["shots"]
    si = 0
    black = Image.new("RGB", (W, H))
    titles = cut.get("_title", {"title": "SITE-9", "sub": "TACTICAL SQUAD FPS", "line3": "IN DEVELOPMENT"})
    for f in range(n):
        T = f / FPS
        while si < len(shots) - 1 and T >= shots[si][2] - 1e-9:
            si += 1
        sid, tin, tout = shots[si][0], shots[si][1], shots[si][2]
        c = cut.get(sid)
        if sid in ("J02", "J03", "J04"):
            img = title_card(T - 101.7, titles["title"], titles["sub"], titles["line3"])
            if T > 110.0:
                img = Image.blend(img, black, min(1, (T - 110.0) / 0.8))
        elif not c or c.get("fx") == "black":
            img = black.copy()
        else:
            src = Source.get(c["src"])
            st = c["at"] + (T - tin) * c.get("speed", 1.0)
            img = src.frame(st)
            fx = c.get("fx")
            if fx == "flashout" and tout - T < 0.1:
                img = Image.blend(img, Image.new("RGB", (W, H), (255, 240, 220)), 1 - (tout - T) / 0.1)
            if fx == "robotpov":
                # Machine vision: red monochrome, scanlines, a bracket locking on centre frame.
                g = np.asarray(img.convert("L"), np.float32)
                g = np.clip(g * 1.6 + 8, 0, 255)
                g[::3, :] *= 0.6
                arr = np.stack([g, g * 0.18, g * 0.12], -1)
                img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
                d = ImageDraw.Draw(img)
                k = min(1, (T - tin) / 0.25)
                bw = int(W * (0.22 - 0.08 * k))
                cx, cy = W // 2, int(H * 0.48)
                for sx in (-1, 1):
                    for sy in (-1, 1):
                        x0, y0 = cx + sx * bw // 2, cy + sy * bw // 3
                        d.line([(x0, y0), (x0 - sx * W // 40, y0)], fill=(255, 80, 50), width=2)
                        d.line([(x0, y0), (x0, y0 - sy * W // 40)], fill=(255, 80, 50), width=2)
                d.text((cx + bw // 2 + 8, cy - bw // 3), f"TGT {int(9 + 40 * k):02d}.{int(T * 97) % 10}", font=font(H // 40), fill=(255, 90, 60))
            if fx == "fadein" and T - tin < 0.5:
                img = Image.blend(black, img, (T - tin) / 0.5)
            if fx == "strobe":
                beats = c.get("beats", [])
                if not any(0 <= T - b < 3 / FPS for b in beats):
                    img = black.copy()
            for ann in c.get("annotate", []):
                if ann["t0"] <= T - tin:
                    annotate(img, T - tin - ann["t0"], int(ann["x"] * W), int(ann["y"] * H), ann["lines"])
        p.stdin.write(img.tobytes())
    p.stdin.close()
    p.wait()


# ------------------------------------------------------------------ audio
def sound_bank():
    """Event name -> sample files, parsed from the game's SoundBank.ts."""
    txt = (GAME / "src" / "audio" / "SoundBank.ts").read_text(encoding="utf-8")
    bank = {}
    for m in re.finditer(r"'([a-z0-9_.]+)':\s*\{(.*?)\n  \},", txt, re.S):
        name, body = m.group(1), m.group(2)
        files = re.findall(r"audio/guns/([a-z0-9_]+)\.wav", body)
        for fam, cnt in re.findall(r"shots\('([a-z]+)',\s*(\d+)\)", body):
            files += [f"{fam}_close{i}" for i in range(int(cnt))]
        bank[name] = {"files": [f for f in files if not f.startswith("distant") and f != "tail_hall"],
                      "tail": "tail_hall" in body, "synth": re.findall(r"synth:\s*'([a-z_]+)'", body)}
    return bank


_cache = {}


def sample(name):
    if name in _cache:
        return _cache[name]
    p = GAME / "public" / "audio" / "guns" / f"{name}.wav"
    if p.exists():
        y, sr = sf.read(p)
        if y.ndim > 1:
            y = y.mean(1)
        if sr != SR:
            y = resample_poly(y, SR, sr)
    else:
        y = synth(name)
    _cache[name] = y
    return y


def bp(y, lo, hi):
    b, a = butter(2, [lo / (SR / 2), min(0.99, hi / (SR / 2))], "band")
    return lfilter(b, a, y)


def synth(kind, dur=1.5):
    t = np.arange(int(SR * dur)) / SR
    rng = np.random.default_rng(abs(hash(kind)) % 2**32)
    noise = rng.standard_normal(len(t))
    if kind.endswith("_punch"):
        f0 = {"shotgun_punch": 48, "pistol_punch": 70}.get(kind, 58)
        return 0.9 * np.sin(2 * np.pi * (f0 + 50 * np.exp(-t * 30)) * t) * np.exp(-t * 14) + 0.3 * bp(noise, 80, 900) * np.exp(-t * 30)
    if kind == "beep":
        return (np.sin(2 * np.pi * 1850 * t) * (t < 0.16) + 0.3 * np.sin(2 * np.pi * 3700 * t) * (t < 0.16)) * np.exp(-t * 4)
    if kind == "thud":
        return np.sin(2 * np.pi * (48 + 40 * np.exp(-t * 18)) * t) * np.exp(-t * 6) + 0.25 * bp(noise, 100, 1500) * np.exp(-t * 25)
    if kind == "servo":
        f = 700 + 900 * np.clip(t / 0.6, 0, 1) - 400 * np.clip((t - 0.7) / 0.4, 0, 1)
        ph = 2 * np.pi * np.cumsum(f) / SR
        y = (np.sin(ph) + 0.4 * np.sin(2 * ph) + 0.2 * np.sin(3.01 * ph)) * np.clip(t / 0.05, 0, 1) * np.clip((1.1 - t) / 0.1, 0, 1)
        return 0.35 * y * (t < 1.1)
    if kind == "breath_in":
        env = np.sin(np.pi * np.clip(t / 1.1, 0, 1)) ** 1.5
        return (bp(noise, 600, 1400) * 1.4 + bp(noise, 2000, 2700) * 0.8) * env * 1.4 * (t < 1.1)
    if kind == "breath_out":
        env = np.sin(np.pi * np.clip(t / 0.9, 0, 1)) ** 1.2
        valve = np.zeros_like(t)
        valve[: int(0.012 * SR)] = bp(noise[: int(0.012 * SR)], 1500, 6000) * 3
        flutter = 1 + 0.35 * np.sin(2 * np.pi * 23 * t)
        return (bp(noise, 400, 1100) * 1.6 + bp(noise, 1800, 2600) * 0.6) * env * flutter * 1.3 * (t < 0.9) + valve
    if kind == "rotor":
        # blade pass ~19 Hz amplitude modulation over low noise + main rotor thump 4.7 Hz
        t = np.arange(int(SR * 14)) / SR
        noise = rng.standard_normal(len(t))
        am = 0.55 + 0.45 * np.maximum(0, np.sin(2 * np.pi * 18.8 * t)) ** 3
        thump = np.maximum(0, np.sin(2 * np.pi * 4.7 * t)) ** 8
        low = bp(noise, 30, 260) * am * 2.2 + bp(noise, 300, 2500) * am * 0.35
        return low + 0.8 * np.sin(2 * np.pi * 38 * t) * thump
    if kind == "wind":
        t = np.arange(int(SR * 14)) / SR
        noise = rng.standard_normal(len(t))
        return bp(noise, 150, 1800) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.21 * t) ** 2)
    if kind == "roomtone":
        t = np.arange(int(SR * 14)) / SR
        noise = rng.standard_normal(len(t))
        hum = 0.25 * np.sin(2 * np.pi * 50 * t) + 0.12 * np.sin(2 * np.pi * 100 * t) + 0.05 * np.sin(2 * np.pi * 150 * t)
        return hum + bp(noise, 60, 400) * 0.5
    if kind == "rope":
        return bp(noise, 1500, 7000) * np.clip(t / 0.1, 0, 1) * np.clip((1.0 - t) / 0.2, 0, 1) * (t < 1.0) * 0.6
    if kind == "static":
        return bp(noise, 1200, 5000) * (t < 0.18) * 0.5 * (0.5 + 0.5 * (rng.random(len(t)) > 0.6))
    if kind == "clunk":
        return np.sin(2 * np.pi * (70 + 60 * np.exp(-t * 25)) * t) * np.exp(-t * 9) + 0.6 * bp(noise, 600, 4000) * np.exp(-t * 40)
    if kind == "hum_rise":
        f = 50 * (1 + 0.04 * t)
        return (0.3 * np.sin(2 * np.pi * f * t) + 0.15 * np.sin(4 * np.pi * f * t)) * np.clip(t / 2.0, 0, 1) * np.clip((8 - t) / 2, 0, 1)
    return np.zeros_like(t)


BANK = None
GUN_FAMILY = ("fire",)


def place(bus, y, T, gain_db=0.0, pan=0.0):
    i = int(T * SR)
    if i >= len(bus) or i + len(y) <= 0:
        return
    g = 10 ** (gain_db / 20)
    if i < 0:
        y = y[-i:]
        i = 0
    j = min(len(bus), i + len(y))
    l = np.cos((pan + 1) * np.pi / 4) * 1.414
    r = np.sin((pan + 1) * np.pi / 4) * 1.414
    bus[i:j, 0] += y[: j - i] * g * l
    bus[i:j, 1] += y[: j - i] * g * r


def render_audio(out_wav):
    global BANK
    BANK = sound_bank()
    music, _ = sf.read(ROOT / "build" / "music_edit.wav", always_2d=True)
    n = len(music)
    sfx = np.zeros((n, 2))
    duck = np.zeros(n)
    rng = np.random.default_rng(7)

    def gun_duck(T, depth=1.0):
        i = int(T * SR)
        d = np.r_[np.linspace(0, depth, 240), np.full(int(0.12 * SR), depth), np.linspace(depth, 0, int(0.2 * SR))]
        j = min(n, i + len(d))
        if i < n:
            duck[i:j] = np.maximum(duck[i:j], d[: j - i])

    # 1) Game sound events from the captures actually used in each slot.
    for sid, tin, tout, *_ in edl["shots"]:
        c = cut.get(sid)
        if not c or c.get("fx") == "black" or c.get("mute"):
            continue
        src = Source.get(c["src"])
        speed = c.get("speed", 1.0)
        a0 = c["at"]
        a1 = a0 + (tout - tin) * speed
        for e in src.meta.get("events", []):
            if not (a0 - 0.02 <= e["t"] < a1):
                continue
            # UI and hazard sounds aren't world sound; t~0 is spawn-time noise.
            if e["name"].startswith(("ui.", "hazard.", "equip.", "self.")) or (e["t"] < 0.05 and not e["name"].endswith(".fire")):
                continue
            T = tin + (e["t"] - a0) / speed
            spec = BANK.get(e["name"])
            if not spec:
                continue
            dist = e.get("distance") or 1.0
            att = -20 * np.log10(max(1.0, dist / 3.0)) * 0.6
            vol = 20 * np.log10(max(1e-3, e.get("volume", 1.0)))
            is_gun = e["name"].endswith(".fire")
            files = spec["files"]
            if files:
                place(sfx, sample(files[rng.integers(len(files))]), T, (-2 if is_gun else -6) + att + vol, rng.uniform(-0.25, 0.25))
            for s in spec["synth"]:
                if s.endswith("_punch"):
                    place(sfx, synth(s), T, -4 + att + vol)
            if spec["tail"]:
                place(sfx, sample("tail_hall"), T + 0.004, -11 + att * 0.5 + vol)
            if is_gun and dist < 6:
                gun_duck(T, 1.0)

    # 2) Designed sound for the cinematic slots (edl markers), and hero shots.
    for T, kind, g, pan in cut.get("_sfx", []):
        y = sample(kind)
        place(sfx, y, T, g, pan)
        if kind.endswith("_close0") or kind.endswith("_close1") or kind.startswith("boom") or kind.startswith("heavy"):
            gun_duck(T, 1.6)

    # 3) Beds: room tone under the cold open, rotor/wind under the insertion.
    for T0, T1, kind, g in cut.get("_beds", []):
        y = sample(kind)
        seg = y[: int((T1 - T0) * SR)]
        env = np.ones(len(seg))
        f = min(len(seg) // 3, int(0.8 * SR))
        env[:f] = np.linspace(0, 1, f)
        env[-f:] = np.linspace(1, 0, f)
        place(sfx, seg * env, T0, g)

    gain = 10 ** (-3.5 * duck / 20)
    out = music * gain[:, None] * 0.82 + sfx * 0.55
    # gentle bus limiter
    pk = np.abs(out).max()
    if pk > 0.98:
        out = np.tanh(out / pk * 1.4) / np.tanh(1.4) * 0.97
    sf.write(out_wav, out, SR, subtype="PCM_24")


if __name__ == "__main__":
    (ROOT / "build").mkdir(exist_ok=True)
    vid = ROOT / "build" / "_trailer_video.mp4"
    wav = ROOT / "build" / "trailer_mix.wav"
    render_audio(wav)
    print("audio ok")
    render_video(vid)
    print("video ok")
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([exe, "-y", "-loglevel", "error", "-i", str(vid), "-i", str(wav), "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
                    "-shortest", str(ROOT / "build" / "trailer.mp4")], check=True)
    print("wrote build/trailer.mp4")
