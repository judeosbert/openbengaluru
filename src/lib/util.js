/* ============================================================================
 * SIMO — Bengaluru traffic lab. Ported from simo-player/app.js pure head
 * (everything above the retired //__PURE_END__ marker) as importable ES
 * modules. src/lib stays JSX-free, DOM-free, react/leaflet-free — enforced
 * by test/lib-purity.test.js.
 * ==========================================================================*/

/* ---------------------------------------------------------------- helpers */

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const n = bin.length;
  const u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function hashStr(s) {
  let h = 5381;
  s = String(s);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}
