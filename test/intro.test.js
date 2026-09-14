/* Intro gate, once per user lifecycle — Phase 1 contract for the PURE head.
 *
 * Behavior being built (user request):
 *   the landing concept becomes the site's intro page, shown ONCE per user
 *   lifecycle. A localStorage flag marks "intro seen"; it is set ONLY when
 *   the visitor clicks the intro CTA (the split reveal), never on plain
 *   visits. Repeat visits skip the intro entirely.
 *
 * src/lib/intro.js is the pure head: storage is a {getItem,setItem} seam
 * parameter — src/lib must never touch a DOM global (lib-purity.test.js
 * bans the bare words document/window/localStorage), so the component wires
 * window.localStorage through the seam (pinned in test/intro-ui.test.js).
 * In the vitest node environment the seam is an in-memory fake — that IS the
 * real contract boundary; there is no DOM storage to test against here.
 */
import { describe, it, expect } from 'vitest';
import {
  INTRO_SEEN_KEY, hasSeenIntro, markIntroSeen,
} from '../src/lib/intro.js';

function fakeStorage(map = new Map()) {
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

describe('intro seen-flag (pure storage seam)', () => {
  it('uses a namespaced lifecycle key', () => {
    expect(INTRO_SEEN_KEY).toBe('ob_intro_seen_v1');
  });

  it('hasSeenIntro: false before the CTA is ever clicked', () => {
    expect(hasSeenIntro(fakeStorage())).toBe(false);
  });

  it('hasSeenIntro: true once the flag is set', () => {
    const storage = fakeStorage(new Map([[INTRO_SEEN_KEY, '1']]));
    expect(hasSeenIntro(storage)).toBe(true);
  });

  it('hasSeenIntro: empty-string value counts as not seen', () => {
    const storage = fakeStorage(new Map([[INTRO_SEEN_KEY, '']]));
    expect(hasSeenIntro(storage)).toBe(false);
  });

  it('hasSeenIntro: a throwing storage reads as not seen (no crash)', () => {
    expect(hasSeenIntro({
      getItem: () => { throw new Error('blocked'); },
    })).toBe(false);
  });

  it('hasSeenIntro: missing storage is treated as not seen, not a crash', () => {
    expect(hasSeenIntro(null)).toBe(false);
    expect(hasSeenIntro(undefined)).toBe(false);
  });

  it('markIntroSeen writes the lifecycle key with a truthy value', () => {
    const map = new Map();
    const calls = [];
    const storage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { calls.push([k, v]); map.set(k, String(v)); },
    };
    markIntroSeen(storage);
    expect(calls).toEqual([[INTRO_SEEN_KEY, '1']]);
    expect(hasSeenIntro(storage)).toBe(true);
  });

  it('markIntroSeen: a throwing storage must never crash the CTA', () => {
    expect(() => markIntroSeen({
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    })).not.toThrow();
  });

  it('round trip through a Map-backed storage', () => {
    const storage = fakeStorage();
    expect(hasSeenIntro(storage)).toBe(false);
    markIntroSeen(storage);
    expect(hasSeenIntro(storage)).toBe(true);
  });
});
