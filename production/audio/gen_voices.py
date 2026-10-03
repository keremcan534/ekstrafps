"""Game voices with Piper neural TTS (commercial-safe models only):
  - lab staff panic / pleading / whimpering lines, six different speakers (LibriTTS-R, CC BY 4.0)
  - The Choir: spoken lines turned into a breathy whisper and layered as a chorus
  - Black Division radio lines (john, public domain): gas-mask muffle, radio band, squelch
  - the facility PA announcement (kristin, public domain)

Models live outside the repo (~/.piper, from huggingface.co/rhasspy/piper-voices).
Output: public/audio/voice/*.wav (mono 22 kHz, 16 bit).

LibriTTS-R (Koizumi et al., 2023) is CC BY 4.0: credited in the README.
"""
import io
import wave
from pathlib import Path

import numpy as np
import soundfile as sf
from piper import PiperVoice, SynthesisConfig
from scipy.signal import butter, fftconvolve, istft, lfilter, resample, stft

SR = 22050
MODELS = Path.home() / ".piper"
OUT = Path(__file__).resolve().parents[2] / "public" / "audio" / "voice"
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(5)
_voices = {}


def voice(name):
    if name not in _voices:
        _voices[name] = PiperVoice.load(str(MODELS / f"{name}.onnx"))
    return _voices[name]


def tts(model, text, speaker=None, length=1.0, noise=0.667):
    v = voice(model)
    b = io.BytesIO()
    w = wave.open(b, "wb")
    v.synthesize_wav(text, w, SynthesisConfig(speaker_id=speaker, length_scale=length, noise_scale=noise, noise_w_scale=0.9))
    w.close()
    b.seek(0)
    r = wave.open(b)
    a = np.frombuffer(r.readframes(r.getnframes()), dtype=np.int16).astype(np.float64) / 32768
    return resample(a, int(len(a) * SR / v.config.sample_rate))


def bp(y, lo, hi, o=2):
    b, a = butter(o, [lo / (SR / 2), hi / (SR / 2)], "band")
    return lfilter(b, a, y)


def lp(y, f, o=2):
    b, a = butter(o, f / (SR / 2), "low")
    return lfilter(b, a, y)


def hp(y, f, o=2):
    b, a = butter(o, f / (SR / 2), "high")
    return lfilter(b, a, y)


def peak(y, f, gain_db, q=1.2):
    """Peaking EQ (RBJ biquad)."""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f / SR
    al = np.sin(w0) / (2 * q)
    b = [1 + al * A, -2 * np.cos(w0), 1 - al * A]
    a = [1 + al / A, -2 * np.cos(w0), 1 - al / A]
    return lfilter(np.array(b) / a[0], np.array(a) / a[0], y)


def norm(y, p=0.9):
    m = np.max(np.abs(y)) or 1
    return y / m * p


def trim(y, thr=0.01):
    idx = np.where(np.abs(y) > thr)[0]
    if not len(idx):
        return y
    return y[max(0, idx[0] - int(0.02 * SR)) : idx[-1] + int(0.08 * SR)]


def room(y, seconds=0.9, wet=0.25, bright=4000):
    n = int(seconds * SR)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / (SR * seconds / 5))
    ir = lp(ir, bright)
    w = fftconvolve(y, ir)
    out = np.zeros(len(w))
    out[: len(y)] += y
    return out + norm(w, np.max(np.abs(y)) * wet)


def pitch(y, k):
    """Tape-style shift (speed with it)."""
    return resample(y, int(len(y) / k))


def whisperize(y):
    """Keep the spectral envelope, throw away the pitch: random phase per bin = breath."""
    f, t, Z = stft(y, SR, nperseg=1024, noverlap=768)
    mag = np.abs(Z)
    ph = np.exp(1j * rng.uniform(0, 2 * np.pi, Z.shape))
    _, w = istft(mag * ph, SR, nperseg=1024, noverlap=768)
    w = hp(w, 250)
    return w[: len(y)]


def write(name, y):
    sf.write(OUT / f"{name}.wav", np.clip(y, -1, 1), SR, subtype="PCM_16")


# ------------------------------------------------------------------ lab staff

CIV = [("libritts_r-medium", 552), ("libritts_r-medium", 414), ("libritts_r-medium", 851),
       ("libritts_r-medium", 667), ("libritts_r-medium", 46), ("libritts_r-medium", 138)]
PANIC = [
    "Help! Somebody help!", "Run! Run!", "Oh god, they're everywhere!", "Get away from me!",
    "They're coming! They're coming!", "Where do we go?!", "Stay down! Stay down!", "Get out! Get out of here!",
]
PLEAD = ["Don't shoot! Please don't shoot!", "Please! I'm unarmed!", "We're just scientists!"]
WHIMPER = ["Please... please...", "Oh god... oh god...", "Not like this...", "Shh... they'll hear us..."]


