/**
 * Redirect-URI policy for the OAuth authorization server.
 *
 * The point of this module: ANY MCP client should be able to connect. Editors
 * and desktop apps come back through a private-use URI scheme
 * (`cursor://`, `vscode://`, `zed://`) rather than an https URL, and the old
 * host allowlist — localhost, *.generect.com, claude.ai, linear.app — refused
 * them at dynamic client registration, so those apps could not finish OAuth at
 * all. A public MCP server that advertises DCR has to accept the callbacks its
 * clients actually use.
 *
 * Opening the door does not mean dropping the guards. What keeps an
 * authorization code out of an attacker's hands is:
 *
 *   - PKCE S256, mandatory on every flow — an intercepted code (a rogue local
 *     app claiming the same URI scheme, RFC 8252 §8.1) is worthless without the
 *     verifier, which never leaves the real client;
 *   - the code is single-use, short-lived, bound to the client_id AND to the
 *     exact redirect_uri it was issued for (see handleToken);
 *   - `http://` stays restricted to the user's own machine, so a code is never
 *     put on the wire in clear;
 *   - schemes the browser can execute (`javascript:`, `data:`, …) are refused —
 *     we navigate to this URI from our own origin, so they would be XSS;
 *   - the consent screen names the destination, which is the user's own check
 *     that the flow they started is the flow they are approving.
 *
 * Deployments that want the old behaviour set `MCP_REDIRECT_POLICY=strict`.
 */

export type RedirectPolicy = 'open' | 'strict';

/** Longest redirect URI we will store. Bounds the on-disk client record. */
export const MAX_REDIRECT_URI_LENGTH = 2048;

/** Most callbacks one client may register. */
export const MAX_REDIRECT_URIS = 20;

/**
 * Schemes that must never be accepted, whatever the policy. The redirect page
 * assigns this URI to `window.location` and renders it as an `<a href>` on the
 * MCP origin, so `javascript:`/`data:` here is script execution on our own
 * origin with a live authorization code in scope. `file:`/`filesystem:` read
 * local files; the browser-internal ones are not app callbacks. `intent:` can
 * launch arbitrary Android components and we have no Android client.
 */
const DANGEROUS_SCHEMES = new Set([
  'javascript',
  'data',
  'vbscript',
  'file',
  'filesystem',
  'blob',
  'about',
  'view-source',
  'chrome',
  'chrome-extension',
  'moz-extension',
  'resource',
  'jar',
  'intent',
  'android-app',
  'ws',
  'wss',
  'ftp',
]);

export function getRedirectPolicy(): RedirectPolicy {
  return (process.env.MCP_REDIRECT_POLICY || '').toLowerCase() === 'strict' ? 'strict' : 'open';
}

function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True for hosts that are the user's own machine or LAN. A code delivered here
 * never leaves the network the user is sitting on, which is why plain http is
 * tolerable for these and nowhere else (RFC 8252 §7.3).
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/** Hosts allowed in strict mode: our own domains plus known first-party clients. */
function isFirstPartyHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (isLocalHost(host)) return true;
  if (/^([a-z0-9-]+\.)*generect\.com$/.test(host)) return true;
  // Fixed, published callbacks:
  //   claude.ai  -> https://claude.ai/api/mcp/auth_callback
  //   linear.app -> https://linear.app/connect/mcp/callback
  if (host === 'claude.ai' || host === 'www.claude.ai') return true;
  if (host === 'linear.app' || host === 'www.linear.app') return true;
  return envList('MCP_ALLOWED_REDIRECT_DOMAINS').includes(host);
}

function isAllowedHttpsHost(hostname: string): boolean {
  if (getRedirectPolicy() === 'open') return true;
  // Pre-existing escape hatch, kept so deployments that set it keep working.
  if (process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT === 'true') return true;
  return isFirstPartyHost(hostname);
}

/**
 * Private-use URI scheme callback, RFC 8252 §7.1 — `cursor://…`,
 * `com.example.app:/oauth2redirect`.
 */
