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
