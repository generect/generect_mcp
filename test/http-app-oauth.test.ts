import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { clearAuthEnv, VALID_TOKEN_KEY } from './helpers.ts';

// OAuth clients (Claude.ai connectors, Cursor) send a JWT this server minted, not an
// API key. The tools decode it per request from the Authorization header, which is
// the one thing that reads differently in each protocol era, so the real Express app
// is driven here with a real minted token in both eras. jwt.ts caches its signing
// key at module scope: the environment is set before app.ts and jwt.ts are imported.

clearAuthEnv();
process.env.JWT_SIGNING_KEY = 'a-strong-non-default-signing-secret';
process.env.TOKEN_ENCRYPTION_KEY = VALID_TOKEN_KEY;
process.env.OAUTH_BASE_URL = 'https://mcp.example.test';
delete process.env.GENERECT_API_KEY;

const { createApp } = await import('../src/app.ts');
const { generateAccessToken } = await import('../src/auth/jwt.ts');
const { resetPriceBookCache } = await import('../src/pricing.ts');

const seen: Array<{ url: string; authorization: string | null }> = [];
let server: Server;
let base: string;

before(async () => {
  const api = (async (url: string, init: any = {}) => {
    seen.push({ url: String(url), authorization: new Headers(init.headers ?? {}).get('authorization') });
    const body = /tiers\/my-tier/.test(String(url))
      ? { current_tier: { name: '3', service_prices: { api_cached: 0.01 } } }
      : { data: { results_count: 7 }, meta: { amount_charged: 0 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  server = createApp(api).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>(r => server.close(() => r())));

for (const [era, mode, sessionful] of [
  ['2025-11-25', 'legacy', true],
  ['2026-07-28', { pin: '2026-07-28' }, false],
] as const) {
  test(`express /mcp, ${era}: an OAuth access token bills the account it was minted for`, async () => {
    resetPriceBookCache();
    seen.length = 0;
    const apiKey = `oauth-key-${era}`;
    const jwt = await generateAccessToken(apiKey, 'user-1', 'client-1');
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const client = new Client({ name: 'oauth-test', version: '0' }, { versionNegotiation: { mode: mode as any } });
    await client.connect(transport);
    try {
      assert.equal(Boolean((transport as any).sessionId), sessionful);
      const r: any = await client.callTool({ name: 'count_leads', arguments: { job_titles: ['CEO'] } });
      assert.equal(r.structuredContent.results_count, 7, JSON.stringify(r));
      const call = seen.find(s => /search\/database\/leads\/count/.test(s.url))!;
      assert.equal(call.authorization, `Token ${apiKey}`);
    } finally {
      await client.close();
    }
  });
}

test('express /mcp: a forged access token is refused before either era is served', async () => {
  seen.length = 0;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    }),
  });
  assert.equal(res.status, 401);
  assert.equal(seen.length, 0);
});
