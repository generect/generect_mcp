# Generect MCP Server

## Overview

The Generect MCP Server is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server that allows you to interact with the Generect Live API via LLMs. Access powerful lead generation, company search, and email finding capabilities directly through your AI assistant.

## Getting Started

**Server URL:** `https://generect-mcp.onrender.com/mcp`

Get your Generect API key from [Generect Dashboard](https://app.generect.com)

## Use Cases

- Finding and enriching B2B leads by job title, company, location, and industry
- Searching for companies based on ICP filters (headcount, industry, keywords)
- Generating professional email addresses for prospects
- Retrieving detailed LinkedIn profile data
- Building prospecting lists for sales and marketing campaigns

## Configuration

### Claude.ai Custom Connectors (Recommended)

**Available for Pro, Max, Team, and Enterprise plans**

1. Get your Generect API key from [Generect Dashboard](https://app.generect.com)
2. In Claude.ai, navigate to:
   - **Team/Enterprise**: Admin settings → Connectors
   - **Pro/Max**: Settings → Connectors
3. Click "Add custom connector"
4. Enter the server URL: `https://generect-mcp.onrender.com/mcp`
5. In the "Authorization Token" field, paste your Generect API key (e.g., `Token grt_live_xxx...`)
6. Click "Add"

Each user can provide their own Generect API key when connecting, ensuring secure and personalized access to lead generation tools.

### Claude Desktop

Add to `claude_desktop_config.json`:

**Option 1: Direct HTTP (Recommended)**

```json
{
  "mcpServers": {
    "generect": {
      "url": "https://generect-mcp.onrender.com/mcp",
      "headers": {
        "Authorization": "Bearer Token <YOUR_GENERECT_API_KEY>"
      }
    }
  }
}
```

**Option 2: Using mcp-remote proxy**

```json
{
  "mcpServers": {
    "generect": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://generect-mcp.onrender.com/mcp",
        "--header",
        "Authorization: Bearer Token ${GENERECT_API_KEY}"
      ],
      "env": {
        "GENERECT_API_KEY": "<YOUR_GENERECT_API_KEY>"
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
    "generect": {
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
    "generect": {
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

## Tools

### Leads

- **search_leads**: Search for B2B leads by ICP filters (job title, location, industry, company)
- **get_lead_by_url**: Get detailed LinkedIn profile data by profile URL

### Companies

- **search_companies**: Search for companies by ICP filters (headcount, industry, keywords)

### Email

- **generate_email**: Generate professional email addresses by first name, last name, and domain

### Utilities

- **health**: Health check for the Generect API

All tools support optional `timeout_ms` parameter for custom request timeouts.

---

## Authentication

This server supports multiple authentication formats for flexibility across different clients:

- **Claude.ai Custom Connectors**: Pass your Generect API key directly in the `authorization_token` field
- **Local MCP clients** (Claude Desktop, Cursor, Windsurf): Use `Authorization: Bearer Token <YOUR_KEY>` in headers
- **Direct API calls**: Use `Authorization: Bearer <YOUR_KEY>` or `Authorization: Token <YOUR_KEY>`

All formats are automatically normalized to work with the Generect API.

---

## Feedback

Please leave feedback via [filing a GitHub issue](https://github.com/generect/generect_mcp/issues) if you have any feature requests, bug reports, suggestions, comments, or concerns.
