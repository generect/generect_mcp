## Generect API MCP Server

B2B lead and company data for AI agents — search, preview, enrich, email and phone
lookup over the Generect API.

Built so an agent can work without burning a customer's balance: sizing an
audience is **free**, every tool says up front whether it costs money, and every
response reports what was actually charged.

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

### Test mode

Generect's API picks live or test mode from the **key**, not the URL — so this
server needs no separate deployment and no extra tool. Paste a test key
(`test_…`, created at
[beta.generect.com/settings/api](https://beta.generect.com/settings/api)) into
the same config and every tool answers with fictional data, at the speed the
real endpoint runs, showing the price the real call would have cost, charging
nothing.

```json
{
  "mcpServers": {
    "generect": {
      "command": "mcp-remote",
      "args": ["https://mcp.generect.com/mcp", "--header", "Authorization: Bearer test_YOUR_TEST_KEY"]
    }
  }
}
```

Every result from a test key carries `test_mode: true` and a notice telling the
model the people are fictional. That is not decoration. An agent handed twelve
invented prospects with no marker will summarise them as twelve prospects, and
the person reading the summary has no way to tell — the likeliest failure of
test mode in an agent channel is a confident report about people who do not
exist. The marker is added centrally, so no tool can forget it.

See [Test mode](https://docs.generect.com/api-reference/test-mode) for the magic
inputs that force a 402, a 429 or a timeout on demand.

### Tools

Every tool states in its own description whether it is free or billable, and every
response carries a `cost` block with the amount the API actually charged. Tools
accept `timeout_ms`.

**Free — start here**

| Tool | What it does |
|------|--------------|
| `count_leads` | How many leads match an ICP + what the next step costs at *your* rates. Run before `search_leads`. |
| `count_companies` | Same, for companies. |
| `get_balance` | Balance, month-to-date usage, and this account's real per-operation prices. |
| `get_bulk_job` | Poll a bulk job (the work was billed at submit time). |
| `manage_webhooks` | List/create/update/delete/test webhook endpoints. |
| `health` | Liveness + credential check against a free endpoint. Safe for monitors. |

**Billable**

| Tool | Billed |
|------|--------|
| `search_leads` | per returned row |
| `search_companies` | per returned row |
| `preview_leads` | per returned row (cheapest way to see real people) |
| `enrich_lead` / `get_lead_by_url` | per record found |
| `resolve_profile` | per **resolved** profile — the cheapest call here; an unresolvable reference is free |
| `enrich_company` | per record found |
| `generate_email` | per **valid** email found |
| `validate_email` | per email submitted — every address, whatever the verdict |
| `find_phone` | per phone found — the most expensive operation here |
| `start_bulk_job` | per record, **reserved at submit time** |

#### database vs realtime

Every search/enrich runs against either the cached database (sub-second, cheaper,
**free counts**) or a live LinkedIn lookup (5–60s, pricier, billable counts, every
filter). Tools take `mode: "auto" | "database" | "realtime"`:

- `auto` (default) tries the cheap path and escalates only if the API says a
  filter you passed does not exist there. The escalation is reported in the
  response, never silent.
- `database` never escalates: if a filter is unsupported you get an error, not a
  bigger bill.
- Counting is the exception — a realtime count costs money, so `count_leads` /
  `count_companies` refuse to run one unless you ask for `mode: "realtime"`
  explicitly. They tell you which filters forced the choice instead.

#### Budget-safe flow

```
count_leads (free)  →  preview_leads (cheap)  →  search_leads (per row)
                                              →  generate_email on the ids you kept
```

`get_balance` before and after a batch gives you an exact spend figure to report.

### Agent skill

Tools give an agent the ability to call Generect; a skill gives it the procedure.
`skills/generect-lead-workflows` documents the flows above so an autonomous agent
follows them without being told each time:

```bash
npx skills add generect/generect_mcp --skill generect-lead-workflows
```

See [skills/README.md](skills/README.md). Release process and the full list of
places a version has to land: [RELEASING.md](RELEASING.md).

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

All three default to **free** API calls only — a smoke test should never quietly
bill whoever runs it.

- Health check (account, price book, free cached count):

```bash
npm run health -- <api-key>
```

- Which filters the free cached index supports right now (free counts only):

```bash
npm run probe -- <api-key>
```

- Call tools via a local MCP client. Free tools by default; `--paid` adds one
  3-row search and one email lookup, and the run prints what it spent:

```bash
npm run mcp:client -- <api-key>
npm run mcp:client -- <api-key> --paid
```

### Security Notes

- **OAuth tokens** are JWTs signed by the server and contain your encrypted API token
- **Token encryption** uses AES-256-GCM with a key from `TOKEN_ENCRYPTION_KEY` (or derived from `JWT_SIGNING_KEY`)
- **Fail-closed secrets** — in production the server refuses to start with a missing or well-known-default `JWT_SIGNING_KEY`, and never publishes symmetric key material in the JWKS
- **Bounded, refreshable tokens** — access tokens expire (default 30 days, `ACCESS_TOKEN_TTL_SECONDS`) and are renewed via a `refresh_token` grant; refresh tokens are rotated on use and revocable at `POST /oauth/revoke` (RFC 7009). Tokens issued before this change remain valid (no forced re-auth)
- **PKCE** is required for all authorization code flows (S256 method), and re-checked on the consent POST as well as the initial redirect — a code intercepted by a rogue app that claims the same URI scheme is useless without the verifier
- **Dynamic Client Registration** allows any MCP client to self-register, but is now **rate-limited per IP** (`MCP_REGISTER_RATE_MAX`, default 60/hour) and the client store is **capped** (`MCP_MAX_CLIENTS`, default 5000, LRU eviction that never drops an in-use client)
- **Redirect URIs: open by default, so any client can connect** (`MCP_REDIRECT_POLICY=open`). Accepted: any `https` URL, `http` only on loopback/private addresses, and an app's own private-use URI scheme (`cursor://…`, `vscode://…`, `com.example.app:/cb` — RFC 8252 §7.1). Refused regardless of policy: cleartext `http` to a public host, `#fragments`, embedded credentials, over-long URIs, and browser-executable schemes (`javascript:`, `data:`, `file:`, …) — that URI is navigated to from our own origin, so those would be XSS. Loopback callbacks match on everything but the port (RFC 8252 §7.3), since a native app's listener gets an ephemeral one. Set `MCP_REDIRECT_POLICY=strict` to fall back to the first-party allowlist (`*.generect.com`, `claude.ai`, `linear.app`, plus `MCP_ALLOWED_REDIRECT_DOMAINS` / `MCP_ALLOWED_REDIRECT_SCHEMES`)
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
| `MCP_REDIRECT_POLICY` | `open` | `open` = any client may register its callback; `strict` = first-party allowlist only |
| `MCP_ALLOWED_REDIRECT_DOMAINS` | — | Extra allowed redirect hostnames, `strict` only (comma-separated) |
| `MCP_ALLOWED_REDIRECT_SCHEMES` | — | Extra allowed private-use URI schemes, `strict` only (comma-separated, e.g. `cursor,vscode`) |
| `MCP_ALLOW_ANY_HTTPS_REDIRECT` | — | Legacy: opens https callbacks under `strict` (implied by `open`) |
- **Log privacy** — prospect payloads are redacted from logs by default (`MCP_LOG_PAYLOADS=1` to opt in)

## Brokered consent: which product UI approves the connection

`/oauth/authorize` does not ask for a password. It hands off to a page in the
product where the user is already signed in, and that page posts a freshly
minted API token back to `/oauth/broker`. Two env vars decide which page that is,
and **they must be changed together**:

| Var | Effect |
|-----|--------|
| `MCP_CONSENT_URL` | Where `/oauth/authorize` redirects the user (`…/authorize/mcp?handoff=…&mcp=…`) |
| `MCP_CONSENT_ORIGIN` | The only `Origin` allowed to call `/oauth/broker`. Defaults to the origin of `MCP_CONSENT_URL` — **but production sets it explicitly in `.env`**, so the default does not save you |

Moving consent from one host to the other by editing only `MCP_CONSENT_URL`
leaves the broker refusing the new page with
`403 {"error":"forbidden","error_description":"Origin not allowed to broker consent."}`,
*after* the user has already clicked Approve. Change both lines, then prove it:

```bash
# expect 400 invalid_handoff (origin accepted), NOT 403 forbidden
curl -s -X POST https://mcp.generect.com/oauth/broker \
  -H 'Content-Type: application/json' -H "Origin: <the new consent origin>" \
  -d '{"handoff":"nonexistent-probe","deny":true}'
```

CORS is not the control here — the server reflects any `Origin` (bearer auth,
no cookies), so a working preflight proves nothing about the broker.

## Deploying to production

`mcp.generect.com` runs **pm2, not Docker** (`.github/workflows/deploy-prod.yml`
is the unused Docker path). Single instance, always: OAuth state and MCP sessions
live in memory, so a second worker split-brains auth.

```bash
ssh root@chronos                      # 65.21.69.164
su - mcp_user && source ~/.nvm/nvm.sh # node via nvm
cd ~/generect_mcp
cp -r dist dist.bak.$(date +%H%M%S)   # what previous deploys did; keeps a rollback
git pull && npm ci && npm run build
$EDITOR .env                          # consent vars, redirect policy
pm2 reload generect-mcp && pm2 list   # version column should show the new one
```

Then verify from outside the box — `pm2 list` showing `online` is not evidence
that the new behaviour is live:

```bash
curl -s https://mcp.generect.com/health
curl -s -o /dev/null -w '%{redirect_url}\n' \
  "https://mcp.generect.com/oauth/authorize?client_id=<id>&redirect_uri=…&response_type=code&code_challenge=…&code_challenge_method=S256"
```
