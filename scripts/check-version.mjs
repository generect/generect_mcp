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

console.log(`[version-check] OK: ${pkg.version}`);