function isAllowedPrivateUseScheme(scheme: string, uri: string): boolean {
  // Syntactically a scheme at all (RFC 3986 §3.1; already lower-cased by URL).
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return false;
  if (DANGEROUS_SCHEMES.has(scheme)) return false;

  // A callback addresses a location: `scheme:/path` or `scheme://authority/path`.
  // Requiring the slash rejects the opaque forms — `mailto:x@y`,
  // `data:text/html,…`, `javascript:alert(1)` — independently of the deny-list
  // above, so a scheme nobody thought to list still cannot smuggle a payload.
  const rest = uri.slice(uri.indexOf(':') + 1);
  if (!rest.startsWith('/')) return false;

  if (getRedirectPolicy() === 'open') return true;
  return envList('MCP_ALLOWED_REDIRECT_SCHEMES').includes(scheme);
}

/**
 * The gate applied at registration time (DCR and client-id-metadata documents).
 * Exported for tests: this is security-critical, so it is asserted directly and
 * not only through the HTTP handlers.
 */
export function isValidRedirectUri(uri: string): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_REDIRECT_URI_LENGTH) return false;

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  // RFC 6749 §3.1.2: a redirection endpoint MUST NOT include a fragment. We
  // append the code to the query, and a fragment would also let a client hide
  // where the URI really points when it is shown to the user.
  if (url.hash) return false;
  // Embedded credentials do nothing for a callback and are a classic way to
  // make `https://claude.ai@evil.example/cb` read as claude.ai.
  if (url.username || url.password) return false;

  const scheme = url.protocol.slice(0, -1);

  if (scheme === 'http') return isLocalHost(url.hostname);
  if (scheme === 'https') return isAllowedHttpsHost(url.hostname);
  return isAllowedPrivateUseScheme(scheme, uri);
}

/** Human-readable reason to hand back on rejection, honest about the live policy. */
export function redirectPolicyHint(): string {
  if (getRedirectPolicy() === 'strict') {
    return (
      'This server runs MCP_REDIRECT_POLICY=strict: only loopback http, ' +
      '*.generect.com, claude.ai, linear.app, hosts in MCP_ALLOWED_REDIRECT_DOMAINS ' +
      'and schemes in MCP_ALLOWED_REDIRECT_SCHEMES are accepted.'
    );
  }
  return (
    'Accepted: any https URL, http on loopback/private addresses, or an ' +
    "app's own URI scheme such as myapp://callback. Not accepted: plain http to " +
    'a public host, URLs with a #fragment or embedded credentials, and ' +
    'browser-executable schemes (javascript:, data:, file:, …).'
  );
}

export interface RedirectTarget {
  /** Short destination to show the user, e.g. `claude.ai` or `cursor://anysphere.cursor-mcp`. */
  label: string;
  /** Extra clause explaining what that destination is. */
  detail: string;
  /** True when the callback hands off to a locally installed application. */
  isExternalApp: boolean;
}

/**
 * How the consent and redirect pages describe where the authorization goes.
 * With registration open to everyone, this line is the user's main defence
 * against approving a flow they did not start, so it must stay legible for
 * every callback shape — including the ones with no hostname at all.
 */
export function describeRedirectTarget(uri: string): RedirectTarget {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { label: uri, detail: '', isExternalApp: false };
  }

  const scheme = url.protocol.slice(0, -1);

  if (scheme === 'http' || scheme === 'https') {
    if (isLocalHost(url.hostname)) {
      return { label: url.host, detail: 'an application running on your own computer', isExternalApp: false };
    }
    // url.host is punycode for a lookalike domain, which is what we want shown.
    return { label: url.host, detail: '', isExternalApp: false };
  }

  return {
    label: url.host ? `${scheme}://${url.host}` : `${scheme}:`,
    detail: 'an application installed on your computer',
    isExternalApp: true,
  };
}

/**
 * RFC 8252 §7.3: a native app's loopback listener takes whatever port the OS
 * gives it, which is usually not the port it registered. Compare loopback
 * callbacks on everything except the port (and treat localhost/127.0.0.1/::1 as
 * the same machine, because they are). Everything else stays an exact match.
 *
 * This cannot help an attacker: both sides must be loopback, so the code can
 * only ever be delivered to the user's own machine.
 */
export function loopbackEquivalent(registered: string, requested: string): boolean {
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    if (a.protocol !== 'http:' || b.protocol !== 'http:') return false;
    if (!isLocalHost(a.hostname) || !isLocalHost(b.hostname)) return false;
    return a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}
