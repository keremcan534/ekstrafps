"""Reveal trailer v4: the polished cut of v3 ("Abandoned Complex", 112 BPM, same grid,
same single music edit, the music stops only on the Warden's shot).

What changed from v3 (the review: buggy animation, broken transitions, the same scene
over and over, gunfire repeated for no reason):

  - Continuity, not montage. A take is cut as one action seen from several angles
    (`chain`): each camera picks up where the last one left the take's own clock, so a hit
    lands from a new angle instead of the same moment being shown again. A camera is never
    used twice on overlapping take time, and gunfire only where it carries a beat.
  - A story: robots -> the squad fights -> SABLE breaches -> the squad dies (CR: a low
    dolly over the bodies in their blood) -> the Warden hunts the last of you -> the
    climax -> the ending among your dead.
  - Effects on the game image (tools/fx.py): a grade per act, film grain, gunshot kick and
    chromatic pulse driven by the logged fire events, slow motion on hero hits (60 fps
    source), SABLE night-vision POV, radio/NVG glitches, whip pans, a heartbeat vignette
    in the ending.
  - Transitions by purpose: cut (default), flash (drops and impacts only), whip (climax),
    glitch (SABLE), dip (to black), dissolve (the insertion).

python tools/flow4.py --windows   -> build/flow4_windows.json + build/flow4_queue.txt
python tools/flow4.py --sheet     -> build/flow4_keyframes.jpg
python tools/flow4.py --audio     -> build/v4_mix.wav (+ build/flow4_levels.json)
python tools/flow4.py             -> build/trailer_v4.mp4
"""
import json
import subprocess
import sys

MODE = sys.argv[1] if len(sys.argv) > 1 else ""
sys.argv = [sys.argv[0], "1280", "720"]
import assemble as A  # noqa: E402
import fx  # noqa: E402
import imageio_ffmpeg  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from scipy.signal import butter, lfilter, resample_poly  # noqa: E402

ROOT = A.ROOT
W, H, FPS, SR = A.W, A.H, A.FPS, A.SR

# ------------------------------------------------------------------ music grid (track seconds)
BEAT = 0.535714
G0 = 34.501
DROP = 33.965


def tbeat(n):
    return G0 + n * BEAT


def tbar(k):
    return DROP + k * 4 * BEAT


SPLICE = tbar(24)
SRC2 = tbar(63)
OFF2 = SRC2 - SPLICE


def T_of(track):
    return track if track < SPLICE + 1e-6 else track - OFF2


def bar(k):
    return T_of(tbar(k))


def hb(k, j=0):
    """Bar k's downbeat + j beats (trailer time)."""
    return bar(k) + j * BEAT


CHORD = T_of(188.252)
HITS = [T_of(t) for t in (187.18, 187.45, 187.72, 187.99)]
SHOT = CHORD + 10 * BEAT
TITLE = SHOT + 0.96
END = TITLE + 4.4

# ------------------------------------------------------------------ takes
_ev = {}


def meta(take):
    if take not in _ev:
        p = ROOT / "build" / "events" / f"{take}.json"
        _ev[take] = json.loads(p.read_text()) if p.exists() else {"fps": 60, "handles": 0, "duration": 10, "events": []}
    return _ev[take]


def fires(take, near_cam=True):
    return sorted(set(e["t"] for e in meta(take)["events"] if e["name"].endswith(".fire") and e["t"] > 0.05 and (not near_cam or (e.get("distance") or 0) <= 3.5)))


def first_fire(take, after=0.0, default=None):
    return next((t for t in fires(take) if t > after), default)


_rows = {}


def rows(src):
    if src not in _rows:
        p = ROOT / "build" / "rows" / f"{src}.json"
        _rows[src] = {int(k): v for k, v in json.loads(p.read_text()).items()} if p.exists() else {}
    return _rows[src]


# ------------------------------------------------------------------ the cut
ROOMS = {"FC": "ASSEMBLY HALL", "SV": "SERVER HALL", "LB": "R&D LABS", "PW": "POWER PLANT", "HG": "HANGAR", "AT": "ATRIUM", "WH": "WAREHOUSE"}
SABLE_TAGS = {"BD": "SABLE / BLACK DIVISION", "SB": "SABLE / THE WARDEN"}
LOOK = {"A0": "steel", "IN": "steel", "BD": "sable", "SB": "sable", "CR": "sable", "WD": "end"}

A03_CLICK, A04_BACK, BD_BREACH = 0.55, 0.70, 1.2
fc0 = first_fire("FC", 3.0, 4.6)
sg = fires("SG") or [3.28, 6.43]
wd_shot = next((e["t"] for e in meta("WD")["events"] if e["name"].endswith(".fire") and e["t"] > 6.0), 7.22)

S = []


def shot(T, src, at=None, tag=None, tr="cut", speed=1.0, fxs=(), **o):
    S.append({"T": T, "src": src, "at": at, "tag": tag, "tr": tr, "speed": speed, "fx": list(fxs), **o})


