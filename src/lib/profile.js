/* Author identity from a verified profile — the ONE source of truth, used
 * by the client store (draft.username pre-fill + local publish author) and
 * by the server (verified token claims -> catalog/DB author; the request
 * body's author field is ignored). Pure, firebase-free, DOM-free — lives in
 * src/lib so test/lib-purity.test.js keeps enforcing that layer.
 *
 * Precedence (settled): displayName (trimmed) -> email prefix (before the
 * first '@') -> uid. Empty/whitespace values fall through; nothing usable
 * resolves to '' — never undefined. Both profile shapes are accepted:
 * the Firebase web user (displayName) and the firebase-admin
 * DecodedIdToken (name).
 */
export function authorFromProfile(p) {
  const rawName = p && typeof p.displayName === 'string'
    ? p.displayName
    : p && typeof p.name === 'string' ? p.name : '';
  const d = rawName.trim();
  if (d) return d;
  const e = p && typeof p.email === 'string' ? p.email : '';
  const prefix = e.split('@')[0].trim();
  if (prefix) return prefix;
  return p && typeof p.uid === 'string' ? p.uid.trim() : '';
}
