// Canonical PM2 process definition — this is how the server runs in production
// today (PM2, not Docker). Checking it in gives PM2 a known-good spec to
// resurrect after `pm2 save` + `pm2 startup`, and removes the ambiguity of an
// ad-hoc `pm2 start`.
//
//   pm2 start ecosystem.config.js   # start/reload from this spec
//   pm2 save                        # persist the process list for boot
//   # (run once, as root) pm2 startup systemd -u mcp_user --hp /home/mcp_user
//
// IMPORTANT — single instance only: OAuth state (registered clients, auth codes)
// and MCP sessions are held IN MEMORY (see src/auth/storage.ts and the transports
// map in src/http.ts). Running more than one instance would route a redemption or
// follow-up request to a worker that never saw the original state, causing
// intermittent auth/session failures. Horizontal scaling requires moving that
// state to a shared store (e.g. Redis) first.
module.exports = {
  apps: [
    {
      name: 'generect-mcp',
      script: 'dist/http.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '600M',
      time: true,
      env: {
        NODE_ENV: 'production',
        // Metadata logging on; payload (PII) logging stays OFF unless explicitly
        // enabled with MCP_LOG_PAYLOADS=1. See README "Logging".
        MCP_LOG: '1',
      },
    },
  ],
};
