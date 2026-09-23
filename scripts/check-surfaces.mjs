#!/usr/bin/env node
// Does every surface a user can reach serve the version this commit declares?
//
//   node scripts/check-surfaces.mjs            # human-readable, exit 1 on drift
//   node scripts/check-surfaces.mjs --json     # machine-readable
//   node scripts/check-surfaces.mjs --summary  # also append a table to $GITHUB_STEP_SUMMARY
//
// RELEASING.md step 7 used to be three commands someone had to remember. On
// 2026-09-23 the registry advertised 0.9.0 for https://mcp.generect.com/mcp while
// that URL still served 0.7.0, and npm — the local install our docs point at —
// served 0.1.0. Each surface was "done" by its own measure. This script is the
// single measure, and the `surfaces` workflow runs it after every deploy/publish
// and once a day.
//
// Required surfaces fail the run. Directories (Glama) are informational: they
// mirror npm and the registry on their own schedule, and scraping them is
// best-effort, so a miss there is reported but never fails the run.

import { readFileSync, appendFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const want = pkg.version;
const remoteUrl = process.env.MCP_PUBLIC_URL || 'https://mcp.generect.com/';
const repo = process.env.GITHUB_REPOSITORY || 'generect/generect_mcp';
const args = new Set(process.argv.slice(2));

// One retry: a single slow answer from npm or the registry is not drift, and a
// daily job that cries wolf gets muted.
async function getJson(url, headers = {}, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt >= 2 || String(e.message).includes('HTTP 404')) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    return getJson(url, headers, attempt + 1);
  }
}

const checks = [
  {
    surface: 'remote',
    where: remoteUrl,
    required: true,
    fix: 'deploy: a green ci on main deploys automatically (deploy-prod.yml); needs the one-time chronos bootstrap + MCP_DEPLOY_ENABLED=true',
    get: async () => (await getJson(remoteUrl)).version,
  },
  {
    surface: 'npm',
    where: `https://www.npmjs.com/package/${pkg.name}`,
    required: true,
    fix: 'publish-npm.yml runs on every version bump on main; needs the NPM_TOKEN secret',
    get: async () => (await getJson(`https://registry.npmjs.org/${pkg.name}/latest`)).version,
  },
  {
    surface: 'mcp-registry',
    where: `https://registry.modelcontextprotocol.io/?q=${encodeURIComponent(server.name)}`,
    required: true,
    fix: 'publish-mcp.yml runs when server.json changes on main',
    get: async () => {
      const d = await getJson(
        `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/latest`,
      );
      return (d.server ?? d).version;
    },
  },
  {
    surface: 'github-release',
    where: `https://github.com/${repo}/releases`,
    required: true,
    fix: 'publish-npm.yml tags v<version> and creates the release on every version bump on main',
    get: async () => {
      const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
      try {
        const r = await getJson(`https://api.github.com/repos/${repo}/releases/latest`, headers);
        return String(r.tag_name || '').replace(/^v/, '') || null;
      } catch (e) {
        if (String(e.message).includes('404')) return null; // no releases at all
        throw e;
      }
    },
  },
  {
    surface: 'glama',
    where: 'https://glama.ai/mcp/servers/generect/generect_mcp',
    required: false,
    fix: 'Glama mirrors npm/registry — fix those, then use "Sync" on the Glama page if it lags',
    get: async () => {
      const res = await fetch('https://glama.ai/mcp/servers/generect/generect_mcp', {
        headers: { 'user-agent': 'Mozilla/5.0 generect-release-check' },
        signal: AbortSignal.timeout(15000),
      });
      // React renders the badge as `v<!-- -->0.1.0`; drop the comments first,
      // then the first vX.Y.Z on the page is the release Glama shows as latest.
      const html = (await res.text()).replace(/<!--.*?-->/g, '');
      const m = html.match(/\bv(\d+\.\d+\.\d+)\b/);
      return m ? m[1] : undefined; // undefined = could not read, not "wrong"
    },
  },
];

const results = [];
for (const c of checks) {
  let got;
  let error;
  try {
    got = await c.get();
  } catch (e) {
    error = e.message;
  }
  const status = error ? 'error' : got === undefined ? 'unknown' : got === want ? 'ok' : 'drift';
  results.push({ surface: c.surface, required: c.required, want, got: got ?? null, status, error, where: c.where, fix: c.fix });
}

const failing = results.filter((r) => r.required && r.status !== 'ok');

if (args.has('--json')) {
  console.log(JSON.stringify({ version: want, ok: failing.length === 0, results }, null, 2));
} else {
  for (const r of results) {
    const mark = r.status === 'ok' ? 'ok   ' : r.required ? 'FAIL ' : 'info ';
    console.log(`${mark} ${r.surface.padEnd(15)} want ${want}  got ${r.got ?? '-'}${r.error ? `  (${r.error})` : ''}`);
    if (r.status !== 'ok') console.log(`      ${r.where}\n      fix: ${r.fix}`);
  }
}

if (args.has('--summary') && process.env.GITHUB_STEP_SUMMARY) {
  const rows = results
    .map((r) => `| ${r.surface} | ${r.required ? 'yes' : 'no'} | ${r.got ?? '-'} | ${r.status} | ${r.status === 'ok' ? '' : r.fix} |`)
    .join('\n');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Release surfaces — main declares ${want}\n\n| surface | required | serves | status | fix |\n|---|---|---|---|---|\n${rows}\n`,
  );
}

process.exit(failing.length ? 1 : 0);
