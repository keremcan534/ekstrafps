"""Generates The Choir's sounds (original; from the game's own recordings + shaped noise):
  public/audio/guns/choir_sting.wav    the jumpscare: a hard dissonant hit, screech and boom (~2 s)
  public/audio/guns/choir_hiss.wav     caught in the light: a long throaty hiss (~0.9 s)
  public/audio/guns/choir_whisper*.wav breathy, syllable-shaped whispers while they creep (3 takes)
  public/audio/guns/choir_slash.wav    the blade: a fast whoosh into a wet cut (~0.5 s)
No pitched synth tones (nothing that reads as a ding).
"""
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, fftconvolve, lfilter, resample

SR = 48000
ROOT = Path(__file__).resolve().parents[3]
GUNS = ROOT / "public" / "audio" / "guns"
rng = np.random.default_rng(9)


def load(name):
    y, sr = sf.read(GUNS / f"{name}.wav", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != SR:
        y = resample(y, int(len(y) * SR / sr))
    return y.astype(np.float64)


def lp(y, f, o=2):
    b, a = butter(o, f / (SR / 2), "low")
    return lfilter(b, a, y)


def hp(y, f, o=2):
    b, a = butter(o, f / (SR / 2), "high")
    return lfilter(b, a, y)


def bp(y, lo, hi, o=2):
    b, a = butter(o, [lo / (SR / 2), hi / (SR / 2)], "band")
    return lfilter(b, a, y)


def env(n, attack, decay_tau):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(attack, 1e-4)) * np.exp(-np.maximum(0, t - attack) / decay_tau)
    return e


def norm(y, peak=0.9):
    m = np.max(np.abs(y)) or 1
    return y / m * peak


def hall(y, seconds=1.8, wet=0.35):
    n = int(seconds * SR)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / (SR * seconds / 5))
    ir = lp(ir, 5000)
    w = fftconvolve(y, ir)
    out = np.zeros(len(w))
    out[: len(y)] += y
    return out + norm(w, np.max(np.abs(y)) * wet)


def stretch(y, rate):
    """Resample (pitch + speed together, like tape)."""
    return resample(y, int(len(y) / rate))


def sting():
    n = int(2.2 * SR)
    out = np.zeros(n)
    # Low impact: the start of the explosion recording, slowed and darkened.
    boom = stretch(load("explosion")[: int(0.9 * SR)], 0.7)
    boom = lp(boom, 180, 3) * env(len(boom), 0.004, 0.45)
    out[: len(boom)] += norm(boom, 0.9)
    # Screech: the metal clang torn up (pitched, reversed tail, band-limited, driven).
    clang = load("metal_clang")
    scr = np.concatenate([stretch(clang, 1.6), stretch(clang[::-1], 2.1)])
    scr = bp(scr, 900, 6500)
    scr = np.tanh(norm(scr) * 3.5) * env(len(scr), 0.002, 0.35)
    out[: min(n, len(scr))] += 0.55 * scr[: min(n, len(scr))]
    # Noise slam on the hit, bright then gone.
    k = int(0.5 * SR)
    noise = bp(rng.standard_normal(k), 300, 9000) * env(k, 0.001, 0.07)
    out[:k] += 0.6 * norm(noise)
    # Second, dissonant clang a beat later (slightly detuned against the first).
    late = bp(stretch(clang, 1.23), 600, 5000) * env(int(len(clang) / 1.23), 0.002, 0.25)
    at = int(0.11 * SR)
    m = min(len(late), n - at)
    out[at : at + m] += 0.35 * np.tanh(norm(late[:m]) * 2)
    return norm(hall(out, 1.6, 0.4), 0.95)


def hiss():
    n = int(0.95 * SR)
    t = np.arange(n) / SR
    y = rng.standard_normal(n)
    # Throaty: a breathy band plus a raspy low band that flutters.
    y = bp(y, 2200, 7000) * 0.8 + bp(rng.standard_normal(n), 500, 1500) * (0.4 + 0.3 * np.sin(2 * np.pi * 31 * t))
    e = np.minimum(1, t / 0.05) * np.exp(-np.maximum(0, t - 0.45) / 0.18)
    return norm(hall(y * e, 0.9, 0.25), 0.8)


def whisper(seed):
    r = np.random.default_rng(seed)
    syl = r.integers(4, 8)
    parts = []
    for _ in range(syl):
        d = r.uniform(0.09, 0.22)
        k = int(d * SR)
        t = np.arange(k) / SR
        # Breath through two moving "formant" bands: vowel-ish noise, no pitch.
        f1 = r.uniform(500, 900)
        f2 = r.uniform(1300, 2600)
        y = bp(r.standard_normal(k), f1 * 0.8, f1 * 1.25) + 0.7 * bp(r.standard_normal(k), f2 * 0.85, f2 * 1.2)
        if r.random() < 0.45:  # a sibilant
            y += 1.4 * bp(r.standard_normal(k), 4500, 9000) * np.exp(-t / 0.05)
        e = np.sin(np.pi * np.minimum(1, t / d)) ** 1.5
        parts.append(y * e)
        parts.append(np.zeros(int(r.uniform(0.02, 0.09) * SR)))
    y = np.concatenate(parts)
    return norm(hall(y, 1.2, 0.4), 0.6)


def slash():
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    # Whoosh: band sweeping up, fast.
    sweep = np.zeros(n)
    w = rng.standard_normal(n)
    for i, (lo, hi) in enumerate([(300, 900), (700, 2000), (1500, 4500), (3000, 8000)]):
        seg = bp(w, lo, hi)
        c = 0.06 + i * 0.03
        sweep += seg * np.exp(-((t - c) ** 2) / (2 * 0.025**2))
    # The cut: a short wet tear right after.
    k = int(0.18 * SR)
    tear = bp(rng.standard_normal(k), 400, 3500) * env(k, 0.001, 0.035)
    at = int(0.16 * SR)
    sweep[at : at + k] += 1.6 * tear
    sweep += lp(rng.standard_normal(n), 220) * env(n, 0.16, 0.06) * 0.8  # thud
    return norm(hall(sweep, 0.6, 0.15), 0.85)


if __name__ == "__main__":
    sf.write(GUNS / "choir_sting.wav", sting(), SR, subtype="PCM_16")
    sf.write(GUNS / "choir_hiss.wav", hiss(), SR, subtype="PCM_16")
    for i in range(3):
        sf.write(GUNS / f"choir_whisper{i}.wav", whisper(40 + i), SR, subtype="PCM_16")
    sf.write(GUNS / "choir_slash.wav", slash(), SR, subtype="PCM_16")
    print("ok")
