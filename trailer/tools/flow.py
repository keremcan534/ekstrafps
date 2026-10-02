"""Flow cut: the trailer as one continuous piece of music (track 0:00-1:32, no edits,
no silences) with every cut on the 105 BPM grid, constant camera drift, light-dip
transitions on downbeats, location typography and a 2.2:1 frame.

python tools/flow.py  ->  build/trailer_flow.mp4
"""
import json
import subprocess
import sys

sys.argv = [sys.argv[0], "1280", "720"]
import assemble as A  # noqa: E402  (footage loader, typography, sound helpers)
import imageio_ffmpeg  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from scipy.signal import resample_poly  # noqa: E402

ROOT = A.ROOT
W, H, FPS, SR = A.W, A.H, A.FPS, A.SR
B = 60 / 105.0
G0 = 18.412          # first downbeat after the drop (track time = trailer time)
END = 92.0


def beat(n):
    return G0 + n * B


# ------------------------------------------------------------------ event-anchored picking
_ev = {}


def meta(take):
    if take not in _ev:
        _ev[take] = json.loads((ROOT / "build" / "events" / f"{take}.json").read_text())
    return _ev[take]


def fires(take, mine):
    out = []
    for e in meta(take)["events"]:
        if e["name"].endswith(".fire") and e["t"] > 0.05:
            if not mine or (e.get("distance") or 0) <= 3.5:
                out.append(e["t"])
    return sorted(set(out))


used = {}


def free(take, a, b):
    return all(b <= x or a >= y for x, y in used.get(take, []))


def pick(src, dur, after=0.0, lead=0.1, mine=None):
    take = src.split("-")[0]
    if mine is None:
        mine = src.endswith("pov")
    end = meta(take).get("duration", 10)
    for t in fires(take, mine):
        a = t - lead
        if t >= after and a >= 0 and a + dur <= end and free(take, a, a + dur):
            used.setdefault(take, []).append((a, a + dur))
            return a
    a = max(0.0, after)
    while (not free(take, a, a + dur)) and a + dur < end:
        a += 0.2
    a = min(a, max(0.0, end - dur))
    used.setdefault(take, []).append((a, a + dur))
    return a


# ------------------------------------------------------------------ the cut
# (start T, src, source time or None=auto, tag, transition)  transition: dissolve | flash | cut
TAGS = {"BD": "BLACK DIVISION", "FC": "01 / ASSEMBLY HALL", "SV": "02 / SERVER HALL", "LB": "03 / R&D LABS", "PW": "04 / POWER PLANT",
        "HG": "05 / HANGAR", "AT": "06 / ATRIUM", "WH": "07 / WAREHOUSE"}
fc0 = next(t for t in fires("FC", True) if t > 3.0)
sg = sorted(set(e["t"] for e in meta("SG")["events"] if e["name"] == "shotgun.fire"))

plan = [
    # intro: the rifle, the drop zone, the machine (music intro swell -> build)
    (0.00, "A02", -0.25, None, "fade"),
    (2.60, "A03", -0.15, None, "dissolve"),
    (4.20, "A04", 0.20, None, "dissolve"),
    (6.20, "A05", 0.00, None, "dissolve"),
    (9.10, "IN-tilt", 2.40, "SITE-9 / VANTA DYNAMICS", "dissolve"),
    (11.40, "IN-rope", 4.20, None, "dissolve"),
    (13.00, "IN-land", 5.60, None, "dissolve"),
    (14.60, "IN-turn", 5.90, None, "dissolve"),
    (16.40, "RB-visor", 1.30, None, "dissolve"),
    (17.25, "RB-servo", 2.00, None, "cut"),
    # DROP: first shot
    (18.233, "FC-pov", fc0 - 0.02, "auto", "flash"),
]
# 8 bars after the drop: a new room every bar
bar_src = ["FC-ots", "SV-pov", "LB-mate", "PW-pov", "HG-pov", "HG-mate", "AT-pov", "AT-mate"]
for k, src in enumerate(bar_src):
    plan.append((beat(4 * (k + 1)) if k else beat(4), src, None, "auto", "flash" if k % 2 == 0 else "cut"))
# Phrase B (more intense): a cut every two beats, rooms rotating.
rot = ["WH-pov", "WH-mate", "HG-side", "LB-pov", "PW-pov", "SV-pov", "HG-pov", "AT-side", "WH-pov", "LB-mate",
       "HG-mate", "LB-pov", "FC-pov", "HG-front", "AT-mate", "AT-side", "LB-pov", "HG-pov", "PW-pov", "AT-front",
       "SG-side"]
