"""Reveal trailer v3: "Abandoned Complex" (112 BPM), the flow2 style with a new edit.

Style kept from the flow cuts: the music runs without a gap, every cut lands on the
grid, a constant slow push-in, room tags, white flash transitions on the hits, 2.2:1
frame, 60 fps captures blended to 30 fps. New in v3:

  - one music edit (bar 23 -> bar 63 of the track, both after a thin "B" bar, on a
    downbeat) so the trailer climbs straight from the SABLE section into the densest
    8 bars of the track (171.1-188.3) and lands on the drumless chord;
  - SABLE carries the second half: the alarm and the evacuation PA, the breach, the
    squad opening fire, the Warden walking his column down the server hall (SB), and
    the ending (WD): you are on the floor, he stands over you, says firstcontact_09,
    fires; white, black, a short SITE-9 title. The music stops on his shot (the only
    place it does) and that shot is the loudest moment of the mix;
  - a Warden voice-over in the cold open, radio chatter on the SABLE shots;
  - every shot window is checked against the take's contact rows (tools/rows.py):
    dark or blown-out stretches are refused, each camera is used at most twice and
    never twice on the same moment.

python tools/flow3.py --windows   -> build/flow3_windows.json + build/flow3_queue.txt
                                     (the frame windows each camera has to capture)
python tools/flow3.py --sheet     -> build/flow3_keyframes.jpg (key frame contact sheet)
python tools/flow3.py --audio     -> build/v3_mix.wav only (+ build/flow3_levels.json)
python tools/flow3.py             -> build/trailer_v3.mp4

Music: music/abandoned.wav (decoded from the source mp3, never committed).
Font: build/fonts/Barlow-Medium.ttf when there is no Bahnschrift (assemble.font).
"""
import json
import subprocess
import sys

MODE = sys.argv[1] if len(sys.argv) > 1 else ""
sys.argv = [sys.argv[0], "1280", "720"]
import assemble as A  # noqa: E402  (footage loader, typography, sound helpers)
import imageio_ffmpeg  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from scipy.signal import butter, lfilter, resample_poly  # noqa: E402

ROOT = A.ROOT
W, H, FPS, SR = A.W, A.H, A.FPS, A.SR

# ------------------------------------------------------------------ music grid (track seconds)
BEAT = 0.535714
G0 = 34.501                      # beat 0; downbeats where (n + 1) % 4 == 0
DROP = 33.965                    # beat -1 = bar 0


def tbeat(n):
    return G0 + n * BEAT


def tbar(k):
    return DROP + k * 4 * BEAT


# One edit: trailer runs the track 0 -> bar 24, then continues from bar 63.
SPLICE = tbar(24)                # 85.394 (end of bar 23, a thin bar)
SRC2 = tbar(63)                  # 168.965 (the build bar into the climax)
OFF2 = SRC2 - SPLICE             # trailer T = track - OFF2 after the splice


def T_of(track):
    return track if track < SPLICE + 1e-6 else track - OFF2


def bar(k):
    """Trailer time of bar k's downbeat (bars 0..23 before the edit, 63.. after)."""
    return T_of(tbar(k)) if k < 24 or k >= 63 else None


def beat(n):
    return T_of(tbeat(n))


CHORD = T_of(188.252)            # 104.68: drumless chord, the ending
HITS = [T_of(t) for t in (187.18, 187.45, 187.72, 187.99)]
SHOT = CHORD + 10 * BEAT         # the Warden's shot (on the beat grid), music stops
TITLE = SHOT + 0.96
END = TITLE + 4.4


# ------------------------------------------------------------------ takes: events, contact rows
_ev = {}


def meta(take):
    if take not in _ev:
        p = ROOT / "build" / "events" / f"{take}.json"
        _ev[take] = json.loads(p.read_text()) if p.exists() else {"fps": 60, "handles": 0, "duration": 10, "events": []}
    return _ev[take]


def fires(take, mine=False, near=None):
    out = []
    for e in meta(take)["events"]:
        if e["name"].endswith(".fire") and e["t"] > 0.05:
            if not mine or (e.get("distance") or 0) <= 3.5:
                out.append(e["t"])
    out = sorted(set(out))
    return out if near is None else sorted(out, key=lambda t: abs(t - near))


