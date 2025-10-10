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

## Feedback

Please leave feedback via [filing a GitHub issue](https://github.com/generect/generect_mcp/issues) if you have any feature requests, bug reports, suggestions, comments, or concerns.
