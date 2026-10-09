#!/usr/bin/env node
/**
 * Run a Blender Python script headless (no UI, factory settings, so the result never depends on
 * a user's Blender preferences or add-ons):
 *   node scripts/blender.mjs <scripts/blender/x.py> [args for the script...]
 *
 * Blender is found from $BLENDER, then BLENDER in .env, then the pinned portable install
 * (5.2.1 LTS, see .env.example). The script gets its own args after "--" (sys.argv).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
if (existsSync(join(root, '.env'))) {
  for (const l of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const candidates = [process.env.BLENDER, env.BLENDER, "C:/Users/Kerem/tools/blender-5.2.1-windows-x64/blender.exe"];
const blender = candidates.find((p) => p && existsSync(p)) ?? 'blender';

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/blender.mjs <script.py> [args...]');
  process.exit(1);
}
const r = spawnSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...args], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
