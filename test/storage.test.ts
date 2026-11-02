import { test } from 'node:test';
import assert from 'node:assert/strict';

let caseId = 0;
async function freshStorage(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import(`../src/auth/storage.ts?case=${caseId++}`);
}

test('refresh token: create -> get -> revoke -> gone', async () => {
  const s = await freshStorage({ REFRESH_TOKEN_TTL_SECONDS: '3600' });
  const tok = s.createRefreshToken({ clientId: 'c1', userId: 'u1', apiToken: 'Token abc', scope: 'generect:api' });
  const got = s.getRefreshToken(tok);
  assert.ok(got, 'freshly created token resolves');
  assert.equal(got.apiToken, 'Token abc');
  assert.equal(got.clientId, 'c1');
  assert.equal(s.revokeRefreshToken(tok), true, 'first revoke reports it was live');
  assert.equal(s.getRefreshToken(tok), null, 'revoked token no longer resolves');
  assert.equal(s.revokeRefreshToken(tok), false, 'second revoke is a no-op');
});

test('refresh token: expired token does not resolve', async () => {
  const s = await freshStorage({ REFRESH_TOKEN_TTL_SECONDS: '-1' });
  const tok = s.createRefreshToken({ clientId: 'c1', userId: 'u1', apiToken: 'Token abc' });
  assert.equal(s.getRefreshToken(tok), null, 'already-expired token is rejected');
});

test('client cap: over the cap, the oldest non-in-use client is evicted', async () => {
  const s = await freshStorage({ MCP_MAX_CLIENTS: '2', REFRESH_TOKEN_TTL_SECONDS: '3600' });
  // None are in use (no auth codes). Registering a 3rd must drop the oldest.
  s.registerClient({ redirect_uris: ['https://claude.ai/cb'], metadata_url: 'https://a.test' });
  s.registerClient({ redirect_uris: ['https://claude.ai/cb'], metadata_url: 'https://b.test' });
  s.registerClient({ redirect_uris: ['https://claude.ai/cb'], metadata_url: 'https://c.test' });

  assert.equal(s.getClient('https://a.test'), undefined, 'oldest evicted');
  assert.ok(s.getClient('https://b.test'), 'b kept');
  assert.ok(s.getClient('https://c.test'), 'newest kept');
  // Invariant: at most MAX clients resolve.
  const alive = ['https://a.test', 'https://b.test', 'https://c.test'].filter(h => s.getClient(h)).length;
  assert.ok(alive <= 2, `cap holds (alive=${alive})`);
});

test('client cap: in-use clients survive a registration flood', async () => {
  const s = await freshStorage({ MCP_MAX_CLIENTS: '2', REFRESH_TOKEN_TTL_SECONDS: '3600' });
  // Two clients pinned by live auth codes...
  for (const host of ['https://keep1.test', 'https://keep2.test']) {
    const cl = s.registerClient({ redirect_uris: ['https://claude.ai/cb'], metadata_url: host });
    s.createAuthCode({
      clientId: cl.clientId,
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: 'x',
      codeChallengeMethod: 'S256',
      apiToken: 'Token x',
      userId: 'u',
    });
  }
  // ...then a flood of anonymous registrations (never completing auth).
  for (const host of ['https://spam1.test', 'https://spam2.test', 'https://spam3.test']) {
    s.registerClient({ redirect_uris: ['https://claude.ai/cb'], metadata_url: host });
  }
  assert.ok(s.getClient('https://keep1.test'), 'in-use client 1 protected from eviction');
  assert.ok(s.getClient('https://keep2.test'), 'in-use client 2 protected from eviction');
  for (const spam of ['https://spam1.test', 'https://spam2.test', 'https://spam3.test']) {
    assert.equal(s.getClient(spam), undefined, `flood client ${spam} evicted`);
  }
});

test('client registry survives a restart (persisted to disk, reloaded on boot)', async () => {
  const path = `/tmp/oc-unit-${process.pid}-${Date.now()}.json`;
  const s1 = await freshStorage({ MCP_CLIENT_STORE_PATH: path, MCP_MAX_CLIENTS: '100' });
  const c = s1.registerClient({ client_name: 'App', redirect_uris: ['https://claude.ai/cb'] });
  assert.ok(s1.getClient(c.clientId), 'registered in the first process');

  // A fresh module instance == a restarted server.
  const s2 = await freshStorage({ MCP_CLIENT_STORE_PATH: path, MCP_MAX_CLIENTS: '100' });
  const restored = s2.getClient(c.clientId);
  assert.ok(restored, 'client must still be known after restart');
  assert.deepEqual(restored.redirectUris, ['https://claude.ai/cb']);
  const { unlinkSync } = await import('node:fs');
  try {
    unlinkSync(path);
  } catch {}
});

test('a corrupt client store never prevents startup', async () => {
  const path = `/tmp/oc-bad-${process.pid}-${Date.now()}.json`;
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(path, 'not json at all');
  const s = await freshStorage({ MCP_CLIENT_STORE_PATH: path });
  assert.equal(s.getClient('anything'), undefined, 'starts clean instead of throwing');
  try {
    unlinkSync(path);
  } catch {}
});

// --- Refresh token persistence (Google "Persistent Linking", PRO-1974) ---------

function tmpPath(tag: string) {
  return `/tmp/rt-unit-${tag}-${process.pid}-${Date.now()}-${caseId}.json`;
}
async function cleanup(...paths: string[]) {
  const { unlinkSync } = await import('node:fs');
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {}
  }
}
const KEYS = { TOKEN_ENCRYPTION_KEY: 'cd'.repeat(32), REFRESH_TOKEN_TTL_SECONDS: '3600' };

