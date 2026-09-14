/* authorFromProfile — the one source of truth for the author identity
 * (plan: Firebase Google sign-in). Used by BOTH the client store (the
 * draft.username pre-fill and the local publish author) and the server
 * (verified token claims -> catalog + DB author, spoof-proof: the request
 * body author field is ignored). Pure, firebase-free, DOM-free — it lives
 * in src/lib, so test/lib-purity.test.js keeps enforcing that layer.
 *
 * Contract (plan decision, settled): displayName (trimmed) -> email prefix
 * (everything before the first '@') -> uid, falling through on empty or
 * whitespace-only values; empty string — never undefined — when nothing is
 * usable.
 */
import { it, expect } from 'vitest';
import { authorFromProfile } from '../src/lib/profile.js';

it('displayName wins and is trimmed', () => {
  expect(authorFromProfile({
    displayName: '  Ada Lovelace  ', email: 'ada@x.test', uid: 'u-ada',
  })).toBe('Ada Lovelace');
});

it('whitespace-only displayName falls through to the email prefix', () => {
  expect(authorFromProfile({
    displayName: '   ', email: 'grace.hopper@x.test', uid: 'u-grace',
  })).toBe('grace.hopper');
});

it('accepts the firebase-admin claim shape (name, not displayName)', () => {
  expect(authorFromProfile({
    name: 'QA User', email: 'qa@x.test', uid: 'qa',
  })).toBe('QA User');
});

it('missing displayName falls through to the email prefix', () => {
  expect(authorFromProfile({ email: 'edsger@dijkstra.test', uid: 'u-ewd' }))
    .toBe('edsger');
});

it('no displayName and no email falls through to the uid', () => {
  expect(authorFromProfile({ uid: 'uid-42' })).toBe('uid-42');
  expect(authorFromProfile({ displayName: '', email: '', uid: 'uid-42' }))
    .toBe('uid-42');
});

it('nothing usable -> empty string (never undefined)', () => {
  expect(authorFromProfile({})).toBe('');
  expect(authorFromProfile(null)).toBe('');
  expect(authorFromProfile(undefined)).toBe('');
});
