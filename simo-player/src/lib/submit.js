/* Server-submit contract for the wizard (plan: real SUMO simulation for
 * wizard-submitted entries). DOM-free: imported by the store glue and
 * unit-tested in the node environment.
 *
 * POST /api/simulate body contract (server.js implements the endpoint):
 *   { id, title, author, desc,
 *     rouXml, todayNetXml, proposedNetXml?,   // raw upload text
 *     anchor?, rotation }                     // wizard placement for
 *                                             // non-geo-locked nets
 */
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
  };
  if (files.proposed) body.proposedNetXml = files.proposed.text || '';
  if (d.latlng) body.anchor = d.latlng;
  return body;
}
