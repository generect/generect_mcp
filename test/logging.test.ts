import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/tools.ts';

beforeEach(() => {
  delete process.env.MCP_LOG_PAYLOADS;
});

test('default: personal data in a tool input is reduced to shape markers', () => {
  const input = { first_name: 'John', last_name: 'Smith', domain: 'acme.com' };
  const out = redact(input) as Record<string, string>;
  assert.deepEqual(out, { first_name: '<str:4>', last_name: '<str:5>', domain: '<str:8>' });
  // No raw PII must appear anywhere in the serialized form.
  const s = JSON.stringify(out);
  for (const pii of ['John', 'Smith', 'acme.com']) assert.ok(!s.includes(pii), `leaked ${pii}`);
});

test('opt-in MCP_LOG_PAYLOADS=1: values are logged verbatim', () => {
  process.env.MCP_LOG_PAYLOADS = '1';
  const input = { first_name: 'John', domain: 'acme.com' };
  assert.deepEqual(redact(input), input);
});

test('nested objects and arrays are summarized recursively', () => {
  const input = { leads: [{ name: 'x' }, { name: 'yy' }], count: 5, ok: true };
  assert.deepEqual(redact(input), {
    leads: [{ name: '<str:1>' }, { name: '<str:2>' }],
    count: '<number>',
    ok: '<boolean>',
  });
});

test('null and undefined are preserved', () => {
  assert.deepEqual(redact({ a: null, b: undefined }), { a: null, b: undefined });
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
});

test('Date and Buffer become type markers', () => {
  assert.equal(redact(new Date()), '<date>');
  assert.equal(redact(Buffer.from('abc')), '<buffer:3>');
});

test('cyclic structures do not throw (depth-bounded)', () => {
  const a: any = { name: 'x' };
  a.self = a;
  assert.doesNotThrow(() => JSON.stringify(redact(a)));
});

test('depth is bounded (beyond 4 levels collapses)', () => {
  const deep = { a: { b: { c: { d: { e: { f: 'deep' } } } } } };
  const out = JSON.stringify(redact(deep));
  assert.ok(!out.includes('deep'));
  assert.ok(out.includes('<object>'));
});

test('breadth is bounded (long arrays truncated to 20 items)', () => {
  const arr = Array.from({ length: 100 }, (_, i) => `item-${i}`);
  const out = redact(arr) as unknown[];
  assert.equal(out.length, 20);
});
