"""Phase 5 v0 rough cut: every shot from edl.json as a timed storyboard card over the
music edit, with temp SFX at the sync points and crude gun ducking.

Output: build/animatic.mp4 (1280x720, 30 fps) and build/animatic_mix.wav.
Captured footage replaces cards shot by shot: if frames/<ID>/ exists it is used instead.
"""
import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw, ImageFont
from scipy.signal import resample_poly

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
GAME_AUDIO = ROOT.parent / "public" / "audio" / "guns"
SR = 48000
W, H, FPS = 1280, 720, 30
FONT = "C:/Windows/Fonts/bahnschrift.ttf"
MONO = "C:/Windows/Fonts/consola.ttf"

TYPE_COL = {"GP": (90, 200, 120), "CIN": (90, 150, 230), "MG": (235, 170, 60), "-": (90, 90, 90)}
ACT_NAMES = {"I": "COLD OPEN", "II": "INSERTION", "III": "BUILD", "IV": "FIRST CONTACT", "V": "THREAT",
             "VI": "CO-OP", "VII": "RESET", "VIII": "CLIMAX", "IX": "STANDOFF", "X": "TITLE"}

# Temp SFX: (T, file or synth id, gain dB, is_gun)
def temp_sfx():
    ev = [
        (1.9, "@servo", -26, False),
        (5.75, "rel_magin", -4, False), (7.30, "rel_boltback", -5, False), (7.52, "rel_boltforward", -4, False),
        (12.55, "gear2", -6, False), (12.6, "metal_hit0", -20, False),
        (17.65, "metal_clang", -10, False), (17.65, "@thud", -4, False),
        (23.45, "@beep", -14, False), (25.0, "metal_hit0", -16, False),
        (32.033, "ar_close0", -1, True), (33.40, "ar_close1", -3, True), (33.42, "metal_hit0", -8, False),
        (34.60, "ar_close2", -3, True), (34.80, "ar_close3", -3, True),
        (36.90, "rel_magout", -5, False), (37.45, "rel_magin", -5, False),
        (38.35, "ar_close0", -3, True), (38.37, "metal_hit1", -6, False),
        (40.30, "bolt_close0", -2, True), (40.80, "bolt_open", -6, False), (41.05, "bolt_close", -6, False),
        (44.10, "metal_hit2", -10, False), (44.55, "metal_hit2", -10, False),
    ]
    ev += [(44.85 + i * 0.1, f"ak_close{i % 4}", -4, True) for i in range(7)]
    ev += [(46.85 + i * 0.22, f"pistol_close{i % 3}", -4, True) for i in range(3)]
    ev += [(50.498, "ak_close1", -1, True), (50.85, "ar_close1", -4, True), (51.2, "ak_close2", -4, True)]
    ev += [(51.70 + i * 0.16, f"{'ak' if i % 2 else 'ar'}_close{i % 4}", -5, True) for i in range(6)]
    ev += [(52.85 + i * 0.075, f"ar_close{i % 4}", -6, True) for i in range(12)]
    ev += [(54.1, "rel_magout", -6, False), (54.6, "rel_magin", -6, False)]
    ev += [(55.15, "ak_close0", -5, True), (55.3, "ar_close2", -5, True), (55.5, "metal_hit0", -8, False)]
    ev += [(59.666, "boom_close0", 0, True), (59.68, "metal_clang", -6, False), (60.45, "pump", -2, False)]
    ev += [(62.1, "ar_close3", -5, True), (62.3, "ar_close0", -5, True)]
    ev += [(64.3 + i * 0.12, f"ak_close{i % 4}", -6, True) for i in range(18)]
    fill = [66.494, 66.778, 67.063, 67.353, 67.498, 67.678, 67.922, 68.206, 68.491, 68.781, 69.002, 69.182, 69.286]
    fills = ["rel_magin", "round_in", "rel_boltforward", "metal_hit0", "@beep", "metal_hit1", "gear4",
             "metal_hit0", "metal_hit0", "metal_hit2", "metal_hit0", "@beep", "ar_close0"]
    ev += [(t, f, -10, f.endswith("0") and "close" in f) for t, f in zip(fill, fills)]
    ev += [(69.40, "@breath", -12, False), (71.297, "@thud", -10, False), (72.0, "rel_magout", -8, False),
           (72.6, "@thud", -8, False), (73.584, "rel_magin", 0, False), (74.9, "@breath", -12, False)]
    ev += [(78.065 + i * 0.075, f"ar_close{i % 4}", -3 if i == 0 else -6, True) for i in range(13)]
    ev += [(79.25 + i * 0.1, f"ak_close{i % 4}", -6, True) for i in range(9)]
    ev += [(81.6, "rel_magout", -6, False), (82.1, "rel_magin", -6, False), (82.4, "rel_boltforward", -6, False)]
    ev += [(83.8 + i * 0.09, f"mg_close{i % 4}", -6, True) for i in range(10)]
    ev += [(88.4 + i * 0.075, f"ar_close{i % 4}", -5, True) for i in range(12)]
    for b in [89.469, 90.040, 90.612, 91.184, 91.755, 92.327, 92.898, 93.469]:
        ev.append((b, "ak_close2", -5, True))
    for b in [94.041, 94.612, 95.184]:
        ev.append((b, "heavy_close0", -3, True))
    ev += [(95.776, "boom_close1", -3, True), (96.061, "ak_close0", -4, True), (96.345, "boom_close0", 0, True),
           (96.630, "ar_close1", -3, True)]
    ev += [(97.2, "@servo", -20, False), (99.4, "@beep", -10, False), (100.300, "heavy_close1", 0, True),
           (100.31, "tail_hall", -2, False), (101.70, "power_out", -10, False)]
    return ev