_rows = {}


def rows(src):
    if src not in _rows:
        p = ROOT / "build" / "rows" / f"{src}.json"
        _rows[src] = {int(k): v for k, v in json.loads(p.read_text()).items()} if p.exists() else {}
    return _rows[src]


def usable(src, a, b):
    """No dark / blown sample of the take's contact rows inside [a, b]."""
    r = rows(src)
    return not any(a - 0.05 <= v["t"] <= b + 0.05 and v["flag"] for v in r.values())


used = {}
uses = {}


def free(src, a, b):
    return all(b <= x - 0.3 or a >= y + 0.3 for x, y in used.get(src, []))


def claim(src, a, b):
    used.setdefault(src, []).append((a, b))
    uses[src] = uses.get(src, 0) + 1


def pick(src, dur, after=0.0, lead=0.1, near=None, fire=True, mine=None):
    """Source time for a shot of `dur` s: on a gunshot (cut lands `lead` s before it) when
    there is one, in a usable stretch nobody else has taken."""
    take = src.split("-")[0]
    if mine is None:
        mine = src.endswith("pov")
    end = meta(take).get("duration", 10)
    cands = fires(take, mine, near) if fire else []
    for t in cands:
        a = t - lead
        if t >= after and a >= 0 and a + dur <= end and free(src, a, a + dur) and usable(src, a, a + dur):
            return a
    grid = np.arange(max(0.0, after), max(0.0, end - dur) + 1e-6, 0.1)
    if near is not None:
        grid = sorted(grid, key=lambda a: abs(a - near))
    for a in grid:
        if free(src, a, a + dur) and usable(src, a, a + dur):
            return float(a)
    print(f"WARNING: no clean window for {src} ({dur:.2f} s after {after}), using a flagged one")
    for a in grid:
        if free(src, a, a + dur):
            return float(a)
    return max(0.0, min(after, end - dur))


# ------------------------------------------------------------------ the cut
# Room tags are numbered in order of appearance; SABLE gets its own tags.
ROOMS = {"FC": "ASSEMBLY HALL", "SV": "SERVER HALL", "LB": "R&D LABS", "PW": "POWER PLANT", "HG": "HANGAR", "AT": "ATRIUM", "WH": "WAREHOUSE"}
SABLE_TAGS = {"BD": "SABLE / BLACK DIVISION", "SB": "SABLE / THE WARDEN"}

# Fixed cues inside takes (take seconds): the edl clicks, the breach, the Warden's shot.
A03_CLICK = 0.55
A04_BACK = 0.70
BD_BREACH = 1.2
fc0 = next((t for t in fires("FC", True) if t > 3.0), 4.6)
wd_shot = next((e["t"] for e in meta("WD")["events"] if e["name"].endswith(".fire") and e["t"] > 6.0), 7.22)
sg = fires("SG", True)

S = []  # [T, src, at|None, tag, tr, opts]


def shot(T, src, at=None, tag=None, tr="cut", **opts):
    S.append([T, src, at, tag, tr, opts])


def hb(k, j=0):
    """Bar k's downbeat + j beats (trailer time)."""
    return bar(k) + j * BEAT


