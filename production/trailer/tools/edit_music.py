"""Builds the trailer music edit from edl.json (sample-accurate, phrase-aligned splices).

Each segment copies source [t0, t1] to trailer time T. Splices get a short equal-power
crossfade centred on the cut; explicit fade_in / fade_out shape entries and exits.
Output: build/music_edit.wav (48 kHz, 24-bit) + build/music_edit.png for checking.
"""
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parents[1]
SR = 48000


def load_edl():
    return json.loads((ROOT / "edl.json").read_text())


def build(edl):
    m = edl["music"]
    src, sr = sf.read(ROOT / m["source"], always_2d=True)
    if sr != SR:
        src = resample_poly(src, SR, sr, axis=0)
    x = m["xfade_ms"] / 1000
    out = np.zeros((int(edl["duration"] * SR) + SR, 2))
    for seg in m["segments"]:
        a = seg["t0"] - x / 2
        b = seg["t1"] + x / 2
        piece = src[max(0, int(a * SR)):int(b * SR)].copy()
        n = len(piece)
        env = np.ones(n)
        fi = max(x, seg.get("fade_in", 0))
        fo = max(x, seg.get("fade_out", 0))
        ni, no = int(fi * SR), int(fo * SR)
        if ni:
            env[:ni] *= np.sin(np.linspace(0, np.pi / 2, ni)) ** 2 if fi > x else np.sin(np.linspace(0, np.pi / 2, ni))
        if no:
            env[-no:] *= np.cos(np.linspace(0, np.pi / 2, no)) ** 2 if fo > x else np.cos(np.linspace(0, np.pi / 2, no))
        piece *= env[:, None]
        start = int((seg["T"] - x / 2) * SR)
        out[start:start + n] += piece
    return out[: int(edl["duration"] * SR)]


def plot(y, edl, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    mono = y.mean(axis=1)
    t = np.arange(len(mono)) / SR
    fig, ax = plt.subplots(figsize=(30, 5))
    ax.plot(t[::40], mono[::40], lw=0.3, color="k")
    for T, label in edl["markers"]:
        ax.axvline(T, color="C3", lw=0.6)
        ax.text(T, 0.95, label, rotation=90, fontsize=6, va="top", color="C3")
    for seg in edl["music"]["segments"]:
        ax.axvspan(seg["T"], seg["T"] + seg["t1"] - seg["t0"], color="C0", alpha=0.06)
    ax.set_xlim(0, edl["duration"])
    ax.set_ylim(-1, 1)
    ax.set_xticks(np.arange(0, edl["duration"] + 1, 2))
    ax.grid(alpha=0.3)
    plt.tight_layout()
    plt.savefig(path, dpi=70)
    plt.close()


if __name__ == "__main__":
    edl = load_edl()
    y = build(edl)
    (ROOT / "build").mkdir(exist_ok=True)
    sf.write(ROOT / "build" / "music_edit.wav", y, SR, subtype="PCM_24")
    plot(y, edl, ROOT / "build" / "music_edit.png")
    # Splice sanity: level jump in the 20 ms on either side of each contiguous joint
    segs = edl["music"]["segments"]
    for a, b in zip(segs, segs[1:]):
        if abs(a["T"] + a["t1"] - a["t0"] - b["T"]) < 1e-3:
            i = int(b["T"] * SR)
            pre = np.sqrt((y[i - 960:i] ** 2).mean())
            post = np.sqrt((y[i:i + 960] ** 2).mean())
            print(f"splice {a['id']}->{b['id']} at T {b['T']:.3f}: rms {20*np.log10(pre+1e-9):.1f} -> {20*np.log10(post+1e-9):.1f} dB")
    print("peak", 20 * np.log10(np.abs(y).max()), "dBFS; length", len(y) / SR, "s")
