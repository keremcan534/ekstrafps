import { Game } from './core/Game';

const app = document.getElementById('app')!;

const overlay = document.createElement('div');
overlay.className = 'overlay';
overlay.innerHTML = `
  <div class="overlay-card">
    <h1>WEAPON LAB <span>v0.2 tactical</span></h1>
    <p class="status">Loading…</p>
    <div class="controls desktop-only">
      <div><b>WASD</b> move · <b>Mouse</b> look · <b>Space</b> jump · <b>Shift</b> sprint · <b>C</b> crouch · <b>Q/E</b> lean</div>
      <div><b>LMB</b> fire · <b>RMB</b> aim · <b>R</b> reload · <b>B</b> fire mode · <b>V</b> shoulder · <b>T</b> inspect · <b>1-0</b> weapons</div>
      <div><b>G</b> aim rays · <b>L</b> laser · <b>Z</b> slow-mo · <b>I</b> inf. ammo · <b>K</b> reset robots · <b>M</b> test stations</div>
      <div><b>Tab</b> tuning · <b>H</b> debug HUD · <b>F1</b> help · <b>Esc</b> release mouse</div>
      <div>Site-9: <b>F</b> buy doors / weapons / contractors · <b>M</b> map · <b>X</b> give up while downed · Weapon Lab: Black Division in the yard · <b>O</b> god mode · <b>U</b> AI on/off</div>
    </div>
    <div class="controls touch-only">
      <div>Left side: move (drag up onto ⇧ to lock sprint) · Right side: look · FIRE also aims while held</div>
      <div>◎ aim · ↻ reload · tap the weapon card to swap · USE appears when you can buy · tap the minimap for the map</div>
    </div>
    <div class="maps">Map <button data-map="lab">Weapon Lab</button><button data-map="site9">Site-9 (facility)</button></div>
    <div class="maps mode-pick">Mode <button data-mode="teams">4 Teams (PvPvE)</button><button data-mode="solo">Solo survival</button></div>
    <div class="maps controls-pick">Controls <button data-ctl="auto">Auto</button><button data-ctl="pc">PC</button><button data-ctl="mobile">Mobile</button></div>
    <button class="start" disabled>Loading…</button>
  </div>`;
app.appendChild(overlay);

const rotateHint = document.createElement('div');
rotateHint.className = 'rotate-hint';
rotateHint.textContent = 'Rotate your device to landscape';
app.appendChild(rotateHint);

// Map picker: reloads with ?map=… (other URL flags are kept).
const currentMap = new URLSearchParams(location.search).get('map') === 'site9' ? 'site9' : 'lab';
overlay.querySelectorAll<HTMLButtonElement>('.maps button[data-map]').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.map === currentMap);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.dataset.map === currentMap) return;
    const params = new URLSearchParams(location.search);
    if (btn.dataset.map === 'site9') params.set('map', 'site9');
    else params.delete('map');
    location.search = params.toString();
  });
});

// Mode picker (Site-9 only): four-team race or classic solo survival.
const modePick = overlay.querySelector<HTMLDivElement>('.mode-pick')!;
modePick.style.display = currentMap === 'site9' ? '' : 'none';
const currentMode = new URLSearchParams(location.search).get('mode') === 'solo' ? 'solo' : 'teams';
modePick.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.mode === currentMode);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.dataset.mode === currentMode) return;
    const params = new URLSearchParams(location.search);
    if (btn.dataset.mode === 'solo') params.set('mode', 'solo');
    else params.delete('mode');
    location.search = params.toString();
  });
});

// Controls picker (PC keyboard+mouse / mobile touch), remembered; reloads to apply.
const ctl = (() => {
  try {
    return localStorage.getItem('weaponlab.controls') ?? 'auto';
  } catch {
    return 'auto';
  }
})();
overlay.querySelectorAll<HTMLButtonElement>('.controls-pick button').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.ctl === ctl);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.dataset.ctl === ctl) return;
    try {
      localStorage.setItem('weaponlab.controls', btn.dataset.ctl!);
    } catch {
      /* storage blocked: nothing to remember */
    }
    const params = new URLSearchParams(location.search);
    params.delete('touch');
    params.delete('mouse');
    location.search = params.toString();
  });
});

const status = overlay.querySelector('.status') as HTMLParagraphElement;
const button = overlay.querySelector('.start') as HTMLButtonElement;

const game = new Game(app);
document.body.classList.toggle('is-touch', game.mobile);

game
  .init((msg) => (status.textContent = msg))
  .then(() => {
    status.textContent = game.mobile ? 'Tap to start' : 'Click or press Enter to start';
    button.disabled = false;
    button.textContent = 'START';
  })
  .catch((err) => {
    console.error(err);
    status.textContent = `Failed to start: ${err}`;
  });

const begin = () => {
  if (button.disabled) return;
  game.start();
  overlay.classList.add('hidden');
  button.textContent = 'RESUME';
  status.textContent = 'Paused';
};
button.addEventListener('click', begin);
// PC convenience: click anywhere on the overlay, or press Enter / Space, to start or resume.
overlay.addEventListener('click', (e) => {
  if (e.target !== button) begin();
});
window.addEventListener('keydown', (e) => {
  if ((e.code === 'Enter' || e.code === 'Space') && !overlay.classList.contains('hidden')) begin();
});

// Desktop: show the overlay again when the mouse is released (Esc), unless tuning.
document.addEventListener('pointerlockchange', () => {
  if (!game.isPaused || game.input.lockFailed || game.ended) overlay.classList.add('hidden');
  else if (!game.tuning?.visible) overlay.classList.remove('hidden');
});
