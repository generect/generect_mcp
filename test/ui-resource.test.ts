import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from '../src/mcp-server.ts';
import { UI_RESOURCE_URI, UI_TOOLS } from '../src/ui.ts';

// What a host that speaks MCP Apps reads: which tools point at a view, and the
// view resource itself. Hosts that don't speak it ignore both.

async function connect() {
  const server = createMcpServer(fetch, 'https://api.example.test', '');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'ui-test', version: '0' });
  await client.connect(b);
  return client;
}

test('tools with a view point at the one Generect view; the rest carry no UI metadata', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  for (const t of tools) {
    const ui = (t._meta as any)?.ui;
    if (UI_TOOLS.has(t.name)) {
      assert.equal(ui?.resourceUri, UI_RESOURCE_URI, t.name);
      // The SDK also writes the legacy flat key older hosts read.
      assert.equal((t._meta as any)?.['ui/resourceUri'], UI_RESOURCE_URI, t.name);
    } else {
      assert.equal(ui, undefined, t.name);
    }
  }
  // Every tool in UI_TOOLS really exists (a typo would silently drop a view).
  const names = new Set(tools.map(t => t.name));
  for (const n of UI_TOOLS) assert.ok(names.has(n), `${n} is in UI_TOOLS but not registered`);
  await client.close();
});

test('the view resource is listed and readable as an MCP App page', async () => {
  const client = await connect();
  const { resources } = await client.listResources();
  const listed = resources.find(r => r.uri === UI_RESOURCE_URI);
  assert.ok(listed, JSON.stringify(resources.map(r => r.uri)));
  assert.equal(listed!.mimeType, 'text/html;profile=mcp-app');

  const read = await client.readResource({ uri: UI_RESOURCE_URI });
  const page: any = read.contents[0];
  assert.equal(page.mimeType, 'text/html;profile=mcp-app');
  assert.match(page.text, /^<!doctype html>/);
  // Without the color-scheme meta, Chromium paints an opaque backdrop in dark mode.
  assert.match(page.text, /<meta name="color-scheme" content="light dark">/);
  assert.match(page.text, /<script>/);
  assert.ok(!/<script src=/i.test(page.text), 'the page must be self-contained');
  assert.deepEqual(page._meta?.ui?.csp, { connectDomains: [], resourceDomains: ['https://assets.claude.ai'] });
  assert.equal(page._meta?.ui?.prefersBorder, false);
  await client.close();
});