def chain(at0, steps, speed=1.0):
    """One action, several angles: steps = [(T, src, tr, extra)], source time continuous
    from at0 at the first T (each camera picks up the take's clock where the last left it)."""
    T0 = steps[0][0]
    for T, src, tr, *extra in steps:
        kw = extra[0] if extra else {}
        shot(T, src, at0 + (T - T0) * kw.get("speed", speed), kw.pop("tag", None), tr, kw.pop("speed", speed), kw.pop("fx", ()), **kw)


# I. Cold open: the rifle in the dark, the Warden on the net.
shot(0.00, "A02", 0.20, None, "fade")
shot(hb(-15), "A03", A03_CLICK - BEAT)
shot(hb(-15, 3), "A05", 0.0)
shot(hb(-13), "A04", A04_BACK - BEAT)
shot(hb(-13, 3), None, tr="black")
# II. Insertion, one descent: searchlight, rope, boots hit, the team, the mask, the turn.
chain(2.5, [(hb(-12), "IN-tilt", "dissolve", {"tag": "SITE-9 / VANTA DYNAMICS RESEARCH CAMPUS"}),
            (hb(-11), "IN-rope", "cut"), (hb(-11, 2), "IN-land", "cut"), (hb(-10), "IN-team", "cut"),
            (hb(-9), "IN-mask", "dissolve"), (hb(-9, 2), "IN-turn", "cut")])
# III. Drums: the machines wake; the walk in (no gunfire before the drop).
chain(1.45, [(hb(-8), "RB-visor", "flash"), (hb(-8, 2), "RB-servo", "cut")])
shot(hb(-7), "FC-ots", 0.4, "auto")
shot(hb(-6), "RB-chest", 2.45)
shot(hb(-5), "SV-front", 0.0, "auto", "dip")
shot(hb(-4), "RB-wide", 3.0)
shot(hb(-3), "RB-far", 3.0)
# The bass drops out: hold the aim down the aisle; two dark beats; the drop is the first shot.
shot(hb(-2), "FC-pov", fc0 - 0.02 - (hb(0) - hb(-2)), None, "dip")
shot(hb(-1, 2), None, tr="black")
# IV. Contact. Each beat one action, two angles, picked up on the take's clock.
chain(fc0 - 0.02, [(hb(0), "FC-pov", "flash"), (hb(0, 2), "FC-low", "cut")])
chain(sg[0] - 0.15, [(hb(1), "SG-pov", "cut"), (hb(1, 1), "SG-side", "cut")])
chain(2.4, [(hb(2), "WH-pov", "cut", {"tag": "auto"}), (hb(2, 2), "WH-mate", "cut")])
shot(hb(3), "SV-pov", 6.2, "auto")
chain(0.45, [(hb(4), "LB-mate", "cut", {"tag": "auto"}), (hb(4, 2), "LB-pov", "cut")])
shot(hb(5), "PW-pov", 3.3, "auto")
chain(0.0, [(hb(6), "HG-side", "cut", {"tag": "auto"}), (hb(6, 2), "HG-pov", "cut")])
shot(hb(7), "AT-pov", 0.0, "auto")
# Bars 8-10: the second blast in slow motion, then the squad holding the line.
chain(sg[1] - 0.12, [(hb(8), "SG-pov", "flash"), (hb(8, 2), "SG-side", "cut")], speed=0.5)
chain(3.85, [(hb(9), "SQ-mate", "cut"), (hb(9, 2), "SQ-robo", "cut"), (hb(10), "SQ-pov", "cut")])
shot(hb(10, 2), "AT-pov", 2.7)
# V. The alarm (bar 11): siren, the evacuation PA; the power fails.
shot(hb(11), "AT-side", 0.0, None, "dip")
shot(hb(12), "LB-mate", 3.6)
shot(hb(13), "FC-ots", 7.2)
shot(hb(13, 2), None, tr="black")
# VI. SABLE (bars 14-18), one continuous breach through their eyes and ours.
chain(BD_BREACH - BEAT, [(hb(13, 3), "BD-breach", "cut", {"tag": "auto"}), (hb(14, 2), "BD-eyes", "glitch", {"fx": ["nvg"]}),
                         (hb(15), "BD-nvg", "cut"), (hb(15, 2), "BD-ots", "cut"), (hb(16), "BD-pov", "flash"),
                         (hb(16, 2), "BD-breach", "cut"), (hb(17), "BD-eyes", "glitch", {"fx": ["nvg"]}), (hb(17, 2), "BD-low", "cut")])
