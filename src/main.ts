import { trailerMode } from '../production/trailer/capture/determinism';
import { Game } from './core/Game';
import { loadGraphics, noGlass } from './config/Graphics';
import { MainMenu } from './ui/MainMenu';
import './ui/glass.css';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

const rotateHint = document.createElement('div');
rotateHint.className = 'rotate-hint';
rotateHint.textContent = 'Rotate your device to landscape';
app.appendChild(rotateHint);

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
// No ?map: the area and mode picked last time (written into the URL, which the game reads).
// Not under trailer capture: there no ?map means the lab.
if (!trailerMode && !params.has('map') && stored('weaponlab.map') === 'site9') {
  params.set('map', 'site9');
  if (!params.has('mode') && stored('weaponlab.mode') === 'solo') params.set('mode', 'solo');
  try {
    history.replaceState(history.state, '', `${location.pathname}?${params}${location.hash}`);
  } catch {
    /* odd scheme or sandboxed frame: stay on the URL's map */
  }
}
// From the URL itself, so the menu shows what the game loads.
const urlParams = new URLSearchParams(location.search);
const map = urlParams.get('map') === 'site9' ? 'site9' : 'lab';
const mode = urlParams.get('mode') === 'solo' ? 'solo' : 'teams';
const controls = stored('weaponlab.controls') ?? 'auto';

let game: Game;
try {
  game = new Game(app);
} catch (err) {
  // No WebGL 2 context (blocklisted GPU, hardware acceleration off, iOS Lockdown Mode): say so instead of a black page.
  console.error(err);
  const msg = document.createElement('div');
  msg.className = 'boot-error';
  msg.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:#111214;color:#e8e8e8;font:15px/1.5 system-ui,sans-serif;text-align:center;z-index:100';
  msg.textContent = 'WebGL 2 is unavailable in this browser. Check chrome://gpu, turn on hardware acceleration, or turn off Lockdown Mode (iPhone / iPad), then reload.';
  app.appendChild(msg);
  throw err;
}
document.body.classList.toggle('is-touch', game.mobile);
// Phones: no frosted glass (a blur pass per panel every frame). The game keeps this in sync with Settings.
document.body.classList.toggle('no-glass', noGlass(game.mobile, loadGraphics(game.mobile)));
// Phones: the UI is laid out for ~640 px of height; scale it to the real screen (a phone in landscape is ~400).
const uiScale = () => document.documentElement.style.setProperty('--ui-zoom', String(Math.max(0.58, Math.min(1, window.innerHeight / 640))));
uiScale();
window.addEventListener('resize', uiScale);

// PLAY / RESUME. Desktop: the menu closes when the mouse is actually locked (pointerlockchange).
const begin = () => {
  game.start();
  if (game.mobile) {
    menu.close();
    // Android back gesture: pause instead of leaving the page (one guard entry in the history).
    if (!(history.state as { site9?: boolean } | null)?.site9) history.pushState({ site9: true }, '');
  }
};
const menu = new MainMenu(app, { map, mode, controls, mobile: game.mobile, onPlay: begin });
if (trailerMode) menu.close();

window.addEventListener('popstate', () => {
  if (!game.mobile || !game.running || (history.state as { site9?: boolean } | null)?.site9) return;
  // Match over: nothing to pause, so this back press leaves (the guard entry is already gone).
  if (game.ended) {
    history.back();
    return;
  }
  history.pushState({ site9: true }, '');
  menu.setPaused(true);
  menu.open();
});

game
  .init((msg) => menu.setStatus(msg))
  .then(() => {
    if (trailerMode) return import('../production/trailer/capture/Director').then((m) => m.runTrailer(game));
    menu.setReady(game);
    // Lock refused (Chromium blocks a re-lock right after Esc): stay paused, the next click retries.
    game.input.onLockRefused = () => {
      if (!game.running || game.mobile) return;
      menu.setPaused(true);
      menu.open();
      menu.setStatus('Click RESUME to continue');
    };
    // No pointer lock at all in this browser: play with free-mouse look.
    const freeMouse = game.input.onLockFailed;
    game.input.onLockFailed = () => {
      freeMouse?.();
      menu.close();
    };
  })
  .catch((err) => {
    console.error(err);
    menu.setStatus(`Failed to start: ${err}`);
  });

// Desktop: the pause menu comes back when the mouse is released (Esc), unless tuning.
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) {
    menu.close();
    return;
  }
  if (!game.running || game.ended || game.input.lockFailed || game.tuning?.visible) return;
  menu.setPaused(true);
  menu.open();
});
