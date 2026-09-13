/* Server-submit contract for the wizard (plan: real SUMO simulation for
 * wizard-submitted entries). DOM-free: imported by the store glue, the
 * SubmitFlow UI, and server.js. Unit-tested in the node environment.
 *
 * POST /api/simulate body contract (server.js implements the endpoint):
 *   { id, title, author, desc,
 *     dataSource, sourceUrl?,                // mandatory data provenance
 *     rouXml, todayNetXml, proposedNetXml?,  // raw upload text
 *     anchor?, rotation }                    // legacy optional placement
 *                                            // (geo-locked nets derive
 *                                            // placement from the net)
 */

/* Mandatory data-provenance options for the wizard's DATA SOURCE field.
 * The survey options require an http(s) sourceUrl; Approximation carries
 * none. Shared by SubmitFlow (select + gating) and server validateBody. */
export const DATA_SOURCES = ['manual_survey', 'survey_data', 'approximation'];

export const DATA_SOURCE_LABELS = {
  manual_survey: 'Manual survey',
  survey_data: 'Survey data',
  approximation: 'Approximation',
};

/* http(s) URL guard for the source link (both ends use this exact rule). */
export function validSourceUrl(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
import { entryIdFor } from './draft.js';

/* Real simulations come from the player server; file:// keeps the
 * geometry-preview-only publish path. loc is injectable (location-like). */
export function serverAvailable(loc) {
  return !!loc && (loc.protocol === 'http:' || loc.protocol === 'https:');
}

/* Draft -> POST body. The entry id is the one approveDraft would generate,
 * so the reloaded page lands on the same id the server persisted. Raw file
 * text rides on the slot records (SubmitFlow keeps it from the FileReader). */
export function buildSimulateRequest(draft, id) {
  const d = draft || {};
  const files = d.files || {};
  const body = {
    id: id || entryIdFor(d.title),
    title: d.title || '',
    author: d.username || '',
    desc: d.desc || '',
    rouXml: (files.demand && files.demand.text) || '',
    todayNetXml: (files.today && files.today.text) || '',
    rotation: d.rotation || 0,
    dataSource: d.dataSource || '',
  };
  if (files.proposed) body.proposedNetXml = files.proposed.text || '';
  if (d.latlng) body.anchor = d.latlng;
  /* Approximation never carries a link (validateBody rejects one). */
  if (validSourceUrl(d.sourceUrl)) body.sourceUrl = d.sourceUrl;
  return body;
}