chain(10.3, [(hb(18), "SQ-mate", "cut"), (hb(18, 2), "SQ-front", "cut")])
# VII. The dead, and the Warden (bars 19-23).
shot(hb(19), "CR-dolly", 0.4, None, "whip")
chain(3.6, [(hb(20), "CR-boots", "cut"), (hb(20, 2), "CR-face", "cut")])
shot(hb(21), "SB-eyes", 1.5, "auto", "glitch", fxs=["nvg"])
chain(3.64, [(hb(22), "SB-warden", "cut"), (hb(23), "SB-column", "cut"), (hb(23, 2), "SB-peek", "cut")])
# ---- music edit, bar 63 (build): the Warden draws down in slow motion; fires on the downbeat.
shot(hb(63), "SB-warden", 7.95, None, "cut", speed=0.6)
# VIII. The climax (bars 64-71): one action a bar, two angles, whip pans between bars.
chain(9.2, [(hb(64), "SB-column", "flash"), (hb(64, 2), "SB-side", "cut")])
shot(hb(65), "HG-pov", 4.1, None, "whip")
chain(6.3, [(hb(66), "PW-pov", "whip"), (hb(66, 2), "PW-front", "cut")])
shot(hb(67), "RB-wide", 5.15, None, "whip")
chain(5.0, [(hb(68), "WH-pov", "whip"), (hb(68, 2), "WH-mate", "cut")])
shot(hb(69), "CR-hand", 2.0, None, "dip")
shot(hb(69, 2), "LB-pov", 9.2)
shot(hb(70), "WD-mask", 1.4, None, "dip")
shot(hb(71), "SV-pov", 10.6)
for T, src, at in zip(HITS, ["BD-ots", "SQ-front", "BD-pov", "SQ-pov"], [7.0, 12.0, 8.0, 12.2]):
    shot(T, src, at, None, "flash")
# IX. The ending, on the chord: on the floor among your dead; he walks up, speaks, fires.
shot(CHORD, "WD-floor", wd_shot - (SHOT - CHORD), None, "dip")
shot(CHORD + 6 * BEAT, "WD-mask", wd_shot - (SHOT - (CHORD + 6 * BEAT)))
shot(CHORD + 8 * BEAT, "WD-floor", wd_shot - (SHOT - (CHORD + 8 * BEAT)))
shot(SHOT, None, tr="white")
shot(SHOT + 2 / FPS, None, tr="black")
shot(TITLE, "TITLE", tr="title")
S.sort(key=lambda p: p["T"])

shots = []
for i, s in enumerate(S):
    s["T1"] = S[i + 1]["T"] if i + 1 < len(S) else END
    shots.append(s)
last_room, numbered = None, {}
for s in shots:
    room = s["src"].split("-")[0] if s["src"] and s["src"] != "TITLE" else None
    if s["tag"] == "auto":
        if room in SABLE_TAGS:
            s["tag"] = SABLE_TAGS[room] if room != last_room else None
        elif room in ROOMS and room not in numbered:
            numbered[room] = len(numbered) + 1
            s["tag"] = f"{numbered[room]:02d} / {ROOMS[room]}"
        else:
            s["tag"] = None
    if room in ROOMS or room in SABLE_TAGS:
        last_room = room


def span(s):
    """Source-time interval a shot shows."""
    return s["at"], s["at"] + (s["T1"] - s["T"]) * s["speed"]


def check():
    """No camera on overlapping take time twice; at most two uses per camera; usable rows."""
    by, warn = {}, []
    for s in shots:
        if s["src"] and s["src"] != "TITLE":
            by.setdefault(s["src"], []).append(span(s))
    for src, sp in by.items():
        if len(sp) > 2 and not src.startswith(("WD", "A0")):
            warn.append(f"{src} used {len(sp)}x")
        sp.sort()
        for (a0, a1), (b0, b1) in zip(sp, sp[1:]):
            if b0 < a1 - 0.05 and not src.startswith("WD"):
                warn.append(f"{src} overlaps itself {a0:.2f}-{a1:.2f} / {b0:.2f}-{b1:.2f}")
        r = rows(src)
        for a, b in sp:
            bad = [v["t"] for v in r.values() if a - 0.02 <= v["t"] <= b + 0.02 and v["flag"]]
            if bad:
                warn.append(f"{src} {a:.2f}-{b:.2f} flagged at {bad[:4]}")
    return warn


# ------------------------------------------------------------------ capture windows
def windows():
    win = {}
    for i, s in enumerate(shots):
        if not s["src"] or s["src"] == "TITLE":
            continue
        a, b = span(s)
        a -= 0.04
        b += 0.06
        nxt = shots[i + 1] if i + 1 < len(shots) else None
        if nxt and nxt["tr"] in ("dissolve", "whip"):
            b += 0.45 * s["speed"]
        win.setdefault(s["src"], []).append([round(max(a, -0.25), 2), round(b, 2)])
    for k, ws in win.items():
        ws.sort()
        merged = [ws[0]]
        for a, b in ws[1:]:
            if a <= merged[-1][1] + 0.3:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        win[k] = merged
    return win


