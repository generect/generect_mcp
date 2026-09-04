import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toApiKey, toAuthHeader } from '../src/auth/credential.js';

// The bug this file exists for, measured on production 2026-09-02: an OAuth
// access token carried `Token <key>` inside its `gtx` claim, the tool layer
// added its own prefix, and every data call went out as
// `Authorization: Token Token <key>`. Django answered 401 "Authentication
// credentials were not provided" — the header was there, so the failure looked
// like a bad key rather than a malformed header. Nothing caught it because no
// test ever built the outbound header from a stored credential.

test('toApiKey returns the bare key from either shape', () => {
  assert.equal(toApiKey('abc123'), 'abc123');
  assert.equal(toApiKey('Token abc123'), 'abc123');
  assert.equal(toApiKey('  Token   abc123  '), 'abc123');
});

test('toApiKey tolerates the case the scheme name is written in', () => {
  // RFC 9110 §11.1 — the scheme is case-insensitive, and hand-written client
  // configs use both spellings.
  assert.equal(toApiKey('token abc123'), 'abc123');
  assert.equal(toApiKey('TOKEN abc123'), 'abc123');
});

test('toApiKey is empty for empty input', () => {
  assert.equal(toApiKey(''), '');
  assert.equal(toApiKey('   '), '');
  assert.equal(toApiKey(undefined), '');
  assert.equal(toApiKey(null), '');
});

test('toAuthHeader prefixes exactly once, whichever shape came in', () => {
  assert.equal(toAuthHeader('abc123'), 'Token abc123');
  assert.equal(toAuthHeader('Token abc123'), 'Token abc123');
});

test('toAuthHeader is idempotent — this is the regression', () => {
  // The production failure was a second application of the prefix.
  assert.equal(toAuthHeader(toAuthHeader('abc123')), 'Token abc123');
  assert.equal(toAuthHeader(toAuthHeader(toAuthHeader('abc123'))), 'Token abc123');
  assert.notEqual(toAuthHeader(toAuthHeader('abc123')), 'Token Token abc123');
});

test('toAuthHeader stays empty rather than emitting a bare scheme', () => {
  // `Authorization: Token ` with nothing after it is what Django reports as
  // "credentials were not provided". Better to send no header at all.
  assert.equal(toAuthHeader(''), '');
  assert.equal(toAuthHeader(undefined), '');
  assert.equal(toAuthHeader('Token '), '');
  assert.equal(toAuthHeader('   '), '');
});

test('round trip through storage and back out is stable', () => {
  // What the OAuth layer stores, what the JWT carries, what the tool layer
  // sends — the shape has to survive all three without accumulating prefixes.
  const fromConsentPage = 'Token 3243cc711d0e4f8a9b';
  const stored = toApiKey(fromConsentPage);
  assert.equal(stored, '3243cc711d0e4f8a9b');
  assert.equal(toAuthHeader(stored), 'Token 3243cc711d0e4f8a9b');
  // And a token minted BEFORE the fix, whose gtx still holds the prefixed form.
  const legacyGtx = 'Token 3243cc711d0e4f8a9b';
  assert.equal(toAuthHeader(legacyGtx), 'Token 3243cc711d0e4f8a9b');
});

// ── integration: mint like OAuth does, then build the header like tools do ──
//
// `jwt.test.ts` already asserts that `extractApiToken` round-trips whatever was
// put in. That is true and was never the problem: the gap was that no test ever
// took a minted token and produced the `Authorization` value from it. This one
// does, so the double prefix cannot come back unnoticed.

import { clearAuthEnv, VALID_TOKEN_KEY } from './helpers.ts';

let caseId = 1000;
async function freshJwt() {
  return import(`../src/auth/jwt.ts?cred=${caseId++}`);
}

async function withJwtEnv<T>(fn: (jwt: any) => Promise<T>): Promise<T> {
  clearAuthEnv();
  process.env.NODE_ENV = 'production';
  process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
  process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
  process.env.OAUTH_BASE_URL = 'https://mcp.example.test';
  return fn(await freshJwt());
}

test('outbound header from a token minted the way OAuth mints it', async () => {
  await withJwtEnv(async jwt => {
    // What the OAuth layer stores from now on: the bare key.
    const minted = await jwt.generateAccessToken('real-api-key', 'user-1', 'client-1');
    const payload = await jwt.verifyAccessToken(minted);
    assert.ok(payload);
    assert.equal(toAuthHeader(jwt.extractApiToken(payload)), 'Token real-api-key');
  });
});

test('outbound header from a token minted BEFORE the fix still works', async () => {
  await withJwtEnv(async jwt => {
    // Access tokens live 30 days. Every one issued before this change carries
    // the prefixed form inside `gtx`; they must not need a reconnect, and they
    // must not produce `Token Token real-api-key`.
    const legacy = await jwt.generateAccessToken('Token real-api-key', 'user-1', 'client-1');
    const payload = await jwt.verifyAccessToken(legacy);
    assert.ok(payload);
    const header = toAuthHeader(jwt.extractApiToken(payload));
    assert.equal(header, 'Token real-api-key');
    assert.equal(header.split('Token').length - 1, 1, 'exactly one scheme name');
  });
});

test('a value that is only the scheme name is treated as no credential', () => {
  // Found by the test above: `'Token '` trims to `'Token'`, which a
  // startsWith('Token ') check no longer recognises as a prefix — it came back
  // out as the key `Token` and re-prefixed to `Token Token`.
  for (const v of ['Token', 'token', 'TOKEN', 'Token ', ' token  ']) {
    assert.equal(toApiKey(v), '', `toApiKey(${JSON.stringify(v)})`);
    assert.equal(toAuthHeader(v), '', `toAuthHeader(${JSON.stringify(v)})`);
  }
});
