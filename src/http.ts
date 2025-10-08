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
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
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
