/* Two-source catalog merge (plan: review flow + dashboards). The client
 * catalog starts as the read-only base bundle (src/data.js CATALOG) and is
 * merged at boot with the server's active submissions (GET /api/catalog):
 * replace-by-id, API wins wholesale (no field-level merging — the DB row's
 * entry_json is the authoritative shape for that id), and every API entry
 * is stamped `apiStream: true` so the lazy-stream loader fetches it from
 * /api/catalog/:id/stream instead of the JSONP base streams.
 *
 * Pure + DOM-free (src/lib) so the node test harness runs it directly.
 * Returns a NEW array; never mutates the inputs. */
export function mergeApiEntries(base, apiEntries) {
  const list = Array.isArray(apiEntries) ? apiEntries : [];
  const byId = new Map();
  for (const e of list) {
    if (e && typeof e.id === 'string' && e.id) {
      byId.set(e.id, { ...e, apiStream: true });
    }
  }
  const out = [];
  for (const e of Array.isArray(base) ? base : []) {
    if (e && byId.has(e.id)) continue;      // API wins wholesale
    out.push(e);
  }
  for (const e of byId.values()) out.push(e);
  return out;
}