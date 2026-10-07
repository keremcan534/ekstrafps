"""Flow cut v2 on "Abandoned Complex" (112 BPM): the approved flow cut rebuilt on the new
track, one use per camera angle where possible, SABLE with the current models, and the
last scene: you are down, the Warden stands over you, one line, one shot, black.

Music edit (trailer T <- track t), every seam on a downbeat:
  0      - 76.822  <- 0       - 76.822   intro, drop, SABLE arrival
  76.822 - shot    <- 171.115 - ...      last 8 bars, final hits, the drumless chord (Warden scene)

python tools/flow2.py  ->  build/trailer_v2.mp4
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
from scipy.signal import butter, lfilter, resample_poly  # noqa: E402

ROOT = A.ROOT
W, H, FPS, SR = A.W, A.H, A.FPS, A.SR
B = 60 / 112.0
G0 = 34.501            # beat 0 (track time); downbeats where (n + 1) % 4 == 0; the drop is beat -1
SEAM_T, SEAM_SRC = 76.822, 171.115   # beat 79 <- track beat 255
WD_AT = 2.4            # WD-down source time at the fade-up (before that the escort beams blow out)
WD_IN = 95.10          # Warden scene fades up from black
FIRE = WD_IN + (7.22 - WD_AT)        # his shot (WD pistol.fire at 7.22 in the take)
TITLE_T = FIRE + 1.75
END = TITLE_T + 5.0


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
    """A window of the take not shown yet, starting just before a shot of yours when there is one."""
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
# (start T, src, source time or None=auto, tag, transition)  transition: fade | dissolve | flash | cut | black | title
TAGS = {"FC": "01 / ASSEMBLY HALL", "SV": "02 / SERVER HALL", "LB": "03 / R&D LABS", "PW": "04 / POWER PLANT",
        "HG": "05 / HANGAR", "AT": "06 / ATRIUM", "WH": "07 / WAREHOUSE"}
fc0 = next(t for t in fires("FC", True) if t > 3.0)
sg = sorted(set(e["t"] for e in meta("SG")["events"] if e["name"] == "shotgun.fire"))

plan = [
    # Intro A: the rifle, macro (track 0 - 8.25)
    (0.000, "A02", -0.25, None, "fade"),
    (2.450, "A03", -0.15, None, "dissolve"),
    (3.850, "A04", 0.20, None, "dissolve"),
    (5.600, "A05", 0.00, None, "dissolve"),
    # Intro B: insertion, one bar each
    (beat(-49), "IN-tilt", 2.40, "SITE", "dissolve"),
    (beat(-45), "IN-rope", 4.20, None, "dissolve"),
    (beat(-41), "IN-land", 5.60, None, "dissolve"),
    (beat(-37), "IN-turn", 5.90, None, "dissolve"),
    # Drums in: the machine wakes, the team switches on
    (beat(-33), "RB-visor", 1.30, None, "cut"),
    (beat(-31), "RB-servo", 2.00, None, "cut"),
    (beat(-29), "IN-crane", 8.50, None, "cut"),
    (beat(-25), "RB-wide", 1.40, None, "cut"),
    (beat(-23), "IN-track", 11.2, None, "cut"),
    (beat(-21), "RB-far", 2.30, None, "cut"),
    # Energy step: robots on patrol, room to room
    (beat(-19), "HG-robo", 0.30, None, "flash"),
    (beat(-17), "PW-robo", 0.50, None, "cut"),
    (beat(-15), "LB-robo", 0.30, None, "cut"),
    (beat(-13), "AT-robo", 3.60, None, "cut"),
    # Bass dip: something else is in the building. "There you are."
    (beat(-11), "SB-ots", 3.00, None, "dissolve"),
    (beat(-7), "SB-warden", 1.20, None, "cut"),
    (beat(-2), None, None, None, "black"),
    # DROP
    (beat(-1), "FC-pov", fc0 - 0.02, "auto", "flash"),
]
# After the drop: a room per bar (POV on the downbeat, a second angle on beat 3).
after_drop = [("FC-ots", None), ("SV-pov", None), ("SV-robo", 6.0), ("LB-pov", None), ("LB-front", 0.3), ("PW-pov", None),
              ("PW-front", 3.8), ("HG-pov", None), ("HG-mate", None), ("AT-pov", None), ("AT-front", 0.3), ("WH-pov", None),
              ("WH-mate", None), ("SQ-pov", 0.85), ("SQ-mate", 9.2)]
for i, (src, at) in enumerate(after_drop):
    n = 1 + 2 * i
    plan.append((beat(n), src, at, "auto", "flash" if (n + 1) % 4 == 0 else "cut"))
# Phrase B: the squads push, alarm and evacuation call over it.
for i, (src, at) in enumerate([("HG-side", 7.2), ("LB-mate", None), ("AT-side", 10.4), ("PW-mate", None), ("HG-front", 5.2), ("AT-mate", None)]):
    n = 31 + 2 * i
    plan.append((beat(n), src, at, None, "flash" if (n + 1) % 4 == 0 else "cut"))
plan.append((beat(42.5), None, None, None, "black"))  # power out
# SABLE: breach, the NVG lead, the squad in the dark, the Warden.
plan += [
    (beat(43), "BD-breach", 1.15, None, "flash"),
    (beat(45), "BD-pov", 2.50, None, "cut"),
    (beat(47), "BD-nvg", 2.95, "HOSTILE / SABLE", "cut"),
    (beat(51), "SB-side", 1.00, None, "cut"),
    (beat(55), "SB-warden", 2.60, None, "cut"),
    (beat(59), "SB-ots", 4.60, None, "cut"),
    (beat(63), "BD-low", 6.60, None, "cut"),
    (beat(67), "BD-ots", 3.25, None, "flash"),
    (beat(69), "BD-pov", 4.20, None, "cut"),
    (beat(71), "HG-front", 0.30, None, "flash"),
    (beat(73), "BD-breach", 4.30, None, "cut"),
    (beat(75), "PW-pov", None, None, "flash"),
    (beat(77), "BD-ots", 6.90, None, "cut"),
]
# The last 8 bars (track 171.1 -): the firefight, both sides.
plan += [
    (beat(79), "SG-pov", sg[0] - 0.05, None, "flash"),
    (beat(83), "SG-side", sg[1] - 0.5 if len(sg) > 1 else 5.9, None, "cut"),
    (beat(85), "AT-side", 11.9, None, "cut"),
    (beat(87), "BD-low", 9.00, None, "flash"),
    (beat(89), "LB-pov", None, None, "cut"),
    (beat(91), "SB-front", 9.30, None, "flash"),
    (beat(93), "WH-pov", None, None, "cut"),
    (beat(95), "BD-pov", 8.20, None, "flash"),
    (beat(97), "HG-pov", None, None, "cut"),
    (beat(99), "BD-ots", 8.30, None, "flash"),
    (beat(101), "LB-front", 4.70, None, "cut"),
    (beat(103), "AT-pov", None, None, "flash"),
]
# A cut a beat, then on every eighth of the final hits.
for n, src in [(105, "SQ-pov"), (106, "FC-pov"), (107, "HG-side"), (108, "SV-pov"),
               (109, "HG-pov"), (109.5, "BD-pov"), (110, "LB-pov"), (110.5, "PW-pov")]:
    plan.append((beat(n), src, {"BD-pov": 9.6, "HG-side": 9.5}.get(src), None, "flash"))
# The chord: down, the Warden over you, the shot, the title.
plan += [
    (beat(111), None, None, None, "black"),
    (WD_IN, "WD-down", WD_AT, None, "fadein"),
    (FIRE + 1 / 30, None, None, None, "whiteout"),
    (TITLE_T, "TITLE", None, None, "title"),
]
plan.sort(key=lambda p: p[0])

# Resolve: explicit windows are booked first so automatic picks never show the same moment again.
for i, (T, src, at, tag, tr) in enumerate(plan):
    if src and src != "TITLE" and at is not None:
        T1 = plan[i + 1][0] if i + 1 < len(plan) else END
        used.setdefault(src.split("-")[0], []).append((at, at + T1 - T))
shots = []
seen_rooms = set()
for i, (T, src, at, tag, tr) in enumerate(plan):
    T1 = plan[i + 1][0] if i + 1 < len(plan) else END
    dur = T1 - T
    if src and src != "TITLE" and at is None:
        at = pick(src, dur + 0.05, after=1.0, lead=0.08)
    room = src.split("-")[0] if src else None
    if tag == "auto":
        tag = TAGS[room] if room in TAGS and room not in seen_rooms else None
    if room in TAGS and T > 33:
        seen_rooms.add(room)
    shots.append({"T": T, "T1": T1, "src": src, "at": at, "tag": tag, "tr": tr})
json.dump(shots, open(ROOT / "build" / "flow2_cut.json", "w"), indent=1)


# ------------------------------------------------------------------ motion design
def tag_overlay(img, t, text):
    """Lower-left tag: hairline draws, text slides up, holds, fades (t = seconds since shot start)."""
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


GAIN = {"WD-down": 1.25, "SB-warden": 1.1}


def shot_frame(s, T):
    lt = T - s["T"]
    img = A.Source.get(s["src"]).frame(s["at"] + lt)
    g = GAIN.get(s["src"])
    if g:
        img = Image.fromarray(np.clip(np.asarray(img, np.float32) * g, 0, 255).astype(np.uint8))
    # The last scene creeps in slower and further: he is standing over you.
    return drift(img, lt, s["T1"] - s["T"], 0.09 if s["src"] == "WD-down" else 0.05)


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
        elif s["tr"] == "whiteout":
            img = white.copy() if lt < 2.5 / FPS else black.copy()
        else:
            img = shot_frame(s, T)
            if s["src"] == "A05" and lt > 0.6:
                A.annotate(img, lt - 0.6, int(W * 0.42), int(H * 0.42), ["M4A1", "5.56×45 M855", "910 M/S", "3.0 KG"])
            prev = shots[si - 1] if si > 0 else None
            if s["tr"] == "fade" and lt < 1.2:
                img = Image.blend(black, img, lt / 1.2)
            elif s["tr"] == "fadein" and lt < 1.0:
                img = Image.blend(black, img, (lt / 1.0) ** 1.6)
            elif s["tr"] == "dissolve" and lt < 0.4 and prev and prev["src"] not in (None, "TITLE"):
                img = Image.blend(shot_frame(prev, T), img, lt / 0.4)
            elif s["tr"] == "flash" and lt < 0.12:
                img = Image.blend(img, white, 0.45 * (1 - lt / 0.12))
            if s["tag"] == "SITE":
                tag_overlay(img, lt, "SITE-9 / VANTA DYNAMICS RESEARCH CAMPUS")
            elif s["tag"]:
                tag_overlay(img, lt, s["tag"])
            # 2.2:1 frame eases in out of the macro intro
            img = letterbox(img, min(1, max(0, (T - beat(-49)) / 0.6)))
        p.stdin.write(img.tobytes())
    p.stdin.close()
    p.wait()


# ------------------------------------------------------------------ sound
def voice_file(name):
    y, vsr = sf.read(A.GAME / "public" / "audio" / "voice" / f"{name}.wav")
    if y.ndim > 1:
        y = y.mean(1)
    return resample_poly(y, SR, vsr) if vsr != SR else y


def radio(y):
    b, a = butter(4, [400 / (SR / 2), 3400 / (SR / 2)], "band")
    y = lfilter(b, a, y)
    return np.tanh(y / (np.abs(y).max() + 1e-9) * 2.5) / np.tanh(2.5) * 0.8


def close(y):
    """The Warden in the room: a touch of low end and a short slap off the walls."""
    b, a = butter(2, 180 / (SR / 2), "low")
    y = y / (np.abs(y).max() + 1e-9) + 0.5 * lfilter(b, a, y / (np.abs(y).max() + 1e-9))
    out = np.zeros(len(y) + int(0.5 * SR))
    for d, g in [(0, 1.0), (0.047, 0.22), (0.11, 0.12), (0.23, 0.06)]:
        i = int(d * SR)
        out[i:i + len(y)] += y * g
    return out / (np.abs(out).max() + 1e-9) * 0.9


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


def music_edit(n):
    src, sr = sf.read(ROOT / "music" / "abandoned.wav", always_2d=True)
    if sr != SR:
        src = resample_poly(src, SR, sr, axis=0)
    xf = int(0.03 * SR)
    a_end = int(SEAM_T * SR)
    b0 = int(SEAM_SRC * SR)
    head = src[: a_end + xf // 2].copy()
    tail = src[b0 - xf // 2:].copy()
    ramp = np.linspace(0, 1, xf)[:, None]
    head[-xf:] = head[-xf:] * (1 - ramp) + tail[:xf] * ramp
    out = np.concatenate([head, tail[xf:]])
    out = np.pad(out, ((0, max(0, n - len(out))), (0, 0)))[:n]
    # Hard stop on his shot (a few ms so it does not click), silence after.
    i = int(FIRE * SR)
    k = int(0.012 * SR)
    out[i:i + k] *= np.linspace(1, 0, k)[:, None]
    out[i + k:] = 0
    return out


def render_audio(path):
    A.BANK = A.sound_bank()
    n = int(END * SR)
    music = music_edit(n)
    sfx = np.zeros_like(music)
    duck = np.zeros(n)
    rng = np.random.default_rng(5)

    def hold_duck(t0, t1, v):
        i0, i1 = int(t0 * SR), min(n, int(t1 * SR))
        duck[i0:i1] = np.maximum(duck[i0:i1], v)

    for s in shots:
        if not s["src"] or s["src"] == "TITLE":
            continue
        meta_ = A.Source.get(s["src"]).meta
        a0, a1 = s["at"], s["at"] + (s["T1"] - s["T"])
        sable = s["src"].startswith(("BD-", "SB-", "WD-"))
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
            if sable:
                vol += 4  # SABLE: louder weapons and steps in their scenes
            if s["src"] == "WD-down":
                vol += 12 if gun else 3  # the last scene is close and quiet: every step counts
            if spec["files"]:
                A.place(sfx, A.sample(spec["files"][rng.integers(len(spec["files"]))]), T, (-4 if gun else -9) + att + vol, rng.uniform(-0.2, 0.2))
            for sy in spec["synth"]:
                if sy.endswith("_punch"):
                    A.place(sfx, A.synth(sy), T, -7 + att + vol)
            if spec["tail"]:
                A.place(sfx, A.sample("tail_hall"), T + 0.004, -14 + att * 0.5 + vol)
            if gun and dist < 6 and T < FIRE - 0.5:
                i = int(T * SR)
                d = np.r_[np.linspace(0, 1, 240), np.ones(int(0.08 * SR)), np.linspace(1, 0, int(0.15 * SR))]
                j = min(n, i + len(d))
                duck[i:j] = np.maximum(duck[i:j], d[: j - i])

    # Intro foley, on the macro and insertion shots.
    for T, kind, g in [(3.15, "rel_magin", -4), (4.35, "rel_boltback", -5), (4.60, "rel_boltforward", -4),
                       (12.94, "thud", -6), (12.95, "metal_clang", -18), (14.98, "breath_in", -11), (16.08, "breath_out", -11),
                       (17.12, "beep", -16), (TITLE_T, "clunk", -9)]:
        A.place(sfx, A.sample(kind), T, g)
    rot = A.sample("rotor")
    seg = rot[: int(9.5 * SR)] * np.r_[np.linspace(0, 1, SR), np.ones(int(7.5 * SR)), np.linspace(1, 0, SR)][: int(9.5 * SR)]
    A.place(sfx, seg, beat(-49), -15)

    # Bass dip before the drop: the Warden, close. "There you are."
    A.place(sfx, close(voice_file("commander_firstcontact_01")), 31.35, 2)
    hold_duck(31.3, 32.4, 1.6)

    # Alarm + evacuation call over phrase B, power out, breach on the downbeat.
    ts = np.arange(int(7.2 * SR)) / SR
    wail = 620 + 280 * (0.5 - 0.5 * np.cos(2 * np.pi * ts / 2.4))
    ph = 2 * np.pi * np.cumsum(wail) / SR
    siren = (np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.12 * np.sin(3 * ph)) * np.clip(ts / 1.2, 0, 1) * np.clip((7.2 - ts) / 1.0, 0, 1)
    for t0 in (beat(31) + 0.2, beat(43)):
        A.place(sfx, siren * 0.5, t0, -14, -0.35)
        A.place(sfx, siren * 0.5, t0 + 0.04, -16, 0.35)
    tt = np.arange(int(0.9 * SR)) / SR
    chime = sum(np.sin(2 * np.pi * f * tt) * np.exp(-((tt - t0) * 9).clip(0)) * (tt >= t0) for f, t0 in [(880, 0.0), (698, 0.28), (587, 0.56)])
    A.place(sfx, chime * 0.3, beat(31) - 0.15, -8)
    A.place(sfx, pa(ROOT / "build" / "pa_main.wav", 1.0), beat(31) + 0.3, -1)
    hold_duck(beat(31) + 0.25, beat(42.5), 1.5)
    for T, name, g in [(beat(42.5), "power_out", -5), (beat(43), "explosion", 1), (beat(43) + 0.005, "boom_close0", -2), (beat(51), "bd_encounter", -4)]:
        A.place(sfx, A.sample(name), T, g)

    # SABLE: their radio, and the Warden's own voice.
    for T, name, g in [(beat(45) + 0.15, "bd_see_enemy", 1), (beat(63) + 0.2, "bd_spread_out", 0), (beat(67) + 0.3, "bd_contact", 0),
                       (beat(77) + 0.1, "bd_flanking", -3)]:
        A.place(sfx, A.sample("static"), T - 0.12, -12)
        A.place(sfx, voice_file(name), T, g)
    A.place(sfx, close(voice_file("commander_firstcontact_07")), beat(47) + 0.35, -1)   # "Contact confirmed. He's mine."
    hold_duck(beat(47) + 0.3, beat(47) + 2.7, 1.8)
    A.place(sfx, close(voice_file("commander_threat_03")), beat(55) + 0.25, 0)          # "No extraction. No rescue. Just us."
    hold_duck(beat(55) + 0.2, beat(55) + 4.5, 2.0)
    A.place(sfx, pa(ROOT / "build" / "pa_repeat.wav", 1.8), beat(63) + 1.6, -9, 0.3)
    A.place(sfx, A.sample("static"), beat(87) - 0.12, -11)
    A.place(sfx, radio(voice_file("commander_command_01")), beat(87), -2)               # "Two left. One with me."
    hold_duck(beat(87), beat(87) + 2.6, 1.0)

    # The last scene: ringing ears, breathing, his line, the shot.
    tr = np.arange(int(5.5 * SR)) / SR
    ring = np.sin(2 * np.pi * 5900 * tr) * np.exp(-tr / 2.2) * np.clip(tr / 0.05, 0, 1)
    A.place(sfx, ring * 0.12, beat(111), -10)
    for T, kind, g in [(beat(111) + 0.05, "boom_close0", -8), (WD_IN - 0.6, "breath_in", -7), (WD_IN + 0.9, "breath_out", -8),
                       (WD_IN + 2.3, "breath_in", -9), (FIRE - 1.6, "breath_out", -10)]:
        A.place(sfx, A.sample(kind), T, g)
    A.place(sfx, close(voice_file("commander_firstcontact_09")), FIRE - 4.6, 1)         # "You've come an awfully long way... just to die here."
    hold_duck(FIRE - 4.65, FIRE, 1.2)
    A.place(sfx, A.sample("boom_close0"), FIRE, 2)
    A.place(sfx, A.sample("explosion"), FIRE, -6)
    ring2 = np.sin(2 * np.pi * 6400 * tr) * np.exp(-tr / 1.6)
    A.place(sfx, ring2 * 0.1, FIRE + 0.25, -12)

    out = music * (10 ** (-2.0 * duck / 20))[:, None] * 0.9 + sfx * 0.5
    pk = np.abs(out).max()
    if pk > 0.98:
        out = np.tanh(out / pk * 1.3) / np.tanh(1.3) * 0.97
    sf.write(path, out, SR, subtype="PCM_24")


if __name__ == "__main__":
    if "--plan" in sys.argv[1:] or "plan" in sys.orig_argv[2:]:
        for s in shots:
            print(f'{s["T"]:7.3f} {s["T1"] - s["T"]:5.2f}  {str(s["src"]):10s} {s["at"] if s["at"] is None else round(s["at"], 2)!s:6s} {s["tr"]:8s} {s["tag"] or ""}')
        sys.exit()
    vid = ROOT / "build" / "_v2_video.mp4"
    wav = ROOT / "build" / "v2_mix.wav"
    render_audio(wav)
    print("audio ok,", len(shots), "shots")
    render_video(vid)
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([exe, "-y", "-loglevel", "error", "-i", str(vid), "-i", str(wav), "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
                    "-shortest", str(ROOT / "build" / "trailer_v2.mp4")], check=True)
    print("wrote build/trailer_v2.mp4")
