import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../src/mcp-server.ts';
import { resetPriceBookCache } from '../src/pricing.ts';
import { TOOL_META, TOOL_ORDER } from '../src/tool-meta.ts';

// What the Claude directory portal (claude.ai/directory/manage, step "Tools")
// reads from the live tools/list, checked on the same output. On 09.11.2026 it
// flagged six tools "to fix" because ten legacy parameters published no JSON
// Schema type (they were z.any()), and asked every tool for annotations.title,
// which directory policy 5E lists with readOnlyHint and destructiveHint.

function handler() {
  resetPriceBookCache();
  const api = (async () =>
    new Response(JSON.stringify({ data: {}, meta: { amount_charged: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return createMcpHandler(() => createMcpServer(api, 'https://api.test', ''));
}

async function listTools(mode: 'legacy' | { pin: string }) {
  const h = handler();
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.test/mcp'), {
    fetch: (url: string | URL, init?: RequestInit) => h.fetch(new Request(url, init)),
    requestInit: { headers: { Authorization: 'Token k' } },
  });
  const client = new Client({ name: 'portal-test', version: '0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools as any[];
  } finally {
    await client.close();
    await h.close();
  }
}

/** Every string a host shows or a model reads from one input property, nested ones included. */
function walkProperties(schema: any, path: string, visit: (path: string, prop: any) => void) {
  for (const [name, prop] of Object.entries<any>(schema?.properties ?? {})) {
    visit(`${path}.${name}`, prop);
    walkProperties(prop, `${path}.${name}`, visit);
    if (prop?.items) walkProperties(prop.items, `${path}.${name}[]`, visit);
  }
}

for (const [era, mode] of [
  ['2026-07-28', { pin: '2026-07-28' }],
  ['2025-11-25', 'legacy'],
] as const) {
  test(`directory portal (${era}): every tool carries annotations.title`, async () => {
    const tools = await listTools(mode as any);
    assert.equal(tools.length, TOOL_ORDER.length);
    for (const t of tools) {
      assert.equal(
        t.annotations?.title,
        TOOL_META[t.name as keyof typeof TOOL_META].title,
        `${t.name} annotations.title`,
      );
      assert.equal(t.title, t.annotations.title, `${t.name}: the two titles must agree`);
      assert.ok(
        typeof t.annotations.readOnlyHint === 'boolean' || typeof t.annotations.destructiveHint === 'boolean',
        `${t.name} needs an explicit hint`,
      );
    }
  });

  test(`directory portal (${era}): every input parameter publishes a type`, async () => {
    const tools = await listTools(mode as any);
    const untyped: string[] = [];
    for (const t of tools) {
      walkProperties(t.inputSchema, t.name, (path, prop) => {
        const typed =
          prop?.type !== undefined ||
          (Array.isArray(prop?.anyOf) &&
            prop.anyOf.length > 0 &&
            prop.anyOf.every((s: any) => s?.type !== undefined)) ||
          Array.isArray(prop?.enum);
        if (!typed) untyped.push(path);
      });
    }
    assert.deepEqual(untyped, [], 'parameters without a JSON Schema type');
  });

  test(`directory portal (${era}): no em dash in any published tool or parameter text`, async () => {
    const tools = await listTools(mode as any);
    const dashed: string[] = [];
    for (const t of tools) {
      for (const [where, text] of [
        [`${t.name}.title`, t.title],
        [`${t.name}.description`, t.description],
      ]) {
        if (typeof text === 'string' && text.includes('—')) dashed.push(where);
      }
      walkProperties(t.inputSchema, t.name, (path, prop) => {
        if (typeof prop?.description === 'string' && prop.description.includes('—')) dashed.push(path);
      });
    }
    assert.deepEqual(dashed, []);
  });
}

test('legacy parameters keep their pre-v1 types and are still accepted', async () => {
  const tools = await listTools({ pin: '2026-07-28' });
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  const expect: Record<string, Record<string, string>> = {
    search_leads: {
      exclude_title_keywords: 'array',
      lead_industries: 'array',
      get_max_leads: 'boolean',
      without_company: 'boolean',
    },
    search_companies: { get_max_companies: 'boolean', fallback_from_leads: 'boolean' },
    get_lead_by_url: {
      comments: 'boolean',
      posts: 'boolean',
      people_also_viewed: 'boolean',
      inexact_company: 'boolean',
    },
  };
  for (const [tool, params] of Object.entries(expect)) {
    for (const [p, type] of Object.entries(params)) {
      const prop = byName[tool].inputSchema.properties[p];
      assert.ok(prop, `${tool}.${p} is still declared, so the SDK does not strip it silently`);
      assert.equal(prop.type, type, `${tool}.${p}`);
      assert.match(prop.description, /^DEPRECATED: accepted but ignored\./, `${tool}.${p}`);
    }
  }
});
