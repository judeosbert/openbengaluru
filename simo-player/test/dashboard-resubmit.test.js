/* Dashboard Resubmit action: clicking Resubmit must close the dashboard
 * overlay before the submit wizard opens. The wizard renders whenever
 * draftSub is set (App.js), while DashboardView stays mounted while
 * view === 'dashboard' — so without an explicit setView('discover') the
 * dashboard panel paints on top of the wizard (the reported bug).
 *
 * The vitest env is node (no jsdom) — UI wiring is pinned as text, same
 * style as test/signin-gate.test.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

describe('dashboard Resubmit closes the panel', () => {
  it('the resubmit handler switches the view off the dashboard', () => {
    const s = read('src', 'components', 'DashboardView.js');
    const start = s.indexOf('const resubmit = (row) => {');
    const end = s.indexOf('const sendReply =');
    expect(start, 'resubmit handler not found').toBeGreaterThan(-1);
    expect(end, 'sendReply handler not found').toBeGreaterThan(-1);
    const block = s.slice(start, end);
    expect(block, 'Resubmit must open the prefilled wizard')
      .toMatch(/store\.startResubmit\(row\)/);
    expect(block, 'Resubmit must close the dashboard overlay — the wizard '
        + 'renders underneath while view stays \'dashboard\'')
      .toMatch(/store\.setView\('discover'\)/);
  });
});
