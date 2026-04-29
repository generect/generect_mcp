import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';
import {
  handleProtectedResourceMetadata,
  handleAuthorizationServerMetadata,
  handleJwks,
  oauthRouter,
  requireBearerAuth,
  AuthenticatedRequest,
} from './auth/index.js';

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';
const rawApiKey = process.env.GENERECT_API_KEY || '';
const apiKey = rawApiKey && rawApiKey.startsWith('Token ') ? rawApiKey : (rawApiKey ? `Token ${rawApiKey}` : '');
const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS
  ? process.env.MCP_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : ['https://beta.generect.com', 'https://generect.com', 'https://app.generect.com']);

const isAllowedOrigin = (origin: string): boolean => {
  // Always allow localhost for local development.
  if (/^https?:\/\/localhost(?::\d+)?$/i.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin)) return true;
  if (/^https:\/\/([a-z0-9-]+\.)*generect\.com$/i.test(origin)) return true;
  return allowedOrigins.includes(origin);
};

const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser clients (e.g. curl, MCP clients) that do not set Origin.
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('CORS origin is not allowed'));
  },
  exposedHeaders: ['Mcp-Session-Id'],
}));

app.use(express.urlencoded({ extended: true }));

app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf?.toString() ?? '';
    },
  }),
);

app.use(
  cors({
    origin: '*',
    exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
  }),
);

app.get('/.well-known/oauth-protected-resource', handleProtectedResourceMetadata);
app.get('/.well-known/oauth-authorization-server', handleAuthorizationServerMetadata);
app.get('/.well-known/jwks.json', handleJwks);

app.use('/oauth', oauthRouter);

const transports = new Map<string, StreamableHTTPServerTransport>();

function createMcpServer() {
  const server = new McpServer({ name: 'generect-api', version: '1.0.0' });
  registerTools(server, fetch, apiBase, apiKey);
  return server;
}

app.options('/mcp', (req: Request, res: Response) => {
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.status(204).end();
});

app.post('/mcp', requireBearerAuth, async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sessionId => {
        transports.set(sessionId, transport!);
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) {
        transports.delete(transport!.sessionId);
      }
    };
    const server = createMcpServer();
    await server.connect(transport);
  }

  if (!transport) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No session' }, id: null });
    return;
  }

  await transport.handleRequest(req as any, res as any, req.body);
});

app.get('/mcp', requireBearerAuth, async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  (req as any).apiToken = req.apiToken;
  await transport.handleRequest(req as any, res as any);
});

app.delete('/mcp', requireBearerAuth, async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  (req as any).apiToken = req.apiToken;
  await transport.handleRequest(req as any, res as any);
});

app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'Generect MCP Server',
    version: '1.0.0',
    endpoints: {
      mcp: '/mcp',
      oauth_authorize: '/oauth/authorize',
      oauth_token: '/oauth/token',
      oauth_register: '/oauth/register',
      protected_resource_metadata: '/.well-known/oauth-protected-resource',
      authorization_server_metadata: '/.well-known/oauth-authorization-server',
      jwks: '/.well-known/jwks.json',
    },
  });
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const port = Number(process.env.MCP_PORT || 3000);
app.listen(port, () => {
  console.log(`MCP HTTP server listening on port ${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`OAuth authorize: http://localhost:${port}/oauth/authorize`);
  console.log(`Protected Resource Metadata: http://localhost:${port}/.well-known/oauth-protected-resource`);
});
