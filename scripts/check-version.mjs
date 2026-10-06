// CI guard: package.json and server.json must declare the same version, so the
// npm package, the MCP registry entry, and the runtime server info never drift.
import { readFileSync } from 'node:fs';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const pkg = read('../package.json');
const srv = read('../server.json');

if (pkg.version !== srv.version) {
  console.error(
    `[version-check] FAIL: package.json version (${pkg.version}) !== server.json version (${srv.version}). ` +
      `Bump both together.`,
  );
  process.exit(1);
}

// The registry lists the npm package too; its entry must name the version being
// released, and the registry verifies ownership through package.json `mcpName`.
for (const entry of srv.packages ?? []) {
  if (entry.registryType === 'npm' && entry.identifier === pkg.name && entry.version !== pkg.version) {
    console.error(
      `[version-check] FAIL: server.json packages[${entry.identifier}].version (${entry.version}) !== ` +
        `package.json version (${pkg.version}).`,
    );
    process.exit(1);
  }
}
if ((srv.packages ?? []).some((e) => e.registryType === 'npm') && pkg.mcpName !== srv.name) {
  console.error(`[version-check] FAIL: package.json mcpName (${pkg.mcpName}) must equal server.json name (${srv.name}).`);
  process.exit(1);
}

console.log(`[version-check] OK: ${pkg.version}`);
