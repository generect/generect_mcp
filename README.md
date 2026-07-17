## Generect Live API MCP Server

Minimal MCP server exposing Generect Live API tools for B2B lead generation and company search.

### Get Your API Key

Sign up and get your API key at [https://beta.generect.com](https://beta.generect.com)

### Remote MCP Server (OAuth - Recommended)

This MCP server implements OAuth 2.1 authorization as specified by the Model Context Protocol. 

Use our hosted MCP server with any OAuth-compliant MCP client:

```json
{
  "mcpServers": {
    "generect": {
      "url": "https://mcp.generect.com/mcp",
      "type": "http"
    }
  }
}
```

When you first connect, the client will initiate an OAuth flow:
1. You'll be redirected to the authorization page
2. Enter your Generect API token from [beta.generect.com](https://beta.generect.com)
3. Authorize the client to access your API
4. The client receives an access token and can now use the MCP tools

### OAuth Endpoints

| Endpoint | Description |
|----------|-------------|
| `/.well-known/oauth-protected-resource` | Protected Resource Metadata (RFC 9728) |
| `/.well-known/oauth-authorization-server` | Authorization Server Metadata (RFC 8414) |
| `/.well-known/jwks.json` | JSON Web Key Set for token verification |
| `/oauth/authorize` | Authorization endpoint (login + consent) |
| `/oauth/token` | Token endpoint |
| `/oauth/register` | Dynamic Client Registration (RFC 7591) |

### Direct API key (no OAuth)

If your MCP client cannot complete the OAuth flow, you can pass the API key directly via the `Authorization` header. The server accepts any of:

```
Authorization: YOUR_API_KEY
Authorization: Bearer YOUR_API_KEY
Authorization: Token YOUR_API_KEY
Authorization: Bearer Token YOUR_API_KEY   (legacy)
```

Example for `mcp-remote`:

```json
{
  "mcpServers": {
    "generect": {
      "command": "mcp-remote",
      "args": [
        "https://mcp.generect.com/mcp",
        "--header",
        "Authorization: Bearer YOUR_API_KEY"
      ]
    }
  }
}
```

### Local Installation (Alternative)

For local development or when OAuth is not needed:

1) Requirements: Node >= 18

2) Configure environment:

```bash
GENERECT_API_BASE=https://api.generect.com
GENERECT_API_KEY=Token <api-key>
GENERECT_TIMEOUT_MS=300000
JWT_SIGNING_KEY=<your-secret-key-for-jwt-signing>
TOKEN_ENCRYPTION_KEY=<32-byte-hex-key-for-token-encryption>
```

3) Local dev (optional)

```bash
npm install
npm run dev:http
```

4) Build and start (stdio server)

```bash
npm run build && npm start
```

### Logging

The server emits one structured JSON log line per event to **stderr** (stdout is reserved for the MCP stdio protocol). Metadata logging is **on by default**; set `MCP_LOG=0` to disable it entirely.

**Privacy — payloads are redacted by default.** Request/response payloads can contain personal data of prospects (names, company domains, generated emails). By default these values are **not** logged verbatim: each is reduced to a non-identifying shape marker (e.g. `"first_name": "<str:4>"`), so you can see *which* fields were sent without recording the data itself. Set `MCP_LOG_PAYLOADS=1` to log payloads verbatim — intended for short-lived debugging, with the data owner's consent.

Events:

| `event` | When | Key fields |
|---------|------|------------|
| `tool_call` | LLM invokes a tool | `reqId`, `tool`, `input` (redacted unless `MCP_LOG_PAYLOADS=1`) |
| `api_request` | Outbound call to Generect API | `url`, `method`, `body` (redacted unless `MCP_LOG_PAYLOADS=1`; never the token) |
| `api_response` | Generect API responded | `url`, `status`, `ms` |
| `tool_result` | Result returned to the LLM | `reqId`, `tool`, `ms`, `output` (redacted unless `MCP_LOG_PAYLOADS=1`) |
| `tool_error` / `api_error` | Failure | `reqId`/`url`, `error`, `ms` |

`reqId` correlates a `tool_call` with its `tool_result`. Set `MCP_DEBUG=1` for additional verbose output.

The hosted server runs under **PM2** (not Docker). View logs on the host with:

```bash
pm2 logs generect-mcp                                # live
pm2 logs generect-mcp --err                          # errors only
grep tool_call ~/.pm2/logs/generect-mcp-out.log      # only LLM tool inputs
```

### Tools

- `search_leads`: Search for leads by ICP filters (supports `timeout_ms`)
- `search_companies`: Search for companies by ICP filters (supports `timeout_ms`)
- `generate_email`: Generate email by first/last name and domain (supports `timeout_ms`)
- `get_lead_by_url`: Get LinkedIn lead by profile URL (supports `timeout_ms`)
- `health`: Quick health check against the API (optional `url`, supports `timeout_ms`)

### Cursor integration (settings.json excerpt)

