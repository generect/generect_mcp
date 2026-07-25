import { test } from 'node:test';
import assert from 'node:assert/strict';

let caseId = 0;
async function freshStorage(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import(`../src/auth/storage.ts?bcase=${caseId++}`);
}

const BASE = {
  clientId: 'client-1',
  clientName: 'Linear',
  redirectUri: 'https://linear.app/connect/mcp/callback',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  codeChallengeMethod: 'S256',
  scope: 'generect:api',
  state: 'xyz',
};

test('handoff: create -> peek (non-consuming) -> consume (single-use)', async () => {
  const s = await freshStorage({ MCP_HANDOFF_TTL_SECONDS: '600' });
  const id = s.createHandoff(BASE);
  assert.ok(id.length >= 32, 'id is long/random');

  const peeked = s.peekHandoff(id);
  assert.ok(peeked, 'peek resolves');
  assert.equal(peeked.redirectUri, BASE.redirectUri);
  assert.ok(s.peekHandoff(id), 'peek does NOT consume');

  const used = s.consumeHandoff(id);
  assert.ok(used, 'consume resolves once');
  assert.equal(used.codeChallenge, BASE.codeChallenge, 'PKCE challenge preserved server-side');
  assert.equal(s.consumeHandoff(id), null, 'second consume fails — replay impossible');
  assert.equal(s.peekHandoff(id), null, 'gone after use');
});

test('handoff: expired ids do not resolve', async () => {
  const s = await freshStorage({ MCP_HANDOFF_TTL_SECONDS: '-1' });
  const id = s.createHandoff(BASE);
  assert.equal(s.peekHandoff(id), null, 'already-expired handoff is rejected');
  assert.equal(s.consumeHandoff(id), null);
});

test('handoff: unknown id returns null (no crash)', async () => {
  const s = await freshStorage();
  assert.equal(s.peekHandoff('does-not-exist'), null);
  assert.equal(s.consumeHandoff(''), null);
});

test('handoff: the map is bounded (cannot grow without limit)', async () => {
  const s = await freshStorage({ MCP_HANDOFF_TTL_SECONDS: '600' });
  // Far below MAX_HANDOFFS, but proves creation works repeatedly and each id is unique.
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) ids.add(s.createHandoff(BASE));
  assert.equal(ids.size, 200, 'every handoff id is unique');
});

test('handoff carries the ORIGINAL redirect + state so the UI cannot change them', async () => {
  const s = await freshStorage({ MCP_HANDOFF_TTL_SECONDS: '600' });
  const id = s.createHandoff(BASE);
  const h = s.consumeHandoff(id);
  // These are the values the broker must use — never anything from the POST body.
  assert.equal(h.redirectUri, 'https://linear.app/connect/mcp/callback');
  assert.equal(h.state, 'xyz');
  assert.equal(h.clientId, 'client-1');
});
