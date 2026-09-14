/* Port of test_app.js test 20 (export helpers) + test_mock.py test 12
 * (placementScale min-scale clamp). Plan: area export + worker pool,
 * phase 2 — osmApiUrl stays (server-side consumer now), convertScript is
 * DELETED (server-side netconvert replaced it), validateBbox +
 * sanitizeAreaName are the new pure head the endpoint uses. */
import { describe, it, expect } from 'vitest';
import { osmApiUrl, validateBbox, sanitizeAreaName }
  from '../src/lib/areaExport.js';
import { placementScale } from '../src/lib/geo.js';

// test_app.js 20 (osmApiUrl half) ---------------------------------------------
it('export helpers', () => {
  // osmApiUrl: bbox [minLat,minLng,maxLat,maxLng] -> OSM bbox=minLng,minLat,maxLng,maxLat
  const url = osmApiUrl([12.94, 77.71, 12.95, 77.72]);
  expect(url).toMatch(/openstreetmap\.org\/api\/0\.6\/map\?bbox=/);
  expect(url, 'lng/lat order: ' + url).toMatch(/bbox=77\.71,12\.94,77\.72,12\.95/);
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

// ------------------------------------------------------------- validateBbox
describe('validateBbox', () => {
  it('accepts a well-formed box within the OSM cap', () => {
    expect(validateBbox([12.94, 77.71, 12.95, 77.72])).toBeNull();
    expect(validateBbox([12.9, 77.7, 13.15, 77.95])).toBeNull();  // exactly 0.25°/side
  });

  it('rejects wrong shapes', () => {
    expect(validateBbox(null)).toBeTruthy();
    expect(validateBbox('bbox')).toBeTruthy();
    expect(validateBbox([1, 2, 3])).toBeTruthy();
    expect(validateBbox([1, 2, 3, 4, 5])).toBeTruthy();
  });

  it('rejects non-numeric entries', () => {
    expect(validateBbox(['12.94', '77.71', '12.95', '77.72'])).toBeTruthy();
    expect(validateBbox([12.94, NaN, 12.95, 77.72])).toBeTruthy();
    expect(validateBbox([12.94, 77.71, 12.95, Infinity])).toBeTruthy();
  });

  it('rejects out-of-range coordinates', () => {
    expect(validateBbox([91, 77.71, 92, 77.72])).toBeTruthy();    // lat > 90
    expect(validateBbox([-91, 77.71, -90.5, 77.72])).toBeTruthy(); // lat < -90
    expect(validateBbox([12.94, 181, 12.95, 182])).toBeTruthy();  // lng > 180
    expect(validateBbox([12.94, -181, 12.95, -180.5])).toBeTruthy();
  });

  it('rejects inverted axes (min >= max)', () => {
    expect(validateBbox([12.95, 77.71, 12.94, 77.72])).toBeTruthy();
    expect(validateBbox([12.94, 77.72, 12.95, 77.71])).toBeTruthy();
    expect(validateBbox([12.94, 77.71, 12.94, 77.72])).toBeTruthy(); // equal
  });

  it('rejects sides over the OSM /map 0.25° hard cap', () => {
    expect(validateBbox([12.9, 77.7, 13.2, 77.75])).toMatch(/0\.25/);
    expect(validateBbox([12.9, 77.7, 12.95, 78.0])).toMatch(/0\.25/);
  });
});

// --------------------------------------------------------- sanitizeAreaName
describe('sanitizeAreaName', () => {
  it('slugs every non [a-z0-9-] run to a dash (the convert.sh regex)', () => {
    expect(sanitizeAreaName('test-area')).toBe('test-area');
    expect(sanitizeAreaName('a b; c$(d)')).toBe('a-b-c-d-');
    /* the locked regex is lowercase-only — uppercase is OUTSIDE
     * [a-z0-9-] and slugs to a dash, faithful to convert.sh */
    expect(sanitizeAreaName('My Area!')).toBe('-y-rea-');
  });

  it('defaults empty/missing names to "area"', () => {
    expect(sanitizeAreaName()).toBe('area');
    expect(sanitizeAreaName('')).toBe('area');
    expect(sanitizeAreaName(null)).toBe('area');
  });
});
