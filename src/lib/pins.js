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

/* Ids of the pins sitting within `radiusPx` (container px, inclusive) of
 * the queried pin, nearest first, excluding the queried id itself. Points
 * is a Map of id -> [x, y] (container points); malformed points are
 * skipped, a non-positive radius yields []. Feeds spreadOverlaps'
 * adjacency: pins closer than the radius are laid out as a vertical list
 * instead of stacking invisibly. */
export function pinNeighbors(id, points, radiusPx) {
  if (!(radiusPx > 0) || !points || typeof points.get !== 'function') {
    return [];
  }
  const me = points.get(id);
  if (!Array.isArray(me) || me.length !== 2
      || !me.every(Number.isFinite)) {
    return [];
  }
  const near = [];
  for (const [other, pt] of points) {
    if (other === id || !Array.isArray(pt) || pt.length !== 2
        || !pt.every(Number.isFinite)) continue;
    const dx = pt[0] - me[0], dy = pt[1] - me[1];
    const d = Math.hypot(dx, dy);
    if (d <= radiusPx) near.push([other, d]);
  }
  near.sort((a, b) => a[1] - b[1]);
  return near.map(([other]) => other);
}

/* Display positions for the ActivePins layer: pins whose points sit
 * within `radiusPx` of each other are re-laid as vertical columns
 * (`spacingPx` apart, centred on the cluster's mean point) so every
 * marker stays visible and individually clickable instead of stacking.
 * Isolated pins keep their exact point, so they return to their anchors
 * once zoom separates them. Cluster members are ordered by (y, x, then
 * insertion order). The layout iterates to a fixpoint — re-clustering
 * merged chains and colliding columns — so no two returned positions
 * remain within the radius. spacingPx must EXCEED radiusPx (inclusive
 * adjacency), otherwise pins can never be separated. Pure: returns a new
 * Map, never mutates the input; malformed points pass through unchanged. */
export function spreadOverlaps(points, radiusPx, spacingPx) {
  const copy = new Map();
  if (!points || typeof points.forEach !== 'function') return copy;
  points.forEach((pt, id) => copy.set(id, pt));
  if (!(radiusPx > 0) || !(spacingPx > radiusPx)) return copy;

  const ids = [...copy.keys()];
  const ok = (id) => {
    const pt = copy.get(id);
    return Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite);
  };
  for (;;) {
    /* adjacency over the CURRENT positions (the tested helper skips
     * malformed points on both ends); union-find clusters the graph */
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));   // halve
        x = parent.get(x);                          // advance
      }
      return x;
    };
    let clustered = false;
    for (const id of ids) {
      if (!ok(id)) continue;
      for (const other of pinNeighbors(id, copy, radiusPx)) {
        if (find(id) !== find(other)) {
          parent.set(find(id), find(other));
          clustered = true;
        }
      }
    }
    if (!clustered) break;
    /* re-lay each multi-member cluster as a vertical column centred on
     * its mean point; singletons keep their position untouched */
    const members = new Map();
    for (const id of ids) {
      if (!ok(id)) continue;
      const root = find(id);
      if (!members.has(root)) members.set(root, []);
      members.get(root).push(id);
    }
    members.forEach((group) => {
      if (group.length < 2) return;
      group.sort((a, b) => {
        const pa = copy.get(a), pb = copy.get(b);
        return pa[1] - pb[1] || pa[0] - pb[0]
          || ids.indexOf(a) - ids.indexOf(b);
      });
      const cx = group.reduce((s, id) => s + copy.get(id)[0], 0)
        / group.length;
      const cy = group.reduce((s, id) => s + copy.get(id)[1], 0)
        / group.length;
      group.forEach((id, i) => {
        copy.set(id, [cx, cy + (i - (group.length - 1) / 2) * spacingPx]);
      });
    });
  }
  return copy;
}
