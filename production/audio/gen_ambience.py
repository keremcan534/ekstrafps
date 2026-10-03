"""Site-9 ambience (original; shaped noise + the game's own recordings, no ringing tones):
loops (seamless, ~12 s, mono 22 kHz) in public/audio/amb/:
  room.wav     building room tone: low air, a faint top
  hvac.wav     ventilation: duct rush with a slow wobble
  servers.wav  server racks: fan whir and a low electrical hum (noise-born, not a sine)
  power.wav    power plant: deep rumble and transformer buzz (amplitude-modulated noise)
  wind.wav     wind over the skylights, with gusts
  dark.wav     blackout: a sub drone under near silence
one-shots:
  groan0-2.wav  the structure creaking (the metal clang slowed way down)
  thump0-1.wav  something heavy, far off
  rattle0-1.wav a vent duct rattling
"""
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, fftconvolve, lfilter, resample

SR = 22050
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "audio" / "amb"
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(17)


def bp(y, lo, hi, o=2):
    b, a = butter(o, [lo / (SR / 2), hi / (SR / 2)], "band")
    return lfilter(b, a, y)


def lp(y, f, o=2):
    b, a = butter(o, f / (SR / 2), "low")
    return lfilter(b, a, y)


def norm(y, p=0.9):
    m = np.max(np.abs(y)) or 1
    return y / m * p


def brown(n):
    w = np.cumsum(rng.standard_normal(n))
    w -= lp(w, 8)  # no DC drift
    return norm(w)


def slow(n, rate, depth, seed):
    """Slow random modulation 1 ± depth."""
    r = np.random.default_rng(seed)
    k = max(4, int(n / SR * rate))
    pts = r.uniform(-1, 1, k + 2)
    x = np.interp(np.arange(n), np.linspace(0, n, k + 2), pts)
    return 1 + depth * lp(x, 2)


def loop(y, fade=1.5):
    """Seamless loop: the tail crossfades into the head."""
    f = int(fade * SR)
    head = y[:f]
    tail = y[-f:]
    w = np.linspace(0, 1, f)
    out = y[f:-f].copy() if len(y) > 3 * f else y[f:].copy()
    mixed = tail * (1 - w) + head * w
    return np.concatenate([mixed, out])


def load(name):
    y, sr = sf.read(ROOT / "public" / "audio" / "guns" / f"{name}.wav")
    if y.ndim > 1:
        y = y.mean(axis=1)
    return resample(y, int(len(y) * SR / sr))


def write(name, y, p=0.8):
    sf.write(OUT / f"{name}.wav", norm(y, p), SR, subtype="PCM_16")


N = int(13.5 * SR)


def room():
    y = lp(brown(N), 380) + 0.05 * bp(rng.standard_normal(N), 2000, 5000)
    return loop(y * slow(N, 0.4, 0.15, 1))


def hvac():
    y = bp(rng.standard_normal(N), 140, 900) * slow(N, 0.8, 0.25, 2) + 0.4 * lp(brown(N), 200)
    return loop(y)


def servers():
    n = N
    t = np.arange(n) / SR
    fans = bp(rng.standard_normal(n), 900, 5200) * slow(n, 1.5, 0.08, 3)
    # Hum from noise: a narrow band at 120 Hz, wavering (it never rings like a sine).
    hum = bp(rng.standard_normal(n), 112, 128, 2) * 6
    whir = bp(rng.standard_normal(n), 2600, 3400, 2) * (1 + 0.15 * np.sin(2 * np.pi * 0.31 * t))
    return loop(fans * 0.7 + hum * 0.5 + whir * 0.25 + 0.3 * lp(brown(n), 150))


def power():
    n = N
    t = np.arange(n) / SR
    rumble = lp(brown(n), 90, 3) * slow(n, 0.5, 0.2, 4)
    buzz = bp(rng.standard_normal(n), 200, 2400) * (0.55 + 0.45 * np.abs(np.sin(2 * np.pi * 50 * t))) ** 3
    return loop(rumble * 1.0 + buzz * 0.18)


def wind():
    n = N
    gust = slow(n, 0.35, 0.7, 5) ** 2
    center = slow(n, 0.25, 0.5, 6)
    lo = bp(rng.standard_normal(n), 200, 700) * gust
    hi = bp(rng.standard_normal(n), 700, 2200) * gust * center * 0.5
    whistle = bp(rng.standard_normal(n), 1100, 1300, 2) * np.clip(gust - 1.2, 0, None) * 0.6
    return loop(lo + hi + whistle)


def dark():
    y = lp(brown(N), 60, 3) * slow(N, 0.2, 0.3, 7) + 0.03 * bp(rng.standard_normal(N), 300, 1500) * slow(N, 0.6, 0.6, 8)
    return loop(y)


def groan(i):
    clang = load("metal_clang")
    k = [0.22, 0.28, 0.18][i]
    y = resample(clang, int(len(clang) / k))  # 4-5x slower: a long structural creak
    y = lp(y, 900) * np.hanning(len(y)) ** 0.3
    if i == 1:
        y = y[::-1]
    ir = rng.standard_normal(int(2.5 * SR)) * np.exp(-np.arange(int(2.5 * SR)) / (SR * 0.6))
    return fftconvolve(y, lp(ir, 1500))[: len(y) + int(1.5 * SR)]


def thump(i):
    ex = load("explosion")[: int(1.2 * SR)]
    y = lp(resample(ex, int(len(ex) / (0.6 + 0.15 * i))), 140, 3)
    return y * np.exp(-np.arange(len(y)) / (SR * 0.6))


def rattle(i):
    n = int(1.4 * SR)
    t = np.arange(n) / SR
    am = (np.sin(2 * np.pi * (13 + 5 * i) * t) > 0.2).astype(float)
    y = bp(rng.standard_normal(n), 300, 2500) * lp(am, 60) * np.exp(-t / 0.5) * np.minimum(1, t / 0.05)
    return y


if __name__ == "__main__":
    write("room", room(), 0.7)
    write("hvac", hvac(), 0.7)
    write("servers", servers(), 0.7)
    write("power", power(), 0.75)
    write("wind", wind(), 0.75)
    write("dark", dark(), 0.7)
    for i in range(3):
        write(f"groan{i}", groan(i), 0.85)
    for i in range(2):
        write(f"thump{i}", thump(i), 0.9)
        write(f"rattle{i}", rattle(i), 0.7)
    print("ok")
