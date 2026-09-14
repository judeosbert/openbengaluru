/* Adapter over the classic-script data bundle public/data.js (generated
 * externally by sim/build_player.py --export-mock — do not edit).
 *
 * Load order contract: index.html loads /data.js as a classic script BEFORE
 * the module entry; classic scripts block while module scripts are deferred,
 * so the bundle has executed by the time this module evaluates. Its
 * top-level `const NAME` bindings live in the global declarative record and
 * are readable here by bare identifier — they are NOT globalThis properties,
 * so the locals are read under aliased names (a bare `CATALOG` in this
 * module would hit the export binding's TDZ). If the app ever inlines data,
 * delete this adapter and import JSON directly. */

const CATALOG_ = typeof CATALOG !== 'undefined' ? CATALOG : undefined;
const OTHER_SIMS_ = typeof OTHER_SIMS !== 'undefined' ? OTHER_SIMS : undefined;
const BALAGERE_GEOMETRY_ = typeof BALAGERE_GEOMETRY !== 'undefined'
  ? BALAGERE_GEOMETRY : undefined;
const LANES_PALETTE_ = typeof LANES_PALETTE !== 'undefined'
  ? LANES_PALETTE : undefined;
const BALAGERE_CSS_STYLE_ = typeof BALAGERE_CSS_STYLE !== 'undefined'
  ? BALAGERE_CSS_STYLE : undefined;

export {
  CATALOG_ as CATALOG,
  OTHER_SIMS_ as OTHER_SIMS,
  BALAGERE_GEOMETRY_ as BALAGERE_GEOMETRY,
  LANES_PALETTE_ as LANES_PALETTE,
  BALAGERE_CSS_STYLE_ as BALAGERE_CSS_STYLE,
};
