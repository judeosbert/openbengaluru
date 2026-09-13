/* Combined dev launcher: `npm run dev` brings up BOTH halves of the app —
 * the player server (server.js: /api/simulate + upload persistence) and the
 * vite dev server (UI). vite.config.js proxies /api to the player server, so
 * the wizard runs real simulations from the vite origin
 * (http://localhost:5173) without a second `npm start` terminal.
 *
 * The player server takes the first free port from 8787 upward (8787 is the
 * documented default; a squatter just bumps it) and the chosen port is
 * handed to vite via SIMO_API_PORT. Ctrl+C tears both processes down.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvFile } from './dotenv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* First free port from `start`, `tries` ports upward. */
function probePort(start, tries) {
  return new Promise((resolve, reject) => {
    const tryOne = (port, left) => {
      const srv = net.createServer();
      srv.once('error', () => (left > 0
        ? tryOne(port + 1, left - 1)
        : reject(new Error('no free port from ' + start))));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    tryOne(start, tries);
  });
}

const port = await probePort(8787, 10);

/* .env (repo root) feeds BOTH children; real shell env still wins so a
 * sourced terminal keeps overriding the file. Missing .env is fine — the
 * server's fail-fast then reports the missing vars itself. */
const env = loadDotEnvFile(path.join(ROOT, '.env'));

const sim = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...env, PORT: String(port) },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const vite = spawn(process.execPath,
  [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], {
    env: { ...env, SIMO_API_PORT: String(port) },
    stdio: 'inherit',
  });

console.log('[dev_all] player server: http://127.0.0.1:' + port
  + '  (vite proxies /api to it)');

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [sim, vite]) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  process.exit(code);
}

/* Either process dying tears down the other — no half-running dev stack. */
sim.on('exit', (code) => shutdown(code ?? 1));
vite.on('exit', (code) => shutdown(code ?? 1));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