```json
{
  "mcpServers": {
    "generect-liveapi": {
      "command": "node",
      "args": ["./node_modules/tsx/dist/cli.mjs", "src/server.ts"],
      "env": {
        "GENERECT_API_BASE": "https://api.generect.com",
        "GENERECT_API_KEY": "Token YOUR_API_KEY",
        "GENERECT_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

### Claude Desktop (MCP) setup

Add to `~/.claude/claude_desktop_config.json` (or via UI → MCP Servers). Recommended: run via npx so users don't install anything globally.

```json
{
  "mcpServers": {
    "generect-api": {
      "command": "npx",
      "args": ["-y", "generect-ultimate-mcp@latest"],
      "env": {
        "GENERECT_API_BASE": "https://api.generect.com",
        "GENERECT_API_KEY": "Token YOUR_API_KEY",
        "GENERECT_TIMEOUT_MS": "300000",
        "MCP_DEBUG": "0"
      }
    }
  }
}
```

macOS note: If Claude shows "spawn npx ENOENT" or launches an older Node via nvm, set `command` to the absolute npx path and/or override PATH:

```json
{
  "command": "/usr/local/bin/npx",
  "env": { "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }
}
```

Alternative without npx:

```bash
npm i -g generect-ultimate-mcp
```

Then use:

```json
{ "command": "/usr/local/bin/generect-mcp", "args": [] }
```

### Deployment (production, PM2)

The hosted server (`https://mcp.generect.com`) runs under **PM2** on the host, fronted by nginx (TLS). The process is defined by [`ecosystem.config.js`](./ecosystem.config.js):

```bash
npm ci && npm run build
pm2 start ecosystem.config.js      # or: pm2 reload ecosystem.config.js
pm2 save                           # persist the process list for reboot
# once, as root, so it survives reboots:
#   pm2 startup systemd -u mcp_user --hp /home/mcp_user
```

**Single instance only.** OAuth state (registered clients, auth codes) and MCP sessions are held in memory, so the server must run as one instance. Scaling horizontally requires a shared store (e.g. Redis) first — see `ecosystem.config.js`.

**Required secrets (fail-closed).** In production (`NODE_ENV=production`) the server refuses to start unless `JWT_SIGNING_KEY` is set to a strong, non-default value; it never falls back to a hardcoded default or an ephemeral key. `TOKEN_ENCRYPTION_KEY`, if set, must be exactly 64 hex characters (32 bytes).

### Docker

Docker is supported for local/alternative runs. Build locally:

```bash
docker build -t ghcr.io/generect/generect_mcp:local .
```

Run the server in a container (note: the same production secrets are required — an
insecure default will cause the container to exit at startup):

```bash
docker run --rm \
  -e NODE_ENV=production \
  -e GENERECT_API_BASE=https://api.generect.com \
  -e GENERECT_API_KEY="Token YOUR_API_KEY" \
  -e JWT_SIGNING_KEY="a-strong-random-secret" \
  -e TOKEN_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" \
  -e OAUTH_BASE_URL=https://your-domain.com \
  -p 3000:3000 \
  ghcr.io/generect/generect_mcp:local
```

### Remote over SSH (advanced)

Some MCP clients allow spawning the server via SSH, using stdio over the SSH session. Example config:

```json
{
  "mcpServers": {
    "generect-remote": {
      "command": "ssh",
      "args": [
        "user@remote-host",
        "-T",
        "node",
        "/opt/generect_mcp/dist/server.js"
      ],
      "env": {
        "GENERECT_API_BASE": "https://api.generect.com",
        "GENERECT_API_KEY": "Token YOUR_API_KEY",
        "GENERECT_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

### Local testing helpers

- Run a simple health check against the API:

```bash
npm run health -- <api-key>
```

- Call tools via a local MCP client:

```bash
npm run mcp:client -- <api-key>
```

### Security Notes

- **OAuth tokens** are JWTs signed by the server and contain your encrypted API token
- **Token encryption** uses AES-256-GCM with a key from `TOKEN_ENCRYPTION_KEY` (or derived from `JWT_SIGNING_KEY`)
- **Fail-closed secrets** — in production the server refuses to start with a missing or well-known-default `JWT_SIGNING_KEY`, and never publishes symmetric key material in the JWKS
- **Bounded, refreshable tokens** — access tokens expire (default 30 days, `ACCESS_TOKEN_TTL_SECONDS`) and are renewed via a `refresh_token` grant; refresh tokens are rotated on use and revocable at `POST /oauth/revoke` (RFC 7009). Tokens issued before this change remain valid (no forced re-auth)
- **PKCE** is required for all authorization code flows (S256 method)
- **Dynamic Client Registration** allows any MCP client to self-register, but is now **rate-limited per IP** (`MCP_REGISTER_RATE_MAX`, default 60/hour) and the client store is **capped** (`MCP_MAX_CLIENTS`, default 5000, LRU eviction that never drops an in-use client)
- **SSRF-guarded metadata fetches** — the client-id-metadata-document flow (`MCP_ENABLE_CIMD`, default on) fetches only `https` URLs that resolve exclusively to public IPs, with no redirect following, a hard timeout, and a response-size cap (blocks loopback / RFC1918 / link-local / cloud-metadata targets)
- **Token validation fails closed** — if Generect cannot confirm a token during login (upstream error), the server declines to mint an access token instead of assuming validity
- **Audience + algorithm pinning** ensures tokens are only used with this MCP server and only via the expected signing algorithm

#### Configuration (security-relevant env vars)

| Var | Default | Effect |
|-----|---------|--------|
| `ACCESS_TOKEN_TTL_SECONDS` | `2592000` (30d) | Access-token lifetime |
| `REFRESH_TOKEN_TTL_SECONDS` | `7776000` (90d) | Refresh-token lifetime |
| `MCP_MAX_CLIENTS` | `5000` | Cap on the in-memory DCR client store |
| `MCP_REGISTER_RATE_MAX` | `60` | Max `/oauth/register` calls per IP per window |
| `MCP_REGISTER_RATE_WINDOW_MS` | `3600000` (1h) | Rate-limit window |
| `MCP_ENABLE_CIMD` | `true` | Allow client-id-as-metadata-URL (SSRF-guarded) |
| `MCP_ALLOWED_REDIRECT_DOMAINS` | — | Extra allowed redirect hostnames (comma-separated) |
- **Log privacy** — prospect payloads are redacted from logs by default (`MCP_LOG_PAYLOADS=1` to opt in)