# Source times come from the contact rows of every camera (tools/rows.py): `at` where the
# moment is fixed, `near` (+ a gunshot when there is one) where the take decides.
# I. Cold open (track intro, no drums): the rifle in the dark, the Warden on the net.
shot(0.00, "A02", 0.20, None, "fade")
shot(hb(-15), "A03", A03_CLICK - BEAT)                      # mag CLICK on the next beat
shot(hb(-15, 3), "A05", 0.0)                                # red sweep + annotation
shot(hb(-13), "A04", A04_BACK - BEAT)                       # bolt back on the next beat
shot(hb(-13, 3), None, None, None, "black")
# II. Insertion (bar -12, the build, rotor): searchlight, rope, boots, the team, the mask.
shot(hb(-12), "IN-tilt", 2.4, "SITE-9 / VANTA DYNAMICS RESEARCH CAMPUS", "dissolve")
shot(hb(-11), "IN-rope", 5.55, None, "dissolve")
shot(hb(-11, 2), "IN-land", 5.5)
shot(hb(-10), "IN-team", 5.2, None, "dissolve")
shot(hb(-9), "IN-mask", 6.0, None, "dissolve")
shot(hb(-9, 2), "IN-turn", 6.15)
# Drums in (bar -8): the machines wake; the walk in.
shot(hb(-8), "RB-visor", 1.9, None, "flash")
shot(hb(-8, 2), "RB-servo", 2.0)
shot(hb(-7), "FC-ots", 0.4, "auto")
shot(hb(-6), "RB-chest", 2.25)
shot(hb(-6, 2), "RB-far", 2.75)
shot(hb(-5), "LB-pov", 4.6, None, "dissolve")
shot(hb(-4), "RB-wide", 1.0, None, "flash")
shot(hb(-3), "FC-low", 2.3)
# The bass drops out (bars -2, -1): hold the aim; two dark beats before the drop.
shot(hb(-2), "FC-pov", fc0 - 3.65, None, "dissolve")
shot(hb(-1, 2), None, None, None, "black")
# III. DROP (bar 0): first shot.
shot(hb(0), "FC-pov", fc0 - 0.02, None, "flash")
shot(hb(0, 2), "FC-low", None, None, near=fc0 + 0.6)
shot(hb(1), "SG-pov", (sg[0] - 0.05) if sg else None, None, "flash")
shot(hb(1, 2), "SG-side", None, None, near=(sg[1] if len(sg) > 1 else 6.4) - 0.1)
shot(hb(2), "WH-pov", None, "auto", "flash", near=2.5)
shot(hb(2, 2), "FC-ots", None, None, near=fc0 + 2.6)
# Rooms (bars 3-7, the thinner phrase): a room a bar.
shot(hb(3), "SV-pov", None, "auto", "flash", near=6.3)
shot(hb(4), "LB-mate", None, "auto", near=0.6)
shot(hb(4, 2), "LB-pov", None, None, near=3.3)
shot(hb(5), "PW-pov", None, "auto", "flash", near=4.7)
shot(hb(6), "HG-side", 0.0, "auto")
shot(hb(6, 2), "HG-pov", None, None, near=2.4)
shot(hb(7), "AT-pov", 0.0, "auto", "flash")
# Bars 8-10 (dense): the squad, two beats a shot, on the gunshots.
# (SQ-mate: the teammate lit only by his own muzzle flashes, fixed on a burst.)
for i, (src, nr) in enumerate([("SQ-mate", 5.9), ("WH-mate", 2.5), ("SQ-front", 3.9), ("HG-pov", 4.2), ("SQ-pov", 5.9), ("AT-pov", 2.8)]):
    shot(hb(8, 2 * i), src, 5.85 if src == "SQ-mate" else None, None, "flash" if i % 2 == 0 else "cut", near=nr)
# IV. The alarm (bar 11): siren, evacuation PA; the power fails; the breach on bar 14.
shot(hb(11), "PW-front", 0.0, None, "flash")
shot(hb(12), "LB-mate", None, None, near=9.3, fire=False)
shot(hb(13), "WH-pov", None, None, near=5.0, fire=False)
shot(hb(13, 2), None, None, None, "black")                  # power out
shot(hb(13, 3), "BD-breach", BD_BREACH - BEAT, None)        # the charge blows on the downbeat
shot(hb(14, 2), "BD-nvg", 2.4, "auto")
shot(hb(15), "BD-ots", 3.0)
shot(hb(15, 2), "BD-breach", 4.4)
# Bars 16-18: SABLE open fire; the squad answers.
shot(hb(16), "BD-pov", None, None, "flash", near=4.1)
shot(hb(16, 2), "BD-nvg", 3.9)
shot(hb(17), "SQ-mate", 10.3, None, "flash")
shot(hb(17, 2), "BD-ots", 5.6)
shot(hb(18), "SQ-front", None, None, "flash", near=11.4)
shot(hb(18, 2), "BD-pov", None, None, near=5.6)
# V. The Warden (bars 19-23, thin phrase): his column comes down the server hall.
shot(hb(19), "SB-column", 2.4, "auto", "dissolve")
shot(hb(20), "SB-warden", 1.0)
shot(hb(21), "SB-peek", 6.0, None, "dissolve")
shot(hb(21, 2), "SB-side", 9.45)
shot(hb(22), "SB-column", 7.3, None, "flash")
shot(hb(23), "SB-warden", 5.4)
# ---- the music edit: bar 63 (build), a cut on every beat
for i, (src, nr) in enumerate([("HG-side", 8.8), ("PW-pov", 6.4), ("SV-pov", 10.6), ("AT-side", 2.9)]):
    shot(hb(63, i), src, None, None, "flash" if i == 0 else "cut", near=nr, fire=src != "HG-side")
