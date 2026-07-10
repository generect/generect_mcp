import { readFileSync } from 'node:fs';

// Single source of truth for the server version: package.json. Reading it at
// runtime (rather than hardcoding a string) keeps the McpServer info, the `/`
// info endpoint, and the npm/registry version from ever drifting apart.
function readVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_NAME = 'generect-api';
export const VERSION: string = readVersion();
