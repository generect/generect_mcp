import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitAllow, _resetRateLimiter } from '../src/auth/ratelimit.ts';

test('allows up to max within the window, then blocks', () => {
  _resetRateLimiter();
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) {
    assert.equal(rateLimitAllow('k', 3, 1000, now), true, `hit ${i + 1} allowed`);
  }
  assert.equal(rateLimitAllow('k', 3, 1000, now), false, '4th hit blocked');
});

test('window slides: old hits expire and quota frees up', () => {
  _resetRateLimiter();
  assert.equal(rateLimitAllow('k', 2, 1000, 0), true);
  assert.equal(rateLimitAllow('k', 2, 1000, 500), true);
  assert.equal(rateLimitAllow('k', 2, 1000, 900), false, 'over quota inside window');
  // At t=1600 the hit at t=0 has aged out (>1000ms), t=500 remains → one slot free.
  assert.equal(rateLimitAllow('k', 2, 1000, 1600), true);
});

test('keys are independent', () => {
  _resetRateLimiter();
  assert.equal(rateLimitAllow('a', 1, 1000, 0), true);
  assert.equal(rateLimitAllow('a', 1, 1000, 0), false);
  assert.equal(rateLimitAllow('b', 1, 1000, 0), true, 'different key has its own quota');
});

test('max=0 blocks everything', () => {
  _resetRateLimiter();
  assert.equal(rateLimitAllow('k', 0, 1000, 0), false);
});
