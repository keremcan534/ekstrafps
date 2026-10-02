import * as THREE from 'three';

/** Quick-travel stations for testing (M cycles). */
export const STATIONS: { name: string; pos: [number, number, number]; yaw: number }[] = [
  { name: 'Spawn / firing line', pos: [0, 0, 4], yaw: 0 },
  { name: 'Close range (5 m robots)', pos: [-12, 0, 1], yaw: 0 },
  { name: 'Long range (30-50 m)', pos: [0, 0, -18], yaw: 0 },
  { name: 'Platform (elevated)', pos: [16, 3, -17], yaw: Math.PI / 2 + 0.35 },
  { name: 'Wall test (weapon collision)', pos: [0, 0, 14.8], yaw: Math.PI },
  { name: 'Behind pillar (lean test)', pos: [-14, 0, -17.4], yaw: 0 },
  { name: 'Crouch tunnel', pos: [-4.5, 0, 6.6], yaw: Math.PI },
  { name: 'Black Division yard (left door)', pos: [-16.5, 0, -61], yaw: 0 },
];

export const HELP_TEXT = `WEAPON LAB — keys
WASD move · Shift sprint · Space jump · C crouch
Q / E  lean (hold) · V  swap shoulder
LMB fire · RMB aim · R reload · B fire mode
T  inspect weapon (mag / chamber)
[ / ]  zero distance · 1-9, 0 / wheel  weapons
── lab ──
G  aim rays + probes + bullet paths
L  laser · J  debug crosshair · N  dmg numbers
Z  slow motion · I  infinite ammo
K  reset robots · M  next test station
── black division ──
Y  respawn squad · O  god mode · U  AI on/off
H  debug HUD · Tab  tuning panel · F1  help`;

export interface LabSettings {
  rays: boolean;
  laser: boolean;
  debugHud: boolean;
  weapon: number;
  help: boolean;
}

const KEY = 'weaponlab.settings.v2';

/** Dev conveniences remembered between page loads (per browser). */
export function loadSettings(): Partial<LabSettings> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LabSettings>;
  } catch {
    return {};
  }
}

export function saveSettings(s: LabSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode): settings just won't persist */
  }
}

export const stationPosition = (i: number): THREE.Vector3 => new THREE.Vector3(...STATIONS[i].pos);
