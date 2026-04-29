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

### Local Installation (Alternative)

For local development or when OAuth is not needed:

1) Requirements: Node >= 18

2) Configure environment:

```bash
GENERECT_API_BASE=https://api.generect.com
GENERECT_API_KEY=Token <api-key>
GENERECT_TIMEOUT_MS=60000
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
        "GENERECT_TIMEOUT_MS": "60000"
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
        "GENERECT_TIMEOUT_MS": "60000",
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

### Docker

Build locally:

```bash
docker build -t ghcr.io/generect/generect_mcp:local .
```

Run the server in a container:

```bash
docker run --rm \
  -e GENERECT_API_BASE=https://api.generect.com \
  -e GENERECT_API_KEY="Token YOUR_API_KEY" \
  -e JWT_SIGNING_KEY="your-secret-key" \
  -e TOKEN_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef" \
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
        "GENERECT_TIMEOUT_MS": "60000"
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
- **Token encryption** uses AES-256-GCM with keys derived from your configuration
- **PKCE** is required for all authorization code flows (S256 method)
- **Dynamic Client Registration** allows any MCP client to self-register
- **Audience validation** ensures tokens are only used with this MCP server