import json, numpy as np, soundfile as sf
from scipy import signal
from scipy.ndimage import uniform_filter1d
x, sr = sf.read("music/escaping.wav"); m = x.mean(1)
HOP=256; N=2048
f,t,Z = signal.stft(m, sr, nperseg=N, noverlap=N-HOP, boundary=None, padded=False)
L = np.log1p(100*np.abs(Z)); fps = sr/HOP
flux = np.r_[0, np.maximum(0, np.diff(L,axis=1)).sum(0)]
low = np.r_[0, np.maximum(0, np.diff(L[f<150],axis=1)).sum(0)]
def fit(t0,t1, env=flux):
    a,b=int(t0*fps),int(t1*fps); e=env[a:b]-np.median(env[a:b]); e=np.maximum(e,0)
    best=None
    for per in np.arange(0.565,0.576,0.00005):
        for ph in np.arange(0,per,0.004):
            idx=((np.arange(t0+ph,t1,per)-t0)*fps).astype(int); idx=idx[idx<len(e)]
            s=e[idx].sum()+0.5*e[np.clip(idx+1,0,len(e)-1)].sum()+0.5*e[np.clip(idx-1,0,len(e)-1)].sum()
            s/=len(idx)
            if best is None or s>best[0]: best=(s,per,t0+ph)
    return best
for name,(a,b) in {"drop1 A":(18.2,36.5),"drop1 B":(36.5,61.4),"drop1 C":(64,82.8),"pulse":(96,110),"drop2 A":(121,140),"drop2 B":(140,158.5)}.items():
    s,per,ph=fit(a,b)
    print(f"{name:8s} {a}-{b}: period {per:.5f} ({60/per:.2f} bpm) first beat {ph:.3f}")
# transient list in quiet sections with strength
def tr(t0,t1,env,k=4):
    a,b=int(t0*fps),int(t1*fps); e=env[a:b]; med=np.median(e); mad=np.median(abs(e-med))+1e-9
    pk,_=signal.find_peaks(e, height=med+k*mad, distance=int(0.15*fps))
    return [(round(t0+p/fps,3), round(float((e[p]-med)/mad),1)) for p in pk]
for a,b in [(0,18.4),(61,64.6),(80,97),(108,121.6),(157,171)]:
    print(f"transients {a}-{b}:", tr(a,b,flux,6))
    print(f"  low     {a}-{b}:", tr(a,b,low,6))
