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
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

// True for addresses that must never be reachable via a client-controlled URL.
// Only ordinary PUBLIC UNICAST addresses are allowed; every special range
// (loopback, RFC1918/unique-local, link-local incl. 169.254.169.254 cloud
// metadata, CGNAT, reserved, multicast, benchmarking, …) is blocked, for both
// IPv4 and IPv6. Hand-rolled prefix matching previously missed IPv6-mapped hex
// forms (e.g. ::ffff:7f00:1 == 127.0.0.1); we now use a vetted parser and, for
// any IPv4-mapped IPv6 address, evaluate the embedded IPv4.
export function isBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip.replace(/^\[|\]$/g, ''));
  } catch {
    return true; // not a recognizable IP → block
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    // Unwrap IPv4-mapped (::ffff:a.b.c.d in any notation) and IPv4-compatible
    // (::a.b.c.d) so an embedded private/loopback v4 can't hide behind v6 syntax.
    if (v6.isIPv4MappedAddress()) return isBlockedIp(v6.toIPv4Address().toString());
    // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 in the low 32 bits.
    if (v6.match(ipaddr.parse('64:ff9b::'), 96)) {
      const b = v6.toByteArray();
      return isBlockedIp([b[12], b[13], b[14], b[15]].join('.'));
    }
  }
  // range() === 'unicast' is the only public, routable-on-the-internet class.
  return addr.range() !== 'unicast';
}

export interface ValidatedTarget {
  url: URL;
  // The exact IP the connection MUST use (all resolved answers were validated;
  // this one is pinned to defeat DNS rebinding between check and connect).
  pinnedAddress: string;
  family: 4 | 6;
}

// Validate that a URL is https and resolves ONLY to public addresses. Returns the
// parsed URL plus the single IP the fetch must connect to. Resolving all answers
// defends against a hostname with one public and one private A record.
export async function assertPublicHttpsUrl(rawUrl: string): Promise<ValidatedTarget> {
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
    return { url, pinnedAddress: host, family: net.isIPv6(host) ? 6 : 4 };
  }
  const answers = await lookup(host, { all: true });
  if (!answers.length) throw new Error('metadata URL host did not resolve');
  for (const a of answers) {
    if (isBlockedIp(a.address)) throw new Error(`metadata URL host resolves to a blocked address (${a.address})`);
  }
  const first = answers[0];
  return { url, pinnedAddress: first.address, family: first.family === 6 ? 6 : 4 };
}

// Fetch JSON from a client-controlled URL with all SSRF guards applied.
export async function safeFetchJson(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const { url, pinnedAddress, family } = await assertPublicHttpsUrl(rawUrl);

  // Pin the connection to the exact IP we validated. Without this, fetch/undici
  // re-resolves the hostname at connect time, so a low-TTL DNS record can rebind
  // to 127.0.0.1/169.254.169.254 in the gap between our check and the connection
  // (TOCTOU). The custom lookup keeps TLS SNI/cert on the original hostname.
  // undici calls lookup with `{ all: true }` and expects an array of
  // {address, family}; other callers expect the (err, address, family) tuple.
  // Support both so the pin actually takes effect (a wrong signature silently
  // fails the connection).
  const pinnedLookup = (_hostname: string, options: any, cb: any) => {
    if (options && options.all) return cb(null, [{ address: pinnedAddress, family }]);
    return cb(null, pinnedAddress, family);
  };
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual', // never follow a redirect into an internal target
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
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
    dispatcher.close().catch(() => {});
  }
}
