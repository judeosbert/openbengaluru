/* Port of test_app.js test 20 (export helpers) + test_mock.py test 12
 * (placementScale min-scale clamp). */
import { describe, it, expect } from 'vitest';
import { osmApiUrl, convertScript } from '../src/lib/areaExport.js';
import { placementScale } from '../src/lib/geo.js';

// test_app.js 20 --------------------------------------------------------------
it('export helpers', () => {
  // osmApiUrl: bbox [minLat,minLng,maxLat,maxLng] -> OSM bbox=minLng,minLat,maxLng,maxLat
  const url = osmApiUrl([12.94, 77.71, 12.95, 77.72]);
  expect(url).toMatch(/openstreetmap\.org\/api\/0\.6\/map\?bbox=/);
  expect(url, 'lng/lat order: ' + url).toMatch(/bbox=77\.71,12\.94,77\.72,12\.95/);
  // convertScript: runnable bash, netconvert auto-detect, geometry/tls flags
  const sh = convertScript([12.94, 77.71, 12.95, 77.72], 'test-area');
  expect(sh, 'shebang').toMatch(/^#!\/bin\/bash/);
  expect(sh, 'netconvert detection').toMatch(/SUMO_HOME\/bin\/netconvert|EclipseSUMO/);
  expect(sh, 'osm input flag').toMatch(/--osm-files/);
  expect(/12\.94/.test(sh) && /77\.72/.test(sh), 'bbox embedded').toBe(true);
  expect(sh, 'safe area name').toMatch(/test-area\.osm\.xml/);
  const shBad = convertScript([1, 2, 3, 4], 'a b; c$(d)');
  expect(/a-b-c-d-/.test(shBad) || !/[;$`]/.test(shBad.split('\n')[4] || ''),
    'name sanitised').toBe(true);
});

// test_mock.py 12 -------------------------------------------------------------
it('min scale keeps road visible', () => {
  const pxPerMetre = placementScale(12.9517, 10);
  expect(3.0 * pxPerMetre,
    `at zoom 10 a 3.0 m lane draws ${(3.0 * pxPerMetre).toFixed(2)}px `
    + '(must stay > 4px via the LATM min-scale clamp)').toBeGreaterThan(4);
  const hi = placementScale(12.9517, 18);
  expect(hi, 'scale must not shrink when zooming in').toBeGreaterThanOrEqual(pxPerMetre);
});
