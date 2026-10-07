import { McpServer } from '@modelcontextprotocol/server';
import { registerTools } from './tools.js';
import { registerUiResource } from './ui.js';
import { VERSION, SERVER_NAME } from './version.js';

type Fetcher = typeof fetch;

// The tool, resource and prompt lists depend on nothing per user or per request,
// so clients and the caches in front of them may share them for a while.
// Protocol revision 2026-07-28 makes ttlMs/cacheScope mandatory on list results;
// without a hint the SDK sends ttlMs 0 (do not cache). 2025-era responses omit them.
export const LIST_CACHE = { ttlMs: 10 * 60 * 1000, cacheScope: 'public' as const };

/** One configured server instance; transports decide how many of them live. */
export function createMcpServer(fetcher: Fetcher, apiBase: string, apiKey: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { cacheHints: { 'tools/list': LIST_CACHE, 'resources/list': LIST_CACHE, 'prompts/list': LIST_CACHE } },
  );
  registerTools(server, fetcher, apiBase, apiKey);
  registerUiResource(server);
  return server;
}
