import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app.ts';
import { resetPriceBookCache } from '../src/pricing.ts';

// The production Express app — OAuth middleware, the isLegacyRequest() router, the
// 2025 session map and the 2026-07-28 handler — on a real port, against a fake
// Generect API. This is the path real traffic takes; protocol-eras.test.ts covers
// the SDK entry on its own.

const seen: Array<{ url: string; authorization: string | null }> = [];
let server: Server;
let base: string;

before(async () => {
  const api = (async (url: string, init: any = {}) => {
    seen.push({ url: String(url), authorization: new Headers(init.headers ?? {}).get('authorization') });
    const body = /tiers\/my-tier/.test(String(url))
      ? { current_tier: { name: '3', service_prices: { api_cached: 0.01 } } }
      : { data: { results_count: 42 }, meta: { amount_charged: 0 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  server = createApp(api).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>(r => server.close(() => r())));

async function connect(mode: 'legacy' | { pin: string }, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'http-app-test', version: '0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return { client, transport };
}

for (const [era, mode, sessionful] of [
  ['2025-11-25', 'legacy', true],
  ['2026-07-28', { pin: '2026-07-28' }, false],
] as const) {
  test(`express /mcp, ${era}: right path, caller's key reaches the API, resources work`, async () => {
    resetPriceBookCache();
    seen.length = 0;
    const { client, transport } = await connect(mode as any, `key-${era}`);
    try {
      assert.equal(Boolean((transport as any).sessionId), sessionful, 'session only on the 2025 path');
      assert.equal((await client.listTools()).tools.length, 17);
      const r: any = await client.callTool({ name: 'count_leads', arguments: { job_titles: ['CEO'] } });
      assert.equal(r.structuredContent.results_count, 42);
      const call = seen.find(s => /search\/database\/leads\/count/.test(s.url))!;
      assert.equal(call.authorization, `Token key-${era}`);

      const uris = (await client.listResources()).resources.map(x => x.uri);
      assert.ok(uris.includes('generect://account/pricing'), JSON.stringify(uris));
      const templates = (await client.listResourceTemplates()).resourceTemplates.map(x => x.uriTemplate);
      assert.ok(
        templates.some(t => t.startsWith('generect://vocabulary/')),
        JSON.stringify(templates),
      );
      const vocab: any = await client.readResource({ uri: 'generect://vocabulary/industries' });
      assert.match(vocab.contents[0].text, /Software Development/);
    } finally {
      await client.close();
    }
  });
}

test('express /mcp: no credential is a 401 with the OAuth challenge', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata=/);
});

test('express /mcp: a browser preflight may send the 2026-07-28 headers', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://claude.ai',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type, mcp-method, mcp-name, mcp-param-region',
    },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /mcp-param-region/);
});

for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
  test(`express /mcp: an initialize at ${version}, with no protocol header, still opens a 2025 session`, async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer old-client-key',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'old', version: '0' } },
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(res.headers.get('mcp-session-id'), 'a 2025-era initialize must get a session');
    const text = await res.text();
    const payload = JSON.parse(text.includes('data:') ? text.split('data:').pop()!.trim() : text);
    assert.equal(payload.result.protocolVersion, version);
  });
}
