import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'] }));

// Extract and validate Generect API key from Authorization header
const extractApiKey = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  // Ensure it has Token prefix for Generect API
  return token.startsWith('Token ') ? token : `Token ${token}`;
};

const transports = new Map<string, any>();
const sessionApiKeys = new Map<string, string>();

// Main MCP endpoint - POST for client messages
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined;

  // Debug logging
  console.log('[MCP POST] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('[MCP POST] Body:', JSON.stringify(req.body, null, 2));
  console.log('[MCP POST] Session ID:', sessionId);
  console.log('[MCP POST] Active sessions:', Array.from(transports.keys()));

  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    const clientApiKey = extractApiKey(req);

    // Use demo API key if none provided (for testing)
    const apiKey = clientApiKey || process.env.GENERECT_API_KEY || 'Token 2c1a9b7c045db3ec42e8d8126b26a7eef171b157';
    console.log('[MCP POST] Using API key:', apiKey.substring(0, 15) + '...');

    const newSessionId = randomUUID();
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId });
    const server = new McpServer({ name: 'generect-api', version: '1.0.0' });
    registerTools(server, fetch, apiBase, apiKey);
    await server.connect(transport);

    // Store transport using the newSessionId we generated, not transport.sessionId (which may be undefined)
    transports.set(newSessionId, transport);
    sessionApiKeys.set(newSessionId, apiKey);
  }

  if (!transport) {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No session' },
      id: null
    });
  }

  await transport.handleRequest(req as any, res as any, req.body);
});

// Main MCP endpoint - GET for server-to-client streaming
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  const transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    return res.status(400).send('Invalid or missing session ID');
  }

  await transport.handleRequest(req as any, res as any);
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', transport: 'streamable-http' });
});

const port = Number(process.env.MCP_PORT || 3000);
app.listen(port, () => {
  console.log(`MCP HTTP server listening on port ${port}`);
  console.log(`Transport: Streamable HTTP (MCP)`);
  console.log(`Authentication: Client provides Generect API key via Authorization: Bearer <key>`);
  console.log(`API Base: ${apiBase}`);
});
