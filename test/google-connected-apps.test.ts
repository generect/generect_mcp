import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { clearAuthEnv, VALID_TOKEN_KEY } from './helpers.ts';

// Google's Connected Apps platform (Gemini, AI Mode in Search), PRO-1974. What
// it needs from this server, driven through the real Express app:
//   - DCR with Google's redirect hosts, then the code exchange it performs —
//     including client authentication by HTTP Basic, which server-side clients use;
//   - "Persistent Linking": the refresh grant returns the SAME refresh token with
//     its expiry extended, while every other client keeps rotation;
//   - domain verification at /.well-known/google-connected-apps.
// Module-level settings (store paths, keys) are read at import, so the
// environment is set before app.ts is imported.

const STORE = `/tmp/gca-${process.pid}-${Date.now()}`;
clearAuthEnv();
process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
process.env.OAUTH_BASE_URL = 'https://mcp.example.test';
process.env.MCP_CLIENT_STORE_PATH = `${STORE}-clients.json`;
process.env.MCP_REFRESH_STORE_PATH = `${STORE}-refresh.json`;
process.env.MCP_REDIRECT_POLICY = 'strict'; // the stricter policy must still admit Google
delete process.env.GOOGLE_CONNECTED_APPS_VERIFICATION;
// Independent of whether the repo already carries a real token file.
process.env.GOOGLE_CONNECTED_APPS_VERIFICATION_FILE = `${STORE}-no-such-token.json`;
delete process.env.GENERECT_API_KEY;

const { createApp } = await import('../src/app.ts');
const { createAuthCode } = await import('../src/auth/storage.ts');
const { verifyAccessToken, extractApiToken } = await import('../src/auth/jwt.ts');

let server: Server;
let base: string;

before(async () => {
  const api = (async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  server = createApp(api).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>(r => server.close(() => r()));
  const { unlinkSync } = await import('node:fs');
  for (const p of [process.env.MCP_CLIENT_STORE_PATH!, process.env.MCP_REFRESH_STORE_PATH!]) {
    try {
      unlinkSync(p);
    } catch {}
  }
});

const GOOGLE_CB = 'https://oauth-redirect.googleusercontent.com/r/generect';

async function register(redirectUris: string[]) {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test', redirect_uris: redirectUris }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).client_id as string;
}

function basic(id: string, secret = '') {
  const enc = (v: string) => encodeURIComponent(v);
  return `Basic ${Buffer.from(`${enc(id)}:${enc(secret)}`).toString('base64')}`;
}

async function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.json() };
}

/** A code as /oauth/broker would mint it after the user approves in the product UI. */
function issueCode(clientId: string, redirectUri: string, apiToken: string) {
  const verifier = randomBytes(32).toString('base64url');
  const code = createAuthCode({
    clientId,
    redirectUri,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    codeChallengeMethod: 'S256',
    apiToken,
    userId: 'user-1',
  });
  return { code, verifier };
}

async function apiKeyIn(accessToken: string) {
  const payload = await verifyAccessToken(accessToken);
  assert.ok(payload, 'access token verifies');
  return extractApiToken(payload!);
}

