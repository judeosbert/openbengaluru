/* Stream-failure + loading wiring (plan: never load fake simulations).
 *
 * The engine no longer synthesizes traffic, so a stream that never arrives
 * must surface honestly: App marks the entry failed (streamFailed) + toasts
 * a reopen-to-retry hint, SimPanel shows loading/error notes instead of
 * numbers, and the map draws the real lanes with zero vehicles. Reopening
 * the entry re-fires the lazy effect (deps [entry && entry.id]).
 *
 * Pinned as text (html.test.js precedent — component glue is not directly
 * testable in the node environment).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const read = (...parts) => fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');

describe('App: lazy stream failure surfaces honestly', () => {
  const app = () => read('src', 'components', 'App.js');

  it('both stream sources route failure through store.streamFailed', () => {
    const s = app();
    expect(s, 'the shared failure helper must mark the entry failed')
      .toMatch(/store\.streamFailed\(entry\.id\)/);
    expect(s, 'the apiStream fetch rejection must fail the entry')
      .toMatch(/\.catch\(\(\) => \{ if \(live\) onFail\(\); \}\)/);
    expect(s, 'the apiStream null payload must fail the entry too')
      .toMatch(/else if \(live\) onFail\(\)/);
    expect(s, 'the JSONP null-payload path must fail the entry')
      .toMatch(/mergeStream\(entry\.id, payload\);\s*else onFail\(\)/);
  });

  it('stream failure toasts a check-connection/reopen hint', () => {
    expect(app(), 'failure must toast — no silent empty map')
      .toMatch(/could not load simulation data/);
    expect(app(), 'the toast must ride through the store setter')
      .toMatch(/store\.setToast\(/);
  });

  it('the dead catalog-grow publish snap effect is gone', () => {
    expect(app(), 'local publishes no longer exist — the grow-snap effect '
      + 'only served them and must be deleted')
      .not.toMatch(/prevLen/);
  });

  it('SimPanel receives the streamError flag for the active entry', () => {
    expect(app(), 'App must pass streamError={store.streamErrorId === entry.id}')
      .toMatch(/streamError:\s*store\.streamErrorId === entry\.id/);
  });
});

describe('SimPanel: honest loading/error states (no fake numbers)', () => {
  const sp = () => read('src', 'components', 'SimPanel.js');

  it('accepts the streamError prop', () => {
    expect(sp(), 'SimPanel must take the streamError prop').toMatch(/streamError/);
  });

  it('frames gate the numbers block — no stats call before frames arrive', () => {
    const s = sp();
    expect(s, 'loaded = !!(scenario && scenario.frames) for the active scenario')
      .toMatch(/loaded = !!\(scenario && scenario\.frames\)/);
    expect(s, 'stats are only read once frames are loaded')
      .toMatch(/stats = loaded \? eng\.getStatsAt/);
  });

  it('shows the error note on stream failure and the loading note otherwise', () => {
    const s = sp();
    expect(s, 'streamError must show the retry hint').toMatch(
      /simulation data failed to load/);
    expect(s, 'absent frames must show the loading note (never zeros dressed '
      + 'as data)').toMatch(/loading simulation data/);
  });
});

describe('store: stream failure state', () => {
  it('exposes streamErrorId + the streamFailed setter; mergeStream clears it', () => {
    const s = read('src', 'state', 'store.js');
    expect(s, 'the store must hold streamErrorId')
      .toMatch(/const \[streamErrorId, setStreamErrorId\] = useState\(null\)/);
    expect(s, 'the store must expose the streamFailed(id) setter')
      .toMatch(/streamFailed/);
    expect(s, 'a successfully merged stream must clear the failure flag')
      .toMatch(/setStreamErrorId\(\(cur\) => \(cur === id \? null : cur\)\)/);
    expect(s, 'the store must expose streamErrorId to App')
      .toMatch(/streamErrorId/);
  });
});
