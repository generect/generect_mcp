<p align="center">
  <img src="https://raw.githubusercontent.com/generect/generect_mcp/main/assets/icon.png" width="96" height="96" alt="Generect">
</p>

<h1 align="center">Generect MCP Server</h1>

<p align="center">
  B2B lead and company data for AI agents.<br>
  Search and audience sizing are free. You pay only for the emails, phones and full profiles you keep.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/generect-ultimate-mcp"><img src="https://img.shields.io/npm/v/generect-ultimate-mcp?label=npm" alt="npm version"></a>
  <a href="https://registry.modelcontextprotocol.io/?q=com.generect"><img src="https://img.shields.io/badge/MCP%20Registry-com.generect%2Fgenerect--mcp-black" alt="MCP Registry"></a>
  <a href="https://docs.generect.com/integrations/mcp"><img src="https://img.shields.io/badge/docs-docs.generect.com-black" alt="Docs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/generect-ultimate-mcp" alt="License"></a>
</p>

## What it does

Give Claude, ChatGPT, Cursor or your own agent access to the Generect B2B database: people and companies by ICP, emails, phones and full profiles.

- **Free to explore.** Counting an audience is free, and so is a database search with thin rows (who, role, where, which company), up to a daily row quota per account.
- **Pay for what you keep.** Emails are billed only when a valid one is found, phones only when found, full profiles per record found.
- **No surprise bills.** Every tool says up front whether it costs money, every response carries a `cost` block with the amount actually charged, and calls above a spend ceiling need an explicit confirmation.
- **Safe to try.** A test key returns realistic fictional data at real speed and charges nothing.

## Connect