n0 = 32 + 2  # beat index after the 8 bars (bar 8 = beat 32) -> phrase B starts at beat 32
plan.append((beat(32), "WH-pov", None, "auto", "flash"))
for i, src in enumerate(rot[1:]):
    T = beat(34 + 2 * i)
    if T >= 61.20:
        break
    plan.append((T, src, None, "auto", "flash" if (34 + 2 * i) % 8 == 0 else "cut"))
# The dip: hold one long aim at the atrium (music thins, never stops).
plan.append((61.26, "AT-pov", 0.0, None, "dissolve"))
# Bar 20 hit: a teammate fires beside you. Then the squads.
plan.append((64.126, "SQ-pov", 0.85, None, "flash"))
for i, src in enumerate(["HG-mate", "AT-mate", "LB-mate", "WH-mate", "HG-side", "HG-pov", "AT-front"]):
    T = beat(84 + 2 * i)
    if T >= 73.2:
        break
    plan.append((T, src, None, "auto", "cut"))
# Bar 24 accent: shotgun hero, pump included.
plan.append((73.294, "SG-pov", sg[0] - 0.0, None, "flash"))
plan.append((75.555, "SG-side", 2.5, None, "cut"))
for i, src in enumerate(["HG-pov", "PW-pov", "WH-pov"]):
    plan.append((beat(100 + 2 * i), src, None, "auto", "cut"))
plan.append((beat(100 + 6), "SG-pov", sg[1] - 0.05 if len(sg) > 1 else 6.4, None, "flash"))
# Drum fill 80.12-82.91: a cut on every hit (muzzle flashes from every room).
fill = [80.122, 80.406, 80.691, 80.981, 81.306, 81.550, 81.834, 82.119, 82.409, 82.630, 82.810]
fill_src = ["HG-pov", "LB-pov", "PW-pov", "WH-pov", "AT-mate", "HG-mate", "SV-pov", "FC-pov", "LB-mate", "HG-side", "PW-mate"]
for T, src in zip(fill, fill_src):
    plan.append((T, src, None, None, "flash"))
plan.append((82.92, None, None, None, "black"))
plan.append((83.40, "TITLE", None, None, "title"))
# Black Division arrival (synced with the radio calls in the mix): breach, NVG lead, fan-out, open fire.
plan = [p for p in plan if not (59.5 <= p[0] < 64.1) and abs(p[0] - beat(88)) > 0.01]
plan += [
    (beat(72), "BD-breach", 1.2 - (59.855 - beat(72)), None, "flash"),
    (61.26, "BD-nvg", 3.2, "HOSTILE / BLACK DIVISION", "cut"),
    (62.70, "BD-low", 6.3, None, "cut"),
    (63.55, "BD-ots", 3.45, None, "cut"),
    (beat(88), "BD-pov", 4.4, None, "flash"),
]
plan.sort(key=lambda p: p[0])

# Resolve source times, durations and room tags.
shots = []
last_room = None
for i, (T, src, at, tag, tr) in enumerate(plan):
    T1 = plan[i + 1][0] if i + 1 < len(plan) else END
    dur = T1 - T
    if src and src not in ("TITLE",) and at is None:
        at = pick(src, dur + 0.05, after=1.0, lead=0.08)
    room = src.split("-")[0] if src else None
    if tag == "auto":
        tag = TAGS.get(room) if room in TAGS and room != last_room else None
    if room in TAGS:
        last_room = room
    shots.append({"T": T, "T1": T1, "src": src, "at": at, "tag": tag, "tr": tr})
json.dump(shots, open(ROOT / "build" / "flow_cut.json", "w"), indent=1)


# ------------------------------------------------------------------ motion design
def tag_overlay(img, t, text):
    """Lower-left room tag: hairline draws, text slides up, holds, fades (t = seconds since shot start)."""
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
    bar = int((H - W / 2.2) / 2 * k)
    if bar <= 0:
        return img
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, bar], fill=(0, 0, 0))
    d.rectangle([0, H - bar, W, H], fill=(0, 0, 0))
    return img


def drift(img, lt, dur, push=0.05):
    """Constant slow push-in: the image never sits still."""
    z = 1.0 + push * min(1, lt / max(dur, 0.5))
    if z <= 1.0005:
        return img
    cw, ch = W / z, H / z
    x0, y0 = (W - cw) / 2, (H - ch) / 2
    return img.crop((int(x0), int(y0), int(x0 + cw), int(y0 + ch))).resize((W, H), Image.BILINEAR)


def shot_frame(s, T):
    lt = T - s["T"]
    src = A.Source.get(s["src"])
    img = src.frame(s["at"] + lt)
    return drift(img, lt, s["T1"] - s["T"])


