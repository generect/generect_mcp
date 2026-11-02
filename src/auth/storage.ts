import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { loopbackEquivalent } from './redirect.js';
import { encryptApiToken, decryptApiToken } from './crypto.js';

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
  apiToken: string; // the BARE Generect API key — see auth/credential.ts; the
  // `Token ` prefix is added only when an outbound request is built
  scope: string;
  expiresAt: number;
  revoked: boolean;
}

// What is kept per refresh token, in memory and on disk. The user's API key is
// held only encrypted (TOKEN_ENCRYPTION_KEY, the same key that seals it inside
// every access token we hand out) and decrypted when the token is redeemed.
interface StoredRefreshToken {
  hash: string;
  clientId: string;
  userId: string;
  apiTokenEnc: string;
  scope: string;
  expiresAt: number;
}

// A pending authorization handed off to the product UI for consent. It holds the
// ORIGINAL OAuth request parameters so the redirect target and PKCE binding come
// from here — never from whatever the broker call sends. Short-lived, single-use.
export interface Handoff {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state?: string;
  expiresAt: number;
}

const clients = new Map<string, OAuthClient>();
const authCodes = new Map<string, AuthCode>();
// Keyed by sha256(token), never by the token itself: the map is persisted (see
// "Refresh token persistence" below) and a copy of the file must not be a list
// of redeemable refresh tokens.
const refreshTokens = new Map<string, StoredRefreshToken>();
const handoffs = new Map<string, Handoff>();

const HANDOFF_TTL_MS = Number(process.env.MCP_HANDOFF_TTL_SECONDS || '600') * 1000;
const MAX_HANDOFFS = 10_000;

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
// This file holds CLIENT metadata only. Auth codes stay in memory (they live ten
// minutes). Refresh tokens are persisted separately, hashed and with the API
// credential encrypted: see "Refresh token persistence" below.
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
  // Bound the attacker-controllable display name: strip control chars and cap
  // length. It is HTML-escaped at render time; this is defense-in-depth so it can
  // never be an oversized/binary blob anywhere downstream.
  const rawName = (data.client_name || 'MCP Client').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
  const client: OAuthClient = {
    clientId,
    clientName: rawName || 'MCP Client',
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
  for (const r of refreshTokens.values()) if (r.expiresAt > now) inUse.add(r.clientId);

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
  if (!redirectUri) return false;
  if (client.redirectUris.includes(redirectUri)) return true;
  // Exact match is the rule, with the one exception the spec carves out: a
  // native app's loopback listener gets an ephemeral port, so the port it
  // registered is often not the port it is on (RFC 8252 §7.3).
  return client.redirectUris.some(registered => loopbackEquivalent(registered, redirectUri));
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
  let droppedRefresh = false;
  for (const [hash, rt] of refreshTokens) {
    if (rt.expiresAt < now) {
      refreshTokens.delete(hash);
      droppedRefresh = true;
    }
  }
  if (droppedRefresh) persistRefreshTokens();
  for (const [id, h] of handoffs) {
    if (h.expiresAt < now) handoffs.delete(id);
  }
}

// --- Consent handoffs (product-UI brokered consent) ---

export function createHandoff(data: Omit<Handoff, 'id' | 'expiresAt'>): string {
  // Bound the map so an unauthenticated /authorize loop can't grow it forever.
  if (handoffs.size >= MAX_HANDOFFS) {
    const now = Date.now();
    for (const [k, h] of handoffs) if (h.expiresAt < now) handoffs.delete(k);
    if (handoffs.size >= MAX_HANDOFFS) {
      const oldest = handoffs.keys().next().value;
      if (oldest !== undefined) handoffs.delete(oldest);
    }
  }
  const id = randomBytes(32).toString('base64url');
  handoffs.set(id, { ...data, id, expiresAt: Date.now() + HANDOFF_TTL_MS });
  return id;
}

// Read WITHOUT consuming — used to render the consent screen. Returns only what
// the caller already knows; secrets (PKCE challenge) stay server-side.
export function peekHandoff(id: string): Handoff | null {
  const h = handoffs.get(id);
  if (!h) return null;
  if (h.expiresAt < Date.now()) {
    handoffs.delete(id);
    return null;
  }
  return h;
}

// Single-use: consuming removes it, so a leaked/replayed id cannot mint a second
// authorization code.
export function consumeHandoff(id: string): Handoff | null {
  const h = peekHandoff(id);
  if (!h) return null;
  handoffs.delete(id);
  return h;
}

// --- Refresh tokens (enable bounded-lifetime access tokens + revocation) ---
//
// Refresh token persistence. Refresh tokens used to live only in memory, so
// every deploy (CI deploys each green merge to main) silently invalidated all
// of them. A client then had nothing to renew with once its 30-day access token
// ran out, and the user had to connect again. Google's Connected Apps platform
// makes this a hard requirement ("Persistent Linking": the refresh token must
// keep working, and its expiry is extended on use), so they now survive a
// restart, under these rules:
//
//   - the token itself is never written: the key is its sha256;
//   - the user's API key is written only AES-GCM encrypted, with the key that
//     already seals it inside every access token (crypto.ts);
//   - the file is 0600 and written atomically (temp + rename);
//   - MCP_REFRESH_STORE_PATH=off keeps the old memory-only behaviour.
const REFRESH_STORE_PATH = process.env.MCP_REFRESH_STORE_PATH ?? '.oauth-refresh-tokens.json';
const REFRESH_PERSIST = !['', 'off', 'false', '0', 'none'].includes(REFRESH_STORE_PATH.trim().toLowerCase());

