# Releasing

A release is not done when `main` is green. It is done when **every surface a user
can reach serves the same version**. The gap this file exists to prevent: between
Aug 2025 and Aug 2026 the repo moved 0.1.0 → 0.6.2 while npm — which our own docs
tell people to install from — still served 0.1.0, and the MCP registry still
served 0.1.2. Outside reviewers were judging a year-old build.

## Surfaces

| Surface | What users get from it | How it updates |
|---------|------------------------|----------------|
| `https://mcp.generect.com/mcp` | Remote MCP (Claude, ChatGPT, Agent Builder, Cursor) | `deploy-prod.yml` after a green `ci` on `main` (SSH forced command → `deploy/remote-deploy.sh`; gated on repo variable `MCP_DEPLOY_ENABLED`) |
| npm `generect-ultimate-mcp` | `npx generect-ultimate-mcp@latest` — the local install in our docs | `publish-npm.yml` on every version bump merged to `main` (needs `NPM_TOKEN`) |
| GitHub Release `v<version>` | Changelog; what directories and humans read as "latest" | `publish-npm.yml` tags and releases the same bump |
| MCP Registry `com.generect/generect-mcp` | Clients that resolve servers by registry id | `publish-mcp.yml` on `server.json` change (needs `MCP_REGISTRY_PRIVATE_KEY`) |
| Directories (Glama, PulseMCP, mcp.so, …) | Discovery | Mirror npm / the registry on their own schedule — fix those, not each directory. Glama showed v0.1.0 (= npm) on 2026-09-23 |
| `docs.generect.com` | Setup instructions, tool list, prices | `generect/generect-docs` |

## Checklist

1. Bump **both** `package.json` and `server.json` (`npm run check-version` enforces it).
2. `npm test && npm run build`.
3. Free live check: `npm run health -- <key>` — it fails if a "free" endpoint charges.
4. Merge to `main`. That is the release — everything below happens by itself:
   - `publish-mcp.yml` fires on the `server.json` change;
   - `publish-npm.yml` tags `v<version>`, creates the GitHub Release and publishes to npm;
   - `deploy-prod.yml` deploys the remote server once `ci` is green.
5. `surfaces.yml` then checks every surface (`scripts/check-surfaces.mjs`) after each of
   those runs and once a day. While anything lags it keeps **one** issue open —
   "Release surfaces out of sync" — with what is behind and how to fix it, and closes
   it when everything matches. Watch that issue, not the individual runs.
6. Same check by hand: `node scripts/check-surfaces.mjs` (exit 1 on drift, `--json` for agents).
7. `curl -s https://mcp.generect.com/health` alone proves nothing about the version.

8. If the tool surface changed, open a docs PR for `integrations/mcp/tools.mdx`.

## One-time setup still required

- **chronos bootstrap (root)** — `DEPLOY_SSH_KEY` / `DEPLOY_KNOWN_HOSTS` are set and
  the pinned host key matches, but on 2026-09-23 the first deploy got
  `mcp_user@65.21.69.164: Permission denied (publickey)`: the CI key is not in
  `mcp_user`'s `authorized_keys` yet. Run `deploy/bootstrap-chronos.sh` as root (header
  has the two commands), then set the repo variable `MCP_DEPLOY_ENABLED=true`.
- **`NPM_TOKEN`** — the npm package is owned by a single personal account. Move it
  to an org-owned account, then store an automation token as a repo secret.
- **`MCP_REGISTRY_PRIVATE_KEY`** — the `com.generect/*` namespace is owned by the
  domain, and GitHub OIDC can only vouch for `io.github.generect/*`. Generate an
  ed25519 key, publish the public half as a TXT record **on the apex domain
  `generect.com`** (`v=MCPv1; k=ed25519; p=<base64>`), and store the hex-encoded
  ed25519 seed (64 hex chars) as the secret.

  MCP DNS auth reads the **apex**, like SPF. A `_mcp-registry` / `_mcp-auth`
  selector is the mistake people make coming from DKIM; the registry probes those
  two names purely so it can tell you the record is in the wrong place
  (`internal/api/handlers/v0/auth/dns.go`, `commonWrongSelectors`).

  Several MCPv1 records can sit at the apex at once — the registry verifies the
  signature against **every** published key and passes if any matches. So adding
  a key is non-destructive and is the safe way to rotate: publish the new record,
  confirm a publish works, then remove the stale one.
