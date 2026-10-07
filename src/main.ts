import { trailerMode } from '../production/trailer/capture/determinism';
import { Game } from './core/Game';
import { enterLandscape, portraitQuery } from './core/Landscape';
import { loadGraphics, noGlass } from './config/Graphics';
import { MainMenu } from './ui/MainMenu';
import { applyHudLayout, loadHudLayout } from './ui/HudLayout';
import { LoadScreen, afterFrames } from './ui/LoadScreen';
import { wearMask } from './ui/DossierGrime';
import './ui/glass.css';
import './ui/touch-hud.css';
import './ui/menu-file.css';
import './ui/hud-file.css';
import './ui/subtitles.css';

const app = document.getElementById('app')!;
// The worn print texture (spoken lines, dossier): relative to the page, like every public
// file the desktop and Android builds load from a file / app origin.
document.documentElement.style.setProperty('--dirt', 'url(ui/dirt.webp)');
document.documentElement.style.setProperty('--dirt-text', 'url(ui/dirt_text.webp)');
document.documentElement.style.setProperty('--dirt-light', 'url(ui/dirt_light.webp)');
// Worn type for the HUD's big numerals (the menu title's mask, painted once).
document.documentElement.style.setProperty('--wear', `url(${wearMask()})`);
const params = new URLSearchParams(location.search);

// Phones held upright: a cover over everything (menu, match, loading) asking for landscape.
const rotateHint = document.createElement('div');
rotateHint.className = 'rotate-hint';
rotateHint.innerHTML = `
  <div class="rh-box">
    <div class="rh-phone"><i></i></div>
    <h2 class="rh-title">Turn your phone</h2>
    <p class="rh-msg">SITE-9 is played in landscape</p>
  </div>`;
document.body.appendChild(rotateHint);

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
if (game.mobile) {
  // The first tap anywhere (the menu too, not only PLAY) goes fullscreen and turns the page
  // sideways where the browser allows it; the portrait cover handles the rest.
  const sideways = () => {
    window.removeEventListener('pointerup', sideways);
    enterLandscape();
  };
  window.addEventListener('pointerup', sideways);
  rotateHint.addEventListener('pointerup', () => enterLandscape());
  // Turned upright mid-raid: pause rather than play on behind the cover.
  portraitQuery().addEventListener('change', (e) => {
    if (e.matches && game.running && !game.ended) pause();
  });
}
// Phones: no frosted glass (a blur pass per panel every frame). The game keeps this in sync with Settings.
document.body.classList.toggle('no-glass', noGlass(game.mobile, loadGraphics(game.mobile)));
// Phones: the UI is laid out for ~640 px of height; scale it to the real screen (a phone in landscape is ~400).
const uiScale = () => document.documentElement.style.setProperty('--ui-zoom', String(Math.max(0.58, Math.min(1, window.innerHeight / 640))));
uiScale();
const relayout = () => {
  uiScale();
  if (game.mobile) applyHudLayout(loadHudLayout());
};
window.addEventListener('resize', relayout);
// Android WebViews can report the old size on the resize itself (rotation, going
// fullscreen and the system bars leaving, often mid-load when the page is busy): check
// again once things have settled, so the UI never stays scaled for the wrong screen.
const relayoutLater = () => {
  relayout();
  for (const ms of [120, 400, 1000]) window.setTimeout(relayout, ms);
};
window.visualViewport?.addEventListener('resize', relayout);
window.addEventListener('orientationchange', relayoutLater);
document.addEventListener('fullscreenchange', relayoutLater);

// PLAY / RESUME. Desktop: the menu closes when the mouse is actually locked (pointerlockchange).
const go = () => {
  game.start();
  if (game.mobile) {
    game.setFrozen(false);
    menu.close();
    // Android back gesture: pause instead of leaving the page (one guard entry in the history).
    if (!(history.state as { site9?: boolean } | null)?.site9) history.pushState({ site9: true }, '');
  }
};
// Phones: the first PLAY shows the loading screen while the match spins up (the first
// frames are the heavy ones), instead of a frozen menu. Painted first, then the start (still
// inside the tap's activation window, which fullscreen and audio need). Resume is instant.
let deployed = false;
const begin = () => {
  if (!game.mobile || deployed) return go();
  deployed = true;
  loader.show('Deploying…');
  void afterFrames(2)
    .then(() => {
      go();
      return afterFrames(4);
    })
    .then(() => loader.hide());
};
const menu = new MainMenu(app, { map, mode, controls, mobile: game.mobile, onPlay: begin });
const loader = new LoadScreen(document.body);
// ?terminal opens the tape list; ?minigame=<id> runs one tape.
if (urlParams.has('terminal') || urlParams.has('minigame')) menu.openTerminal(urlParams.get('minigame') ?? undefined);
if (trailerMode) {
  menu.close();
  loader.hide();
}

window.addEventListener('popstate', () => {
  if (!game.mobile || !game.running || (history.state as { site9?: boolean } | null)?.site9) return;
  // Match over: nothing to pause, so this back press leaves (the guard entry is already gone).
  if (game.ended) {
    history.back();
    return;
  }
  history.pushState({ site9: true }, '');
  // Already paused: back closes the terminal, the dossier or the open panel first.
  if (menu.visible && menu.back()) return;
  pause();
});

/** Phones: the pause button / back gesture. The raid holds still until RESUME. */
function pause(): void {
  game.setFrozen(true);
  menu.setPaused(true);
  menu.open();
}
game.onPauseRequest = () => {
  if (game.running && !game.ended) pause();
};

game
  .init((msg) => {
    menu.setStatus(msg);
    loader.status(msg);
  })
  .then(() => {
    if (trailerMode) return import('../production/trailer/capture/Director').then((m) => m.runTrailer(game));
    menu.setReady(game);
    loader.hide();
    // Phones: the control layout (preset + Settings → Controls → CUSTOMIZE HUD); the controls exist from init().
    if (game.mobile) applyHudLayout(loadHudLayout());
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
    loader.status(`Failed to start: ${err}`);
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