Get an API key at [app.generect.com/settings/api](https://app.generect.com/settings/api). Clients that support OAuth sign you in without one.

### Remote server (recommended)

`https://mcp.generect.com/mcp` speaks streamable HTTP with OAuth 2.1, so most clients only need the URL.

**Claude Code**

```bash
claude mcp add --transport http generect https://mcp.generect.com/mcp
```

**Claude.ai and Claude Desktop:** Settings, Connectors, Add custom connector, then paste `https://mcp.generect.com/mcp`.

**Cursor** (`.cursor/mcp.json`) and other JSON-configured clients:

```json
{
  "mcpServers": {
    "generect": {
      "url": "https://mcp.generect.com/mcp"
    }
  }
}
```

The first connection opens the Generect consent page in the browser. Approve it with the account you are already signed into, and the client receives its own token.

**No OAuth in your client?** Pass the key as a header, for example with `mcp-remote`:

```json
{
  "mcpServers": {
    "generect": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.generect.com/mcp", "--header", "Authorization: Bearer YOUR_API_KEY"]
    }
  }
}
```

### Local server (stdio)

```json
{
  "mcpServers": {
    "generect": {
      "command": "npx",
      "args": ["-y", "generect-ultimate-mcp@latest"],
      "env": {
        "GENERECT_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

Requires Node 20 or newer. Optional: `GENERECT_API_BASE` (default `https://api.generect.com`) and `GENERECT_TIMEOUT_MS`. If Claude Desktop on macOS reports `spawn npx ENOENT`, set `command` to the absolute path of `npx`.

### Test mode

Use a `test_…` key from [app.generect.com/settings/api](https://app.generect.com/settings/api) in any of the configs above. Every tool then answers with fictional data, shows what the real call would have cost and charges nothing. Results carry `test_mode: true` so an agent cannot mistake them for real people. See [Test mode](https://docs.generect.com/api-reference/test-mode).

## Tools

**Free**

| Tool | What it does |
|------|--------------|
| `count_leads` | How many people match an ICP, and what the next step costs at your rates. Start here. |
| `count_companies` | The same for companies. |
| `search_leads` | People matching an ICP. Free with the default thin rows (database mode, daily quota). |
| `search_companies` | Companies matching an ICP. Free with the default thin rows (database mode, daily quota). |
| `get_balance` | Balance, your real per-operation prices, and optionally spend by operation or by token. |
| `get_bulk_job` | Poll a bulk job (the work was billed at submit time). |
| `manage_webhooks` | List, create, update, delete or test webhook endpoints. |
| `health` | Liveness and credential check against a free endpoint. Safe for monitors. |

**Billable**

| Tool | Billed |
|------|--------|
| `search_leads`, `search_companies` with `detail: "full"`, in realtime mode and once the free quota is used up | per returned row |
| `preview_leads` | per returned row (`count_only: true` is free) |
| `resolve_profile` | per resolved profile, the cheapest paid call; an unresolvable link is free |
| `enrich_lead`, `get_lead_by_url` | per record found |
| `enrich_company` | per record found |
| `generate_email` | per valid email found |
| `validate_email` | per email submitted, whatever the verdict |
| `find_phone` | per phone found, the most expensive operation |
| `start_bulk_job` | per record, reserved when the job is submitted |

Prices depend on your account tier: `get_balance` returns yours, and every response reports what was actually charged.

### A budget-safe flow

```
count_leads (free)  →  search_leads, thin rows (free)  →  generate_email on the ids you keep (per valid email)
                                                        →  enrich_lead / find_phone only where needed
```

### Thin and full rows

`search_leads` and `search_companies` take `detail`:

- left out (default): thin rows while the free tier is available. Once it is not (quota spent, a custom-contract account), the search continues with full rows billed per row and says so in `thin_unavailable`.
- `"thin"`: free rows only. Never billed and never escalated to realtime; a spent quota returns a 429.
- `"full"`: the whole record, billed per row.

Thin lead rows carry id, name, job title, seniority, location and company (name, id, industry, country). Thin company rows carry id, name, industry, headcount range, HQ city and country, company type and founding year. Neither carries a LinkedIn URL, domain, contacts or history: `generate_email` takes the lead id directly, and `enrich_lead` / `enrich_company` return the full record.

### Database and realtime

Search and enrich run against the Generect database (sub-second, free counts) or a live LinkedIn lookup (5 to 60 seconds, billed counts, every filter). Tools take `mode`:

- `auto` (default) tries the database first and escalates only if the API says a filter you passed is not supported there. The escalation is reported and is refused above the spend ceiling.
- `database` never escalates: an unsupported filter is an error, not a bigger bill.
- `realtime` goes live directly. Counting live costs money, so `count_*` run it only when asked for explicitly.

### Filter vocabularies

`company_industries` and `seniorities` accept unknown values silently and return zero results, which reads like "this audience does not exist". The server therefore checks values before sending anything: unknown industries, headcount buckets and company types are refused locally with the closest valid names, and mis-cased values are corrected. `allow_unlisted_values: true` overrides the check.

The full vocabularies are exposed as resources:

```
generect://vocabulary/industries
generect://vocabulary/seniorities
generect://vocabulary/functions         (realtime only)
generect://vocabulary/company-types
generect://vocabulary/headcounts
generect://vocabulary/follower-ranges   (realtime only)
generect://account/pricing              your per-operation prices
generect://account/balance              balance and month-to-date usage
```

### Prompts

Workflow prompts appear as slash commands in clients that support them: `size_an_audience`, `build_prospect_list`, `enrich_my_list` and `spend_report`. Each one starts from the free step.

### Spend ceiling

A row cap bounds results, not money. Any call whose worst case exceeds `MCP_MAX_SPEND_PER_CALL` (default $5) is refused with the exact figure and must be repeated with `confirm_spend_usd` set to at least that amount. `start_bulk_job` is checked before it submits, because a bulk job reserves its whole cost up front.

## Agent skill

Tools let an agent call Generect; the skill teaches it the procedure above.

```bash
npx skills add generect/generect_mcp --skill generect-lead-workflows
```

See [skills/README.md](skills/README.md).

## More

- [Documentation](https://docs.generect.com/integrations/mcp)
- [Operating and self-hosting the server](docs/OPERATIONS.md): logging, OAuth endpoints, security settings, deployment, Docker
- [Release process](RELEASING.md)
- [Issues](https://github.com/generect/generect_mcp/issues)

## License

MIT