# ------------------------------------------------------------------ gunshot kicks from events
def kicks(s):
    """(trailer time, strength) of every gunshot / blast the shot shows, from the take's log."""
    if not s["src"] or s["src"] == "TITLE":
        return []
    take = s["src"].split("-")[0]
    a0, a1 = span(s)
    pov = s["src"].endswith("pov")
    out = []
    for e in meta(take)["events"]:
        if not (a0 - 0.05 <= e["t"] < a1):
            continue
        n = e["name"]
        d = e.get("distance") or 99
        if n.endswith(".fire"):
            k = 1.0 if (pov and d <= 3.5) else 0.55 if d < 6 else 0.25 if d < 15 else 0
        elif n.startswith("explosion") or n == "impact.heavy":
            k = 1.6
        else:
            continue
        if k:
            out.append((s["T"] + (e["t"] - a0) / s["speed"], k))
    if s["src"] == "BD-breach" and a0 <= BD_BREACH <= a1:
        out.append((s["T"] + (BD_BREACH - a0) / s["speed"], 2.0))
    return out


for s in shots:
    s["kicks"] = kicks(s)


def kick_at(s, T):
    dx = dy = rot = ab = ex = 0.0
    for tk, k in s["kicks"]:
        d = T - tk
        if 0 <= d < 0.35:
            e = np.exp(-d * 13) * k
            ph = tk * 17.3
            dx += np.sin(ph) * 9 * e
            dy += (np.cos(ph * 1.3) * 5 - 4) * e
            rot += np.sin(ph * 0.7) * 0.006 * e
            ab += 3.5 * np.exp(-d * 22) * k
            ex += 0.12 * np.exp(-d * 30) * k
    return dx, dy, rot, min(ab, 7), min(ex, 0.3)


# ------------------------------------------------------------------ motion design
def tag_overlay(img, t, text):
    if t > 2.0:
        return
    d = ImageDraw.Draw(img, "RGBA")
    a = min(1, t / 0.2) * (1 if t < 1.6 else max(0, 1 - (t - 1.6) / 0.4))
    x, y = int(W * 0.06), int(H * 0.80)
    L = int(W * 0.11 * min(1, t / 0.3))
    d.line([(x, y), (x + L, y)], fill=(255, 74, 28, int(255 * a)), width=2)
    f = A.font(int(H * 0.03))
    yy = y - int(H * 0.045) + int(10 * max(0, 1 - t / 0.35))
    num, _, name = text.partition(" / ")
    d.text((x, yy), num, font=f, fill=(255, 74, 28, int(230 * a)))
    d.text((x + d.textlength(num + "  ", font=f), yy), name, font=f, fill=(235, 236, 238, int(235 * a)))


def letterbox(img, k=1.0):
    bar_ = int((H - W / 2.2) / 2 * k)
    if bar_ > 0:
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W, bar_], fill=(0, 0, 0))
        d.rectangle([0, H - bar_, W, H], fill=(0, 0, 0))
    return img


def drift(img, lt, dur, push=0.05):
    z = 1.0 + push * min(1, lt / max(dur, 0.5))
    if z <= 1.0005:
        return img
    cw, ch = W / z, H / z
    x0, y0 = (W - cw) / 2, (H - ch) / 2
    return img.crop((int(x0), int(y0), int(x0 + cw), int(y0 + ch))).resize((W, H), Image.BILINEAR)


def look_of(s):
    return LOOK.get((s["src"] or "")[:2], "site9")


def raw(s, T):
    """The shot's own image at trailer time T: frame, drift, kick, effects, grade (no transition)."""
    lt = T - s["T"]
    img = A.Source.get(s["src"]).frame(s["at"] + lt * s["speed"])
    img = drift(img, lt, s["T1"] - s["T"])
    a = np.asarray(img, np.float32)
    dx, dy, rot, ab, ex = kick_at(s, T)
    a = fx.shake(a, dx, dy, rot)
    if "nvg" in s["fx"]:
        a = fx.nvg(a, int(T * FPS))
    else:
        a = fx.grade(a, look_of(s))
    a = fx.aberrate(a * (1 + ex), ab)
    return a


def heartbeat(T):
    """0..1 pulse at 66 bpm (a double thump) through the ending."""
    if T < CHORD:
        return 0.0
    p = ((T - CHORD) * 66 / 60) % 1
    return np.exp(-p * 14) + 0.6 * np.exp(-max(0, p - 0.18) * 16) * (p > 0.18)


def short_title(t):
    img = A.title_card(t * 1.25, "SITE-9", "TACTICAL CO-OP FPS", None)
    if t > END - TITLE - 0.9:
        img = Image.blend(img, Image.new("RGB", (W, H)), min(1, (t - (END - TITLE - 0.9)) / 0.8))
    return img


