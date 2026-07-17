import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, importJWK } from 'jose';
import { clearAuthEnv, VALID_TOKEN_KEY } from './helpers.ts';

let caseId = 0;
async function freshJwt() {
  return import(`../src/auth/jwt.ts?tcase=${caseId++}`);
}

function decodePayload(token: string): any {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

const BASE = 'https://mcp.example.test';
function baseEnv() {
  clearAuthEnv();
  process.env.NODE_ENV = 'production';
  process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
  process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
  process.env.OAUTH_BASE_URL = BASE;
}

test('access token carries an exp ~ iat + TTL', async () => {
  baseEnv();
  process.env.ACCESS_TOKEN_TTL_SECONDS = '3600';
  const jwt = await freshJwt();
  const token = await jwt.generateAccessToken('Token k', 'u', 'c');
  const p = decodePayload(token);
  assert.equal(typeof p.exp, 'number', 'exp claim present');
  assert.equal(typeof p.iat, 'number', 'iat present');
  assert.ok(Math.abs(p.exp - p.iat - 3600) <= 1, `exp-iat ≈ TTL (got ${p.exp - p.iat})`);
  assert.equal(typeof p.jti, 'string', 'jti present');
  assert.equal(jwt.ACCESS_TOKEN_TTL_SECONDS, 3600);
});

test('an expired access token is rejected by verify', async () => {
  baseEnv();
  process.env.ACCESS_TOKEN_TTL_SECONDS = '-10'; // exp already in the past at mint
  const jwt = await freshJwt();
  const token = await jwt.generateAccessToken('Token k', 'u', 'c');
  assert.equal(await jwt.verifyAccessToken(token), null, 'expired token must not verify');
});

test('backward compatible: a legacy token WITHOUT exp still verifies (grandfathered)', async () => {
  baseEnv();
  process.env.ACCESS_TOKEN_TTL_SECONDS = '3600';
  const jwt = await freshJwt();

  // Craft a token exactly as the pre-0.4 server did: no exp, same key/iss/aud.
  const key = await importJWK(
    { k: Buffer.from(process.env.JWT_SIGNING_KEY as string).toString('base64url'), kty: 'oct', alg: 'HS256' },
    'HS256',
  );
  const legacy = await new SignJWT({ sub: 'u', scope: 'generect:api', gtx: 'anything', client_id: 'c' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(BASE)
    .setAudience(`${BASE}/mcp`)
    .sign(key);

  const payload = await jwt.verifyAccessToken(legacy);
  assert.ok(payload, 'legacy no-exp token must still verify (no forced breakage)');
  assert.equal(payload.sub, 'u');
});

test('a token signed with the wrong key is rejected', async () => {
  baseEnv();
  const jwt = await freshJwt();
  const wrongKey = await importJWK(
    { k: Buffer.from('some-other-secret').toString('base64url'), kty: 'oct', alg: 'HS256' },
    'HS256',
  );
  const forged = await new SignJWT({ sub: 'u', scope: 'generect:api', gtx: 'x' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(BASE)
    .setAudience(`${BASE}/mcp`)
    .sign(wrongKey);
  assert.equal(await jwt.verifyAccessToken(forged), null, 'wrong-key token must not verify');
});
