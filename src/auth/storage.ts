import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  logoUri?: string;
  clientUri?: string;
  metadataUrl?: string;
  createdAt: number;
}

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  apiToken: string;
  userId: string;
  expiresAt: number;
  scope: string;
}

export interface PKCEChallenge {
  challenge: string;
  method: 'S256' | 'plain';
}

export interface RefreshToken {
  token: string;
  clientId: string;
  userId: string;
  apiToken: string; // normalized "Token <x>" — the credential the access token proxies
  scope: string;
  expiresAt: number;
  revoked: boolean;
}

const clients = new Map<string, OAuthClient>();
const authCodes = new Map<string, AuthCode>();
const refreshTokens = new Map<string, RefreshToken>();

// Hard cap so unauthenticated Dynamic Client Registration cannot grow the client
// map without bound. Configurable for large deployments.
const MAX_CLIENTS = Number(process.env.MCP_MAX_CLIENTS || '5000');
const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_SECONDS || String(90 * 24 * 60 * 60)) * 1000;

// --- Client registry persistence -------------------------------------------
// Registered clients used to live only in memory, so every restart/redeploy made
// previously-registered clients unknown: an app that had connected fine would
// suddenly get "Unknown client_id. Please register your client first." (observed
// in production for a client that registered on 2026-07-12 and then failed
// repeatedly on 2026-07-18 after a restart).
//
// Only CLIENT metadata is persisted — never auth codes or refresh tokens, which
// carry the user's API credential. Those stay in memory by design.
const CLIENT_STORE_PATH = process.env.MCP_CLIENT_STORE_PATH || '.oauth-clients.json';

