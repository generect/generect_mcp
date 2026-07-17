import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, assertPublicHttpsUrl } from '../src/auth/ssrf.ts';

test('isBlockedIp blocks loopback, private, link-local, CGNAT, multicast (IPv4)', () => {
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata — the PoC target
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1', // multicast
    '255.255.255.255',
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} must be blocked`);
  }
});

test('isBlockedIp allows ordinary public IPv4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '140.82.121.3', '160.79.104.10']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('isBlockedIp handles IPv6 loopback, link-local, ULA, and mapped IPv4', () => {
  assert.equal(isBlockedIp('::1'), true);
  assert.equal(isBlockedIp('fe80::1'), true);
  assert.equal(isBlockedIp('fc00::1'), true);
  assert.equal(isBlockedIp('fd12:3456::1'), true);
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true, 'IPv4-mapped loopback must be blocked');
  assert.equal(isBlockedIp('::ffff:169.254.169.254'), true, 'IPv4-mapped metadata must be blocked');
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false, 'public IPv6 allowed');
});

test('isBlockedIp blocks anything that is not a recognizable IP', () => {
  assert.equal(isBlockedIp('not-an-ip'), true);
  assert.equal(isBlockedIp(''), true);
  assert.equal(isBlockedIp('999.999.999.999'), true);
});

test('assertPublicHttpsUrl rejects non-https schemes', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('http://example.com/'), /https/);
  await assert.rejects(() => assertPublicHttpsUrl('ftp://example.com/'), /https/);
  await assert.rejects(() => assertPublicHttpsUrl('file:///etc/passwd'), /https/);
});

test('assertPublicHttpsUrl rejects embedded credentials', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('https://user:pass@example.com/'), /credentials/);
});

test('assertPublicHttpsUrl blocks literal private/loopback/metadata IP hosts (no DNS needed)', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('https://127.0.0.1/x'), /blocked/);
  await assert.rejects(() => assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data/'), /blocked/);
  await assert.rejects(() => assertPublicHttpsUrl('https://10.0.0.5:8080/y'), /blocked/);
  await assert.rejects(() => assertPublicHttpsUrl('https://[::1]/z'), /blocked/);
});

test('assertPublicHttpsUrl allows a literal public IP host', async () => {
  const url = await assertPublicHttpsUrl('https://8.8.8.8/metadata.json');
  assert.equal(url.hostname, '8.8.8.8');
});

test('assertPublicHttpsUrl rejects malformed URLs', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('::::'), /invalid URL/);
});
