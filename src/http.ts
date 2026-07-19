import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';
import { VERSION, SERVER_NAME } from './version.js';
import {
  handleProtectedResourceMetadata,
  handleAuthorizationServerMetadata,
  handleJwks,
  oauthRouter,
  requireBearerAuth,
  AuthenticatedRequest,
  getPublicKeyJwk,
  assertEncryptionKeyConfigured,
} from './auth/index.js';

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';
const rawApiKey = process.env.GENERECT_API_KEY || '';
const apiKey = rawApiKey && rawApiKey.startsWith('Token ') ? rawApiKey : rawApiKey ? `Token ${rawApiKey}` : '';
const allowedOrigins = process.env.MCP_ALLOWED_ORIGINS
  ? process.env.MCP_ALLOWED_ORIGINS.split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  : [
      'https://beta.generect.com',
      'https://generect.com',
      'https://app.generect.com',
      // First-party MCP clients whose web apps call the discovery endpoints
      // from their own origin during connect.
      'https://claude.ai',
      'https://linear.app',
    ];

const isAllowedOrigin = (origin: string): boolean => {
  // Always allow localhost for local development.
  if (/^https?:\/\/localhost(?::\d+)?$/i.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin)) return true;
  if (/^https:\/\/([a-z0-9-]+\.)*generect\.com$/i.test(origin)) return true;
  return allowedOrigins.includes(origin);
};

const app = express();
// Trust the loopback reverse proxy (nginx) so req.ip reflects the real client
// address from X-Forwarded-For for per-IP rate limiting. Only loopback is
// trusted, so a direct client cannot spoof XFF.
app.set('trust proxy', 'loopback');

// Structured access logging for every request. nginx logs the transport view;
// this logs the application view (including the OAuth client_id and the MCP
// session), which is what you actually need to debug a failed integration.
// Never logs credentials: the Authorization header and any token/secret query
// parameters are omitted.
const LOG_REQUESTS = process.env.MCP_LOG_REQUESTS !== '0' && process.env.MCP_LOG !== '0';
app.use((req: Request, res: Response, next) => {
  if (!LOG_REQUESTS) return next();
  const started = Date.now();
  res.on('finish', () => {
    try {
      const q = req.query as Record<string, unknown>;
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'http_request',
          method: req.method,
          path: (req.originalUrl || req.url).split('?')[0],
          status: res.statusCode,
          ms: Date.now() - started,
          ip: req.ip ?? null,
          origin: (req.headers.origin as string) ?? null,
          ua: (req.headers['user-agent'] as string) ?? null,
          // OAuth/MCP correlation handles — identifiers, never secrets.
          client_id: typeof q.client_id === 'string' ? q.client_id : undefined,
          redirect_uri: typeof q.redirect_uri === 'string' ? q.redirect_uri : undefined,
          session: (req.headers['mcp-session-id'] as string) ?? undefined,
          authenticated: req.headers.authorization ? true : false,
        }),
      );
    } catch {
      /* logging must never break a request */
    }
  });
  next();
});

app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser clients (e.g. curl, MCP clients) that do not set Origin.
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);
      // Log WHICH origin was refused — without this the error is undiagnosable
      // (it previously surfaced as a bare stack trace with no origin).
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'cors_rejected',
          origin,
        }),
      );
      return callback(new Error(`CORS origin is not allowed: ${origin}`));
    },
    exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
  }),
);

app.use(express.urlencoded({ extended: true }));

app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf?.toString() ?? '';
    },
  }),
);

app.get('/.well-known/oauth-protected-resource', handleProtectedResourceMetadata);
app.get('/.well-known/oauth-authorization-server', handleAuthorizationServerMetadata);
app.get('/.well-known/jwks.json', handleJwks);

app.use('/oauth', oauthRouter);

const transports = new Map<string, StreamableHTTPServerTransport>();

function createMcpServer() {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
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
    version: VERSION,
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

async function start() {
  // Fail fast at startup rather than on the first victim: in production a missing
  // or default security secret throws here, instead of the server silently coming
  // up and issuing forgeable tokens or encrypting with a source-visible key.
  await getPublicKeyJwk();
  assertEncryptionKeyConfigured();

  app.listen(port, () => {
    console.log(`MCP HTTP server listening on port ${port} (v${VERSION})`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`OAuth authorize: http://localhost:${port}/oauth/authorize`);
    console.log(`Protected Resource Metadata: http://localhost:${port}/.well-known/oauth-protected-resource`);
  });
}

start().catch(err => {
  console.error('[startup] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
