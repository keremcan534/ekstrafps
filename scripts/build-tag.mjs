// The build's tag, shown in the game's bottom-right corner: a word and a digit worked out from the
// commit it was built from, so a deployed page tells at a glance which push it is.
//   node -e "import('./scripts/build-tag.mjs').then((m) => console.log(m.buildTag(m.headSha())))"
import { execSync } from 'node:child_process';

const WORDS = [
  'apple', 'orange', 'lemon', 'cherry', 'plum', 'mango', 'peach', 'grape', 'melon', 'kiwi',
  'pear', 'lime', 'berry', 'fig', 'olive', 'banana', 'coconut', 'papaya', 'apricot', 'quince',
  'carrot', 'pepper', 'tomato', 'potato', 'onion', 'garlic', 'radish', 'pumpkin', 'walnut', 'almond',
  'hazel', 'cocoa', 'honey', 'cookie', 'muffin', 'waffle', 'toffee', 'pretzel', 'bagel', 'donut',
];

/** `sha`: a commit hash. No commit (no git): 'dev'. */
export function buildTag(sha) {
  if (!sha || !/^[0-9a-f]{10}/i.test(sha)) return 'dev';
  return WORDS[parseInt(sha.slice(0, 8), 16) % WORDS.length] + (parseInt(sha.slice(8, 10), 16) % 10);
}

/** The commit being built: GitHub Actions says, else the local checkout's HEAD. */
export function headSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}