// Every refresh token belongs to a user who completed a Generect login, so the
// count is bounded by real logins, not by anonymous traffic. The cap is a
// backstop against a bug or a login loop growing the file without limit.
const MAX_REFRESH_TOKENS = Number(process.env.MCP_MAX_REFRESH_TOKENS || '50000');

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isStoredRefreshToken(r: any): r is StoredRefreshToken {
  return (
    r &&
    typeof r.hash === 'string' &&
    typeof r.clientId === 'string' &&
    typeof r.userId === 'string' &&
    typeof r.apiTokenEnc === 'string' &&
    typeof r.scope === 'string' &&
    typeof r.expiresAt === 'number'
  );
}

function loadRefreshTokensFromDisk(): void {
  if (!REFRESH_PERSIST) return;
  try {
    const parsed = JSON.parse(readFileSync(REFRESH_STORE_PATH, 'utf8'));
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const r of parsed) {
      if (isStoredRefreshToken(r) && r.expiresAt > now) refreshTokens.set(r.hash, r);
    }
    console.log(`[oauth] Restored ${refreshTokens.size} refresh token(s) from ${REFRESH_STORE_PATH}`);
  } catch (err: any) {
    // ENOENT on first boot is normal; a corrupt file must never stop the server.
    if (err?.code !== 'ENOENT') {
      console.error(`[oauth] Could not load refresh token store (${REFRESH_STORE_PATH}):`, err?.message ?? err);
    }
  }
}

// Same atomic, synchronous write as the client registry. Writes happen on a
// login, a refresh or a revocation: a handful a day per user.
function persistRefreshTokens(): void {
  if (!REFRESH_PERSIST) return;
  try {
    const tmp = `${REFRESH_STORE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify([...refreshTokens.values()]), { mode: 0o600 });
    renameSync(tmp, REFRESH_STORE_PATH);
  } catch (err: any) {
    console.error(`[oauth] Could not persist refresh token store:`, err?.message ?? err);
  }
}

function enforceRefreshCap(): void {
  if (refreshTokens.size <= MAX_REFRESH_TOKENS) return;
  // Drop the ones closest to expiry: they are the least use to anybody.
  const bySoonest = [...refreshTokens.values()].sort((a, b) => a.expiresAt - b.expiresAt);
  for (const r of bySoonest) {
    if (refreshTokens.size <= MAX_REFRESH_TOKENS) break;
    refreshTokens.delete(r.hash);
  }
}

loadRefreshTokensFromDisk();

export function createRefreshToken(data: {
  clientId: string;
  userId: string;
  apiToken: string;
  scope?: string;
}): string {
  const token = randomBytes(32).toString('base64url');
  const hash = hashRefreshToken(token);
  refreshTokens.set(hash, {
    hash,
    clientId: data.clientId,
    userId: data.userId,
    apiTokenEnc: encryptApiToken(data.apiToken),
    scope: data.scope || 'generect:api',
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  });
  enforceRefreshCap();
  persistRefreshTokens();
  return token;
}

// Look up a refresh token without consuming it. Returns null if unknown, revoked,
// or expired — and if the stored API key no longer decrypts (the encryption key
// was rotated), which leaves the client to connect again rather than crash.
export function getRefreshToken(token: string): RefreshToken | null {
  if (typeof token !== 'string' || !token) return null;
  const hash = hashRefreshToken(token);
  const rt = refreshTokens.get(hash);
  if (!rt) return null;
  if (rt.expiresAt < Date.now()) {
    refreshTokens.delete(hash);
    persistRefreshTokens();
    return null;
  }
  let apiToken: string;
  try {
    apiToken = decryptApiToken(rt.apiTokenEnc);
  } catch {
    console.error('[oauth] A stored refresh token no longer decrypts (encryption key changed?); dropping it');
    refreshTokens.delete(hash);
    persistRefreshTokens();
    return null;
  }
  return {
    token,
    clientId: rt.clientId,
    userId: rt.userId,
    apiToken,
    scope: rt.scope,
    expiresAt: rt.expiresAt,
    revoked: false,
  };
}

// Push a live refresh token's expiry out by a full TTL from now. Used instead of
// rotation for clients that must keep the same token (see oauth.ts,
// keepsRefreshToken). Returns the new expiry, or null if the token is not live.
export function extendRefreshToken(token: string): number | null {
  if (typeof token !== 'string' || !token) return null;
  const rt = refreshTokens.get(hashRefreshToken(token));
  if (!rt || rt.expiresAt < Date.now()) return null;
  rt.expiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;
  persistRefreshTokens();
  return rt.expiresAt;
}

// Revoke a refresh token (RFC 7009). Idempotent; returns true if a live token was
// found and revoked.
export function revokeRefreshToken(token: string): boolean {
  if (typeof token !== 'string' || !token) return false;
  const hash = hashRefreshToken(token);
  const rt = refreshTokens.get(hash);
  if (!rt) return false;
  refreshTokens.delete(hash);
  persistRefreshTokens();
  return rt.expiresAt >= Date.now();
}

export function cleanupExpired(): void {
  cleanupExpiredCodes();
}

// unref() so this housekeeping timer never keeps the process alive on its own
// (matters for clean shutdown and for test runners that import this module).
setInterval(cleanupExpiredCodes, 60 * 1000).unref();
