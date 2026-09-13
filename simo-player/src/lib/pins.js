/* Active-pin selection + progressive batch scheduling for the map's
 * ActivePins layer. Pure + DOM-free (src/lib): only review-flow ACTIVE
 * entries (apiStream-stamped by the boot merge of GET /api/catalog) are
 * pinned — the preloaded base-bundle entries stay marker-free. */

export function pinEntries(catalog) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((e) => e && typeof e === 'object' && e.apiStream
      && Array.isArray(e.anchor) && e.anchor.length === 2
      && e.anchor.every(Number.isFinite));
}

/* Indices 0..n-1 chunked into batches of `size`; the last batch takes the
 * remainder. The ActivePins layer schedules one timer per batch so a large
 * catalog never blocks the first paint. */
export function batches(n, size) {
  const out = [];
  for (let i = 0; i < n; i += size) {
    out.push(Array.from({ length: Math.min(size, n - i) }, (_, k) => i + k));
  }
  return out;
}
