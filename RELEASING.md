# Releasing

A release is not done when `main` is green. It is done when **every surface a user
can reach serves the same version**. The gap this file exists to prevent: between
Aug 2025 and Aug 2026 the repo moved 0.1.0 → 0.6.2 while npm — which our own docs
tell people to install from — still served 0.1.0, and the MCP registry still
served 0.1.2. Outside reviewers were judging a year-old build.

## Surfaces

| Surface | What users get from it | How it updates |
|---------|------------------------|----------------|
| `https://mcp.generect.com/mcp` | Remote MCP (Claude, ChatGPT, Agent Builder, Cursor) | Deploy on the host (PM2) |
| npm `generect-ultimate-mcp` | `npx generect-ultimate-mcp@latest` — the local install in our docs | `publish-npm.yml` (needs `NPM_TOKEN`) |
| MCP Registry `com.generect/generect-mcp` | Clients that resolve servers by registry id | `publish-mcp.yml` on `server.json` change (needs `MCP_REGISTRY_PRIVATE_KEY`) |
| Directories (Glama, mcp.so, …) | Discovery | Mirror the MCP Registry — fix the registry, not each directory |
| `docs.generect.com` | Setup instructions, tool list, prices | `generect/generect-docs` |

## Checklist

1. Bump **both** `package.json` and `server.json` (`npm run check-version` enforces it).
2. `npm test && npm run build`.
3. Free live check: `npm run health -- <key>` — it fails if a "free" endpoint charges.
4. Merge to `main`. `publish-mcp.yml` fires on the `server.json` change.
5. Cut a GitHub Release → `publish-npm.yml` publishes to npm.
6. Deploy the remote server.
7. **Verify all three**, do not assume:

```bash
npm view generect-ultimate-mcp dist-tags.latest
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=generect" \
  | python3 -c "import json,sys;[print(s['server']['name'],s['server']['version']) for s in json.load(sys.stdin)['servers'] if s['_meta']['io.modelcontextprotocol.registry/official'].get('isLatest')]"
curl -s https://mcp.generect.com/health
```

8. If the tool surface changed, open a docs PR for `integrations/mcp/tools.mdx`.

## One-time setup still required

- **`NPM_TOKEN`** — the npm package is owned by a single personal account. Move it
  to an org-owned account, then store an automation token as a repo secret.
- **`MCP_REGISTRY_PRIVATE_KEY`** — the `com.generect/*` namespace is owned by the
  domain, and GitHub OIDC can only vouch for `io.github.generect/*`. Generate an
  ed25519 key, publish the public half as a TXT record on
  `_mcp-registry.generect.com` (`v=MCPv1; k=ed25519; p=<base64>`), store the hex
  private key as the secret.
