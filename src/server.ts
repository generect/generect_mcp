import 'dotenv/config';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from './mcp-server.js';
import { toAuthHeader } from './auth/credential.js';

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';
const rawApiKey = process.env.GENERECT_API_KEY || '';
const apiKey = toAuthHeader(rawApiKey);

// serveStdio owns the era decision for the connection: a 2026-07-28 client opens
// with server/discover and is served statelessly, a 2025-era client opens with
// initialize and gets the same server it always did. One instance per connection.
serveStdio(() => createMcpServer(fetch, apiBase, apiKey));
