/* Shared upload-ingest helper (plan: review flow + dashboards). ONE pure
 * core for the two callers that turn stored file text into draft-slot
 * records:
 *   - SubmitFlow's FileReader addSlot path (browser upload), and
 *   - startResubmit's prefill (re-downloaded XMLs from /api/files).
 * DOM-free (src/lib): the DOM FileReader stays in SubmitFlow; this module
 * only classifies + parses.
 *
 * ingestSlot(slot, name, text) where slot ∈ 'demand' | 'today' |
 * 'proposed' -> {
 *   fileRecord: { name, size, kind, text } | null,
 *   demandCount?: number,     // demand slot only (0 = parsed 0 elements)
 *   geo?: parseNetXml result | null,   // net slots only (null = 0 lanes)
 *   reject: string | null,             // slot-mismatch message for the UI
 * }
 */
import { classifyUploadFile, parseDemandCount, parseNetXml } from './netxml.js';

export function ingestSlot(slot, name, text) {
  const t = typeof text === 'string' ? text : '';
  const c = classifyUploadFile(name, t.length);
  const want = slot === 'demand' ? 'routes' : 'network';
  const ext = slot === 'demand' ? '.rou.xml' : '.net.xml';
  if (!c || c.kind !== want) {
    return {
      fileRecord: null,
      reject: 'DEMAND/TODAY NET/PROPOSED NET slot "' + String(slot)
        .toUpperCase() + '": ' + name + ' — needs a ' + ext + ' file',
    };
  }
  const fileRecord = { ...c, text: t };
  if (slot === 'demand') {
    return { fileRecord, demandCount: parseDemandCount(t), reject: null };
  }
  return { fileRecord, geo: parseNetXml(t), reject: null };
}