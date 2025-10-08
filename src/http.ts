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

// Normalize Authorization header values so we accept Bearer/Token/plain API keys.
const normalizeToken = (value?: string | null): string | null => {
  if (!value) return null;
  let token = value.trim();
  if (!token) return null;

  // Strip any number of repeated Bearer/Token prefixes that might have been added by clients.
  while (token.toLowerCase().startsWith('bearer ')) {
    token = token.slice(7).trim();
  }
  while (token.toLowerCase().startsWith('token ')) {
    token = token.slice(6).trim();
  }

  if (!token) return null;
  return `Token ${token}`;
};

// Extract and validate Generect API key from Authorization header
const extractApiKey = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  return normalizeToken(authHeader);
};

const transports = new Map<string, any>();
const sessionApiKeys = new Map<string, string>();

const looksLikeInitializeRequest = (body: unknown): boolean => {
  if (isInitializeRequest(body)) {
    return true;
  }
  if (!body || typeof body !== 'object') {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  const method = candidate.method;
  if (typeof method !== 'string') {
    return false;
  }
  if (method.toLowerCase() !== 'initialize') {
    return false;
  }
  const params = candidate.params;
  if (params !== undefined && typeof params !== 'object') {
    return false;
  }
  return true;
};

// Main MCP endpoint - POST for client messages
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && looksLikeInitializeRequest(req.body)) {
    const clientApiKey = extractApiKey(req);
    if (!clientApiKey) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: Missing Authorization header with Generect API key' },
        id: null
      });
    }

    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const server = new McpServer({ name: 'generect-api', version: '1.0.0' });
    registerTools(server, fetch, apiBase, clientApiKey);
    await server.connect(transport);

    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
      sessionApiKeys.set(transport.sessionId, clientApiKey);
    }
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