def synth(kind):
    t = np.arange(int(SR * 1.2)) / SR
    if kind == "@beep":
        y = np.sin(2 * np.pi * 1850 * t) * np.exp(-t * 9) * (t < 0.35)
        y += 0.3 * np.sin(2 * np.pi * 3700 * t) * np.exp(-t * 20)
    elif kind == "@thud":
        y = np.sin(2 * np.pi * (55 + 40 * np.exp(-t * 20)) * t) * np.exp(-t * 7)
    elif kind == "@servo":
        f = 900 + 500 * np.minimum(t / 0.8, 1)
        y = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * 0.3 * np.sin(np.pi * np.minimum(t / 1.0, 1))
    elif kind == "@breath":
        n = np.random.default_rng(1).standard_normal(len(t))
        from scipy.signal import butter, lfilter
        b, a = butter(2, [700 / (SR / 2), 2600 / (SR / 2)], "band")
        y = lfilter(b, a, n) * np.sin(np.pi * np.minimum(t / 1.1, 1)) ** 2 * 3
    else:
        y = np.zeros_like(t)
    return np.stack([y, y], 1)


def load(name, cache={}):
    if name in cache:
        return cache[name]
    if name.startswith("@"):
        y = synth(name)
    else:
        y, sr = sf.read(GAME_AUDIO / f"{name}.wav", always_2d=True)
        if y.shape[1] == 1:
            y = np.repeat(y, 2, 1)
        if sr != SR:
            y = resample_poly(y, SR, sr, axis=0)
    cache[name] = y
    return y


def mix(edl):
    music, _ = sf.read(ROOT / "build" / "music_edit.wav", always_2d=True)
    n = len(music)
    sfx = np.zeros_like(music)
    duck = np.zeros(n)
    for T, name, gdb, gun in temp_sfx():
        y = load(name) * 10 ** (gdb / 20)
        i = int(T * SR)
        j = min(n, i + len(y))
        sfx[i:j] += y[: j - i]
        if gun:
            tail = load("tail_hall") * 10 ** ((gdb - 13) / 20)
            k = min(n, i + 200 + len(tail))
            sfx[i + 200:k] += tail[: k - i - 200]
            d = np.r_[np.linspace(0, 1, 240), np.ones(int(0.12 * SR)), np.linspace(1, 0, int(0.18 * SR))]
            j = min(n, i + len(d))
            duck[i:j] = np.maximum(duck[i:j], d[: j - i])
    gain = 10 ** (-3.5 * duck / 20)
    out = music * gain[:, None] * 0.85 + sfx * 0.7
    pk = np.abs(out).max()
    if pk > 0.97:
        out *= 0.97 / pk
    sf.write(ROOT / "build" / "animatic_mix.wav", out, SR, subtype="PCM_24")
    return out


