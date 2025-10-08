## Generect Live API - Remote MCP Server

Remote MCP server exposing Generect Live API tools. Users connect with their own API keys.

### Tools

- `search_leads`: Search for leads by ICP filters
- `search_companies`: Search for companies by ICP filters
- `generate_email`: Generate email by first/last name and domain
- `get_lead_by_url`: Get LinkedIn lead by profile URL
- `health`: Health check against the API

All tools support `timeout_ms` parameter.

---

## Deploy to Render

1. Fork this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com/)
3. Click **New** → **Blueprint**
4. Connect your GitHub repo
5. Render auto-deploys using `render.yaml`

Your server will be at: `https://your-app-name.onrender.com/mcp`

**Manual deployment:**
- Runtime: **Node**
- Build: `npm install && npm run build`
- Start: `node dist/http.js`
- Health Check: `/health`

---

## Usage

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "generect-api": {
      "url": "https://your-app-name.onrender.com/mcp",
      "headers": {
        "Authorization": "Bearer Token <YOUR_GENERECT_API_KEY>"
      }
    }
  }
}
```

Replace:
- `your-app-name.onrender.com` with your Render URL
- `<YOUR_GENERECT_API_KEY>` with your Generect API key

### Claude API (MCP Connector)

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: mcp-client-2025-04-04" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-3-7-sonnet-20250219",
    "max_tokens": 1024,
    "messages": [{
      "role": "user",
      "content": "Search for 10 leads in tech companies"
    }],
    "mcp_servers": [{
      "url": "https://your-app-name.onrender.com/mcp",
      "authorization_token": "Token <your-generect-api-key>"
    }]
  }'
```

### MCP Inspector

Test your server:

```bash
npx @modelcontextprotocol/inspector \
  --transport streamableHttp \
  --url https://your-app-name.onrender.com/mcp \
  --header "Authorization: Bearer Token <your-generect-api-key>"
```

### Custom MCP Client

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport({
  url: 'https://your-app-name.onrender.com/mcp',
  headers: {
    'Authorization': 'Bearer Token <your-generect-api-key>'
  }
});

const client = new Client({
  name: 'my-client',
  version: '1.0.0'
}, {
  capabilities: {}
});

await client.connect(transport);
const tools = await client.listTools();
```

---

## Local Development

```bash
npm install
npm run dev:http   # Start HTTP server on port 3000
npm run build      # Build TypeScript
```

### Testing

```bash
# Health check
npm run health -- <api-key>

# Test authentication
npm run test:auth -- http://localhost:3000/mcp <api-key>
```

### Environment Variables

```bash
GENERECT_API_BASE=https://api.generect.com  # Generect API endpoint
MCP_PORT=3000                                # Port (10000 for Render)
```

---

## Docker

Build:
```bash
docker build -t generect-mcp:latest .
```

Run:
```bash
docker run --rm -p 3000:3000 \
  -e GENERECT_API_BASE=https://api.generect.com \
  -e MCP_PORT=3000 \
  generect-mcp:latest \
  node dist/http.js
```

---

## Architecture

- **Transport**: Streamable HTTP (MCP SDK)
- **Endpoints**:
  - `POST /mcp` - Client messages (JSON-RPC 2.0)
  - `GET /mcp` - Server streaming (SSE)
  - `GET /health` - Health check
- **Authentication**: Per-request via `Authorization: Bearer Token <key>` header
- **Multi-tenant**: Each client uses their own Generect API key

---

## License

MIT
