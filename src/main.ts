import { trailerMode } from '../production/trailer/capture/determinism';
import { Game } from './core/Game';
import { MainMenu } from './ui/MainMenu';
import './ui/glass.css';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

const rotateHint = document.createElement('div');
rotateHint.className = 'rotate-hint';
rotateHint.textContent = 'Rotate your device to landscape';
app.appendChild(rotateHint);

const map = params.get('map') === 'site9' ? 'site9' : 'lab';
const mode = params.get('mode') === 'solo' ? 'solo' : 'teams';
const controls = (() => {
  try {
    return localStorage.getItem('weaponlab.controls') ?? 'auto';
  } catch {
    return 'auto';
  }
})();

const game = new Game(app);
document.body.classList.toggle('is-touch', game.mobile);
// Phones: the UI is laid out for ~640 px of height; scale it to the real screen (a phone in landscape is ~400).
const uiScale = () => document.documentElement.style.setProperty('--ui-zoom', String(Math.max(0.58, Math.min(1, window.innerHeight / 640))));
uiScale();
window.addEventListener('resize', uiScale);

// PLAY / RESUME. Desktop: the menu closes when the mouse is actually locked (pointerlockchange).
const begin = () => {
  game.start();
  if (game.mobile) menu.close();
};
const menu = new MainMenu(app, { map, mode, controls, mobile: game.mobile, onPlay: begin });
if (trailerMode) menu.close();

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
