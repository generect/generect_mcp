import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidRedirectUri, describeRedirectTarget, loopbackEquivalent } from '../src/auth/redirect.ts';
import { validateRedirectUri, OAuthClient } from '../src/auth/storage.ts';

// The redirect policy decides where an authorization code may be delivered
// (CWE-601). The default is open — any app can register — so what is pinned here
// is the shape of what "open" still refuses, and that `strict` really closes it.

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Every test states the policy it means, so a change of default cannot silently
// turn a "must reject" assertion into a vacuous one.
const OPEN = { MCP_REDIRECT_POLICY: 'open', MCP_ALLOW_ANY_HTTPS_REDIRECT: undefined };
const STRICT = { MCP_REDIRECT_POLICY: 'strict', MCP_ALLOW_ANY_HTTPS_REDIRECT: undefined };

test('open is the default policy', () => {
  withEnv({ MCP_REDIRECT_POLICY: undefined, MCP_ALLOW_ANY_HTTPS_REDIRECT: undefined }, () => {
    assert.equal(isValidRedirectUri('https://any-new-app.example/cb'), true);
    assert.equal(isValidRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback'), true);
  });
});

test('accepts the callbacks real clients use', () => {
  withEnv(OPEN, () => {
    // Cursor — the exact URI production rejected on 2026-08-16.
    assert.equal(isValidRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback'), true);
    assert.equal(isValidRedirectUri('vscode://generect.mcp/callback'), true);
    assert.equal(isValidRedirectUri('windsurf://cb/'), true);
    // RFC 8252 §7.1 reverse-DNS form, which has no authority component at all.
    assert.equal(isValidRedirectUri('com.example.app:/oauth2redirect'), true);
    assert.equal(isValidRedirectUri('https://linear.app/connect/mcp/callback'), true);
    assert.equal(isValidRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
    assert.equal(isValidRedirectUri('http://127.0.0.1:8080/cb'), true);
    assert.equal(isValidRedirectUri('http://[::1]:8080/cb'), true);
  });
});

test('open policy still refuses codes over cleartext to a public host', () => {
  withEnv(OPEN, () => {
    assert.equal(isValidRedirectUri('http://evil.example/cb'), false);
    assert.equal(isValidRedirectUri('http://localhost:5173/callback'), true, 'the user’s own machine is fine');
    assert.equal(isValidRedirectUri('http://192.168.1.20:9000/cb'), true, 'LAN dev is fine');
  });
});

test('open policy refuses schemes the browser would execute', () => {
  withEnv(OPEN, () => {
    // We navigate to this URI from our own origin, so these would be XSS with a
    // live authorization code in scope.
    assert.equal(isValidRedirectUri('javascript:alert(1)'), false);
    assert.equal(isValidRedirectUri('javascript://comment%0aalert(1)'), false, 'the //-comment bypass');
    assert.equal(isValidRedirectUri('JavaScript:alert(1)'), false, 'case is normalised');
    assert.equal(isValidRedirectUri('data:text/html,<script>alert(1)</script>'), false);
    assert.equal(isValidRedirectUri('file:///etc/passwd'), false);
    assert.equal(isValidRedirectUri('vbscript:msgbox(1)'), false);
    assert.equal(isValidRedirectUri('mailto:x@example.com'), false, 'not a location');
    assert.equal(isValidRedirectUri('not a url'), false);
    assert.equal(isValidRedirectUri(''), false);
  });
});

test('open policy refuses URIs that obscure or corrupt the destination', () => {
  withEnv(OPEN, () => {
    // RFC 6749 §3.1.2 — a redirection endpoint MUST NOT carry a fragment.
    assert.equal(isValidRedirectUri('https://app.example/cb#frag'), false);
    // Reads as claude.ai, delivers to evil.example.
    assert.equal(isValidRedirectUri('https://claude.ai@evil.example/cb'), false);
    assert.equal(isValidRedirectUri('https://user:pw@app.example/cb'), false);
    assert.equal(isValidRedirectUri(`https://app.example/${'a'.repeat(4000)}`), false, 'length is bounded');
  });
});

test('strict policy restores the first-party-only allowlist', () => {
  withEnv(STRICT, () => {
    assert.equal(isValidRedirectUri('https://linear.app/connect/mcp/callback'), true);
    assert.equal(isValidRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
    assert.equal(isValidRedirectUri('https://beta.generect.com/cb'), true);
    assert.equal(isValidRedirectUri('http://localhost:5173/callback'), true);
    assert.equal(isValidRedirectUri('https://evil.example.com/cb'), false);
    assert.equal(isValidRedirectUri('https://linear.app.evil.com/cb'), false, 'suffix-confusion must not pass');
    assert.equal(isValidRedirectUri('https://notlinear.app/cb'), false);
    assert.equal(isValidRedirectUri('https://generect.com.evil.com/cb'), false);
    assert.equal(isValidRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback'), false);
    assert.equal(isValidRedirectUri('https://LINEAR.APP/connect/mcp/callback'), true, 'case-insensitive host');
  });
});

test('strict policy is extended by the env allowlists', () => {
  withEnv({ ...STRICT, MCP_ALLOWED_REDIRECT_DOMAINS: 'partner.example' }, () => {
    assert.equal(isValidRedirectUri('https://partner.example/cb'), true);
    assert.equal(isValidRedirectUri('https://other.example/cb'), false);
  });
  withEnv({ ...STRICT, MCP_ALLOWED_REDIRECT_SCHEMES: 'cursor' }, () => {
    assert.equal(isValidRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback'), true);
    assert.equal(isValidRedirectUri('vscode://x/cb'), false);
  });
});

test('MCP_ALLOW_ANY_HTTPS_REDIRECT still opens https under strict', () => {
  withEnv({ MCP_REDIRECT_POLICY: 'strict', MCP_ALLOW_ANY_HTTPS_REDIRECT: 'true' }, () => {
    assert.equal(isValidRedirectUri('https://any-new-app.example/cb'), true);
    assert.equal(isValidRedirectUri('http://any-new-app.example/cb'), false, 'plain http still refused');
    assert.equal(isValidRedirectUri('cursor://x/cb'), false, 'the https flag does not open schemes');
  });
});

test('the consent screen can name every callback shape', () => {
  assert.deepEqual(describeRedirectTarget('https://claude.ai/api/mcp/auth_callback').label, 'claude.ai');
  assert.equal(describeRedirectTarget('https://claude.ai@evil.example/cb').label, 'evil.example');
  const app = describeRedirectTarget('cursor://anysphere.cursor-mcp/oauth/callback');
  assert.equal(app.label, 'cursor://anysphere.cursor-mcp');
  assert.equal(app.isExternalApp, true);
  // No authority component: must still say something, never an empty string.
  assert.equal(describeRedirectTarget('com.example.app:/oauth2redirect').label, 'com.example.app:');
  assert.equal(describeRedirectTarget('http://127.0.0.1:8976/cb').isExternalApp, false);
  assert.equal(describeRedirectTarget('nonsense').label, 'nonsense');
  // Lookalike domains are shown punycoded, i.e. not as "claude.ai".
  assert.equal(describeRedirectTarget('https://clаude.ai/cb').label, 'xn--clude-5ve.ai');
});

test('loopback callbacks match on everything but the port (RFC 8252 §7.3)', () => {
  const client = {
    clientId: 'c1',
    clientName: 'native app',
    redirectUris: ['http://127.0.0.1:8976/cb', 'https://app.example/cb'],
    grantTypes: ['authorization_code'],
    responseTypes: ['code'],
    createdAt: Date.now(),
  } as OAuthClient;

  assert.equal(validateRedirectUri(client, 'http://127.0.0.1:51244/cb'), true, 'ephemeral port');
  assert.equal(validateRedirectUri(client, 'http://localhost:51244/cb'), true, 'same machine, other spelling');
  assert.equal(validateRedirectUri(client, 'http://127.0.0.1:51244/other'), false, 'path still binds');
  assert.equal(validateRedirectUri(client, 'https://app.example:8443/cb'), false, 'non-loopback stays exact');
  assert.equal(validateRedirectUri(client, 'https://evil.example/cb'), false);
  assert.equal(validateRedirectUri(client, ''), false);

  // The exception must never bridge a loopback registration to a remote host.
  assert.equal(loopbackEquivalent('http://127.0.0.1:8976/cb', 'http://evil.example:8976/cb'), false);
  assert.equal(loopbackEquivalent('https://127.0.0.1:8976/cb', 'http://127.0.0.1:8976/cb'), false);
});