# VI. The climax (bars 64-71): two beats a shot, a held bar, two beats, the four hits.
for i, (src, nr) in enumerate([("SB-peek", 9.3), ("SG-pov", 6.35), ("SQ-robo", 3.0), ("HG-front", 8.6), ("SV-front", 6.4), ("WH-mate", 5.6),
                               ("SQ-robo", 7.0), ("PW-front", 9.1), ("SG-side", 3.2), ("SQ-pov", 11.9), ("AT-side", 6.7), ("AT-front", 2.0)]):
    shot(hb(64, 2 * i), src, None, None, "flash" if i % 2 == 0 else "cut", near=nr, fire=src not in ("HG-front", "PW-front"))
shot(hb(70), "RB-visor", 4.4, None, "flash")                # the thin bar: the machine looks back
shot(hb(71), "SV-front", None, None, near=11.0)
for T, (src, nr) in zip(HITS, [("AT-front", 5.5), ("SB-side", 10.8), ("HG-front", 0.5), ("RB-servo", 0.3)]):
    shot(T, src, None, None, "flash", near=nr)
# VII. The ending, on the chord: on the floor; he walks up, speaks, draws down, fires.
shot(CHORD, "WD-floor", wd_shot - (SHOT - CHORD))
shot(CHORD + 6 * BEAT, "WD-mask", wd_shot - (SHOT - (CHORD + 6 * BEAT)))
shot(CHORD + 8 * BEAT, "WD-floor", wd_shot - (SHOT - (CHORD + 8 * BEAT)))
shot(SHOT, None, None, None, "white")
shot(SHOT + 2 / FPS, None, None, None, "black")
shot(TITLE, "TITLE", None, None, "title")
S.sort(key=lambda p: p[0])

# Resolve source times, durations, tags. Fixed source times first (they own their moments).
shots = []
for i, (T, src, at, tag, tr, o) in enumerate(S):
    T1 = S[i + 1][0] if i + 1 < len(S) else END
    shots.append({"T": T, "T1": T1, "src": src, "at": at, "tag": tag, "tr": tr, "o": o})
for s in shots:
    if s["src"] and s["src"] != "TITLE" and s["at"] is not None:
        claim(s["src"], s["at"], s["at"] + (s["T1"] - s["T"]))
for s in shots:
    if s["src"] and s["src"] != "TITLE" and s["at"] is None:
        o = s["o"]
        dur = s["T1"] - s["T"] + 0.05
        nr = o.get("near")
        s["at"] = pick(s["src"], dur, after=o.get("after", 0.0 if nr is not None else 1.0), lead=o.get("lead", 0.08), near=nr, fire=o.get("fire", True))
        claim(s["src"], s["at"], s["at"] + dur)
last_room = None
numbered = {}
for s in shots:
    room = s["src"].split("-")[0] if s["src"] and s["src"] != "TITLE" else None
    if s["tag"] == "auto":
        if room in SABLE_TAGS:
            s["tag"] = SABLE_TAGS[room] if room != last_room else None
        elif room in ROOMS and room != last_room and room not in numbered:
            numbered[room] = len(numbered) + 1
            s["tag"] = f"{numbered[room]:02d} / {ROOMS[room]}"
        else:
            s["tag"] = None
    if room in ROOMS or room in SABLE_TAGS:
        last_room = room
    s.pop("o")
over = {k: n for k, n in uses.items() if n > 2 and not k.startswith("WD")}
if over:
    print("WARNING: cameras used more than twice:", over)


