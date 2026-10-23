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

function setup(answer?: (url: string, body: any) => unknown) {
  resetPriceBookCache();
  const seen: Seen[] = [];
  const api = (async (url: string, init: any = {}) => {
    const headers = new Headers(init.headers ?? {});
    seen.push({ url: String(url), authorization: headers.get('authorization') });
    const body =
      answer?.(String(url), init.body ? JSON.parse(init.body) : null) ??
      (/tiers\/my-tier/.test(String(url))
        ? { current_tier: { name: '3', service_prices: { api_cached: 0.01, api_realtime: 0.04 } } }
        : /search\/realtime\/leads\//.test(String(url))
          ? { data: { leads: [], results_count: 0 }, meta: { amount_charged: 0 } }
          : { data: { results_count: 321 }, meta: { amount_charged: 0 } });
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
      assert.equal(names.length, TOOL_ORDER.length);
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

for (const [era, mode] of [
  ['2026-07-28', { pin: '2026-07-28' }],
  ['2025-11-25', 'legacy'],
] as const) {
  test(`protocol ${era}: progress heartbeats reach the client through the real transport`, async () => {
    const { handler } = setup();
    const client = await connect(handler, mode as any, 'k');
    try {
      const events: any[] = [];
      await client.callTool(
        { name: 'search_leads', arguments: { job_titles: ['CEO'], mode: 'realtime', limit: 1 } },
        { onprogress: (p: any) => events.push(p) },
      );
      assert.ok(events.length >= 1, 'expected at least the "started" heartbeat');
      assert.match(String(events[0].message), /search_leads: started/);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test(`protocol ${era}: prompts list and render with their arguments`, async () => {
    const { handler } = setup();
    const client = await connect(handler, mode as any, 'k');
    try {
      const names = (await client.listPrompts()).prompts.map(p => p.name).sort();
      assert.deepEqual(names, ['build_prospect_list', 'enrich_my_list', 'size_an_audience', 'spend_report']);
      const got: any = await client.getPrompt({ name: 'size_an_audience', arguments: { icp: 'CTOs in Berlin' } });
      assert.match(got.messages[0].content.text, /CTOs in Berlin/);
      const noArgs: any = await client.getPrompt({ name: 'spend_report' });
      assert.ok(noArgs.messages.length >= 1, 'a prompt without arguments renders without them');
    } finally {
      await client.close();
      await handler.close();
    }
  });
}

// PRO-1717: the client validates structuredContent against the published output
// schema (additionalProperties: false). The default search is thin, and its extra
// fields (detail, free_tier, thin_note) failed that check for every account.
const FREE_TIER = { detail: 'thin', daily_rows: 2000, rows_used_today: 2, rows_left_today: 1998 };
const thinSearch = (url: string, body: any) =>
  /search\/database\/leads\/$/.test(url) && body?.detail === 'thin'
    ? {
        data: { leads: [{ id: 'ACwAAT1', full_name: 'Ada Byron' }], results_count: 1 },
        meta: { amount_charged: 0, free_tier: FREE_TIER },
      }
    : /search\/database\/companies\/$/.test(url) && body?.detail === 'thin'
      ? {
          data: { companies: [{ id: '9', name: 'Analytical' }], results_count: 1 },
          meta: { amount_charged: 0, free_tier: FREE_TIER },
        }
      : undefined;

for (const [era, mode] of [
  ['2026-07-28', { pin: '2026-07-28' }],
  ['2025-11-25', 'legacy'],
] as const) {
  test(`protocol ${era}: a default (thin) search returns rows, not an output-schema error`, async () => {
    const { handler } = setup(thinSearch);
    const client = await connect(handler, mode as any, 'k');
    try {
      await client.listTools(); // as every host does: this is where the client learns the output schemas
      for (const [name, args, rows] of [
        ['search_leads', { job_titles: ['CEO'] }, 'leads'],
        ['search_leads', { job_titles: ['CEO'], detail: 'thin' }, 'leads'],
        ['search_companies', { industries: ['Security and Investigations'], limit: 2 }, 'companies'],
        ['search_companies', { industries: ['Security and Investigations'], detail: 'thin' }, 'companies'],
      ] as const) {
        const r: any = await client.callTool({ name, arguments: args });
        assert.notEqual(r.isError, true, `${name} ${JSON.stringify(args)}: ${JSON.stringify(r.content)}`);
        assert.equal(r.structuredContent.detail, 'thin');
        assert.equal(r.structuredContent.cost.amount_charged_usd, 0);
        assert.deepEqual(r.structuredContent.free_tier, FREE_TIER);
        assert.equal(r.structuredContent[rows].length, 1);
      }
    } finally {
      await client.close();
      await handler.close();
    }
  });
}
