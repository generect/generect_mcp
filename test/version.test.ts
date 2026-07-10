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