test('Google client: code exchange with HTTP Basic, then every refresh returns the SAME refresh token', async () => {
  const clientId = await register([GOOGLE_CB, 'https://oauth-redirect-sandbox.googleusercontent.com/r/generect']);
  const { code, verifier } = issueCode(clientId, GOOGLE_CB, 'google-user-key');

  // Server-side clients authenticate with Basic; no client_id in the body.
  const exch = await token(
    { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: GOOGLE_CB },
    { authorization: basic(clientId, 'ignored-secret') },
  );
  assert.equal(exch.status, 200, JSON.stringify(exch.body));
  const refresh = exch.body.refresh_token as string;
  assert.ok(refresh);
  assert.equal(await apiKeyIn(exch.body.access_token), 'google-user-key');

  for (let i = 0; i < 3; i++) {
    const r = await token({ grant_type: 'refresh_token', refresh_token: refresh }, { authorization: basic(clientId) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refresh_token, refresh, `refresh #${i + 1} returns the exact same refresh token`);
    assert.equal(await apiKeyIn(r.body.access_token), 'google-user-key');
  }

  // Body client_id works too, and unlinking (RFC 7009) ends it.
  const viaBody = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
  assert.equal(viaBody.status, 200);
  const rev = await fetch(`${base}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(clientId) },
    body: new URLSearchParams({ token: refresh }).toString(),
  });
  assert.equal(rev.status, 200);
  const after = await token(
    { grant_type: 'refresh_token', refresh_token: refresh },
    { authorization: basic(clientId) },
  );
  assert.equal(after.status, 400);
  assert.equal(after.body.error, 'invalid_grant');
});

test('every other client still rotates: the used refresh token is dead', async () => {
  const cb = 'https://claude.ai/api/mcp/auth_callback';
  const clientId = await register([cb]);
  const { code, verifier } = issueCode(clientId, cb, 'claude-user-key');
  const exch = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
  assert.equal(exch.status, 200, JSON.stringify(exch.body));
  const first = exch.body.refresh_token as string;

  const r = await token({ grant_type: 'refresh_token', refresh_token: first, client_id: clientId });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.refresh_token, first, 'rotated');
  const replay = await token({ grant_type: 'refresh_token', refresh_token: first, client_id: clientId });
  assert.equal(replay.status, 400, 'old refresh token no longer works');
});

test('a client that mixes Google and other callbacks does not get the sticky refresh token', async () => {
  // Strict policy admits *.generect.com; the point is the mix, not the host.
  const clientId = await register([GOOGLE_CB, 'https://app.generect.com/cb']);
  const { code, verifier } = issueCode(clientId, GOOGLE_CB, 'k');
  const exch = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
  const r = await token({ grant_type: 'refresh_token', refresh_token: exch.body.refresh_token, client_id: clientId });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.refresh_token, exch.body.refresh_token, 'rotated: only an all-Google client keeps its token');
});

test('a refresh token is bound to its client, whichever way the client_id arrives', async () => {
  const google = await register([GOOGLE_CB]);
  const other = await register([GOOGLE_CB]);
  const { code, verifier } = issueCode(google, GOOGLE_CB, 'k');
  const exch = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: google });
  const stolen = await token(
    { grant_type: 'refresh_token', refresh_token: exch.body.refresh_token },
    { authorization: basic(other) },
  );
  assert.equal(stolen.status, 400);
  assert.equal(stolen.body.error, 'invalid_grant');
  const noClient = await token({ grant_type: 'refresh_token', refresh_token: exch.body.refresh_token });
  assert.equal(noClient.status, 400, 'no client_id anywhere is still refused');
  const garbage = await token(
    { grant_type: 'refresh_token', refresh_token: exch.body.refresh_token },
    { authorization: 'Basic %%%not-base64' },
  );
  assert.equal(garbage.status, 400, 'an unparseable Basic header is no client_id');
});

test('domain verification: 404 until a token exists, then served verbatim with 200 and no redirect', async () => {
  const missing = await fetch(`${base}/.well-known/google-connected-apps`, { redirect: 'manual' });
  assert.equal(missing.status, 404);

  const content = '{"token":"abc123-from-google-connected-console"}\n';
  process.env.GOOGLE_CONNECTED_APPS_VERIFICATION = content;
  try {
    const res = await fetch(`${base}/.well-known/google-connected-apps`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(await res.text(), content, 'byte-for-byte what Google issued');
  } finally {
    delete process.env.GOOGLE_CONNECTED_APPS_VERIFICATION;
  }

  // The file route, as production uses it (the token committed under well-known/).
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const file = `${STORE}-token.json`;
  writeFileSync(file, content);
  process.env.GOOGLE_CONNECTED_APPS_VERIFICATION_FILE = file;
  try {
    const res = await fetch(`${base}/.well-known/google-connected-apps`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), content);
  } finally {
    process.env.GOOGLE_CONNECTED_APPS_VERIFICATION_FILE = `${STORE}-no-such-token.json`;
    unlinkSync(file);
  }
});

test('the committed token, if any, is what production will serve', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const committed = new URL('../well-known/google-connected-apps.json', import.meta.url);
  if (!existsSync(committed)) return; // not issued yet
  const text = readFileSync(committed, 'utf8');
  assert.doesNotThrow(() => JSON.parse(text), 'the committed token file is valid JSON');
  delete process.env.GOOGLE_CONNECTED_APPS_VERIFICATION_FILE;
  try {
    const res = await fetch(`${base}/.well-known/google-connected-apps`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), text);
  } finally {
    process.env.GOOGLE_CONNECTED_APPS_VERIFICATION_FILE = `${STORE}-no-such-token.json`;
  }
});
