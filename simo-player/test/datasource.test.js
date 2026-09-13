/* Data-source provenance contract: the mandatory wizard field
 * (Manual survey / Survey data / Approximation — an http(s) source URL is
 * required for the survey options) end-to-end. This suite locks the
 * server-side body validation (validateBody, exported from server.js);
 * the wizard/review wiring pins live in submit.test.js, the entry_json
 * ride-along in tools.test.js, the DB columns in db_uploads.test.js, and
 * the real-SUMO pipeline proof in endpoint.test.js. */
import { describe, it, expect } from 'vitest';
import { validateBody } from '../server.js';

function body(over = {}) {
  return {
    id: 'ds-body', title: 'DS body', rouXml: '<routes/>',
    todayNetXml: '<net/>', dataSource: 'survey_data',
    sourceUrl: 'https://example.test/counts', ...over,
  };
}

describe('validateBody: data source', () => {
  it('accepts survey+url, approximation without url, legacy anchor/rotation optional', () => {
    expect(validateBody(body())).toBeNull();
    expect(validateBody(body({ dataSource: 'manual_survey',
      sourceUrl: 'http://localhost:3000/sheet' }))).toBeNull();
    expect(validateBody(body({ dataSource: 'approximation',
      sourceUrl: undefined }))).toBeNull();
    expect(validateBody(body({ dataSource: 'approximation',
      sourceUrl: '' }))).toBeNull();
    expect(validateBody(body({ anchor: [12.9, 77.7], rotation: 5 })))
      .toBeNull();
  });

  it('dataSource is required and enumerated', () => {
    const { dataSource, ...without } = body();
    expect(validateBody({ ...without, dataSource: undefined }))
      .toMatch(/dataSource/);
    expect(validateBody(body({ dataSource: 'vibes' }))).toMatch(/dataSource/);
    expect(validateBody(body({ dataSource: 42 }))).toMatch(/dataSource/);
  });

  it('survey options require an http(s) sourceUrl', () => {
    expect(validateBody(body({ sourceUrl: undefined }))).toMatch(/sourceUrl/);
    expect(validateBody(body({ sourceUrl: '' }))).toMatch(/sourceUrl/);
    expect(validateBody(body({ sourceUrl: 'ftp://example.test/x' })))
      .toMatch(/sourceUrl/);
    expect(validateBody(body({ sourceUrl: 'example.test/counts' })))
      .toMatch(/sourceUrl/);
    expect(validateBody(body({ sourceUrl: 42 }))).toMatch(/sourceUrl/);
  });

  it('approximation must not carry a source url', () => {
    expect(validateBody(body({ dataSource: 'approximation',
      sourceUrl: 'https://example.test/counts' }))).toMatch(/sourceUrl/);
  });
});
