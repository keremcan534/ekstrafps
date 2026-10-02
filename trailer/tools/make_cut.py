"""Writes cut.json: which capture (and which moment of it) fills every edl slot.

v2: locations rotate through the acts (assembly aisle, server hall, power plant,
hangar, warehouse, atrium, labs) and no stretch of a take is used twice. Gameplay
slots start just before a real logged shot of that take, so every cut lands on action.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDL = json.loads((ROOT / "edl.json").read_text())
SLOT = {s[0]: (s[1], s[2]) for s in EDL["shots"]}
_ev = {}


def events(take):
    if take not in _ev:
        p = ROOT / "build" / "events" / f"{take}.json"
        _ev[take] = json.loads(p.read_text()) if p.exists() else {"events": [], "duration": 0}
    return _ev[take]["events"]


def length(take):
    events(take)
    return _ev[take].get("duration", 0)


def fires(take, mine=True):
    """Shot times: mine = the player's own (close to the camera); otherwise anyone's."""
    out = []
    for e in events(take):
        if e["name"].endswith(".fire") and e["t"] > 0.05:
            d = e.get("distance") or 0
            if not mine or d <= 3.5:
                out.append(e["t"])
    return sorted(set(round(t, 3) for t in out))


used = {}  # take -> source ranges already in the cut


def free(take, a, b):
    return all(b <= x or a >= y for x, y in used.get(take, []))


def claim(take, a, b):
    used.setdefault(take, []).append((a, b))


def dur(sid):
    return SLOT[sid][1] - SLOT[sid][0]


cut = {}


def put(sid, src, at, **kw):
    take = src.split("-")[0]
    d = dur(sid) * abs(kw.get("speed", 1.0))
    claim(take, min(at, at - d if kw.get("speed", 1) < 0 else at), at + d)
    cut[sid] = {"src": src, "at": round(at, 3), **kw}


def on_shot(sid, src, after=0.0, lead=0.12, mine=True, **kw):
    """Fill a slot starting `lead` s before the first unused shot after `after` in this take."""
    take = src.split("-")[0]
    d = dur(sid)
    end = length(take)
    for t in fires(take, mine):
        a = t - lead
        if t >= after and a >= 0 and a + d <= end and free(take, a, a + d):
            put(sid, src, a, **kw)
            return a
    a = max(0.0, min(after, end - d))
    while not free(take, a, a + d) and a + d < end:
        a += 0.25
    put(sid, src, a, **kw)
    return a


def first(lst, after=-1e9, default=0.0):
    for t in lst:
        if t > after:
            return t
    return default


# ---------------- Act I: macro set
cut["A01"] = {"fx": "black"}
put("A02", "A02", 0.0, fx="fadein")
put("A03", "A03", 0.0)
put("A04", "A04", 0.0)
put("A05", "A05", 0.0, annotate=[{"t0": 0.55, "x": 0.42, "y": 0.42, "lines": ["M4A1", "5.56×45 M855", "910 M/S", "3.0 KG"]}])
cut["A06"] = {"fx": "black"}

# ---------------- Act II: insertion (IN) + far sensor (RB)
put("B01", "IN-track", 0.8)
put("B02", "IN-track", 3.0)
put("B03", "IN-tilt", 2.4)
put("B04", "IN-rope", 4.2)
put("B05", "IN-land", 5.75)
put("B06", "IN-team", 6.0)
put("B07", "IN-turn", 5.9)
put("B08", "IN-team", 9.6)
put("B09", "RB-far", 1.25)
put("B10", "IN-team", 10.3)

# ---------------- Act III: build — server hall walk-in, robot fragments, the aisle
fc0 = first(fires("FC"), 3.0, 4.6)
put("C01", "SV-pov", 0.3)
put("C02", "RB-visor", 1.45)
put("C03", "RB-foot", 1.0)
put("C04", "RB-servo", 1.75)
put("C05", "FC-pov", 2.05)
put("C06", "FC-pov", fc0 - dur("C06") - dur("C07") + 0.1)
cut["C07"] = {"src": "FC-ots", "at": round(fc0 - dur("C07"), 3)}

# ---------------- Act IV: first contact, then the guns in different rooms
put("D01", "FC-pov", fc0)
cut["D02"] = {"src": "FC-low", "at": round(fc0 + 0.35, 3)}
on_shot("D03", "SV-pov", 3.0)
on_shot("D04", "SV-mate", 3.0, mine=False)
reloads = [e["t"] for e in events("SV") if "magout" in e["name"]]
put("D05", "SV-pov", first(reloads, 2.0, 9.0) - 0.15)
on_shot("D06", "HG-pov", 4.0)
on_shot("D07", "PW-side", 3.0, mine=False)
on_shot("D08", "AT-pov", 9.8, lead=0.25, fx="flashout")

# ---------------- Act V: the threat
put("E01", "SV-robo", 7.2)
put("E02", "RB-wide", 1.2)
put("E03", "HG-front", 3.5)
on_shot("E04", "PW-pov", 2.8, lead=0.05)
on_shot("E05", "LB-pov", 4.5)
put("E06", "AT-pov", 0.0)

# ---------------- Act VI: co-op discovered, squads in every room
put("F01", "SQ-pov", 0.85)  # a teammate fires at 0.93 while you are still aiming
on_shot("F02", "HG-mate", 3.6, mine=False)
on_shot("F03", "SV-mate", 6.0, mine=False)
on_shot("F04", "PW-mate", 3.0, mine=False)
on_shot("F05", "HG-side", 5.0, mine=False)
on_shot("F06", "SV-side", 4.0, mine=False)
on_shot("F07", "HG-pov", 6.5)
sg = sorted(set(e["t"] for e in events("SG") if e["name"] == "shotgun.fire"))
sg0 = first(sg, 0.0, 3.27)
put("F08", "SG-pov", sg0 - dur("F08"))
put("F09", "SG-pov", sg0)
on_shot("F10", "AT-mate", 3.0, mine=False)
on_shot("F11", "PW-robo", 3.0, mine=False)
on_shot("F12a", "HG-front", 6.0, mine=False)
on_shot("F12b", "WH-pov", 1.0)
on_shot("F12c", "PW-side", 6.0, mine=False)
on_shot("F12d", "AT-front", 4.0, mine=False)
mont = [("M01", "A03", 0.53), ("M02", "A05", 1.2), ("M03", "A04", 0.66), ("M04", "A05", 2.2), ("M05", "RB-servo", 2.8),
        ("M06", "RB-foot", 2.3), ("M07", "IN-land", 5.9), ("M08", "SV-pov", 9.0), ("M09", "WH-pov", 6.0),
        ("M10", "HG-pov", 9.0), ("M11", "A04", 1.5), ("M12", "RB-visor", 1.66), ("M13", "PW-pov", 9.0)]
for sid, src, at in mont:
    cut[sid] = {"src": src, "at": at}

# ---------------- Act VII: reset
cut["G01"] = {"src": "IN-crane", "at": 7.6}
cut["G02"] = {"src": "A02", "at": 0.6}
cut["G03"] = {"src": "RB-wide", "at": 4.2}
cut["G04"] = {"src": "A03", "at": round(0.55 - (73.584 - SLOT["G04"][0]), 3)}
cut["G05"] = {"src": "IN-turn", "at": 7.6}
cut["G06"] = {"src": "IN-turn", "at": 10.0}

# ---------------- Act VIII: climax — rotate rooms, shorter and shorter
on_shot("H01", "PW-pov", 5.0, lead=0.04)
on_shot("H02", "HG-mate", 7.0, mine=False)
cut["H03"] = {"src": "SG-side", "at": 2.4}
reloads_h = [e["t"] for e in events("HG") if "magout" in e["name"]]
put("H04", "HG-pov", first(reloads_h, 3.0, 10.0) - 0.15)
cut["H05"] = {"src": "RB-visor", "at": 2.6}
on_shot("H06", "AT-mate", 6.0, mine=False)
on_shot("H07", "WH-pov", 4.0)
on_shot("H08", "HG-side", 8.0, mine=False)
cut["H09"] = {"src": "SG-pov", "at": 5.4}
on_shot("H10", "LB-pov", 6.0)
for sid, src, after in [("H11", "SV-pov", 9.0), ("H12", "PW-mate", 7.0), ("H13", "HG-pov", 10.0), ("H14", "SQ-top", 11.0),
                        ("H15", "WH-pov", 7.0), ("H16", "AT-side", 6.0), ("H17", "SV-mate", 9.0), ("H18", "PW-side", 9.0)]:
    on_shot(sid, src, after, lead=0.06, mine=src.endswith("pov"))
on_shot("H19", "SV-pov", 10.5, lead=0.05)
on_shot("H20", "HG-front", 9.0, mine=False, lead=0.04)
cut["H21"] = {"src": "SG-side", "at": 3.2}
sg1 = first(sg, sg0 + 0.5, 6.43)
cut["H22"] = {"src": "SG-pov", "at": sg1}
on_shot("H23", "PW-pov", 10.0, lead=0.03)

# ---------------- Review fixes: dark / blocked / glove-filled frames replaced
for sid, src, at, kw in [
    ("D08", "AT-mate", 10.55, {"fx": "flashout"}), ("D07", "WH-mate", 5.0, {}), ("D04", "LB-mate", 2.2, {}),
    ("F03", "LB-mate", 3.4, {}), ("F06", "WH-robo", 2.4, {}), ("F12a", "HG-side", 7.5, {}), ("F12c", "LB-mate", 8.4, {}),
    ("H18", "WH-mate", 9.2, {}), ("H20", "HG-mate", 9.2, {}), ("H23", "HG-pov", 7.6, {}),
    ("C01", "FC-pov", 0.2, {}), ("D05", "PW-pov", 6.2, {}), ("E01", "AT-robo", 4.2, {}), ("F06", "WH-mate", 2.5, {}),
    ("H17", "LB-mate", 4.8, {}), ("H19", "HG-pov", 11.4, {}), ("H11", "WH-pov", 9.2, {}),
]:
    cut[sid] = {"src": src, "at": at, **kw}

# ---------------- Act IX: standoff
cut["I01"] = {"src": "RB-wide", "at": 0.1}
cut["I02"] = {"src": "RB-visor", "at": 1.75}
cut["I03"] = {"src": "FC-pov", "at": round(fc0 - dur("I03") + 1 / 30, 3), "mute": True}

# ---------------- Act X: title
cut["J01"] = {"fx": "black"}
cut["_title"] = {"title": "SITE-9", "sub": "TACTICAL SQUAD FPS", "line3": "IN DEVELOPMENT"}

cut["_sfx"] = [
    [1.9, "servo", -26, 0.4], [3.2, "static", -24, 0], [5.75, "rel_magin", -3, 0], [7.30, "rel_boltback", -4, 0],
    [7.52, "rel_boltforward", -3, 0], [10.4, "static", -18, -0.2],
    [12.55, "gear2", -8, -0.3], [12.56, "metal_hit0", -18, -0.3], [13.9, "gear5", -12, 0.2], [16.3, "rope", -10, 0.1],
    [17.65, "thud", -2, 0], [17.66, "metal_clang", -16, 0], [18.5, "breath_in", -7, 0], [19.75, "breath_out", -6, 0],
    [20.75, "breath_in", -6, 0], [21.85, "breath_out", -7, 0], [23.45, "beep", -14, 0.5], [25.0, "metal_hit0", -16, 0],
    [26.95, "servo", -22, 0.3], [28.45, "servo", -18, -0.2], [29.1, "thud", -20, 0],
    [69.5, "breath_in", -8, 0], [70.7, "breath_out", -8, 0], [71.297, "thud", -8, -0.4], [71.5, "rel_magout", -6, 0],
    [72.6, "thud", -6, -0.3], [72.7, "servo", -20, -0.3], [73.584, "rel_magin", 0, 0], [74.9, "breath_out", -8, 0],
    [75.6, "rel_boltforward", -8, 0], [97.4, "servo", -24, 0.3], [99.4, "beep", -9, 0.3],
    [100.300, "heavy_close1", 1, 0], [100.300, "shotgun_punch", -2, 0], [100.305, "tail_hall", -2, 0],
    [101.7, "clunk", -6, 0], [101.7, "hum_rise", -14, 0],
]
cut["_beds"] = [[0.0, 12.0, "roomtone", -22], [8.5, 24.6, "rotor", -6], [11.5, 24.0, "wind", -18],
                [69.4, 78.2, "roomtone", -24], [96.9, 101.5, "roomtone", -24]]

(ROOT / "cut.json").write_text(json.dumps(cut, indent=1))
takes = {}
for k, c in cut.items():
    if not k.startswith("_") and "src" in c:
        t = c["src"].split("-")[0]
        takes[t] = takes.get(t, 0) + 1
print("cut.json:", len([k for k in cut if not k.startswith("_")]), "slots; shots per take:", takes)
