"""Waveform analysis of the trailer track.

Produces: loudness envelope, band energies, onsets (spectral flux), tempo/beat grid,
structural novelty (section boundaries), silences, and a plot for visual inspection.
Writes trailer/music/analysis.json and trailer/music/analysis.png.
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import uniform_filter1d, maximum_filter1d

ROOT = Path(__file__).resolve().parents[1]
import os
WAV = ROOT / "music" / os.environ.get("TRACK", "escaping.wav")
TAG = os.environ.get("TAG", "analysis")

x, sr = sf.read(WAV)
mono = x.mean(axis=1) if x.ndim > 1 else x
dur = len(mono) / sr

HOP = 512
NFFT = 2048
f, t, Z = signal.stft(mono, sr, nperseg=NFFT, noverlap=NFFT - HOP, boundary=None, padded=False)
S = np.abs(Z)
fps = sr / HOP
times = t


def band(lo, hi):
    m = (f >= lo) & (f < hi)
    return (S[m] ** 2).sum(axis=0)


def db(v):
    return 10 * np.log10(v + 1e-12)


sub = db(band(20, 60))
low = db(band(60, 200))
mid = db(band(200, 2000))
high = db(band(2000, 8000))
air = db(band(8000, 16000))
total = db((S ** 2).sum(axis=0))

# Short-term loudness (~400 ms) and long-term (~3 s)
lt_short = uniform_filter1d(total, int(0.4 * fps))
lt_long = uniform_filter1d(total, int(3.0 * fps))

# Spectral flux onset strength (log magnitude, half-wave rectified)
L = np.log1p(100 * S)
flux = np.maximum(0, np.diff(L, axis=1)).sum(axis=0)
flux = np.concatenate([[0], flux])
# Low-band flux for kicks/bass hits
mlow = f < 150
flux_low = np.concatenate([[0], np.maximum(0, np.diff(L[mlow], axis=1)).sum(axis=0)])
mhi = f > 3000
flux_hi = np.concatenate([[0], np.maximum(0, np.diff(L[mhi], axis=1)).sum(axis=0)])


def norm(v):
    v = v - np.median(v)
    return v / (np.percentile(v, 99) + 1e-9)


def peaks(env, min_gap_s, thresh_win_s=1.5, k=1.5, floor=0.15):
    env = norm(env)
    w = int(thresh_win_s * fps)
    local = uniform_filter1d(env, w) + k * np.sqrt(uniform_filter1d((env - uniform_filter1d(env, w)) ** 2, w))
    mx = maximum_filter1d(env, int(min_gap_s * fps) | 1)
    idx = np.where((env == mx) & (env > local) & (env > floor))[0]
    return idx, env


on_idx, on_env = peaks(flux, 0.09)
kick_idx, kick_env = peaks(flux_low, 0.12, k=1.8, floor=0.2)
hi_idx, hi_env = peaks(flux_hi, 0.09, k=1.8, floor=0.2)

# Major transients: strong onset AND big short-term loudness jump
jump = np.concatenate([np.zeros(int(0.25 * fps)), lt_short[int(0.25 * fps):] - lt_short[:-int(0.25 * fps)]])
major = []
for i in on_idx:
    strength = on_env[i]
    j = jump[min(len(jump) - 1, i + int(0.2 * fps))]
    if strength > 0.9 or j > 6:
        major.append((float(times[i]), round(float(strength), 2), round(float(j), 1)))

# Tempo from onset autocorrelation (60-180 bpm)
oe = norm(flux)
oe = oe - oe.mean()
ac = np.correlate(oe, oe, mode="full")[len(oe) - 1:]
lags = np.arange(len(ac)) / fps
bpm_range = (lags > 60 / 180) & (lags < 60 / 60)
best_lag = lags[bpm_range][np.argmax(ac[bpm_range])]
bpm = 60 / best_lag

# Windowed tempo (tempo may change across sections)
def local_tempo(t0, t1):
    a, b = int(t0 * fps), int(t1 * fps)
    seg = oe[a:b] - oe[a:b].mean()
    if len(seg) < fps * 4:
        return None
    c = np.correlate(seg, seg, mode="full")[len(seg) - 1:]
    lg = np.arange(len(c)) / fps
    r = (lg > 60 / 180) & (lg < 60 / 60)
    if c[r].max() <= 0:
        return None
    # parabolic refine
    k = np.argmax(c[r]) + np.where(r)[0][0]
    if 0 < k < len(c) - 1:
        y0, y1, y2 = c[k - 1], c[k], c[k + 1]
        d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 + 1e-12)
    else:
        d = 0
    conf = c[k] / (c[0] + 1e-9)
    return 60 / ((k + d) / fps), float(conf)

tempo_windows = []
for t0 in np.arange(0, dur - 8, 4):
    r = local_tempo(t0, t0 + 8)
    if r:
        tempo_windows.append((float(t0), round(r[0], 1), round(r[1], 2)))

# Structural novelty: chroma-ish + band features self-similarity with checkerboard kernel
feat = np.vstack([sub, low, mid, high, air,
                  db(band(200, 400)), db(band(400, 800)), db(band(800, 1600)), db(band(1600, 3200))])
# downsample to ~4 fps
step = int(fps / 4)
F = np.array([feat[:, i:i + step].mean(axis=1) for i in range(0, feat.shape[1] - step, step)]).T
F = (F - F.mean(axis=1, keepdims=True)) / (F.std(axis=1, keepdims=True) + 1e-9)
ft = np.arange(F.shape[1]) * step / fps
Fn = F / (np.linalg.norm(F, axis=0, keepdims=True) + 1e-9)
SSM = Fn.T @ Fn
K = 16  # 4 s each side
g = signal.windows.gaussian(2 * K, K / 2)
ker = np.outer(g, g) * np.block([[np.ones((K, K)), -np.ones((K, K))], [-np.ones((K, K)), np.ones((K, K))]])
nov = np.zeros(SSM.shape[0])
for i in range(K, SSM.shape[0] - K):
    nov[i] = (SSM[i - K:i + K, i - K:i + K] * ker).sum()
nov = np.maximum(nov, 0)
nov_n = nov / (nov.max() + 1e-9)
nb = signal.find_peaks(nov_n, height=0.2, distance=int(4 * 4))[0]
boundaries = [(round(float(ft[i]), 2), round(float(nov_n[i]), 2)) for i in nb]

# Silences / drop-outs: short-term loudness far below long-term
quiet = []
in_q = False
thr = np.percentile(lt_short, 20)
for i, v in enumerate(lt_short):
    q = v < max(thr, lt_long[i] - 12)
    if q and not in_q:
        qs = times[i]; in_q = True
    elif not q and in_q:
        if times[i] - qs > 0.25:
            quiet.append((round(float(qs), 2), round(float(times[i]), 2)))
        in_q = False

# Per-second summary
per_sec = []
for s in range(int(dur) + 1):
    m = (times >= s) & (times < s + 1)
    if not m.any():
        continue
    per_sec.append({
        "t": s,
        "loud": round(float(total[m].mean()), 1),
        "sub": round(float(sub[m].mean()), 1),
        "low": round(float(low[m].mean()), 1),
        "mid": round(float(mid[m].mean()), 1),
        "high": round(float(high[m].mean()), 1),
        "onsets": int(((times[on_idx] >= s) & (times[on_idx] < s + 1)).sum()),
        "kicks": int(((times[kick_idx] >= s) & (times[kick_idx] < s + 1)).sum()),
    })

out = {
    "duration": dur,
    "global_bpm": round(bpm, 2),
    "tempo_windows": tempo_windows,
    "boundaries": boundaries,
    "quiet": quiet,
    "major": major,
    "onsets": [round(float(times[i]), 3) for i in on_idx],
    "kicks": [round(float(times[i]), 3) for i in kick_idx],
    "hats": [round(float(times[i]), 3) for i in hi_idx],
    "per_sec": per_sec,
}
(ROOT / "music" / f"{TAG}.json").write_text(json.dumps(out, indent=1))

# ---- plot ----
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

def plot(t0, t1, path):
    fig, ax = plt.subplots(5, 1, figsize=(28, 14), sharex=True)
    m = (times >= t0) & (times <= t1)
    tt = times[m]
    a = int(t0 * sr); b = int(t1 * sr)
    wt = np.arange(a, b) / sr
    ax[0].plot(wt[::20], mono[a:b:20], lw=0.3, color="k")
    ax[0].set_ylabel("wave")
    ax[1].plot(tt, sub[m], label="sub<60", lw=0.7)
    ax[1].plot(tt, low[m], label="60-200", lw=0.7)
    ax[1].plot(tt, mid[m], label="200-2k", lw=0.7)
    ax[1].plot(tt, high[m], label="2k-8k", lw=0.7)
    ax[1].plot(tt, lt_short[m], label="loud(0.4s)", lw=1.5, color="k")
    ax[1].legend(loc="upper left", fontsize=7); ax[1].set_ylabel("dB")
    ax[2].plot(tt, on_env[m], lw=0.6, color="C3")
    for i in on_idx:
        if t0 <= times[i] <= t1:
            ax[2].axvline(times[i], color="C3", lw=0.3, alpha=0.5)
    ax[2].set_ylabel("onset")
    ax[3].plot(tt, kick_env[m], lw=0.6, color="C0", label="low flux")
    ax[3].plot(tt, hi_env[m], lw=0.6, color="C2", alpha=0.6, label="high flux")
    for i in kick_idx:
        if t0 <= times[i] <= t1:
            ax[3].axvline(times[i], color="C0", lw=0.5, alpha=0.6)
    ax[3].legend(loc="upper left", fontsize=7)
    mm = (ft >= t0) & (ft <= t1)
    ax[4].plot(ft[mm], nov_n[mm], color="purple")
    for bt, _ in boundaries:
        if t0 <= bt <= t1:
            for a_ in ax:
                a_.axvline(bt, color="purple", lw=1.2, ls="--")
    ax[4].set_ylabel("novelty")
    ax[4].set_xticks(np.arange(np.floor(t0), t1 + 1, 1 if t1 - t0 <= 60 else 5))
    for a_ in ax:
        a_.grid(alpha=0.3)
    plt.tight_layout()
    plt.savefig(path, dpi=60)
    plt.close()

plot(0, dur, ROOT / "music" / f"{TAG}_full.png")
for i, (a, b) in enumerate([(0, 55), (50, 105), (100, 155), (150, dur)]):
    plot(a, b, ROOT / "music" / f"{TAG}_{i}.png")

print(f"duration {dur:.2f}s  global bpm {bpm:.2f}")
print("boundaries", boundaries)
print("quiet", quiet)
print("tempo windows", tempo_windows)
print("major transients (t, onset, loudness jump dB):")
for m_ in major:
    print("  ", m_)
print("per-second:")
for p in per_sec:
    print(f"  {p['t']:4d}s loud {p['loud']:6.1f} sub {p['sub']:6.1f} low {p['low']:6.1f} mid {p['mid']:6.1f} hi {p['high']:6.1f} on {p['onsets']:2d} kick {p['kicks']:2d}")
