import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';
const rawApiKey = process.env.GENERECT_API_KEY || '';
const apiKey = rawApiKey && rawApiKey.startsWith('Token ') ? rawApiKey : (rawApiKey ? `Token ${rawApiKey}` : '');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'] }));

const transports = new Map<string, any>();

app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const server = new McpServer({ name: 'generect-api', version: '1.0.0' });
    registerTools(server, fetch, apiBase, apiKey);
    await server.connect(transport);
    if (transport.sessionId) transports.set(transport.sessionId, transport);
  }

  if (!transport) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No session' }, id: null });
  await transport.handleRequest(req as any, res as any, req.body);
});

app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return res.status(400).send('Invalid or missing session ID');
  await transport.handleRequest(req as any, res as any);
});

const port = Number(process.env.MCP_PORT || 3000);
app.listen(port, () => {
  console.log(`MCP HTTP server listening on port ${port}`);
});


