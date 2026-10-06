import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer, LIST_CACHE } from '../src/mcp-server.ts';
import { resetPriceBookCache } from '../src/pricing.ts';
import { TOOL_ORDER } from '../src/tool-meta.ts';

// The same server factory production uses, behind the SDK's HTTP entry, driven by
// the SDK's own client in both protocol eras. What must hold in each:
// - the tool list is the full, ordered list;
// - a tool call reaches the Generect API carrying the caller's own key, taken
//   from the HTTP request behind the MCP call (ctx.http.req) — the path that
//   decides whose balance is charged.

type Seen = { url: string; authorization: string | null };

function setup() {
  resetPriceBookCache();
  const seen: Seen[] = [];
  const api = (async (url: string, init: any = {}) => {
    const headers = new Headers(init.headers ?? {});
    seen.push({ url: String(url), authorization: headers.get('authorization') });
    const body = /tiers\/my-tier/.test(String(url))
      ? { current_tier: { name: '3', service_prices: { api_cached: 0.01, api_realtime: 0.04 } } }
      : { data: { results_count: 321 }, meta: { amount_charged: 0 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const handler = createMcpHandler(() => createMcpServer(api, 'https://api.test', ''));
  return { handler, seen };
}

function negotiated(client: Client): string | undefined {
  return (client as any).getNegotiatedProtocolVersion?.() ?? (client as any).transport?.protocolVersion;
}

async function connect(handler: ReturnType<typeof createMcpHandler>, mode: 'legacy' | { pin: string }, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.test/mcp'), {
    fetch: (url: string | URL, init?: RequestInit) => handler.fetch(new Request(url, init)),
    requestInit: { headers: { Authorization: `Token ${key}` } },
  });
  const client = new Client({ name: 'era-test', version: '0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

for (const [era, mode, expected] of [
  ['2026-07-28 (stateless, server/discover)', { pin: '2026-07-28' }, '2026-07-28'],
  ['2025-11-25 (initialize)', 'legacy', '2025-11-25'],
] as const) {
  test(`protocol ${era}: full ordered tool list, and the caller's key reaches the API`, async () => {
    const { handler, seen } = setup();
    const client = await connect(handler, mode as any, 'k-era-123');
    try {
      assert.equal(negotiated(client), expected);
      const listed = await client.listTools();
      const names = listed.tools.map(t => t.name);
      assert.equal(names.length, 17);
      assert.deepEqual(
        names.slice(0, TOOL_ORDER.length),
        TOOL_ORDER.filter(n => names.includes(n)),
      );

      const r: any = await client.callTool({ name: 'count_leads', arguments: { job_titles: ['CEO'] } });
      assert.equal(r.isError, undefined);
      assert.equal(r.structuredContent.results_count, 321);
      const countCall = seen.find(s => /search\/database\/leads\/count/.test(s.url))!;
      assert.equal(countCall.authorization, 'Token k-era-123', 'the key must come from the HTTP request');
    } finally {
      await client.close();
      await handler.close();
    }
  });
}

test('protocol 2026-07-28: the negotiated revision is the new one, with the list cache hint', async () => {
  const { handler } = setup();
  const client = await connect(handler, { pin: '2026-07-28' }, 'k');
  try {
    assert.equal(negotiated(client), '2026-07-28');
    const listed: any = await client.listTools();
    const hint = listed.ttlMs !== undefined ? listed : (listed._meta?.['io.modelcontextprotocol/cache'] ?? listed);
    assert.equal(hint.ttlMs, LIST_CACHE.ttlMs);
    assert.equal(hint.cacheScope, LIST_CACHE.cacheScope);
  } finally {
    await client.close();
    await handler.close();
  }
});
