import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLoginPage } from '../src/auth/login-ui.ts';

// A malformed POST that omits optional fields (scope/state) must not throw — an
// unhandled throw in the async handler crashes the whole server (dropping every
// in-memory session). Regression for the escapeHtml(undefined) crash.
test('renderLoginPage tolerates undefined optional fields (no throw)', () => {
  const html = renderLoginPage({
    clientId: 'c',
    redirectUri: 'https://linear.app/connect/mcp/callback',
    codeChallenge: 'x',
    codeChallengeMethod: 'S256',
    scope: undefined as unknown as string,
    state: undefined,
    clientName: undefined,
  });
  assert.ok(html.includes('name="email"'), 'renders email field');
  assert.ok(html.includes('name="password"'), 'renders password field');
  assert.ok(html.includes('name="api_token"'), 'keeps token fallback');
  assert.ok(html.includes('linear.app'), 'shows the redirect host');
});

test('renderLoginPage escapes hostile client/redirect values', () => {
  const html = renderLoginPage({
    clientId: '"><script>alert(1)</script>',
    redirectUri: 'https://evil.example/"><img>',
    codeChallenge: 'x',
    codeChallengeMethod: 'S256',
    scope: 'generect:api',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'client_id is escaped');
});
