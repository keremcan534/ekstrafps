import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dev-only endpoint used by the in-game tuning panel ("Save to source") and the weapon
 * calibration page.
 * POST /__tuning/save  { file: "weapons/assault_rifle", data: {...} }
 * writes src/config/<file>.json so tuned values become the new defaults. `text` instead of
 * `data` writes that JSON text as formatted. A view profile (viewprofiles/<id>) may be new;
 * every other config must already exist.
 */
function tuningSavePlugin(): Plugin {
  const configDir = path.resolve(root, 'src/config');
  return {
    name: 'weapon-lab-tuning-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__tuning/save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk));
        req.on('end', () => {
          try {
            const { file, data, text } = JSON.parse(body) as { file: string; data?: unknown; text?: string };
            if (!/^[a-z0-9_]+(\/[a-z0-9_]+)?$/.test(file)) throw new Error('bad file name');
            const target = path.join(configDir, `${file}.json`);
            if (!fs.existsSync(target) && !file.startsWith('viewprofiles/')) throw new Error(`unknown config ${file}`);
            if (typeof text === 'string') JSON.parse(text);
            const out = typeof text === 'string' ? text : JSON.stringify(data, null, 2);
            fs.writeFileSync(target, out.endsWith('\n') ? out : out + '\n');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, file: path.relative(root, target) }));
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });
    },
  };
}

/**
 * Dev-only trailer frame sink. The capture director POSTs each rendered frame:
 * POST /__trailer/frame?shot=A03&i=12 (body: image/jpeg or image/png)
 * writes production/trailer/frames/A03/00012.jpg. POST /__trailer/clear?shot=A03 empties the folder.
 * POST /__trailer/file?name=events/A03.json writes sidecar files (sound-event logs).
 */
function trailerFramesPlugin(): Plugin {
  const framesDir = path.resolve(root, 'production/trailer/frames');
  const buildDir = path.resolve(root, 'production/trailer/build');
  const safe = (v: string | null) => (v && /^[A-Za-z0-9_-]+$/.test(v) ? v : null);
  return {
    name: 'trailer-frames',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__trailer', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? '', 'http://x');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks);
            if (url.pathname === '/frame') {
              const shot = safe(url.searchParams.get('shot'));
              const i = Number(url.searchParams.get('i'));
              if (!shot || !Number.isInteger(i) || i < 0) throw new Error('bad frame');
              const ext = (req.headers['content-type'] ?? '').includes('png') ? 'png' : 'jpg';
              const dir = path.join(framesDir, shot);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, `${String(i).padStart(5, '0')}.${ext}`), body);
            } else if (url.pathname === '/clear') {
              const shot = safe(url.searchParams.get('shot'));
              if (!shot) throw new Error('bad shot');
              fs.rmSync(path.join(framesDir, shot), { recursive: true, force: true });
            } else if (url.pathname === '/file') {
              const name = url.searchParams.get('name') ?? '';
              if (!/^[a-z]+\/[A-Za-z0-9_-]+\.(json|wav)$/.test(name)) throw new Error('bad name');
              const target = path.join(buildDir, name);
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, body);
            } else throw new Error('unknown');
            res.end('{"ok":true}');
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  // Relative asset paths in builds, so the game works under any sub-path
  // (GitHub Pages serves it at /ekstrafps/).
  base: command === 'build' ? './' : '/',
  plugins: [tuningSavePlugin(), trailerFramesPlugin()],
  server: {
    host: true, // expose on LAN so phones on the same Wi-Fi can open the lab
    port: 5173,
    // The trailer capture server (port 5180) must never reload a page mid-capture.
    hmr: process.argv.includes('5180') ? false : undefined,
    // Trailer production files (frames, renders, music, tools) are not game source;
    // its capture code (production/trailer/capture) is.
    watch: {
      ignored: (p: string) => {
        const f = p.replace(/\\/g, '/');
        const t = path.resolve(root, 'production/trailer').replace(/\\/g, '/') + '/';
        return f.startsWith(t) && !f.startsWith(t + 'capture/');
      },
    },
  },
  build: {
    // es2022 alone keeps three's class static blocks, which iOS Safari 16.0-16.3
    // cannot parse (blank page); the browser targets make esbuild lower them.
    target: ['es2022', 'safari16', 'chrome100', 'firefox100'],
    chunkSizeWarningLimit: 4000,
  },
}));
