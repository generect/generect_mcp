import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearAuthEnv, VALID_TOKEN_KEY, INSECURE_DEFAULT_KEY } from './helpers.ts';

// jwt.ts caches the signing key at module scope, so each scenario imports a fresh
// copy (cache-busting query) after the environment is set up.
let caseId = 0;
async function freshJwt() {
  return import(`../src/auth/jwt.ts?case=${caseId++}`);
}

test('HS256: sign -> verify round-trips and carries the encrypted api token', async () => {
  clearAuthEnv();
  process.env.NODE_ENV = 'production';
  process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
  process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
  process.env.OAUTH_BASE_URL = 'https://mcp.example.test';

  const jwt = await freshJwt();
  const token = await jwt.generateAccessToken('Token real-api-key', 'user-1', 'client-1');
  const payload = await jwt.verifyAccessToken(token);

  assert.ok(payload, 'payload should verify');
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.scope, 'generect:api');
  assert.equal(payload.client_id, 'client-1');
  assert.equal(jwt.extractApiToken(payload), 'Token real-api-key');
});

test('verify rejects garbage tokens (returns null, never throws)', async () => {
  clearAuthEnv();
  process.env.NODE_ENV = 'production';
  process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
  const jwt = await freshJwt();
  assert.equal(await jwt.verifyAccessToken('not.a.jwt'), null);
  assert.equal(await jwt.verifyAccessToken(''), null);
});

test('verify enforces issuer/audience (token from a different base url fails)', async () => {
  clearAuthEnv();
  process.env.NODE_ENV = 'production';
  process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
  process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
  process.env.OAUTH_BASE_URL = 'https://issuer-a.test';

  const jwt = await freshJwt();
  const token = await jwt.generateAccessToken('Token k', 'user-2');
  // Same signing key, but the expected issuer/audience now differ.
  process.env.OAUTH_BASE_URL = 'https://issuer-b.test';
  assert.equal(await jwt.verifyAccessToken(token), null);
});

test('fail closed: production without JWT_SIGNING_KEY refuses to sign', async () => {
  clearAuthEnv();
  process.env.NODE_ENV = 'production';
  const jwt = await freshJwt();
  await assert.rejects(
    () => jwt.generateAccessToken('Token k', 'user-3'),
    /must be set to a strong, non-default value/,
  );
});

test('fail closed: production with the hardcoded default key refuses to sign', async () => {
  clearAuthEnv();
  process.env.NODE_ENV = 'production';
  process.env.JWT_SIGNING_KEY = INSECURE_DEFAULT_KEY;
  const jwt = await freshJwt();
  await assert.rejects(() => jwt.generateAccessToken('Token k', 'user-4'), /must be set to/);
});

test('published JWKS never contains key material (no `k`)', async () => {
  clearAuthEnv();
  process.env.NODE_ENV = 'production';
  process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
  const jwt = await freshJwt();
  const jwk = await jwt.getPublicKeyJwk();
  assert.equal(jwk.kty, 'oct');
  assert.equal(jwk.k, undefined, 'symmetric key material must never be published');
});

test('dev fallback: non-production without a signing key still issues verifiable tokens', async () => {
  clearAuthEnv();
  process.env.NODE_ENV = 'test';
  process.env.OAUTH_BASE_URL = 'https://dev.test';
  const jwt = await freshJwt();
  const token = await jwt.generateAccessToken('Token dev', 'user-5');
  const payload = await jwt.verifyAccessToken(token);
  assert.ok(payload);
  assert.equal(payload.sub, 'user-5');
});
