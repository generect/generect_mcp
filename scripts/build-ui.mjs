#!/usr/bin/env node
// Builds the MCP Apps view into ONE self-contained HTML file: dist/ui/app.html.
//
// Hosts render it in a sandbox that blocks every outside origin unless the
// resource declares it (`_meta.ui.csp`), so the script and styles are inlined
// rather than loaded. One page serves every tool's view: the host caches a
// single resource instead of one per tool.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const out = await build({
  entryPoints: [join(root, 'ui/main.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020', 'safari15'],
  write: false,
  legalComments: 'none',
  define: { __APP_VERSION__: JSON.stringify(version) },
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join(root, 'ui/app.css'), 'utf8');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Generect</title>
<style>${css}</style>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script>${js}</script>
</body>
</html>
`;

const file = join(root, 'dist/ui/app.html');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, html);
console.log(`[build-ui] ${file} ${(html.length / 1024).toFixed(0)} KB (v${version})`);