# ------------------------------------------------------------------ capture windows
def windows():
    """Take-time windows per camera (with the dissolve tails and the 60->30 sub-frame)."""
    win = {}
    for i, s in enumerate(shots):
        if not s["src"] or s["src"] == "TITLE":
            continue
        a = s["at"] - 0.04
        b_ = s["at"] + (s["T1"] - s["T"]) + 0.06
        nxt = shots[i + 1] if i + 1 < len(shots) else None
        if nxt and nxt["tr"] == "dissolve":
            b_ += 0.42
        win.setdefault(s["src"], []).append([round(max(a, -0.25), 2), round(b_, 2)])
    for k, ws in win.items():
        ws.sort()
        merged = [ws[0]]
        for a, b_ in ws[1:]:
            if a <= merged[-1][1] + 0.3:
                merged[-1][1] = max(merged[-1][1], b_)
            else:
                merged.append([a, b_])
        win[k] = merged
    return win


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
    bar_ = int((H - W / 2.2) / 2 * k)
    if bar_ <= 0:
        return img
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, bar_], fill=(0, 0, 0))
    d.rectangle([0, H - bar_, W, H], fill=(0, 0, 0))
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
    img = A.Source.get(s["src"]).frame(s["at"] + lt)
    return drift(img, lt, s["T1"] - s["T"])


def short_title(t):
    """SITE-9 under a raking light, one descriptor line, out to black (short)."""
    img = A.title_card(t * 1.25, "SITE-9", "TACTICAL CO-OP FPS", None)
    if t > END - TITLE - 0.9:
        img = Image.blend(img, Image.new("RGB", (W, H)), min(1, (t - (END - TITLE - 0.9)) / 0.8))
    return img


def frame_at(T, si):
    s = shots[si]
    lt = T - s["T"]
    black = Image.new("RGB", (W, H))
    if s["tr"] == "title":
        return short_title(lt)
    if s["tr"] == "black":
        return black
    if s["tr"] == "white":
        return Image.new("RGB", (W, H), (255, 250, 242))
    img = shot_frame(s, T)
    if s["src"] == "A05" and lt > 0.6:
        A.annotate(img, lt - 0.6, int(W * 0.42), int(H * 0.42), ["M4A1", "5.56×45 M855", "910 M/S", "3.0 KG"])
    prev = shots[si - 1] if si > 0 else None
    if s["tr"] == "fade" and lt < 1.2:
        img = Image.blend(black, img, lt / 1.2)
    elif s["tr"] == "dissolve" and lt < 0.4 and prev and prev["src"] not in (None, "TITLE"):
        img = Image.blend(shot_frame(prev, T), img, lt / 0.4)
    elif s["tr"] == "flash" and lt < 0.12:
        img = Image.blend(img, Image.new("RGB", (W, H), (255, 244, 230)), 0.45 * (1 - lt / 0.12))
    if s["tag"]:
        tag_overlay(img, lt, s["tag"])
    # The 2.2:1 frame eases in with the insertion, out of the macro cold open.
    k = min(1, max(0, (T - (bar(-12) - 0.3)) / 0.6))
    return letterbox(img, k)


def render_video(path):
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    n = int(END * FPS)
    p = subprocess.Popen([exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                          "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    si = 0
    for f in range(n):
        T = f / FPS
        while si < len(shots) - 1 and T >= shots[si + 1]["T"] - 1e-9:
            si += 1
        p.stdin.write(frame_at(T, si).tobytes())
    p.stdin.close()
    p.wait()


def key_sheet(path):
    """Contact sheet of the cut: the frame 40% into every shot, with its slot and source."""
    cells = [(i, s) for i, s in enumerate(shots) if s["src"] and s["src"] != "TITLE"]
    tw, th, cols = 256, 144, 8
    rows_ = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows_ * th), (20, 20, 22))
    f = A.font(13)
    for k, (i, s) in enumerate(cells):
        T = s["T"] + 0.4 * (s["T1"] - s["T"])
        im = frame_at(T, i).resize((tw, th))
        d = ImageDraw.Draw(im)
        d.text((4, th - 34), f"{s['T']:.2f}  {s['src']}", font=f, fill=(255, 200, 0))
        d.text((4, th - 18), f"@{s['at']:.2f}  {s['T1'] - s['T']:.2f}s", font=f, fill=(200, 200, 200))
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
    """SABLE squad net: narrow band, a little grit."""
    y = band(y, 420, 3300)
    y = np.tanh(y / (np.abs(y).max() + 1e-9) * 2.4) / np.tanh(2.4)
    return y


