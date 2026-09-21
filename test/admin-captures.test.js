/* AdminView capture moderation + filter drop (plan: capture-admin-moderation)
 * — regex/source-wiring assertions (pattern from capture.test.js /
 * contribute.test.js; the vitest env is node, so React components are pinned
 * by source, not by rendering):
 *
 * - the ALL chip is GONE: FILTERS is exactly the four review states and the
 *   default filter is 'pending' (the review queue's first screen).
 * - a SIMS | CAPTURES section switcher in the dash head; SIMS is the
 *   default section.
 * - the CAPTURES section: loads via the fetchAdminCaptures wrapper, renders
 *   the rows (junction/method/date + author meta + size), offers View file
 *   (authed blob fetch -> URL.createObjectURL — the route needs the bearer
 *   header, so a bare link can never work) and a reject row (reason input +
 *   Reject, disabled until non-empty, mirroring the sims reject UI); a
 *   successful reject toasts and reloads the list.
 * - api.js exposes the two authed wrappers (fetchAdminCaptures +
 *   rejectCapture) hitting /api/admin/captures.
 */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

const VIEW = () => read('src', 'components', 'AdminView.js');
const API = () => read('src', 'api.js');

/* --------------------------------------------------- ALL chip is gone --- */

it('FILTERS drops ALL: exactly the four review states, default pending', () => {
  const s = VIEW();
  expect(s, 'FILTERS is exactly the four review states (no "all")').toMatch(
    /const FILTERS = \['pending', 'active', 'rejected', 'inactive'\];/);
  expect(s, "the default filter is 'pending' (the queue's first screen)")
    .toMatch(/useState\('pending'\)/);
  expect(s, "no 'all' state left behind").not.toMatch(/useState\('all'\)/);
  expect(s, "the dead filter === 'all' branch is removed")
    .not.toMatch(/filter === 'all'/);
});

/* --------------------------------------------- SIMS | CAPTURES switcher --- */

it('the dash head gains a SIMS | CAPTURES section switcher (SIMS default)',
  () => {
    const s = VIEW();
    expect(s, "the section state defaults to 'sims'").toMatch(
      /useState\('sims'\)/);
    expect(s, 'both chips render (uppercase labels)').toMatch(
      /'SIMS'/);
    expect(s).toMatch(/'CAPTURES'/);
    expect(s, 'a section setter exists').toMatch(/setSection\(/);
  });

/* -------------------------------------------------- CAPTURES section UI --- */

it('the CAPTURES section loads via fetchAdminCaptures and renders the rows',
  () => {
    const s = VIEW();
    expect(s, 'the list wrapper is imported from api.js').toMatch(
      /fetchAdminCaptures/);
    expect(s, 'the list loads through a loadCaptures callback').toMatch(
      /loadCaptures/);
    expect(s, 'capture rows render from the list').toMatch(
      /\.captures\.map\(|captures\.map\(/);
    expect(s, 'the meta line shows the author email').toMatch(
      /author_email/);
    expect(s, 'the meta line shows the byte size').toMatch(/byte_size/);
    expect(s, 'the meta line shows captured_at').toMatch(/captured_at/);
  });

it('View file is an AUTHED blob fetch (bearer route — a bare link cannot '
  + 'work)', () => {
  const s = VIEW();
  expect(s, 'the token comes from the firebase adapter').toMatch(
    /import \{ currentToken \} from '\.\.\/auth\/firebase\.js';/);
  expect(s, 'the file URL targets the admin capture file route').toMatch(
    /admin\/captures\//);
  expect(s, 'the bytes become a blob object URL').toMatch(
    /URL\.createObjectURL/);
});

it('the captures reject row mirrors the sims reject UI', () => {
  const s = VIEW();
  expect(s, 'a captures reject reason state exists').toMatch(/capReject/);
  expect(s, 'the reject goes through the rejectCapture wrapper').toMatch(
    /rejectCapture\(/);
  expect(s, 'the reason input requires a non-empty trim (same copy as the '
    + 'sims reject row)').toMatch(/Reject reason \(required\)/);
  expect(s, 'a successful reject toasts').toMatch(/setToast/);
});

/* --------------------------------------------------- api.js wrappers --- */

it('api.js exposes fetchAdminCaptures + rejectCapture (authed call helpers)',
  () => {
    const src = API();
    expect(src, 'fetchAdminCaptures wrapper exists').toMatch(
      /export\s+function\s+fetchAdminCaptures\s*\(\)/);
    expect(src, 'hits the admin captures list route').toMatch(
      /\/api\/admin\/captures/);
    expect(src, 'rejectCapture wrapper exists').toMatch(
      /export\s+function\s+rejectCapture\s*\(/);
    expect((src.match(/\/api\/admin\/captures/g) || []).length,
      'both wrappers share the /api/admin/captures base')
      .toBeGreaterThanOrEqual(2);
    expect(src, 'reject POSTs the reason').toMatch(
      /rejectCapture[\s\S]{0,400}method:\s*'POST'/);
  });
