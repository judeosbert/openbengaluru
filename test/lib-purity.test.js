/* Structural successor of test_app.js test 18 (the vm harness proved the
 * pure head was DOM-free by loading it with no window/document globals).
 * The guarantee is now enforced on the source layout: src/lib/*.js must
 * import no react/react-dom/leaflet/DOM packages and must never touch a DOM
 * global — so every src/lib module runs in the vitest node environment. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const LIB_DIR = path.join(PLAYER_ROOT, 'src', 'lib');

function listLibFiles() {
  return fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.js'));
}

/* All module specifiers of a file: `import ... from 'x'` and bare
 * `import 'x'`. */
function importSources(src) {
  const out = [];
  const re = /(?:^|\n)import\s[^;'"]*['"]([^'"]+)['"]|(?:^|\n)import\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1] || m[2]);
  return out;
}

it('src/lib imports no react/leaflet/DOM packages', () => {
  const files = listLibFiles();
  expect(files.length, 'no src/lib modules found').toBeGreaterThan(0);
  for (const f of files) {
    const src = fs.readFileSync(path.join(LIB_DIR, f), 'utf8');
    for (const spec of importSources(src)) {
      expect(spec,
        `${f}: forbidden import '${spec}' — src/lib must stay react/leaflet/DOM-free`)
        .not.toMatch(/react|leaflet|dom/i);
    }
  }
});

it('src/lib code never touches document/window/localStorage', () => {
  const files = listLibFiles();
  expect(files.length, 'no src/lib modules found').toBeGreaterThan(0);
  for (const f of files) {
    const src = fs.readFileSync(path.join(LIB_DIR, f), 'utf8');
    expect(src, `${f}: references a DOM global — src/lib must stay DOM-free`)
      .not.toMatch(/\b(document|window|localStorage)\b/);
  }
});