function loadClientsFromDisk(): void {
  try {
    const raw = readFileSync(CLIENT_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as OAuthClient[];
    if (!Array.isArray(parsed)) return;
    for (const c of parsed) {
      if (c && typeof c.clientId === 'string' && Array.isArray(c.redirectUris)) {
        clients.set(c.clientId, c);
      }
    }
    console.log(`[oauth] Restored ${clients.size} registered client(s) from ${CLIENT_STORE_PATH}`);
  } catch (err: any) {
    // ENOENT on first boot is normal; anything else is logged but never fatal.
    if (err?.code !== 'ENOENT') {
      console.error(`[oauth] Could not load client store (${CLIENT_STORE_PATH}):`, err?.message ?? err);
    }
  }
}

// Atomic synchronous write (temp + rename), so a crash mid-write cannot corrupt
// the store and a shutdown immediately after a registration cannot lose it.
// Registrations are rare (a handful per day) and the file is tiny, so writing
// inline is simpler and strictly safer than a debounced/deferred flush — an
// earlier debounced version silently lost writes when the process exited first.
function schedulePersist(): void {
  try {
    const tmp = `${CLIENT_STORE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify([...clients.values()]), { mode: 0o600 });
    renameSync(tmp, CLIENT_STORE_PATH);
  } catch (err: any) {
    console.error(`[oauth] Could not persist client store:`, err?.message ?? err);
  }
}

loadClientsFromDisk();

export function generateClientId(): string {
  return randomUUID();
}

export function registerClient(data: {
  client_name?: string;
  redirect_uris: string[];
  logo_uri?: string;
  client_uri?: string;
  grant_types?: string[];
  response_types?: string[];
  metadata_url?: string;
}): OAuthClient {
  const clientId = data.metadata_url || generateClientId();
  const client: OAuthClient = {
    clientId,
    clientName: data.client_name || 'MCP Client',
    redirectUris: data.redirect_uris,
    grantTypes: data.grant_types || ['authorization_code'],
    responseTypes: data.response_types || ['code'],
    logoUri: data.logo_uri,
    clientUri: data.client_uri,
    metadataUrl: data.metadata_url,
    createdAt: Date.now(),
  };

  clients.set(clientId, client);
  enforceClientCap();
  schedulePersist();
  return client;
}

// Bound the client map. Evict the oldest clients first, but never a client that
// is referenced by a still-valid authorization code or refresh token (evicting
// one mid-flow would 400 an in-progress login). If nothing is safely evictable
// we still drop the single oldest to guarantee the cap holds.
function enforceClientCap(): void {
  if (clients.size <= MAX_CLIENTS) return;
  const now = Date.now();
  const inUse = new Set<string>();
  for (const c of authCodes.values()) if (c.expiresAt > now) inUse.add(c.clientId);
  for (const r of refreshTokens.values()) if (!r.revoked && r.expiresAt > now) inUse.add(r.clientId);

  const byAge = [...clients.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const c of byAge) {
    if (clients.size <= MAX_CLIENTS) break;
    if (!inUse.has(c.clientId)) clients.delete(c.clientId);
  }
  // Backstop: if every remaining client is in use, evict the absolute oldest so
  // the cap is never exceeded unboundedly.
  while (clients.size > MAX_CLIENTS) {
    const oldest = [...clients.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    clients.delete(oldest.clientId);
  }
}

export function getClient(clientId: string): OAuthClient | undefined {
  return clients.get(clientId);
}

export function getClientByMetadataUrl(metadataUrl: string): OAuthClient | undefined {
  for (const client of clients.values()) {
    if (client.metadataUrl === metadataUrl) {
      return client;
    }
  }
  return undefined;
}

export function generateCodeChallenge(verifier: string, method: 'S256' | 'plain' = 'S256'): string {
  if (method === 'plain') return verifier;
  return createHash('sha256').update(verifier).digest('base64url');
}

export function verifyCodeChallenge(verifier: string, challenge: string, method: 'S256' | 'plain' = 'S256'): boolean {
  const computed = generateCodeChallenge(verifier, method);
  return computed === challenge;
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateAuthCode(): string {
  return randomBytes(32).toString('base64url');
}

export function createAuthCode(data: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  apiToken: string;
  userId: string;
  scope?: string;
}): string {
  const code = generateAuthCode();
  const authCode: AuthCode = {
    code,
    clientId: data.clientId,
    redirectUri: data.redirectUri,
    codeChallenge: data.codeChallenge,
    codeChallengeMethod: data.codeChallengeMethod,
    apiToken: data.apiToken,
    userId: data.userId,
    expiresAt: Date.now() + 10 * 60 * 1000,
    scope: data.scope || 'generect:api',
  };

  authCodes.set(code, authCode);
  return code;
}

export function consumeAuthCode(code: string): AuthCode | null {
  const authCode = authCodes.get(code);
  if (!authCode) return null;

  authCodes.delete(code);

  if (Date.now() > authCode.expiresAt) {
    return null;
  }

  return authCode;
}

export function validateRedirectUri(client: OAuthClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

export function generateUserId(): string {
  return randomUUID();
}

export function cleanupExpiredCodes(): void {
  const now = Date.now();
  for (const [code, authCode] of authCodes) {
    if (authCode.expiresAt < now) {
      authCodes.delete(code);
    }
  }
  for (const [token, rt] of refreshTokens) {
    if (rt.revoked || rt.expiresAt < now) {
      refreshTokens.delete(token);
    }
  }
}

// --- Refresh tokens (enable bounded-lifetime access tokens + revocation) ---

export function createRefreshToken(data: {
  clientId: string;
  userId: string;
  apiToken: string;
  scope?: string;
}): string {
  const token = randomBytes(32).toString('base64url');
  refreshTokens.set(token, {
    token,
    clientId: data.clientId,
    userId: data.userId,
    apiToken: data.apiToken,
    scope: data.scope || 'generect:api',
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    revoked: false,
  });
  return token;
}

// Look up a refresh token without consuming it. Returns null if unknown, revoked,
// or expired.
export function getRefreshToken(token: string): RefreshToken | null {
  const rt = refreshTokens.get(token);
  if (!rt) return null;
  if (rt.revoked || rt.expiresAt < Date.now()) return null;
  return rt;
}

// Revoke a refresh token (RFC 7009). Idempotent; returns true if a live token was
// found and revoked.
export function revokeRefreshToken(token: string): boolean {
  const rt = refreshTokens.get(token);
  if (!rt) return false;
  const wasLive = !rt.revoked;
  rt.revoked = true;
  refreshTokens.delete(token);
  return wasLive;
}

export function cleanupExpired(): void {
  cleanupExpiredCodes();
}

// unref() so this housekeeping timer never keeps the process alive on its own
// (matters for clean shutdown and for test runners that import this module).
setInterval(cleanupExpiredCodes, 60 * 1000).unref();
