"""Summarise a take's logged game sounds: python tools/events.py FC"""
import json, sys
from collections import defaultdict
from pathlib import Path
take = sys.argv[1]
m = json.loads((Path(__file__).resolve().parents[1] / "build" / "events" / f"{take}.json").read_text())
ev = m["events"]
kinds = defaultdict(list)
for e in ev:
    kinds[e["name"]].append(e["t"])
for k, ts in sorted(kinds.items(), key=lambda kv: kv[1][0]):
    near = [t for t in ts]
    print(f"{k:22s} n={len(ts):3d}  " + " ".join(f"{t:.2f}" for t in near[:40]))
