/* Sign-in gate: an unauthenticated "Submit a sim" OR "Export area" click
 * must open a modal explaining the Google sign-in requirement with a
 * Google-themed CTA ("Sign in with Google"); only clicking the CTA starts
 * the Google sign-in flow, and success continues into the flow that asked
 * for it (submit -> wizard, export -> the export-area flow). The store's
 * signGate state holds the INTENT ('submit' | 'export') so the gate copy
 * and the post-sign-in continuation match the entry point.
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

describe('sign-in gate (unauthenticated submit + export)', () => {
  it('signed-out startDraft opens the gate instead of popping Firebase', () => {
    const s = read('src', 'state', 'store.js');
    expect(s, 'store must hold the sign-gate state — an INTENT string '
      + '(null | "submit" | "export"), so the gate copy and the '
      + 'post-sign-in continuation can match the entry point')
      .toMatch(/const \[signGate, setSignGate\] = useState\(null\)/);

    /* slice ends AT cancelDraft — signInFromGate lives after it, so this
     * window holds only startDraft itself */
    const start = s.slice(
      s.indexOf('const startDraft'), s.indexOf('const cancelDraft'));
    expect(start, 'startDraft callback not found').not.toBe('');

    expect(start, 'signed-out startDraft must open the gate with the '
      + 'submit intent')
      .toMatch(/setSignGate\('submit'\)/);
    expect(start,
      'startDraft must NOT open the Google popup itself — the gate CTA does')
      .not.toMatch(/signInWithGoogle/);

    expect(s, 'store must expose signGate, closeSignGate, signInFromGate')
      .toMatch(/signGate, closeSignGate, signInFromGate/);
  });

  it('the gate CTA continues into the flow that opened the gate', () => {
    const s = read('src', 'state', 'store.js');
    const gate = s.slice(
      s.indexOf('const signInFromGate'), s.indexOf('const setDraftGeo'));
    expect(gate, 'signInFromGate callback not found').not.toBe('');
    expect(gate, 'the gate CTA must start the Google sign-in flow')
      .toMatch(/signInWithGoogle\(/);
    expect(gate, 'the gate must close on sign-in success')
      .toMatch(/setSignGate\(null\)/);
    expect(gate,
      'export intent: sign-in success must continue into the export flow '
      + '(the store-held exportOpen — App renders ExportFlow from it)')
      .toMatch(/intent === 'export'\)[\s\S]{0,80}setExportOpen\(true\)/);
    expect(gate,
      'submit intent: sign-in success must continue into the submit wizard '
      + '— the same opener the signed-in startDraft path uses')
      .toMatch(/openDraftFor\(/);
    expect(gate, 'sign-in failure must surface the honest toast')
      .toMatch(/setToast\(/);
  });

  it('signed-out startExport opens the same gate with the export intent', () => {
    const s = read('src', 'state', 'store.js');

    expect(s, 'the store must hold the export-flow open state (moved out '
      + 'of App) so the gate CTA can open the flow after sign-in')
      .toMatch(/const \[exportOpen, setExportOpen\] = useState\(false\)/);

    const win = s.slice(
      s.indexOf('const startExport'), s.indexOf('const setDraftGeo'));
    expect(win, 'startExport callback not found').not.toBe('');

    expect(win, 'signed-in startExport must open the export flow directly '
      + '(unchanged behavior)')
      .toMatch(/setExportOpen\(true\)/);
    expect(win, 'signed-out startExport must open the gate with the '
      + 'export intent — the SAME modal the submit flow uses')
      .toMatch(/setSignGate\('export'\)/);
    expect(win,
      'startExport must NOT open the Google popup itself — the gate CTA does')
      .not.toMatch(/signInWithGoogle/);

    expect(s, 'store must expose exportOpen, startExport, closeExport')
      .toMatch(/exportOpen, startExport, closeExport/);
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

  it('SignInGate copy matches the intent (export vs submit)', () => {
    const c = read('src', 'components', 'SignInGate.js');
    expect(c, 'the gate must branch its copy on the store intent')
      .toMatch(/store\.signGate === 'export'/);
    expect(c, 'export intent: step label matches the export modal')
      .toMatch(/'EXPORT AREA FOR SUMO' : 'SUBMIT A SIMULATION'/);
    expect(c, 'export intent: heading is the export ask')
      .toMatch(/'Sign in to export' : 'Sign in to submit a sim'/);
    expect(c, 'export intent: hint explains what sign-in unlocks — the '
      + 'road-network export')
      .toMatch(/export a SUMO road network/);
    expect(c, 'submit intent: the recorded-author hint stays')
      .toMatch(/becomes the recorded author/);
  });

  it('EXTRA_CSS styles the Google-branded button', () => {
    const m = read('src', 'main.js');
    expect(m, 'EXTRA_CSS must style .gbtn').toMatch(/\.gbtn\{/);
    expect(m, '.gbtn must be white with Google-brand ink')
      .toMatch(/\.gbtn\{[^}]*background:#fff[^}]*color:#1F1F1F/);
  });
});