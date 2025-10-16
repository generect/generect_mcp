## Generect Live API MCP Server

Minimal MCP server exposing Generect Live API tools for B2B lead generation and company search.

### Get Your API Key

Sign up and get your API key at [https://beta.generect.com](https://beta.generect.com)

### Remote MCP Server (Recommended)

Use our hosted MCP server via [MCP Registry](https://registry.modelcontextprotocol.io):

```json
{
  "mcpServers": {
    "generect": {
      "command": "mcp-remote",
      "args": [
        "https://mcp.generect.com/mcp",
        "--header",
        "Authorization: Bearer Token YOUR_API_KEY"
      ]
    }
  }
}
```

Replace `YOUR_API_KEY` with your key from [beta.generect.com](https://beta.generect.com).

### Local Installation (Alternative)

1) Requirements: Node >= 18

2) Configure environment (usually via your MCP client settings):

```bash
GENERECT_API_BASE=https://api.generect.com
GENERECT_API_KEY=Token <api-key>
GENERECT_TIMEOUT_MS=60000
```

3) Local dev (optional)

```bash
npm install
npm run dev
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

