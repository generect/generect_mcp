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
  if (!authHeader) return null;

  // Support multiple formats:
  // 1. "Bearer Token XXX" (from local MCP clients with explicit "Token " prefix)
  // 2. "Bearer XXX" where XXX is the raw Generect API key (from Claude.ai Custom Connectors)
  // 3. "Token XXX" (direct format)

  if (authHeader.startsWith('Bearer Token ')) {
    return authHeader.substring(7); // "Token XXX"
  }
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    // If token already has "Token " prefix, use as-is, otherwise add it
    return token.startsWith('Token ') ? token : `Token ${token}`;
  }
  if (authHeader.startsWith('Token ')) {
    return authHeader;
  }

  return null;
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
  let apiKey = sessionId ? sessionApiKeys.get(sessionId) : null;

  if (!transport && isInitializeRequest(req.body)) {
    const clientApiKey = extractApiKey(req);
    apiKey = clientApiKey || process.env.GENERECT_API_KEY || null;

    if (!apiKey) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized: API key required' },
        id: null
      });
    }

    console.log('[MCP POST] Initialize with API key:', apiKey?.substring(0, 15) + '...');

    const newSessionId = randomUUID();
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId });
    const server = new McpServer({ name: 'generect-api', version: '1.0.0' });

    // Pass callback that dynamically retrieves API key for this session
    registerTools(server, fetch, apiBase, () => sessionApiKeys.get(newSessionId) || apiKey!);
    await server.connect(transport);

    transports.set(newSessionId, transport);
    sessionApiKeys.set(newSessionId, apiKey);

    console.log('[MCP POST] Created session:', newSessionId);
  }

  if (!transport) {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No session' },
      id: null
    });
  }

  // ВАЖЛИВО: Для non-initialize запитів оновлюємо API ключ з поточного request
  if (!isInitializeRequest(req.body)) {
    const currentApiKey = extractApiKey(req);
    if (currentApiKey && sessionId) {
      sessionApiKeys.set(sessionId, currentApiKey);
      console.log('[MCP POST] Updated API key for session:', sessionId);
    }
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
  console.log(`Authentication: Supports multiple formats:`);
  console.log(`  - Local MCP clients: Authorization: Bearer Token <GENERECT_API_KEY>`);
  console.log(`  - Claude.ai Custom Connectors: authorization_token parameter with Generect API key`);
  console.log(`API Base: ${apiBase}`);
});