test('refresh tokens survive a restart, and the file holds neither the token nor the API key', async () => {
  const path = tmpPath('persist');
  const s1 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  const tok = s1.createRefreshToken({ clientId: 'c1', userId: 'u1', apiToken: 'secret-api-key-123' });

  const { readFileSync, statSync } = await import('node:fs');
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes(tok), 'the refresh token itself is never written');
  assert.ok(!raw.includes('secret-api-key-123'), 'the API key is never written in clear');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'store is owner-only');

  const s2 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  const got = s2.getRefreshToken(tok);
  assert.ok(got, 'token still redeemable after restart');
  assert.equal(got.apiToken, 'secret-api-key-123');
  assert.equal(got.clientId, 'c1');
  assert.equal(got.userId, 'u1');
  await cleanup(path);
});

test('a revoked refresh token stays revoked across a restart', async () => {
  const path = tmpPath('revoke');
  const s1 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  const tok = s1.createRefreshToken({ clientId: 'c1', userId: 'u1', apiToken: 'k' });
  assert.equal(s1.revokeRefreshToken(tok), true);
  const s2 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  assert.equal(s2.getRefreshToken(tok), null, 'revocation is persisted, not undone by a restart');
  await cleanup(path);
});

test('extendRefreshToken pushes the expiry out a full TTL and persists it', async () => {
  const path = tmpPath('extend');
  const s1 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  const tok = s1.createRefreshToken({ clientId: 'c1', userId: 'u1', apiToken: 'k' });
  const before = s1.getRefreshToken(tok).expiresAt;
  await new Promise(r => setTimeout(r, 15));
  const extended = s1.extendRefreshToken(tok);
  assert.ok(extended > before, 'expiry moved forward');
  const s2 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  assert.equal(s2.getRefreshToken(tok).expiresAt, extended, 'extended expiry survives restart');
  assert.equal(s1.extendRefreshToken('unknown'), null, 'unknown token is not extended');
  s1.revokeRefreshToken(tok);
  assert.equal(s1.extendRefreshToken(tok), null, 'revoked token cannot be extended back to life');
  await cleanup(path);
});

test('an expired refresh token is not extended and is dropped from the store', async () => {
  const path = tmpPath('expired');
  const s = await freshStorage({ ...KEYS, REFRESH_TOKEN_TTL_SECONDS: '-1', MCP_REFRESH_STORE_PATH: path });
  const tok = s.createRefreshToken({ clientId: 'c1', userId: 'u1', apiToken: 'k' });
  assert.equal(s.extendRefreshToken(tok), null);
  assert.equal(s.getRefreshToken(tok), null);
  const s2 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  assert.equal(s2.getRefreshToken(tok), null, 'expired tokens are not restored');
  await cleanup(path);
});

test('MCP_REFRESH_STORE_PATH=off keeps refresh tokens in memory only', async () => {
  const s = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: 'off' });
  const tok = s.createRefreshToken({ clientId: 'c1', userId: 'u1', apiToken: 'k' });
  assert.ok(s.getRefreshToken(tok), 'still works in memory');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync('off'), false, 'no file named after the switch');
  const s2 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: 'off' });
  assert.equal(s2.getRefreshToken(tok), null, 'nothing restored');
});

test('a corrupt refresh store never prevents startup', async () => {
  const path = tmpPath('corrupt');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, '{not json');
  const s = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  assert.equal(s.getRefreshToken('anything'), null);
  const tok = s.createRefreshToken({ clientId: 'c1', userId: 'u1', apiToken: 'k' });
  assert.ok(s.getRefreshToken(tok), 'and the store is usable again');
  await cleanup(path);
});

test('a stored token that no longer decrypts (key rotated) is refused, not a crash', async () => {
  const path = tmpPath('rotated');
  const s1 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  const tok = s1.createRefreshToken({ clientId: 'c1', userId: 'u1', apiToken: 'k' });
  const s2 = await freshStorage({ ...KEYS, TOKEN_ENCRYPTION_KEY: 'ef'.repeat(32), MCP_REFRESH_STORE_PATH: path });
  assert.equal(s2.getRefreshToken(tok), null, 'undecryptable record resolves to null');
  const s3 = await freshStorage({ ...KEYS, MCP_REFRESH_STORE_PATH: path });
  assert.equal(s3.getRefreshToken(tok), null, 'and it was dropped, not left to fail again');
  await cleanup(path);
});

test('refresh store is capped: the tokens closest to expiry go first', async () => {
  const path = tmpPath('cap');
  const s = await freshStorage({ ...KEYS, MCP_MAX_REFRESH_TOKENS: '2', MCP_REFRESH_STORE_PATH: path });
  const a = s.createRefreshToken({ clientId: 'c', userId: 'u', apiToken: 'k' });
  await new Promise(r => setTimeout(r, 5));
  const b = s.createRefreshToken({ clientId: 'c', userId: 'u', apiToken: 'k' });
  await new Promise(r => setTimeout(r, 5));
  const c = s.createRefreshToken({ clientId: 'c', userId: 'u', apiToken: 'k' });
  assert.equal(s.getRefreshToken(a), null, 'oldest (soonest to expire) evicted');
  assert.ok(s.getRefreshToken(b));
  assert.ok(s.getRefreshToken(c));
  await cleanup(path);
  delete process.env.MCP_MAX_REFRESH_TOKENS;
});
