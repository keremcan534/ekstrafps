"""Helpers shared by the cleanup steps."""
import numpy as np


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def log(*a):
    print('[cleanup]', *a, flush=True)
