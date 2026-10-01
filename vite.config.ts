import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dev-only endpoint used by the in-game tuning panel ("Save to source").
 * POST /__tuning/save  { file: "weapons/assault_rifle", data: {...} }
 * writes src/config/<file>.json so tuned values become the new defaults.
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
            const { file, data } = JSON.parse(body) as { file: string; data: unknown };
            if (!/^[a-z_]+(\/[a-z_]+)?$/.test(file)) throw new Error('bad file name');
            const target = path.join(configDir, `${file}.json`);
            if (!fs.existsSync(target)) throw new Error(`unknown config ${file}`);
            fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
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

export default defineConfig({
  plugins: [tuningSavePlugin()],
  server: {
    host: true, // expose on LAN so phones on the same Wi-Fi can open the lab
    port: 5173,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
});
