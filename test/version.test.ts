import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION, SERVER_NAME } from '../src/version.ts';

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const pkg = read('../package.json');
const srv = read('../server.json');

test('VERSION is read from package.json (single source of truth)', () => {
  assert.equal(VERSION, pkg.version);
});

test('server.json version matches package.json version', () => {
  assert.equal(srv.version, pkg.version);
});

test('VERSION looks like semver', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('SERVER_NAME is stable', () => {
  assert.equal(SERVER_NAME, 'generect-api');
});

test('server.json description fits the MCP Registry limit (<= 100 chars)', () => {
  // The registry rejects a longer description with a 422 at publish time — after
  // the merge, when nothing can be reviewed any more. 0.9.0 shipped a 167-char
  // description and its first real publish failed on exactly this.
  assert.ok(typeof srv.description === 'string' && srv.description.length > 0);
  assert.ok(srv.description.length <= 100, `description is ${srv.description.length} chars`);
});

test('server.json name is the domain-owned namespace we authenticate for', () => {
  // DNS auth proves generect.com, which grants com.generect/*. Any other
  // namespace would authenticate fine and then be refused at publish.
  assert.match(srv.name, /^com\.generect\//);
});
