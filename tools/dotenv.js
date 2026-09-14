/* Minimal .env loader (no dependency): `npm run dev` must work standalone
 * with a repo-root .env present — shell sourcing (`set -a; . ./.env`) is
 * only documented for `npm start`. Format: KEY=VALUE per line, `#` comments
 * and blank lines skipped, surrounding matching quotes stripped, empty
 * values kept (the server fail-fast treats empty as missing). Base-env
 * precedence matches dotenv: an already-set shell var always wins, so a
 * sourced shell still overrides the file. A missing file is tolerated —
 * consumers keep their own fail-fast missing-vars reporting (db.js etc).
 */
import { readFileSync } from 'node:fs';

export function parseDotEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadDotEnvFile(filePath, base = process.env) {
  const env = { ...base };
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return env;
  }
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (!(key in env)) env[key] = value;
  }
  return env;
}
