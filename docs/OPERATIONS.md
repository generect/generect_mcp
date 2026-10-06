# Operating and self-hosting the Generect MCP server

For people who run, deploy or debug the server. Using it from an MCP client is covered in the [README](../README.md).

## Protocol revisions

The server is built on MCP TypeScript SDK v2 and answers two protocol eras on the same
endpoints:

- **2026-07-28** (stateless): no `initialize`, no `Mcp-Session-Id`; the client's version
  and capabilities ride in every request's `_meta`, and the SDK answers `server/discover`.
  Over HTTP each such request is served by a fresh instance from `createMcpServer`
  (`src/mcp-server.ts`) through `createMcpHandler(..., { legacy: 'reject' })`.
- **2025-11-25 / 2025-06-18** (sessionful): `initialize` plus `Mcp-Session-Id`, served by
  the same `NodeStreamableHTTPServerTransport` session map as before the upgrade, so
  clients connected today see no change.

`POST /mcp` routes between them with the SDK's own `isLegacyRequest()`; GET/DELETE are
2025 session operations. Over stdio, `serveStdio()` makes the same decision from the
connection's opening message.

Because 2026-07-28 clients send `Mcp-Method`, `Mcp-Name` and per-argument `Mcp-Param-*`
headers, CORS reflects the preflight's requested headers instead of a fixed list (bearer
auth, no cookies, so this grants nothing). List results carry a shared cache hint
(`LIST_CACHE`, 10 minutes, `public`).

The 2025 path keeps protocol sessions in memory, and OAuth codes live in memory as well,
so the hosted server still runs as a single instance.

## Authentication

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

### OAuth Endpoints

| Endpoint | Description |
|----------|-------------|
| `/.well-known/oauth-protected-resource` | Protected Resource Metadata (RFC 9728) |
| `/.well-known/oauth-authorization-server` | Authorization Server Metadata (RFC 8414) |
| `/.well-known/jwks.json` | JSON Web Key Set for token verification |
| `/oauth/authorize` | Authorization endpoint (login + consent) |
| `/oauth/token` | Token endpoint |
| `/oauth/register` | Dynamic Client Registration (RFC 7591) |


### Brokered consent: which product UI approves the connection

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

## Running locally

### From a checkout

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

### Cursor against a checkout (settings.json excerpt)

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

## Logging

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

## Deployment

### Production (PM2)

The hosted server (`https://mcp.generect.com`) runs under **PM2** as `mcp_user` on
the host, fronted by nginx (TLS), defined by [`ecosystem.config.cjs`](./ecosystem.config.cjs).

**Deploys are automatic.** A green `ci` run on `main` triggers
[`deploy-prod.yml`](.github/workflows/deploy-prod.yml), which reaches the host over
SSH with a key that can run exactly one thing —
[`deploy/remote-deploy.sh`](deploy/remote-deploy.sh) — and verifies the public
endpoint afterwards. The script:

- only ever brings the host to the **tip of `main`** (never an older commit);
- refuses to deploy over uncommitted edits on the host, or to start a second
  pm2 instance;
- restarts with the environment pm2 already holds (`reload`, not `--update-env`);
- **rolls back automatically** to what was running if the new build does not
  come up with the expected version within 60 s.

`deploy/sandbox-test.sh` exercises all of that against a throwaway copy of the
repo with its own pm2 — run it after touching the deploy script. One-time host
setup is [`deploy/bootstrap-chronos.sh`](deploy/bootstrap-chronos.sh) (as root).

**Single instance only.** OAuth state (registered clients, auth codes) and MCP sessions are held in memory, so the server must run as one instance. Scaling horizontally requires a shared store (e.g. Redis) first — see `ecosystem.config.js`.

**Required secrets (fail-closed).** In production (`NODE_ENV=production`) the server refuses to start unless `JWT_SIGNING_KEY` is set to a strong, non-default value; it never falls back to a hardcoded default or an ephemeral key. `TOKEN_ENCRYPTION_KEY`, if set, must be exactly 64 hex characters (32 bytes).

### Manual deploy (fallback only)

Use this only if the automatic deploy is unavailable. It is what `deploy/remote-deploy.sh`
automates, including the rollback, so prefer fixing the automation.

```bash
ssh root@chronos                      # the MCP host
su - mcp_user && source ~/.nvm/nvm.sh # node via nvm
cd ~/generect_mcp
git fetch origin main && git checkout --detach origin/main
npm ci && npm run build
pm2 reload generect-mcp && pm2 list
```

Then verify from outside the box: `pm2 list` showing `online` is not evidence that
the new version is live.

```bash
curl -s https://mcp.generect.com/ | head -c 80   # "version" must be the new one
node scripts/check-surfaces.mjs                   # every release surface, see RELEASING.md
```

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

## Security

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

## Maintenance

The filter vocabularies the server serves as `generect://vocabulary/*` resources are
regenerated from the backend's own filter data, never hand-edited:

```bash
node scripts/gen-vocabulary.mjs <api_parser checkout>
```
