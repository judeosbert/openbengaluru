/* Intro lifecycle flag — pure head of the once-per-lifecycle intro gate.
 *
 * The storage seam is a {getItem,setItem} pair: src/lib must stay DOM-free
 * (lib-purity.test.js bans the browser-global words outright), so the
 * IntroShell component passes the real browser storage through these calls.
 * Errors are swallowed on purpose: a blocked/quota store reads as "not seen"
 * and the flag write is skipped — storage must never crash the intro or the
 * CTA handler.
 */
export const INTRO_SEEN_KEY = 'ob_intro_seen_v1';

export function hasSeenIntro(storage) {
  if (!storage || typeof storage.getItem !== 'function') return false;
  try {
    return Boolean(storage.getItem(INTRO_SEEN_KEY));
  } catch (err) {
    return false;
  }
}

export function markIntroSeen(storage) {
  if (!storage || typeof storage.setItem !== 'function') return;
  try {
    storage.setItem(INTRO_SEEN_KEY, '1');
  } catch (err) { /* private mode / quota — the intro may re-show; fine */ }
}
