"""Generates the extraction sounds for the game (original, synthesized):
  public/audio/music/extracted.wav   epic extraction theme (~11 s)
  public/audio/guns/heli_approach.wav  tandem-rotor helicopter flying in and settling (~16 s)
  public/audio/guns/heli_takeoff.wav   spool-up and lift-off (~7 s)
  public/audio/guns/blastdoor.wav      hydraulics, klaxon, slam (~4.5 s)
  public/audio/guns/heartbeat.wav      low countdown thump (no pitch)
"""
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, lfilter, fftconvolve

SR = 48000
OUT = Path(__file__).resolve().parents[2] / "public" / "audio"
rng = np.random.default_rng(11)


def t_(d):
    return np.arange(int(d * SR)) / SR


def lp(y, f, o=2):
    b, a = butter(o, min(0.99, f / (SR / 2)), "low")
    return lfilter(b, a, y)


def bp(y, lo, hi, o=2):
    b, a = butter(o, [lo / (SR / 2), min(0.99, hi / (SR / 2))], "band")
    return lfilter(b, a, y)


def hall(seconds=3.2, decay=0.9):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-t / decay)[:, None]
    ir = np.stack([lp(ir[:, 0], 6000), lp(ir[:, 1], 5500)], 1)
    ir[: int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))[:, None]
    return ir / np.abs(ir).sum(0).max() * 6


def reverb(dry, wet=0.35, seconds=3.2, decay=0.9):
    ir = hall(seconds, decay)
    st = np.stack([dry, dry], 1) if dry.ndim == 1 else dry
    w = np.stack([fftconvolve(st[:, c], ir[:, c])[: len(st) + len(ir)] for c in range(2)], 1)
    out = np.zeros_like(w)
    out[: len(st)] += st
    return out * (1 - wet) + w * wet


def norm(y, peak=0.9):
    return y * (peak / (np.abs(y).max() + 1e-9))


def saw(f, t, detune=0.0):
    ph = (f * (1 + detune)) * t
    return 2 * (ph - np.floor(ph + 0.5))


def place(buf, y, at):
    i = int(at * SR)
    j = min(len(buf), i + len(y))
    buf[i:j] += y[: j - i]


# ------------------------------------------------------------------ theme
def theme():
    D = 11.0
    out = np.zeros(int(D * SR))
    # Taiko / impact hits
    def hit(at, g=1.0, f0=55):
        t = t_(1.6)
        body = np.sin(2 * np.pi * (f0 + 70 * np.exp(-t * 18)) * t) * np.exp(-t * 3.2)
        skin = bp(rng.standard_normal(len(t)), 120, 1800) * np.exp(-t * 22) * 0.6
        place(out, (body + skin) * g, at)

    def chord(at, dur, notes, g, cutoff0, cutoff1, attack=0.05):
        t = t_(dur)
        y = sum(saw(n, t, d) for n in notes for d in (-0.004, 0.0, 0.005)) / (len(notes) * 3)
        env = np.clip(t / attack, 0, 1) * np.clip((dur - t) / 1.4, 0, 1)
        # opening filter sweep in blocks
        seg = int(0.05 * SR)
        res = np.zeros_like(y)
        for k in range(0, len(y), seg):
            frac = k / len(y)
            res[k:k + seg] = lp(y[max(0, k - seg * 4):k + seg], cutoff0 + (cutoff1 - cutoff0) * frac)[-len(y[k:k + seg]):]
        place(out, res * env * g, at)

    Dm = [73.42, 110.0, 146.83, 174.61]          # D2 A2 D3 F3
    Bb = [58.27, 116.54, 146.83, 174.61]          # Bb1 Bb2 D3 F3
    C = [65.41, 130.81, 164.81, 196.0]            # C2 C3 E3 G3
    hit(0.0, 1.2, 48)
    hit(0.02, 0.8, 90)
    chord(0.0, 3.4, Dm, 0.9, 300, 2400, 0.02)
    for k, at in enumerate([1.15, 1.7, 2.25, 2.55]):
        hit(at, 0.55 + 0.1 * k, 62)
    chord(2.9, 2.6, Bb, 0.8, 500, 3000)
    chord(5.2, 2.6, C, 0.85, 600, 3600)
    # rising swell into the final hit
    t = t_(2.2)
    swell = sum(saw(f, t, d) for f in (146.83, 220.0, 293.66) for d in (-0.003, 0.004)) / 6
    swell = lp(swell, 2500) * (t / 2.2) ** 2
    place(out, swell * 0.7, 5.6)
    noise_rise = bp(rng.standard_normal(len(t)), 800, 6000) * (t / 2.2) ** 3 * 0.25
    place(out, noise_rise, 5.6)
    hit(7.8, 1.4, 44)
    hit(7.82, 0.9, 85)
    chord(7.8, 3.2, [73.42, 110.0, 146.83, 220.0, 293.66], 1.0, 1800, 900, 0.01)
    y = reverb(lp(out, 9000), wet=0.32, seconds=3.6, decay=1.1)
    y = np.tanh(norm(y, 1.0) * 1.3) / np.tanh(1.3)
    sf.write(OUT / "music" / "extracted.wav", norm(y, 0.92).astype(np.float32), SR, subtype="PCM_16")


