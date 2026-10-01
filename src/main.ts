import { Game } from './core/Game';

const app = document.getElementById('app')!;

const overlay = document.createElement('div');
overlay.className = 'overlay';
overlay.innerHTML = `
  <div class="overlay-card">
    <h1>WEAPON LAB <span>v0.1</span></h1>
    <p class="status">Loading…</p>
    <div class="controls desktop-only">
      <div><b>WASD</b> move · <b>Mouse</b> look · <b>Space</b> jump · <b>Shift</b> sprint · <b>C</b> crouch</div>
      <div><b>LMB</b> fire · <b>RMB</b> aim · <b>R</b> reload · <b>1 2 3</b> / wheel / <b>Q</b> switch</div>
      <div><b>Tab</b> tuning · <b>H</b> debug HUD · <b>G</b> aim rays · <b>L</b> laser · <b>N</b> damage numbers · <b>Esc</b> release mouse</div>
    </div>
    <div class="controls touch-only">
      <div>Left side: move (push to top = sprint) · Right side: look</div>
      <div>FIRE buttons also aim while held · ADS toggles · ⚙ tuning · DBG debug · RAY aim rays · LSR laser</div>
    </div>
    <button class="start" disabled>Loading…</button>
  </div>`;
app.appendChild(overlay);

const rotateHint = document.createElement('div');
rotateHint.className = 'rotate-hint';
rotateHint.textContent = 'Rotate your device to landscape';
app.appendChild(rotateHint);

const status = overlay.querySelector('.status') as HTMLParagraphElement;
const button = overlay.querySelector('.start') as HTMLButtonElement;

const game = new Game(app);
document.body.classList.toggle('is-touch', game.mobile);

game
  .init((msg) => (status.textContent = msg))
  .then(() => {
    status.textContent = game.mobile ? 'Tap to start' : 'Click to start';
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

// Desktop: show the overlay again when the mouse is released (Esc), unless tuning.
document.addEventListener('pointerlockchange', () => {
  if (!game.isPaused) overlay.classList.add('hidden');
  else if (!game.tuning?.visible) overlay.classList.remove('hidden');
});