def frame_at(T, si):
    s = shots[si]
    lt = T - s["T"]
    f = int(round(T * FPS))
    if s["tr"] == "title":
        a = np.asarray(short_title(lt), np.float32)
        return Image.fromarray(np.clip(fx.grain(a, f, 4.0), 0, 255).astype(np.uint8))
    if s["tr"] == "black":
        return Image.new("RGB", (W, H))
    if s["tr"] == "white":
        return Image.new("RGB", (W, H), (255, 250, 242))
    a = raw(s, T)
    prev = shots[si - 1] if si > 0 else None
    has_prev = prev and prev["src"] not in (None, "TITLE")
    tr = s["tr"]
    if tr == "fade" and lt < 1.2:
        a = a * (lt / 1.2)
    elif tr == "dip" and lt < 0.35:
        a = a * (lt / 0.35) ** 1.5
    elif tr == "dissolve" and lt < 0.4 and has_prev:
        k = lt / 0.4
        a = raw(prev, T) * (1 - k) + a * k
    elif tr == "flash" and lt < 0.12:
        a = a + (np.array([255, 244, 230], np.float32) - a) * 0.5 * (1 - lt / 0.12)
    elif tr == "whip" and lt < 0.2 and has_prev:
        k = lt / 0.2
        a = fx.whip(raw(prev, T), a, k)
    elif tr == "glitch" and lt < 0.14:
        a = fx.glitch(a, f, 1.0 - lt / 0.14)
    # Radio / NVG crackle: a few torn frames at random inside the NVG POV shots.
    if "nvg" in s["fx"] and (f % 23) in (0, 1) and lt > 0.3:
        a = fx.glitch(a, f, 0.35)
    hb_ = heartbeat(T)
    a = fx.vignette(a, 0.32 + 0.45 * hb_)
    a = fx.grain(a, f, 4.5 if "nvg" not in s["fx"] else 2.0)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    if s["tag"]:
        tag_overlay(img, lt, s["tag"])
    k = min(1, max(0, (T - (bar(-12) - 0.3)) / 0.6))
    return letterbox(img, k)