def civ_line(model, spk, text, kind):
    a = trim(tts(f"en_US-{model}", text, spk, length=0.8 if kind != "whimper" else 1.15, noise=0.8))
    if kind == "whimper":
        a = 0.55 * a + 0.45 * norm(whisperize(a), np.max(np.abs(a)))  # breathy, shaky
        a *= 1 + 0.25 * np.sin(2 * np.pi * 6.5 * np.arange(len(a)) / SR)  # tremble
    else:
        a = pitch(a, 1.05)  # panic sits higher
        a = np.tanh(norm(a) * 1.6)  # strained
        a += 0.04 * bp(rng.standard_normal(len(a)), 1500, 6000)  # breath
    a = peak(a, 2800, 3)
    return norm(room(a, 0.8, 0.22), 0.85 if kind != "whimper" else 0.5)


def lab_staff():
    for i, (model, spk) in enumerate(CIV):
        for j, t in enumerate(PANIC):
            if (i + j) % 2:  # each speaker says half the lines: 24 panic takes
                continue
            write(f"civ_panic_{i}{j}", civ_line(model, spk, t, "panic"))
        for j, t in enumerate(PLEAD):
            write(f"civ_plead_{i}{j}", civ_line(model, spk, t, "plead"))
        for j, t in enumerate(WHIMPER):
            if (i + j) % 2 == 0:
                write(f"civ_whimper_{i}{j}", civ_line(model, spk, t, "whimper"))


# ------------------------------------------------------------------ The Choir

CHOIR = ["We hear you.", "Hush now.", "The machines are singing.", "Give us your light.", "Come into the dark.",
         "Don't run.", "It wants you whole.", "Sing with us."]
CHOIR_VOICES = [("libritts_r-medium", 805), ("libritts_r-medium", 552), ("libritts_r-medium", 46), ("joe-medium", None)]


def choir():
    for j, t in enumerate(CHOIR):
        layers = []
        for k, (model, spk) in enumerate(CHOIR_VOICES):
            a = trim(tts(f"en_US-{model}", t, spk, length=1.35, noise=0.5))
            a = pitch(a, 0.86 + 0.04 * k)  # low and slow
            layers.append(norm(whisperize(a)) * (1 if k == 0 else 0.6))
        n = max(len(l) for l in layers) + int(0.3 * SR)
        mix = np.zeros(n)
        for k, l in enumerate(layers):
            at = int((0.0 if k == 0 else rng.uniform(0.03, 0.12)) * SR)
            mix[at : at + len(l)] += l
        mix = bp(mix, 300, 7500)
        mix = peak(mix, 4500, 4)  # the hiss of the sibilants
        write(f"choir_voice_{j}", norm(room(mix, 1.6, 0.45, 3000), 0.6))


# ------------------------------------------------------------------ Black Division

BD = {
    "see_enemy": "I see the enemy.", "spread_out": "Spread out.", "contact": "Contact.", "flanking": "Flanking.",
    "moving": "Moving.", "reloading": "Reloading.", "target_down": "Target down.", "man_down": "Man down.",
    "lost_visual": "Lost visual.", "hit": "I am hit.",
}


def black_division():
    for key, text in BD.items():
        a = trim(tts("en_US-john-medium", text, None, length=1.12, noise=0.5))
        a = pitch(a, 0.93)  # a touch lower
        # Gas mask: muffled top, a boxy cavity resonance, then the radio band with grit.
        a = lp(a, 3200)
        a = peak(a, 850, 7, 2.0)
        a = peak(a, 1900, 4, 3.0)
        a = bp(a, 320, 3300, 3)
        a = np.tanh(norm(a) * 2.4) * 0.8
        # Squelch tail and a slapback.
        tail = bp(rng.standard_normal(int(0.12 * SR)), 1000, 4000) * np.exp(-np.arange(int(0.12 * SR)) / (0.03 * SR)) * 0.25
        a = np.concatenate([a, tail])
        slap = np.zeros(len(a) + int(0.07 * SR))
        slap[: len(a)] += a
        slap[int(0.07 * SR) :] += 0.22 * a
        write(f"bd_{key}", norm(room(slap, 1.2, 0.18, 3500), 0.85))


def announcement():
    a = trim(tts("en_US-kristin-medium", "Attention. Security breach in progress. All personnel, evacuate immediately.", None, length=1.05, noise=0.4))
    a = bp(a, 280, 4200, 2)
    a = peak(a, 1600, 4)
    a = np.tanh(norm(a) * 1.5)
    # PA: two speakers down a long corridor, then the big hall.
    out = np.zeros(len(a) + int(0.25 * SR))
    out[: len(a)] += a
    out[int(0.11 * SR) : int(0.11 * SR) + len(a)] += 0.45 * a
    write("announce_intruders", norm(room(out, 2.6, 0.5, 2500), 0.85))


if __name__ == "__main__":
    lab_staff()
    choir()
    black_division()
    announcement()
    print("ok", len(list(OUT.glob("*.wav"))), "files")