def render_video(path):
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    n = int(END * FPS)
    p = subprocess.Popen([exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                          "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    black = Image.new("RGB", (W, H))
    white = Image.new("RGB", (W, H), (255, 244, 230))
    si = 0
    for f in range(n):
        T = f / FPS
        while si < len(shots) - 1 and T >= shots[si + 1]["T"] - 1e-9:
            si += 1
        s = shots[si]
        lt = T - s["T"]
        if s["tr"] == "title":
            img = A.title_card(lt, "SITE-9", "TACTICAL SQUAD FPS", "IN DEVELOPMENT")
            if T > END - 1.6:
                img = Image.blend(img, black, min(1, (T - (END - 1.6)) / 1.4))
        elif s["tr"] == "black":
            img = black.copy()
        else:
            img = shot_frame(s, T)
            if s["src"] == "A05":
                A.annotate(img, lt - 0.6, int(W * 0.42), int(H * 0.42), ["M4A1", "5.56×45 M855", "910 M/S", "3.0 KG"]) if lt > 0.6 else None
            # transitions
            if s["tr"] == "fade" and lt < 1.2:
                img = Image.blend(black, img, lt / 1.2)
            elif s["tr"] == "dissolve" and lt < 0.4 and si > 0 and shots[si - 1]["src"] not in (None, "TITLE"):
                prev = shot_frame(shots[si - 1], T)
                img = Image.blend(prev, img, lt / 0.4)
            elif s["tr"] == "flash" and lt < 0.12:
                img = Image.blend(img, white, 0.45 * (1 - lt / 0.12))
            if s["tag"] and T >= 9:
                tag_overlay(img, lt, s["tag"]) if " / " in s["tag"] and not s["tag"].startswith("SITE") else None
            if s["tag"] and s["tag"].startswith("SITE"):
                tag_overlay(img, lt, "SITE-9 / VANTA DYNAMICS RESEARCH CAMPUS".replace("SITE-9 / ", "SITE-9 / "))
            # 2.2:1 frame eases in at the drop, out of the macro intro
            img = letterbox(img, min(1, max(0, (T - 8.6) / 0.6)) if T < 18.233 else 1.0)
        p.stdin.write(img.tobytes())
    p.stdin.close()
    p.wait()


# ------------------------------------------------------------------ sound
def render_audio(path):
    A.BANK = A.sound_bank()
    src, sr = sf.read(ROOT / "music" / "escaping.wav", always_2d=True)
    if sr != SR:
        src = resample_poly(src, SR, sr, axis=0)
    n = int(END * SR)
    music = src[:n].copy()
    fo = int(3.2 * SR)
    music[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 2
    sfx = np.zeros_like(music)
    duck = np.zeros(n)
    rng = np.random.default_rng(5)
    for s in shots:
        if not s["src"] or s["src"] in ("TITLE",):
            continue
        meta_ = A.Source.get(s["src"]).meta
        a0, a1 = s["at"], s["at"] + (s["T1"] - s["T"])
        for e in meta_.get("events", []):
            if not (a0 - 0.02 <= e["t"] < a1):
                continue
            if e["name"].startswith(("ui.", "hazard.", "equip.", "self.")) or (e["t"] < 0.05 and not e["name"].endswith(".fire")):
                continue
            spec = A.BANK.get(e["name"])
            if not spec:
                continue
            T = s["T"] + e["t"] - a0
            dist = e.get("distance") or 1.0
            att = -20 * np.log10(max(1.0, dist / 3.0)) * 0.6
            vol = 20 * np.log10(max(1e-3, e.get("volume", 1.0)))
            gun = e["name"].endswith(".fire")
            if s["src"].startswith("BD-"):
                vol += 4  # Black Division: louder weapons in their sequence
            if spec["files"]:
                A.place(sfx, A.sample(spec["files"][rng.integers(len(spec["files"]))]), T, (-4 if gun else -9) + att + vol, rng.uniform(-0.2, 0.2))
            for sy in spec["synth"]:
                if sy.endswith("_punch"):
                    A.place(sfx, A.synth(sy), T, -7 + att + vol)
            if spec["tail"]:
                A.place(sfx, A.sample("tail_hall"), T + 0.004, -14 + att * 0.5 + vol)
            if gun and dist < 6:
                i = int(T * SR)
                d = np.r_[np.linspace(0, 1, 240), np.ones(int(0.08 * SR)), np.linspace(1, 0, int(0.15 * SR))]
                j = min(n, i + len(d))
                duck[i:j] = np.maximum(duck[i:j], d[: j - i])
    for T, kind, g in [(3.30, "rel_magin", -4), (4.70, "rel_boltback", -5), (4.95, "rel_boltforward", -4),
                       (13.40, "thud", -6), (13.41, "metal_clang", -18), (14.9, "breath_in", -11), (16.0, "breath_out", -11),
                       (16.7, "beep", -16), (83.4, "clunk", -9)]:
        A.place(sfx, A.sample(kind), T, g)
    # Black Division arrival (1:00-1:09): power slam, siren, radio calls, breaching charge on the bar-20 hit.
    def voice(name):
        y, vsr = sf.read(A.GAME / "public" / "audio" / "voice" / f"{name}.wav")
        if y.ndim > 1:
            y = y.mean(1)
        return resample_poly(y, SR, vsr) if vsr != SR else y

    ts = np.arange(int(7.2 * SR)) / SR
    wail = 620 + 280 * (0.5 - 0.5 * np.cos(2 * np.pi * ts / 2.4))  # slow two-tone facility siren
    ph = 2 * np.pi * np.cumsum(wail) / SR
    siren = (np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.12 * np.sin(3 * ph)) * np.clip(ts / 1.2, 0, 1) * np.clip((7.2 - ts) / 1.0, 0, 1)
    for t0 in (53.8, 60.0):
        A.place(sfx, siren * 0.5, t0, -14, -0.35)
        A.place(sfx, siren * 0.5, t0 + 0.04, -16, 0.35)
    for T, name, g in [(59.45, "power_out", -5), (59.855, "explosion", 1), (59.86, "boom_close0", -2), (64.13, "bd_encounter", -3)]:
        A.place(sfx, A.sample(name), T, g)
    for T, name, g in [(61.45, "bd_see_enemy", 2), (62.75, "bd_spread_out", 1), (69.2, "bd_contact", 0), (71.0, "bd_flanking", -3)]:
        A.place(sfx, A.sample("static"), T - 0.12, -12)
        A.place(sfx, voice(name), T, g)

    # Facility evacuation announcement: alert chime, then the PA (speaker band, overdrive, hall echoes).
    from scipy.signal import butter, lfilter

    def pa(path, wet):
        y, psr = sf.read(path)
        y = y if psr == SR else resample_poly(y, SR, psr)
        b, a = butter(4, [350 / (SR / 2), 3800 / (SR / 2)], "band")
        y = lfilter(b, a, y)
        y = np.tanh(y / (np.abs(y).max() + 1e-9) * 3.2) / np.tanh(3.2)
        out = np.zeros(len(y) + int(1.2 * SR))
        for delay, g in [(0, 1.0), (0.085, 0.38 * wet), (0.21, 0.26 * wet), (0.43, 0.16 * wet), (0.71, 0.09 * wet)]:
            i = int(delay * SR)
            out[i:i + len(y)] += y * g
        return out

    tt = np.arange(int(0.9 * SR)) / SR
    chime = sum(np.sin(2 * np.pi * f * tt) * np.exp(-((tt - t0) * 9).clip(0)) * (tt >= t0) for f, t0 in [(880, 0.0), (698, 0.28), (587, 0.56)])
    A.place(sfx, chime * 0.3, 53.45, -8)
    A.place(sfx, pa(ROOT / "build" / "pa_main.wav", 1.0), 53.85, -1)
    A.place(sfx, pa(ROOT / "build" / "pa_repeat.wav", 1.8), 66.2, -7, 0.3)
    i0, i1 = int(53.8 * SR), int(60.0 * SR)
    duck[i0:i1] = np.maximum(duck[i0:i1], 1.5)  # music -3 dB under the announcement
    rot = A.sample("rotor")
    seg = rot[: int(9.5 * SR)] * np.r_[np.linspace(0, 1, SR), np.ones(int(7.5 * SR)), np.linspace(1, 0, SR)][: int(9.5 * SR)]
    A.place(sfx, seg, 8.6, -15)
    out = music * (10 ** (-2.0 * duck / 20))[:, None] * 0.9 + sfx * 0.5
    pk = np.abs(out).max()
    if pk > 0.98:
        out = np.tanh(out / pk * 1.3) / np.tanh(1.3) * 0.97
    sf.write(path, out, SR, subtype="PCM_24")


if __name__ == "__main__":
    vid = ROOT / "build" / "_flow_video.mp4"
    wav = ROOT / "build" / "flow_mix.wav"
    render_audio(wav)
    print("audio ok,", len(shots), "shots")
    render_video(vid)
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([exe, "-y", "-loglevel", "error", "-i", str(vid), "-i", str(wav), "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
                    "-shortest", str(ROOT / "build" / "trailer_flow.mp4")], check=True)
    print("wrote build/trailer_flow.mp4")
