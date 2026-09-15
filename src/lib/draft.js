/* Draft id helpers for the server-submit flow: the title slug and the
 * catalog id for a new submission. The POST body carries this id so the
 * persisted entry matches it (and a resubmission re-pins the same id).
 * The old local publish path (a fabricated geometry-only catalog entry)
 * is gone — submissions run the real SUMO pipeline on the player server
 * and entries only arrive through GET /api/catalog. */

export function slugTitle(title) {
  const s = String(title == null ? '' : title).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'sim';
}

/* Catalog id for a new entry: slug + base36 timestamp. */
export function entryIdFor(title) {
  return slugTitle(title) + '-' + Date.now().toString(36);
}
