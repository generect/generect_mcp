import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';
const rawApiKey = process.env.GENERECT_API_KEY || '';
const apiKey = rawApiKey && rawApiKey.startsWith('Token ') ? rawApiKey : (rawApiKey ? `Token ${rawApiKey}` : '');

const server = new McpServer({ name: 'generect-api', version: '1.0.0' });

registerTools(server, fetch, apiBase, apiKey);

const transport = new StdioServerTransport();
await server.connect(transport);


