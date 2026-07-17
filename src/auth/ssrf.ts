// SSRF guard for server-side outbound fetches to client-controlled URLs
// (OAuth "client-id-as-metadata-document"). Without this, an unauthenticated
// caller can make the server fetch arbitrary internal URLs (cloud metadata at
// 169.254.169.254, loopback services, RFC1918 hosts) and use response timing as
// an internal port scanner. We defend by:
//   - https only, no embedded credentials,
//   - resolving EVERY DNS answer and rejecting any private/loopback/link-local/
//     reserved address,
//   - a hard timeout, no redirect following, and a response-size cap.
import { lookup } from 'node:dns/promises';
import net from 'node:net';

// True for addresses that must never be reachable via a client-controlled URL.
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 test nets
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved (224+)
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (low === '::1' || low === '::') return true; // loopback / unspecified
    if (low.startsWith('fe80')) return true; // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local
    if (low.startsWith('ff')) return true; // multicast
    const mapped = low.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isBlockedIp(mapped[1]); // IPv4-mapped
    return false;
  }
  return true; // not a recognizable IP → block
}

// Validate that a URL is https and resolves ONLY to public addresses. Returns the
// parsed URL or throws. Resolving all answers defends against a hostname with one
// public and one private A record.
export async function assertPublicHttpsUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (url.protocol !== 'https:') throw new Error('only https metadata URLs are allowed');
  if (url.username || url.password) throw new Error('credentials in metadata URL are not allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`metadata URL resolves to a blocked address (${host})`);
    return url;
  }
  const answers = await lookup(host, { all: true });
  if (!answers.length) throw new Error('metadata URL host did not resolve');
  for (const a of answers) {
    if (isBlockedIp(a.address)) throw new Error(`metadata URL host resolves to a blocked address (${a.address})`);
  }
  return url;
}

// Fetch JSON from a client-controlled URL with all SSRF guards applied.
export async function safeFetchJson(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const url = await assertPublicHttpsUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual', // never follow a redirect into an internal target
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    // undici surfaces a blocked redirect as an opaqueredirect response (status 0)
    // or a 3xx; reject either — following it would re-open the SSRF hole.
    if ((res as any).type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new Error('metadata URL responded with a redirect, which is not allowed');
    }
    if (!res.ok) throw new Error(`metadata fetch failed with status ${res.status}`);

    // Bounded read: stop as soon as we exceed the cap instead of buffering a
    // potentially huge (or infinite) body.
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      if (Buffer.byteLength(text) > maxBytes) throw new Error('metadata document too large');
      return JSON.parse(text);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          throw new Error('metadata document too large');
        }
        chunks.push(value);
      }
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}
