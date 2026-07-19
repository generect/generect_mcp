import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidRedirectUri } from '../src/auth/oauth.ts';

// The redirect allowlist is the control that stops an attacker from having
// authorization codes delivered to a host they own (CWE-601). These assertions
// pin both the "must allow" (first-party MCP clients) and "must reject" sides.

test('allows the real first-party MCP client callbacks', () => {
  // Linear — the exact URI that was rejected in production on 2026-07-19.
  assert.equal(isValidRedirectUri('https://linear.app/connect/mcp/callback'), true);
  assert.equal(isValidRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
});

test('allows generect domains and localhost dev callbacks', () => {
  assert.equal(isValidRedirectUri('https://generect.com/cb'), true);
  assert.equal(isValidRedirectUri('https://beta.generect.com/cb'), true);
  assert.equal(isValidRedirectUri('http://localhost:5173/callback'), true);
  assert.equal(isValidRedirectUri('http://127.0.0.1:8080/cb'), true);
});

test('rejects arbitrary third-party hosts', () => {
  assert.equal(isValidRedirectUri('https://evil.example.com/cb'), false);
  assert.equal(isValidRedirectUri('https://linear.app.evil.com/cb'), false, 'suffix-confusion must not pass');
  assert.equal(isValidRedirectUri('https://notlinear.app/cb'), false);
  assert.equal(isValidRedirectUri('https://generect.com.evil.com/cb'), false);
});

test('rejects non-http(s) schemes and malformed URIs', () => {
  assert.equal(isValidRedirectUri('claude://callback'), false);
  assert.equal(isValidRedirectUri('javascript:alert(1)'), false);
  assert.equal(isValidRedirectUri('not a url'), false);
});

test('host matching is case-insensitive', () => {
  assert.equal(isValidRedirectUri('https://LINEAR.APP/connect/mcp/callback'), true);
});

test('MCP_ALLOWED_REDIRECT_DOMAINS extends the allowlist at runtime', () => {
  const prev = process.env.MCP_ALLOWED_REDIRECT_DOMAINS;
  process.env.MCP_ALLOWED_REDIRECT_DOMAINS = 'partner.example';
  try {
    assert.equal(isValidRedirectUri('https://partner.example/cb'), true);
    assert.equal(isValidRedirectUri('https://other.example/cb'), false);
  } finally {
    if (prev === undefined) delete process.env.MCP_ALLOWED_REDIRECT_DOMAINS;
    else process.env.MCP_ALLOWED_REDIRECT_DOMAINS = prev;
  }
});

test('MCP_ALLOW_ANY_HTTPS_REDIRECT opens https callbacks but never plain http', () => {
  const prev = process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT;
  process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT = 'true';
  try {
    assert.equal(isValidRedirectUri('https://any-new-app.example/cb'), true, 'any https allowed when opted in');
    assert.equal(isValidRedirectUri('http://any-new-app.example/cb'), false, 'plain http still refused');
    assert.equal(isValidRedirectUri('http://localhost:9999/cb'), true, 'localhost http still fine');
  } finally {
    if (prev === undefined) delete process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT;
    else process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT = prev;
  }
});
