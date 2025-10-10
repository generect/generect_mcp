## Generect Live API - Remote MCP Server

Remote MCP server exposing Generect Live API tools. Users connect with their own API keys.

### Available Tools

- `search_leads` - Search for leads by ICP filters
- `search_companies` - Search for companies by ICP filters
- `generate_email` - Generate email by first/last name and domain
- `get_lead_by_url` - Get LinkedIn lead by profile URL
- `health` - Health check against the API

---

## How to Use

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "generect-api": {
      "url": "https://generect-mcp.onrender.com/mcp",
      "headers": {
        "Authorization": "Bearer Token <YOUR_GENERECT_API_KEY>"
      }
    }
  }
}
```

Replace `<YOUR_GENERECT_API_KEY>` with your Generect API key.

### Cursor

Add to MCP configuration file:

**Windows:** `%APPDATA%\Cursor\User\globalStorage\mcp\mcp.json`
**macOS:** `~/Library/Application Support/Cursor/User/globalStorage/mcp/mcp.json`
**Linux:** `~/.config/Cursor/User/globalStorage/mcp/mcp.json`

```json
{
  "mcpServers": {
    "generect-api": {
      "url": "https://generect-mcp.onrender.com/mcp",
      "headers": {
        "Authorization": "Bearer Token <YOUR_GENERECT_API_KEY>"
      }
    }
  }
}
```

Replace `<YOUR_GENERECT_API_KEY>` with your Generect API key. After saving, restart Cursor.

### Windsurf

Add to MCP configuration file:

**Windows:** `%APPDATA%\Windsurf\User\globalStorage\mcp\mcp.json`
**macOS:** `~/Library/Application Support/Windsurf/User/globalStorage/mcp/mcp.json`
**Linux:** `~/.config/Windsurf/User/globalStorage/mcp/mcp.json`

```json
{
  "mcpServers": {
    "generect-api": {
      "url": "https://generect-mcp.onrender.com/mcp",
      "headers": {
        "Authorization": "Bearer Token <YOUR_GENERECT_API_KEY>"
      }
    }
  }
}
```

Replace `<YOUR_GENERECT_API_KEY>` with your Generect API key. After saving, restart Windsurf.

---

## Server URL

**Production:** `https://generect-mcp.onrender.com/mcp`

Get your Generect API key from [Generect Dashboard](https://app.generect.com)
