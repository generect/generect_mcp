import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encryptApiToken, decryptApiToken } from '../src/auth/crypto.ts';
import { clearAuthEnv, VALID_TOKEN_KEY, INSECURE_DEFAULT_KEY } from './helpers.ts';

beforeEach(() => clearAuthEnv());

test('direct key path: round-trips a token', () => {
  process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
  const token = 'Token abc123-secret';
  assert.equal(decryptApiToken(encryptApiToken(token)), token);
});

test('direct key path: round-trips empty, unicode and long values', () => {
  process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
  for (const v of ['', 'ключ-日本語-🔑', 'x'.repeat(10_000)]) {
    assert.equal(decryptApiToken(encryptApiToken(v)), v);
  }
});

test('two distinct ciphertexts of the same plaintext differ (random iv/salt)', () => {
  process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
  assert.notEqual(encryptApiToken('same'), encryptApiToken('same'));
});

test('derived path: works when only JWT_SIGNING_KEY is set (non-prod)', () => {
  process.env.NODE_ENV = 'development';
  process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
  const token = 'derived-path-token';
  assert.equal(decryptApiToken(encryptApiToken(token)), token);
});

test('fail closed: production + no secrets throws', () => {
  process.env.NODE_ENV = 'production';
  assert.throws(() => encryptApiToken('x'), /must be set to a strong, non-default value/);
});

test('fail closed: production + hardcoded default JWT key throws', () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SIGNING_KEY = INSECURE_DEFAULT_KEY;
  assert.throws(() => encryptApiToken('x'), /must be set to a strong, non-default value/);
});

test('fail loud: TOKEN_ENCRYPTION_KEY set but not 64-hex throws (no silent fallthrough)', () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
  for (const bad of ['nothex', 'ab'.repeat(16) /* 16 bytes */, 'zz'.repeat(32) /* non-hex */]) {
    process.env.TOKEN_ENCRYPTION_KEY = bad;
    assert.throws(() => encryptApiToken('x'), /not a 32-byte value/, `expected throw for ${bad.slice(0, 8)}`);
  }
});

test('dev fallback: non-production + no secrets does not throw', () => {
  process.env.NODE_ENV = 'test';
  const token = 'dev-token';
  assert.equal(decryptApiToken(encryptApiToken(token)), token);
});

test('tamper/wrong-key: ciphertext from one key fails under another', () => {
  process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
  const ct = encryptApiToken('secret');
  process.env.TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
  assert.throws(() => decryptApiToken(ct));
});