# ------------------------------------------------------------------ helicopter
def rotor(t, rate=3.9):
    """Tandem rotor: two blade-pass streams slightly out of phase, low thump + slap."""
    n = rng.standard_normal(len(t))
    a1 = np.maximum(0, np.sin(2 * np.pi * rate * t)) ** 6
    a2 = np.maximum(0, np.sin(2 * np.pi * rate * 1.03 * t + 1.1)) ** 6
    thump = lp(n, 140) * (a1 + a2) * 6
    slap = bp(n, 300, 1600) * (a1 + 0.8 * a2) ** 2 * 1.6
    turbine = np.sin(2 * np.pi * 2830 * t) * 0.02 + bp(n, 2000, 5000) * 0.06
    wash = bp(n, 80, 900) * 0.5
    return thump + slap + turbine + wash


def heli():
    D = 16.0
    t = t_(D)
    y = rotor(t)
    # flies in: distance envelope, darker far away, settles to idle after landing (~11 s)
    dist = np.clip(1 - t / 11.0, 0, 1)
    gain = 0.12 + 0.88 * (1 - dist) ** 1.6
    near = (1 - dist) ** 2
    far = lp(y, 500) * (1 - near) + lp(y, 6500) * near
    y = far * gain
    y[int(13 * SR):] *= np.linspace(1, 0.55, len(y) - int(13 * SR))
    st = reverb(y, wet=0.25, seconds=2.4, decay=0.7)[: len(y)]
    st[: int(0.8 * SR)] *= np.linspace(0, 1, int(0.8 * SR))[:, None]
    st[-int(1.2 * SR):] *= np.linspace(1, 0, int(1.2 * SR))[:, None]
    sf.write(OUT / "guns" / "heli_approach.wav", norm(st, 0.9).astype(np.float32), SR, subtype="PCM_16")
    # take-off: spool up, then climbing away
    D2 = 7.0
    t2 = t_(D2)
    rate = 3.9 + 1.4 * np.clip(t2 / 2.5, 0, 1)
    ph = np.cumsum(rate) / SR
    n = rng.standard_normal(len(t2))
    a1 = np.maximum(0, np.sin(2 * np.pi * ph)) ** 6
    y2 = lp(n, 160) * a1 * 7 + bp(n, 300, 1800) * a1 ** 2 * 1.8 + bp(n, 80, 1200) * 0.7
    g2 = np.clip(t2 / 0.5, 0, 1) * np.where(t2 < 3.0, 1.0, np.exp(-(t2 - 3.0) / 1.6))
    y2 = lp(y2, 7000) * g2
    st2 = reverb(y2, wet=0.3, seconds=2.6, decay=0.8)[: len(y2)]
    sf.write(OUT / "guns" / "heli_takeoff.wav", norm(st2, 0.9).astype(np.float32), SR, subtype="PCM_16")


# ------------------------------------------------------------------ blast door
def blastdoor():
    D = 4.5
    out = np.zeros(int(D * SR))
    t = t_(2.2)
    hiss = bp(rng.standard_normal(len(t)), 1500, 7000) * np.exp(-t * 1.2) * 0.5
    place(out, hiss, 0.0)
    motor = (saw(48, t) + 0.5 * saw(96.5, t)) * 0.18 * np.clip(t / 0.3, 0, 1)
    place(out, lp(motor, 600), 0.1)
    # klaxon (two short honks, band-limited square, no sine ping)
    th = t_(0.42)
    honk = np.tanh(np.sin(2 * np.pi * 330 * th) * 5)
    honk = bp(honk, 250, 2400) * np.clip(th / 0.01, 0, 1) * np.clip((0.42 - th) / 0.04, 0, 1) * 0.45
    place(out, honk, 0.15)
    place(out, honk, 0.75)
    # the slam
    ts = t_(2.2)
    slam = np.sin(2 * np.pi * (42 + 60 * np.exp(-ts * 14)) * ts) * np.exp(-ts * 2.4) * 1.3
    crash = bp(rng.standard_normal(len(ts)), 120, 3500) * np.exp(-ts * 9) * 0.9
    place(out, slam + crash, 2.2)
    y = reverb(out, wet=0.35, seconds=3.0, decay=0.9)[: len(out)]
    # Two files: opening (hydraulics + klaxon, no slam) and the slam on its own.
    cut = int(2.15 * SR)
    opening = y[:cut].copy()
    opening[-int(0.3 * SR):] *= np.linspace(1, 0, int(0.3 * SR))[:, None]
    sf.write(OUT / "guns" / "blastdoor_open.wav", norm(opening, 0.85).astype(np.float32), SR, subtype="PCM_16")
    slam = y[int(1.6 * SR):]
    sf.write(OUT / "guns" / "blastdoor_slam.wav", norm(slam, 0.95).astype(np.float32), SR, subtype="PCM_16")


def heartbeat():
    t = t_(0.5)
    y = np.sin(2 * np.pi * (52 + 30 * np.exp(-t * 25)) * t) * np.exp(-t * 9)
    y += lp(rng.standard_normal(len(t)), 300) * np.exp(-t * 30) * 0.3
    sf.write(OUT / "guns" / "heartbeat.wav", norm(y, 0.85).astype(np.float32), SR, subtype="PCM_16")


if __name__ == "__main__":
    (OUT / "music").mkdir(exist_ok=True)
    theme()
    heli()
    blastdoor()
    heartbeat()
    print("ok")