def render_video(path, T0=0.0, T1=None):
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    T1 = END if T1 is None else T1
    p = subprocess.Popen([exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                          "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    si = 0
    for f in range(int(T0 * FPS), int(T1 * FPS)):
        T = f / FPS
        while si < len(shots) - 1 and T >= shots[si + 1]["T"] - 1e-9:
            si += 1
        p.stdin.write(frame_at(T, si).tobytes())
    p.stdin.close()
    p.wait()


def key_sheet(path):
    cells = [(i, s) for i, s in enumerate(shots) if s["src"] and s["src"] != "TITLE"]
    tw, th, cols = 256, 144, 8
    sheet = Image.new("RGB", (cols * tw, ((len(cells) + cols - 1) // cols) * th), (20, 20, 22))
    f = A.font(13)
    for k, (i, s) in enumerate(cells):
        T = s["T"] + 0.45 * (s["T1"] - s["T"])
        im = frame_at(T, i).resize((tw, th))
        d = ImageDraw.Draw(im)
        d.text((4, th - 34), f"{s['T']:.2f}  {s['src']}  {s['tr']}", font=f, fill=(255, 200, 0))
        d.text((4, th - 18), f"@{s['at']:.2f}  {s['T1'] - s['T']:.2f}s" + (f"  x{s['speed']}" if s["speed"] != 1 else ""), font=f, fill=(200, 200, 200))
        sheet.paste(im, ((k % cols) * tw, (k // cols) * th))
    sheet.save(path, quality=88)


# ------------------------------------------------------------------ sound
def voice(name):
    y, vsr = sf.read(A.GAME / "public" / "audio" / "voice" / f"{name}.wav")
    if y.ndim > 1:
        y = y.mean(1)
    return resample_poly(y, SR, vsr) if vsr != SR else y


def band(y, lo, hi, order=4):
    b_, a_ = butter(order, [lo / (SR / 2), hi / (SR / 2)], "band")
    return lfilter(b_, a_, y)


def radio(y):
    y = band(y, 420, 3300)
    return np.tanh(y / (np.abs(y).max() + 1e-9) * 2.4) / np.tanh(2.4)


def pa(y, wet):
    y = band(y, 350, 3800)
    y = np.tanh(y / (np.abs(y).max() + 1e-9) * 3.2) / np.tanh(3.2)
    out = np.zeros(len(y) + int(1.2 * SR))
    for delay, g in [(0, 1.0), (0.085, 0.38 * wet), (0.21, 0.26 * wet), (0.43, 0.16 * wet), (0.71, 0.09 * wet)]:
        i = int(delay * SR)
        out[i:i + len(y)] += y * g
    return out


def whoosh(dur=0.35, up=True):
    t = np.arange(int(dur * SR)) / SR
    n = np.random.default_rng(int(dur * 1000) + up).standard_normal(len(t))
    out = np.zeros_like(n)
    # A band that sweeps (up or down) through the pass.
    for i, (lo, hi) in enumerate([(300, 900), (900, 2500), (2500, 6000)]):
        env = np.exp(-((t / dur - (i / 2 if up else 1 - i / 2)) ** 2) / 0.05)
        out += band(n, lo, hi, 2) * env
    return out * np.sin(np.pi * np.clip(t / dur, 0, 1)) * 0.8


def crackle(dur=0.18, seed=0):
    r = np.random.default_rng(seed)
    t = np.arange(int(dur * SR)) / SR
    n = band(r.standard_normal(len(t)), 900, 7000, 2)
    gate = (r.random(len(t) // 240 + 1) > 0.45).repeat(240)[: len(t)]
    return n * gate * np.exp(-t * 6)


def music_bed(n):
    src, sr = sf.read(ROOT / "music" / "abandoned.wav", always_2d=True)
    if sr != SR:
        src = resample_poly(src, SR, sr, axis=0)
    a = src[: int(SPLICE * SR)]
    b_ = src[int(SRC2 * SR):]
    xf = int(0.015 * SR)
    ramp = np.linspace(0, 1, xf)[:, None]
    joined = np.concatenate([a[:-xf], a[-xf:] * (1 - ramp) + b_[:xf] * ramp, b_[xf:]])
    music = np.zeros((n, 2))
    m = min(n, len(joined))
    music[:m] = joined[:m]
    i = int(SHOT * SR)
    k = int(0.008 * SR)
    music[i - k:i] *= np.linspace(1, 0, k)[:, None]
    music[i:] = 0
    return music


SKIP_EVENTS = ("ui.", "hazard.", "equip.", "self.", "choir.", "civ.")


def render_audio(path):
    A.BANK = A.sound_bank()
    n = int(END * SR)
    music = music_bed(n)
    sfx = np.zeros_like(music)
    duck = np.zeros(n)
    rng = np.random.default_rng(11)

    def gun_duck(T, depth=1.0):
        i = int(T * SR)
        d = np.r_[np.linspace(0, depth, 240), np.full(int(0.08 * SR), depth), np.linspace(depth, 0, int(0.15 * SR))]
        j = min(n, i + len(d))
        if 0 <= i < n:
            duck[i:j] = np.maximum(duck[i:j], d[: j - i])

    # 1) The game's own sounds from every shot on screen (slow motion: the times stretch).
    for s in shots:
        if not s["src"] or s["src"] == "TITLE":
            continue
        meta_ = A.Source.get(s["src"]).meta
        a0, a1 = span(s)
        for e in meta_.get("events", []):
            if not (a0 - 0.02 <= e["t"] < a1):
                continue
            if e["name"].startswith(SKIP_EVENTS) or (e["t"] < 0.05 and not e["name"].endswith(".fire")):
                continue
            spec = A.BANK.get(e["name"])
            if not spec:
                continue
            T = s["T"] + (e["t"] - a0) / s["speed"]
            if T >= SHOT - 0.05:
                continue
            dist = e.get("distance") or 1.0
            att = -20 * np.log10(max(1.0, dist / 3.0)) * 0.6
            vol = 20 * np.log10(max(1e-3, e.get("volume", 1.0)))
            gun = e["name"].endswith(".fire")
            if s["src"].startswith(("BD-", "SB-")):
                vol += 3
            if s["speed"] < 1:
                vol += 2 if gun else -4
            if spec["files"]:
                y = A.sample(spec["files"][rng.integers(len(spec["files"]))])
                if s["speed"] < 1 and gun:
                    y = resample_poly(y, 4, 3)  # slow motion: the shot drops in pitch
                A.place(sfx, y, T, (-5 if gun else -10) + att + vol, rng.uniform(-0.2, 0.2))
            for sy in spec["synth"]:
                if sy.endswith("_punch"):
                    A.place(sfx, A.synth(sy), T, -8 + att + vol)
            if spec["tail"]:
                A.place(sfx, A.sample("tail_hall"), T + 0.004, -15 + att * 0.5 + vol)
            if gun and dist < 6:
                gun_duck(T)
        # Transitions get their sound.
        if s["tr"] == "whip":
            A.place(sfx, whoosh(0.32), s["T"] - 0.16, -12, 0.0)
        elif s["tr"] == "glitch":
            A.place(sfx, crackle(0.16, int(s["T"] * 10)), s["T"], -15, 0.1)

    # 2) Cold open, insertion.
    tone = A.sample("roomtone")[: int(9 * SR)] * np.r_[np.linspace(0, 1, SR), np.ones(int(6.5 * SR)), np.linspace(1, 0, int(1.5 * SR))][: int(9 * SR)]
    A.place(sfx, tone, 0.0, -24)
    for T, kind, g in [(hb(-15, 1), "rel_magin", -5), (hb(-13, 1), "rel_boltback", -6), (hb(-13, 1) + 0.25, "rel_boltforward", -5)]:
        A.place(sfx, A.sample(kind), T, g)
    A.place(sfx, A.sample("static"), hb(-14) - 0.14, -14)
    A.place(sfx, radio(voice("commander_threat_04")), hb(-14), -6, -0.1)
    A.place(sfx, A.sample("static"), hb(-14) + 2.05, -16)
    rot = A.sample("rotor")
    seg = rot[: int(9.2 * SR)] * np.r_[np.linspace(0, 1, SR), np.ones(int(7.0 * SR)), np.linspace(1, 0, int(1.2 * SR))][: int(9.2 * SR)]
    A.place(sfx, seg, bar(-12) - 0.6, -15)
    land = hb(-11, 2) + (6.0 - (2.5 + (hb(-11, 2) - hb(-12))))  # touchdown in the chain's clock
    for T, kind, g in [(land, "thud", -6), (land + 0.01, "metal_clang", -18), (hb(-9) + 0.2, "breath_in", -11),
                       (hb(-9) + 1.3, "breath_out", -11), (hb(-9, 2) + 0.15, "beep", -17)]:
        A.place(sfx, A.sample(kind), T, g)

    # 3) The alarm, the PA, power out, the breach.
    a0 = bar(11)
    A.place(sfx, A.sample("alarm_short"), a0 - 0.05, -9, -0.2)
    ts = np.arange(int(6.6 * SR)) / SR
    wail = 620 + 280 * (0.5 - 0.5 * np.cos(2 * np.pi * ts / 2.4))
    ph = 2 * np.pi * np.cumsum(wail) / SR
    siren = (np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.12 * np.sin(3 * ph)) * np.clip(ts / 1.2, 0, 1) * np.clip((6.6 - ts) / 0.8, 0, 1)
    A.place(sfx, siren * 0.5, a0 + 0.4, -15, -0.35)
    A.place(sfx, siren * 0.5, a0 + 0.44, -17, 0.35)
    pa_main = ROOT / "build" / "pa_main.wav"
    pa_src = sf.read(pa_main)[0] if pa_main.exists() else voice("announce_intruders")
    if pa_src.ndim > 1:
        pa_src = pa_src.mean(1)
    A.place(sfx, pa(pa_src, 1.0), a0 + 0.55, -3)
    i0, i1 = int((a0 + 0.5) * SR), int(hb(13, 2) * SR)
    duck[i0:i1] = np.maximum(duck[i0:i1], 1.4)
    for T, name, g in [(hb(13, 2), "power_out", -5), (hb(14), "explosion", 1), (hb(14) + 0.005, "boom_close0", -3), (hb(14, 2) + 0.2, "bd_encounter", -4)]:
        A.place(sfx, A.sample(name), T, g)
        if name == "explosion":
            gun_duck(T, 1.6)
    # SABLE on the net, the Warden's voice over his hunt.
    calls = [(hb(15) + 0.15, "bd_see_enemy", 1, "radio"), (hb(16) + 0.3, "bd_spread_out", 0, "radio"), (hb(18) + 0.2, "bd_contact", -1, "radio"),
             (hb(19) + 0.6, "bd_target_down", -1, "radio"), (hb(20, 2) + 0.2, "commander_kill_07", -2, "radio"),
             (hb(21) + 0.35, "commander_rare_06", 1, "near"), (hb(23) + 0.7, "bd_flanking", -3, "radio"),
             (hb(68) + 0.25, "commander_lowhp_04", -2, "radio")]
    for T, name, g, how in calls:
        A.place(sfx, A.sample("static"), T - 0.12, -13)
        y = voice(name)
        A.place(sfx, radio(y) if how == "radio" else band(y, 90, 9000, 2), T, g, 0.1)
        A.place(sfx, A.sample("static"), T + len(y) / SR + 0.02, -16)
    # The dead: a low drone under the dolly.
    tt = np.arange(int(4.3 * SR)) / SR
    drone = (np.sin(2 * np.pi * 43 * tt) + 0.5 * np.sin(2 * np.pi * 64.5 * tt)) * np.sin(np.pi * tt / 4.3) ** 2
    A.place(sfx, drone * 0.35, hb(19), -14)

    # 4) The ending: heartbeat, his line, a breath of silence, the shot.
    hbeat = A.sample("heartbeat")
    for k in range(6):
        A.place(sfx, hbeat, CHORD + k * 60 / 66, -10 + k * 0.8)
    line = voice("commander_firstcontact_09")
    t_line = SHOT - 0.8 - len(line) / SR
    A.place(sfx, band(line, 70, 10000, 2), t_line, 1.5)
    for e in meta("WD")["events"]:
        T = SHOT - (wd_shot - e["t"])
        if CHORD <= T < SHOT - 0.05 and e["name"].startswith("foley"):
            A.place(sfx, A.sample(A.BANK[e["name"]]["files"][0]) if A.BANK.get(e["name"], {}).get("files") else A.synth("thud") * 0.2, T, -14)
    i_pre = int((SHOT - 0.07) * SR)
    sfx[i_pre:int(SHOT * SR)] *= np.linspace(1, 0.1, int(SHOT * SR) - i_pre)[:, None]
    fin = np.zeros((int(5.5 * SR), 2))
    for kind, g in [("heavy_close0", 0.0), ("boom_close1", -3.0), ("pistol_punch", -1.5)]:
        A.place(fin, A.sample(kind) if kind != "pistol_punch" else A.synth(kind), 0.0, g)
    A.place(fin, A.sample("tail_hall"), 0.006, -3)
    tt = np.arange(int(4.5 * SR)) / SR
    A.place(fin, 0.5 * np.sin(2 * np.pi * (38 + 30 * np.exp(-tt * 6)) * tt) * np.exp(-tt * 1.6), 0.0, -2)
    A.place(fin, 0.05 * np.sin(2 * np.pi * 3900 * tt) * np.exp(-tt * 0.9) * np.clip(tt / 0.3, 0, 1), 0.15, -8)
    fpk = np.abs(fin).max() + 1e-9
    fin = np.tanh(fin / fpk * 2.6) / np.tanh(2.6) * fpk
    fin_gain = 0.45
    A.place(sfx, A.sample("clunk"), TITLE, -9)
    A.place(sfx, A.sample("hum_rise") * 0.5, TITLE + 0.05, -14)

    def mix(fg):
        out = music * (10 ** (-2.0 * duck / 20))[:, None] * 0.74 + sfx * 0.42
        A.place(out, fin[:, 0] * fg, SHOT, 0.0, 0.0)
        return out

    def levels(x):
        m = np.abs(x).max(1)
        win = int(0.4 * SR)
        c = np.concatenate([[0.0], np.cumsum((x ** 2).mean(1))])
        i = np.clip(np.arange(len(x)) + win // 2, 0, len(x))
        j = np.clip(np.arange(len(x)) - win // 2, 0, len(x))
        return m, np.sqrt(np.maximum(0, (c[i] - c[j]) / win))

    i0, i1 = int((SHOT - 0.02) * SR), int((SHOT + 0.5) * SR)
    for _ in range(40):
        out = mix(fin_gain)
        pk, en = levels(out)
        rest_pk = max(pk[:i0].max(), pk[i1:].max())
        rest_en = max(en[: int((SHOT - 0.3) * SR)].max(), en[int((SHOT + 1.0) * SR):].max())
        if pk[i0:i1].max() > rest_pk * 1.41 and en[i0:i1].max() > rest_en * 1.3:
            break
        fin_gain *= 1.06
    out = out * (0.97 / max(1e-9, np.abs(out).max()))
    pk, en = levels(out)
    rep = {"shot_peak_db": round(float(20 * np.log10(pk[i0:i1].max())), 2), "rest_peak_db": round(float(20 * np.log10(max(pk[:i0].max(), pk[i1:].max()))), 2),
           "shot_rms400_db": round(float(20 * np.log10(en[i0:i1].max())), 2),
           "rest_rms400_db": round(float(20 * np.log10(max(en[: int((SHOT - 0.3) * SR)].max(), en[int((SHOT + 1.0) * SR):].max()))), 2),
           "loudest_400ms_at": round(float(np.argmax(en)) / SR, 3), "shot_T": round(SHOT, 3)}
    (ROOT / "build" / "flow4_levels.json").write_text(json.dumps(rep, indent=1))
    print("levels", rep)
    sf.write(path, out, SR, subtype="PCM_24")


if __name__ == "__main__":
    (ROOT / "build").mkdir(exist_ok=True)
    json.dump([{k: v for k, v in s.items() if k != "kicks"} for s in shots], open(ROOT / "build" / "flow4_cut.json", "w"), indent=1)
    for w_ in check():
        print("WARNING:", w_)
    if MODE == "--windows":
        win = windows()
        (ROOT / "build" / "flow4_windows.json").write_text(json.dumps(win, indent=1))
        lines = []
        for src, ws in sorted(win.items()):
            take, _, cam = src.partition("-")
            q = " --q=nobeams" if take == "BD" else ""
            lines.append(f"{take} {cam} --win={','.join(f'{a}-{b_}' for a, b_ in ws)} --keep{q}".replace("  ", " "))
        (ROOT / "build" / "flow4_queue.txt").write_text("\n".join(lines) + "\n")
        tot = sum(b_ - a for ws in win.values() for a, b_ in ws)
        print(f"{len(shots)} slots, {len(win)} cameras, {tot:.1f} s of capture ({tot * 60:.0f} frames)")
        for src, ws in sorted(win.items()):
            print(f"  {src:10s} {ws}")
    elif MODE == "--audio":
        render_audio(ROOT / "build" / "v4_mix.wav")
    elif MODE == "--sheet":
        key_sheet(ROOT / "build" / "flow4_keyframes.jpg")
        print("wrote build/flow4_keyframes.jpg")
    elif MODE == "--preview":
        # A quick look at a stretch: python tools/flow4.py --preview  (T0/T1 from env)
        import os
        T0, T1 = float(os.environ.get("T0", 0)), float(os.environ.get("T1", 20))
        render_video(ROOT / "build" / "_v4_preview.mp4", T0, T1)
    else:
        vid = ROOT / "build" / "_v4_video.mp4"
        wav = ROOT / "build" / "v4_mix.wav"
        render_audio(wav)
        print("audio ok,", len(shots), "shots")
        render_video(vid)
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        subprocess.run([exe, "-y", "-loglevel", "error", "-i", str(vid), "-i", str(wav), "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
                        "-shortest", str(ROOT / "build" / "trailer_v4.mp4")], check=True)
        print("wrote build/trailer_v4.mp4")