def cards(edl):
    big = ImageFont.truetype(FONT, 64)
    mid = ImageFont.truetype(FONT, 34)
    small = ImageFont.truetype(FONT, 22)
    mono = ImageFont.truetype(MONO, 20)
    out = {}
    for sid, tin, tout, typ, act, title, cam in edl["shots"]:
        img = Image.new("RGB", (W, H), (0, 0, 0) if typ == "-" else (14, 15, 17))
        d = ImageDraw.Draw(img)
        col = TYPE_COL.get(typ, (120, 120, 120))
        if typ != "-":
            d.rectangle([60, 70, 66, 250], fill=col)
            d.text((90, 62), sid, font=big, fill=(235, 235, 235))
            d.text((90 + d.textlength(sid, font=big) + 24, 92), f"{typ}  ·  ACT {act} {ACT_NAMES[act]}", font=small, fill=col)
            d.text((90, 160), title, font=mid, fill=(220, 220, 220))
            d.text((90, 210), cam, font=small, fill=(140, 140, 140))
        else:
            d.text((90, 92), f"{sid} · {title}", font=small, fill=(70, 70, 70))
            d.text((90, 124), cam, font=small, fill=(55, 55, 55))
        d.text((90, 600), f"{tin:7.3f} – {tout:7.3f}  ({tout - tin:.2f}s)", font=mono, fill=(110, 110, 110))
        out[sid] = img
    return out


_meta = {}


def footage_frame(sid, t_local):
    """Captured frame at shot-local time t_local, if frames/<sid>/ exists (skips the head handle)."""
    d = ROOT / "frames" / sid
    if sid not in _meta:
        files = sorted(list(d.glob("*.jpg")) + list(d.glob("*.png"))) if d.exists() else []
        ev = ROOT / "build" / "events" / f"{sid}.json"
        meta = json.loads(ev.read_text()) if ev.exists() else {"fps": 30, "handles": 0.25}
        _meta[sid] = (files, meta)
    files, meta = _meta[sid]
    if not files:
        return None
    k = int(round((t_local + meta["handles"]) * meta["fps"]))
    f = files[max(0, min(k, len(files) - 1))]
    return Image.open(f).convert("RGB").resize((W, H), Image.LANCZOS)


def render(edl):
    card = cards(edl)
    gun_times = sorted(T for T, _, _, gun in temp_sfx() if gun)
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    n = int(edl["duration"] * FPS)
    cmd = [exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
           "-i", "-", "-i", str(ROOT / "build" / "animatic_mix.wav"), "-c:v", "libx264", "-crf", "20",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-shortest", str(ROOT / "build" / "animatic.mp4")]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    shots = edl["shots"]
    si = 0
    gi = 0
    acts = []
    for s in shots:
        if not acts or acts[-1][0] != s[4]:
            acts.append([s[4], s[1], s[2]])
        acts[-1][2] = s[2]
    for f in range(n):
        T = f / FPS
        while si < len(shots) - 1 and T >= shots[si][2] - 1e-9:
            si += 1
        s = shots[si]
        img = footage_frame(s[0], T - s[1]) or card[s[0]].copy()
        d = ImageDraw.Draw(img)
        while gi < len(gun_times) and gun_times[gi] < T - 2 / FPS:
            gi += 1
        if gi < len(gun_times) and abs(T - gun_times[gi]) < 1.5 / FPS and s[3] != "-":
            img = Image.new("RGB", (W, H), (255, 236, 205))
            d = ImageDraw.Draw(img)
        # timeline strip
        y0 = H - 40
        for a, t0, t1 in acts:
            x0, x1 = 60 + (W - 120) * t0 / edl["duration"], 60 + (W - 120) * t1 / edl["duration"]
            d.rectangle([x0 + 1, y0, x1 - 1, y0 + 6], fill=(45, 45, 48) if a != s[4] else (120, 120, 125))
        x = 60 + (W - 120) * T / edl["duration"]
        d.rectangle([x - 1, y0 - 6, x + 1, y0 + 12], fill=(255, 74, 28))
        p.stdin.write(img.tobytes())
    p.stdin.close()
    p.wait()


if __name__ == "__main__":
    edl = json.loads((ROOT / "edl.json").read_text())
    mix(edl)
    render(edl)
    print("wrote build/animatic.mp4")
