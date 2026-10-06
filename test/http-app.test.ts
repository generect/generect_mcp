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

// A whole hand-written 2025 session, the way older clients speak it: 2025-03-26 and
// 2024-11-05 never send Mcp-Protocol-Version, 2025-06-18 and later send their own
// (non-modern) version. Every follow-up must stay on the session path: only a
// `_meta` protocol-version claim routes to 2026-07-28, so a progressToken in `_meta`
// must not.
function messages(text: string): any[] {
  if (!text.includes('data:')) return [JSON.parse(text)];
  return text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => JSON.parse(line.slice(5).trim()));
}

for (const [version, sendsHeader] of [
  ['2025-03-26', false],
  ['2024-11-05', false],
  ['2025-06-18', true],
  ['2025-11-25', true],
] as const) {
  test(`express /mcp: a full ${version} session (${sendsHeader ? 'own' : 'no'} protocol header) stays on the session path`, async () => {
    resetPriceBookCache();
    seen.length = 0;
    const key = `old-${version}`;
    let sessionId: string | null = null;
    const post = (body: unknown) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${key}`,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(sessionId && sendsHeader ? { 'mcp-protocol-version': version } : {}),
        },
        body: JSON.stringify(body),
      });

    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'old', version: '0' } },
    });
    assert.equal(init.status, 200, await init.clone().text());
    sessionId = init.headers.get('mcp-session-id');
    assert.ok(sessionId);
    await init.text();

    const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(initialized.status, 202, await initialized.clone().text());

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(list.status, 200, await list.clone().text());
    const listed = messages(await list.text()).find(m => m.id === 2);
    assert.equal(listed.result.tools.length, 17, JSON.stringify(listed));

    const call = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'count_leads', arguments: { job_titles: ['CEO'] }, _meta: { progressToken: 'p-1' } },
    });
    assert.equal(call.status, 200, await call.clone().text());
    const called = messages(await call.text()).find(m => m.id === 3);
    assert.equal(called.result.isError, undefined, JSON.stringify(called));
    assert.match(called.result.content[0].text, /42/);
    const apiCall = seen.find(s => /search\/database\/leads\/count/.test(s.url))!;
    assert.equal(apiCall.authorization, `Token ${key}`);

    const closed = await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${key}`, 'mcp-session-id': sessionId! },
    });
    assert.equal(closed.status, 200, await closed.clone().text());
  });
}

test('express /mcp: malformed JSON is a 400 parse error, an oversized body a 413, neither a 500', async () => {
  const post = (body: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer some-key',
      },
      body,
    });
  const broken = await post('{nope');
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error.code, -32700);
  const huge = await post(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(200_000) } }),
  );
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).error.code, -32600);
});

// Two more 2025 behaviours 0.10.1 had, measured on it and pinned here: a 2025-03-26
// client may send a JSON-RPC batch on its session, and a client that refreshes its
// token mid-session is billed under the token it sends now, not the one it opened with.
test('express /mcp: a 2025-03-26 session answers a batch, and a key change mid-session bills the new key', async () => {
  resetPriceBookCache();
  let sessionId: string | null = null;
  const post = (body: unknown, key: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${key}`,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  const init = await post(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'old', version: '0' } },
    },
    'key-before',
  );
  sessionId = init.headers.get('mcp-session-id');
  assert.ok(sessionId);
  await init.text();
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'key-before')).status, 202);

  const batch = await post(
    [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ],
    'key-before',
  );
  assert.equal(batch.status, 200);
  const answered = messages(await batch.text()).flat();
  assert.equal(answered.find(m => m.id === 2)?.result.tools.length, 17, JSON.stringify(answered).slice(0, 300));
  assert.deepEqual(answered.find(m => m.id === 3)?.result, {});

  // The same tool on the same session, first under the key the session opened with,
  // then under a refreshed one: each call must carry the key its own request sent.
  const countUnder = async (id: number, key: string) => {
    seen.length = 0;
    const call = await post(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'count_leads', arguments: { job_titles: ['CEO'] } } },
      key,
    );
    assert.equal(call.status, 200);
    await call.text();
    return seen.filter(s => /search\/database\/leads\/count/.test(s.url)).map(s => s.authorization);
  };
  assert.deepEqual(await countUnder(4, 'key-before'), ['Token key-before']);
  assert.deepEqual(await countUnder(5, 'key-after'), ['Token key-after']);
});