def pa(y, wet):
    """Facility PA: speaker band, overdrive, hall echoes."""
    y = band(y, 350, 3800)
    y = np.tanh(y / (np.abs(y).max() + 1e-9) * 3.2) / np.tanh(3.2)
    out = np.zeros(len(y) + int(1.2 * SR))
    for delay, g in [(0, 1.0), (0.085, 0.38 * wet), (0.21, 0.26 * wet), (0.43, 0.16 * wet), (0.71, 0.09 * wet)]:
        i = int(delay * SR)
        out[i:i + len(y)] += y * g
    return out


def music_bed(n):
    src, sr = sf.read(ROOT / "music" / "abandoned.wav", always_2d=True)
    if sr != SR:
        src = resample_poly(src, SR, sr, axis=0)
    a = src[: int(SPLICE * SR)]
    b_ = src[int(SRC2 * SR):]
    xf = int(0.015 * SR)                      # 15 ms crossfade at the downbeat
    ramp = np.linspace(0, 1, xf)[:, None]
    joined = np.concatenate([a[:-xf], a[-xf:] * (1 - ramp) + b_[:xf] * ramp, b_[xf:]])
    music = np.zeros((n, 2))
    m = min(n, len(joined))
    music[:m] = joined[:m]
    # The Warden's shot cuts the music (the only stop): 8 ms out, nothing after.
    i = int(SHOT * SR)
    k = int(0.008 * SR)
    music[i - k:i] *= np.linspace(1, 0, k)[:, None]
    music[i:] = 0
    return music


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

    # 1) The game's own sound events from every shot actually on screen.
    for s in shots:
        if not s["src"] or s["src"] == "TITLE":
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
            if T >= SHOT - 0.05:
                continue  # nothing competes with the last shot
            dist = e.get("distance") or 1.0
            att = -20 * np.log10(max(1.0, dist / 3.0)) * 0.6
            vol = 20 * np.log10(max(1e-3, e.get("volume", 1.0)))
            gun = e["name"].endswith(".fire")
            if s["src"].startswith(("BD-", "SB-")):
                vol += 3  # SABLE: their weapons carry in their sequence
            if spec["files"]:
                A.place(sfx, A.sample(spec["files"][rng.integers(len(spec["files"]))]), T, (-5 if gun else -10) + att + vol, rng.uniform(-0.2, 0.2))
            for sy in spec["synth"]:
                if sy.endswith("_punch"):
                    A.place(sfx, A.synth(sy), T, -8 + att + vol)
            if spec["tail"]:
                A.place(sfx, A.sample("tail_hall"), T + 0.004, -15 + att * 0.5 + vol)
            if gun and dist < 6:
                gun_duck(T)

    # 2) Cold open: room tone, the clicks, the Warden on the net.
    tone = A.sample("roomtone")[: int(9 * SR)] * np.r_[np.linspace(0, 1, SR), np.ones(int(6.5 * SR)), np.linspace(1, 0, int(1.5 * SR))][: int(9 * SR)]
    A.place(sfx, tone, 0.0, -24)
    for T, kind, g in [(hb(-15, 1), "rel_magin", -5), (hb(-13, 1), "rel_boltback", -6), (hb(-13, 1) + 0.25, "rel_boltforward", -5)]:
        A.place(sfx, A.sample(kind), T, g)
    A.place(sfx, A.sample("static"), hb(-14) - 0.14, -14)
    A.place(sfx, radio(voice("commander_threat_04")), hb(-14), -6, -0.1)
    A.place(sfx, A.sample("static"), hb(-14) + 2.05, -16)
    # Insertion: rotor under the build, boot on the deck, the mask breathing.
    rot = A.sample("rotor")
    seg = rot[: int(9.2 * SR)] * np.r_[np.linspace(0, 1, SR), np.ones(int(7.0 * SR)), np.linspace(1, 0, int(1.2 * SR))][: int(9.2 * SR)]
    A.place(sfx, seg, bar(-12) - 0.6, -15)
    for T, kind, g in [(hb(-11, 2) + 0.75, "thud", -7), (hb(-11, 2) + 0.76, "metal_clang", -19), (hb(-9) + 0.2, "breath_in", -11),
                       (hb(-9) + 1.3, "breath_out", -11), (hb(-9, 2) + 0.25, "beep", -17)]:
        A.place(sfx, A.sample(kind), T, g)
    # The dark beats before the drop: a vacuum (music only).

    # 3) The alarm (bar 11): chime + two-tone siren, the evacuation PA, power out, the breach.
    a0 = bar(11)
    alarm = A.sample("alarm_short")
    A.place(sfx, alarm, a0 - 0.05, -9, -0.2)
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
    duck[i0:i1] = np.maximum(duck[i0:i1], 1.4)        # music -3 dB under the announcement
    for T, name, g in [(hb(13, 2), "power_out", -5), (hb(14), "explosion", 1), (hb(14) + 0.005, "boom_close0", -3), (hb(14, 2) + 0.2, "bd_encounter", -4)]:
        A.place(sfx, A.sample(name), T, g)
        if name == "explosion":
            gun_duck(T, 1.6)
    # SABLE net: the lead sees you, spreads them, contact; the Warden's orders over his column.
    calls = [(hb(15) + 0.15, "bd_see_enemy", 1, "radio"), (hb(16) + 0.3, "bd_spread_out", 0, "radio"), (hb(18) + 0.2, "bd_contact", -1, "radio"),
             (hb(19) + 0.5, "commander_command_14", -1, "radio"), (hb(20) + 0.5, "commander_threat_07", 0, "near"),
             (hb(23) + 0.7, "bd_flanking", -3, "radio"), (hb(68) + 0.25, "commander_lowhp_04", -2, "radio")]
    for T, name, g, how in calls:
        A.place(sfx, A.sample("static"), T - 0.12, -13)
        y = voice(name)
        A.place(sfx, radio(y) if how == "radio" else band(y, 90, 9000, 2), T, g, 0.1)
        A.place(sfx, A.sample("static"), T + len(y) / SR + 0.02, -16)

    # 4) The ending. The chord rings; footsteps; his line; a breath of silence; the shot.
    line = voice("commander_firstcontact_09")
    t_line = SHOT - 0.8 - len(line) / SR
    A.place(sfx, band(line, 70, 10000, 2), t_line, 1.5)
    for e in meta("WD")["events"]:
        T = SHOT - (wd_shot - e["t"])
        if CHORD <= T < SHOT - 0.05 and e["name"].startswith("foley"):
            A.place(sfx, A.sample(A.BANK[e["name"]]["files"][0]) if A.BANK.get(e["name"], {}).get("files") else A.synth("thud") * 0.2, T, -14)
    i_pre = int((SHOT - 0.07) * SR)
    sfx[i_pre:int(SHOT * SR)] *= np.linspace(1, 0.1, int(SHOT * SR) - i_pre)[:, None]  # a vacuum before it
    fin = np.zeros((int(5.5 * SR), 2))
    for kind, g in [("heavy_close0", 0.0), ("boom_close1", -3.0), ("pistol_punch", -1.5)]:
        A.place(fin, A.sample(kind) if kind != "pistol_punch" else A.synth(kind), 0.0, g)
    A.place(fin, A.sample("tail_hall"), 0.006, -3)
    tt = np.arange(int(4.5 * SR)) / SR
    A.place(fin, 0.5 * np.sin(2 * np.pi * (38 + 30 * np.exp(-tt * 6)) * tt) * np.exp(-tt * 1.6), 0.0, -2)   # sub drop
    A.place(fin, 0.05 * np.sin(2 * np.pi * 3900 * tt) * np.exp(-tt * 0.9) * np.clip(tt / 0.3, 0, 1), 0.15, -8)  # the ring
    fin_gain = 1.0
    # 5) Title.
    A.place(sfx, A.sample("clunk"), TITLE, -9)
    A.place(sfx, A.sample("hum_rise") * 0.5, TITLE + 0.05, -14)

    def mix(fg):
        out = music * (10 ** (-2.0 * duck / 20))[:, None] * 0.74 + sfx * 0.42
        A.place(out, fin[:, 0] * fg, SHOT, 0.0, 0.0)
        return out

    # Loudness: the Warden's shot must be the loudest moment (peak and 400 ms energy).
    def levels(x):
        m = np.abs(x).max(1)
        win = int(0.4 * SR)
        c = np.concatenate([[0.0], np.cumsum((x ** 2).mean(1))])
        i = np.clip(np.arange(len(x)) + win // 2, 0, len(x))
        j = np.clip(np.arange(len(x)) - win // 2, 0, len(x))
        e = np.sqrt(np.maximum(0, (c[i] - c[j]) / win))
        return m, e
    for _ in range(12):
        out = mix(fin_gain)
        pk, en = levels(out)
        i0 = int((SHOT - 0.02) * SR)
        i1 = int((SHOT + 0.5) * SR)
        rest_pk = max(pk[:i0].max(), pk[i1:].max())
        rest_en = max(en[: int((SHOT - 0.3) * SR)].max(), en[int((SHOT + 1.0) * SR):].max())
        if pk[i0:i1].max() > rest_pk * 1.12 and en[i0:i1].max() > rest_en * 1.25:
            break
        fin_gain *= 1.12
    scale = 0.97 / max(1e-9, np.abs(out).max())
    out = out * scale
    pk, en = levels(out)
    i0, i1 = int((SHOT - 0.02) * SR), int((SHOT + 0.5) * SR)
    rep = {"shot_peak_db": round(20 * np.log10(pk[i0:i1].max()), 2), "rest_peak_db": round(20 * np.log10(max(pk[:i0].max(), pk[i1:].max())), 2),
           "shot_rms400_db": round(20 * np.log10(en[i0:i1].max()), 2),
           "rest_rms400_db": round(20 * np.log10(max(en[: int((SHOT - 0.3) * SR)].max(), en[int((SHOT + 1.0) * SR):].max())), 2),
           "loudest_400ms_at": round(float(np.argmax(en)) / SR, 3), "shot_T": round(SHOT, 3)}
    (ROOT / "build" / "flow3_levels.json").write_text(json.dumps(rep, indent=1))
    print("levels", rep)
    sf.write(path, out, SR, subtype="PCM_24")


if __name__ == "__main__":
    (ROOT / "build").mkdir(exist_ok=True)
    json.dump(shots, open(ROOT / "build" / "flow3_cut.json", "w"), indent=1)
    if MODE == "--windows":
        win = windows()
        (ROOT / "build" / "flow3_windows.json").write_text(json.dumps(win, indent=1))
        lines = []
        for src, ws in sorted(win.items()):
            take, _, cam = src.partition("-")
            lines.append(f"{take} {cam} --win={','.join(f'{a}-{b_}' for a, b_ in ws)} --keep".replace("  ", " "))
        (ROOT / "build" / "flow3_queue.txt").write_text("\n".join(lines) + "\n")
        tot = sum(b_ - a for ws in win.values() for a, b_ in ws)
        print(f"{len(shots)} slots, {len(win)} cameras, {tot:.1f} s of capture ({tot * 60:.0f} frames)")
        for src, n_ in sorted(uses.items()):
            print(f"  {src:10s} x{n_}  {win.get(src)}")
    elif MODE == "--audio":
        render_audio(ROOT / "build" / "v3_mix.wav")
    elif MODE == "--sheet":
        key_sheet(ROOT / "build" / "flow3_keyframes.jpg")
        print("wrote build/flow3_keyframes.jpg")
    else:
        vid = ROOT / "build" / "_v3_video.mp4"
        wav = ROOT / "build" / "v3_mix.wav"
        render_audio(wav)
        print("audio ok,", len(shots), "shots")
        render_video(vid)
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        subprocess.run([exe, "-y", "-loglevel", "error", "-i", str(vid), "-i", str(wav), "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
                        "-shortest", str(ROOT / "build" / "trailer_v3.mp4")], check=True)
        print("wrote build/trailer_v3.mp4")
