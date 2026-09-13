/* Sign-in gate for the submit flow: an unauthenticated "Submit a sim"
 * click must open a modal explaining the Google sign-in requirement with a
 * Google-themed CTA ("Sign in with Google"); only clicking the CTA starts
 * the Google sign-in flow, and success continues into the submit wizard.
 *
 * The vitest env is node (no jsdom) — UI wiring is pinned as text, same
 * style as test/html.test.js pins the TrafficMap attach-effect dep array
 * and test/dev-wiring.test.js pins the dev launcher.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

describe('sign-in gate (unauthenticated submit)', () => {
  it('signed-out startDraft opens the gate instead of popping Firebase', () => {
    const s = read('src', 'state', 'store.js');
    expect(s, 'store must hold the sign-gate state')
      .toMatch(/const \[signGate, setSignGate\] = useState\(false\)/);

    /* slice ends AT cancelDraft — signInFromGate lives after it, so this
     * window holds only startDraft itself */
    const start = s.slice(
      s.indexOf('const startDraft'), s.indexOf('const cancelDraft'));
    expect(start, 'startDraft callback not found').not.toBe('');

    expect(start, 'signed-out startDraft must open the gate')
      .toMatch(/setSignGate\(true\)/);
    expect(start,
      'startDraft must NOT open the Google popup itself — the gate CTA does')
      .not.toMatch(/signInWithGoogle/);

    const gate = s.slice(
      s.indexOf('const signInFromGate'), s.indexOf('const setDraftGeo'));
    expect(gate, 'signInFromGate callback not found').not.toBe('');
    expect(gate, 'the gate CTA must start the Google sign-in flow')
      .toMatch(/signInWithGoogle\(/);
    expect(gate, 'the gate must close on sign-in success')
      .toMatch(/setSignGate\(false\)/);
    expect(gate,
      'sign-in success must continue into the submit wizard — the same '
      + 'opener the signed-in startDraft path uses')
      .toMatch(/openDraftFor\(/);
    expect(gate, 'sign-in failure must surface the honest toast')
      .toMatch(/setToast\(/);

    expect(s, 'store must expose signGate, closeSignGate, signInFromGate')
      .toMatch(/signGate, closeSignGate, signInFromGate/);
  });

  it('App renders SignInGate from the store gate flag', () => {
    const app = read('src', 'components', 'App.js');
    expect(app, 'App must import the SignInGate component')
      .toMatch(/import \{ SignInGate \} from '\.\/SignInGate\.js'/);
    expect(app, 'App must render SignInGate while the gate flag is set')
      .toMatch(/store\.signGate \? h\(SignInGate, \{ store \}\) : null/);
  });

  it('SignInGate modal carries the Google-themed CTA', () => {
    const c = read('src', 'components', 'SignInGate.js');
    /* same modal idiom as SubmitFlow/ExportFlow */
    expect(c, 'gate must render in the standard modal veil')
      .toMatch(/className: 'modal-veil'/);
    expect(c, 'veil click must dismiss the gate').toMatch(/closeSignGate/);
    expect(c, 'gate must explain the requirement')
      .toMatch(/sign in with Google/i);
    expect(c, 'CTA must use the Google-branded button class')
      .toMatch(/className: 'gbtn'/);
    expect(c, 'CTA label must be "Sign in with Google"')
      .toMatch(/h\('span', null, 'Sign in with Google'\)/);
    expect(c, 'CTA must carry the four-color Google G logo — blue')
      .toMatch(/#4285F4/);
    expect(c, 'CTA must carry the four-color Google G logo — red')
      .toMatch(/#EA4335/);
    expect(c, 'CTA must carry the four-color Google G logo — yellow')
      .toMatch(/#FBBC05/);
    expect(c, 'CTA must carry the four-color Google G logo — green')
      .toMatch(/#34A853/);
    expect(c, 'CTA click must route through store.signInFromGate')
      .toMatch(/store\.signInFromGate/);
  });

  it('EXTRA_CSS styles the Google-branded button', () => {
    const m = read('src', 'main.js');
    expect(m, 'EXTRA_CSS must style .gbtn').toMatch(/\.gbtn\{/);
    expect(m, '.gbtn must be white with Google-brand ink')
      .toMatch(/\.gbtn\{[^}]*background:#fff[^}]*color:#1F1F1F/);
  });
});
