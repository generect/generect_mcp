import 'dotenv/config';
import { createApp } from './app.js';
import { VERSION } from './version.js';
import { getPublicKeyJwk, assertEncryptionKeyConfigured } from './auth/index.js';

// Entry point (pm2 runs dist/http.js). The routes live in app.ts so tests can run
// them against a fake Generect API without starting a listener.
const port = Number(process.env.MCP_PORT || 3000);

async function start() {
  // Fail fast at startup rather than on the first victim: in production a missing
  // or default security secret throws here, instead of the server silently coming
  // up and issuing forgeable tokens or encrypting with a source-visible key.
  await getPublicKeyJwk();
  assertEncryptionKeyConfigured();

  const app = createApp();
  app.listen(port, () => {
    console.log(`MCP HTTP server listening on port ${port} (v${VERSION})`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`OAuth authorize: http://localhost:${port}/oauth/authorize`);
    console.log(`Protected Resource Metadata: http://localhost:${port}/.well-known/oauth-protected-resource`);
  });
}

start().catch(err => {
  console.error('[startup] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
