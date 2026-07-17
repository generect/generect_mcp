import { Router, Request, Response } from 'express';
import { renderLoginPage, renderErrorPage, renderRedirectPage } from './login-ui.js';
import {
  getClient,
  getClientByMetadataUrl,
  registerClient,
  validateRedirectUri,
  verifyCodeChallenge,
  createAuthCode,
  consumeAuthCode,
  generateUserId,
  createRefreshToken,
  getRefreshToken,
  revokeRefreshToken,
  OAuthClient,
} from './storage.js';
import { generateAccessToken, ACCESS_TOKEN_TTL_SECONDS } from './jwt.js';
import { safeFetchJson } from './ssrf.js';
import { rateLimitAllow } from './ratelimit.js';

// Client-ID-Metadata-Document support (client_id is an https URL). Kept enabled
// by default for compatibility with clients that use it, but the fetch is now
// SSRF-guarded (see safeFetchJson). Set MCP_ENABLE_CIMD=false to disable entirely.
const CIMD_ENABLED = process.env.MCP_ENABLE_CIMD !== 'false';
// Unauthenticated DCR rate limit (registrations per IP per window). This is
// defense-in-depth; the hard memory bound is the client-map cap in storage.ts.
const REGISTER_MAX = Number(process.env.MCP_REGISTER_RATE_MAX || '60');
const REGISTER_WINDOW_MS = Number(process.env.MCP_REGISTER_RATE_WINDOW_MS || String(60 * 60 * 1000));

interface ClientMetadataDocument {
  client_name?: string;
  redirect_uris: string[];
  logo_uri?: string;
  client_uri?: string;
  grant_types?: string[];
  response_types?: string[];
}

async function fetchClientMetadata(metadataUrl: string): Promise<ClientMetadataDocument | null> {
  try {
    // SSRF-guarded fetch: https only, DNS answers must all be public, no redirect
    // following, hard timeout, and a size cap. This closes the unauthenticated
    // internal-fetch / port-scan / metadata-endpoint vector.
    const metadata = (await safeFetchJson(metadataUrl, {
      timeoutMs: 5000,
      maxBytes: 256 * 1024,
    })) as ClientMetadataDocument;

    if (
      !metadata ||
      !metadata.redirect_uris ||
      !Array.isArray(metadata.redirect_uris) ||
      metadata.redirect_uris.length === 0
    ) {
      console.error(`[oauth] Client metadata missing redirect_uris`);
      return null;
    }

    return metadata;
  } catch (error) {
    console.error(`[oauth] Rejected client metadata fetch:`, error instanceof Error ? error.message : error);
    return null;
  }
}

const GENERECT_API_BASE = process.env.GENERECT_API_BASE || 'https://api.generect.com';

async function validateApiToken(token: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const normalizedToken = token.startsWith('Token ') ? token : `Token ${token}`;
    const res = await fetch(`${GENERECT_API_BASE}/api/linkedin/leads/by_link/`, {
      method: 'POST',
      headers: {
        Authorization: normalizedToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://www.linkedin.com/in/satyanadella/' }),
    });

    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: 'Invalid API token. Please check your token at beta.generect.com' };
    }

    if (res.ok) {
      return { valid: true };
    }

    // Fail CLOSED: any other status (5xx, 429, 502, …) means we could NOT confirm
    // the token. Do not mint a long-lived access token around an unverified
    // credential — ask the user to retry instead.
    return { valid: false, error: 'Could not verify the API token right now (upstream error). Please try again.' };
  } catch (error) {
    return { valid: false, error: 'Failed to validate token. Please try again.' };
  }
}

async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  let client = await getClient(clientId);
  if (client) {
    return client;
  }

  if (CIMD_ENABLED && (clientId.startsWith('https://') || clientId.startsWith('http://'))) {
    client = getClientByMetadataUrl(clientId);
    if (client) {
      return client;
    }

    const metadata = await fetchClientMetadata(clientId);
    if (!metadata) {
      return null;
    }

    const normalizedGrantTypes = metadata.grant_types
      ? Array.isArray(metadata.grant_types)
        ? metadata.grant_types
        : [metadata.grant_types]
      : ['authorization_code'];

    const normalizedResponseTypes = metadata.response_types
      ? Array.isArray(metadata.response_types)
        ? metadata.response_types
        : [metadata.response_types]
      : ['code'];

    // Validate redirect URIs from metadata document against allowlist
    for (const uri of metadata.redirect_uris) {
      if (!isValidRedirectUri(uri)) {
        console.error(`[oauth] Rejected metadata client ${clientId}: disallowed redirect_uri ${uri}`);
        return null;
      }
    }

    client = registerClient({
      client_name: metadata.client_name,
      redirect_uris: metadata.redirect_uris,
      logo_uri: metadata.logo_uri,
      client_uri: metadata.client_uri,
      grant_types: normalizedGrantTypes,
      response_types: normalizedResponseTypes,
      metadata_url: clientId,
    });

    console.log(`[oauth] Auto-registered client from metadata URL: ${clientId}`);
    return client;
  }

  return null;
}

export const oauthRouter = Router();

oauthRouter.get('/authorize', handleAuthorizeGet);
oauthRouter.post('/authorize', handleAuthorizePost);
oauthRouter.post('/token', handleToken);
oauthRouter.post('/register', handleRegister);
oauthRouter.post('/revoke', handleRevoke);

async function handleAuthorizeGet(req: Request, res: Response) {
  const clientId = req.query.client_id as string;
  const redirectUri = req.query.redirect_uri as string;
  const state = req.query.state as string;
  const codeChallenge = req.query.code_challenge as string;
  const codeChallengeMethod = (req.query.code_challenge_method as string) || 'S256';
  const scope = (req.query.scope as string) || 'generect:api';
  const responseType = req.query.response_type as string;

  if (!clientId) {
    res.status(400).send(renderErrorPage({ error: 'invalid_request', errorDescription: 'client_id is required' }));
    return;
  }

  if (!redirectUri) {
    res.status(400).send(renderErrorPage({ error: 'invalid_request', errorDescription: 'redirect_uri is required' }));
    return;
  }

  if (!codeChallenge) {
    res
      .status(400)
      .send(renderErrorPage({ error: 'invalid_request', errorDescription: 'PKCE code_challenge is required' }));
    return;
  }

  if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
    res.status(400).send(
      renderErrorPage({
        error: 'invalid_request',
        errorDescription: 'Only S256 code_challenge_method is supported',
      }),
    );
    return;
  }

  if (responseType && responseType !== 'code') {
    res.status(400).send(
      renderErrorPage({
        error: 'unsupported_response_type',
        errorDescription: 'Only "code" response type is supported',
      }),
    );
    return;
  }

  const client = await resolveClient(clientId);
  if (!client) {
    res.status(400).send(
      renderErrorPage({
        error: 'invalid_client',
        errorDescription: 'Unknown client_id. Please register your client first.',
      }),
    );
    return;
  }

  if (!validateRedirectUri(client, redirectUri)) {
    res
      .status(400)
      .send(renderErrorPage({ error: 'invalid_request', errorDescription: 'Invalid redirect_uri for this client' }));
    return;
  }

  const error = req.query.error as string | undefined;

  res.send(
    renderLoginPage({
      clientId,
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod,
      scope,
      clientName: client.clientName,
      error: error === 'invalid_token' ? 'Invalid API token. Please check and try again.' : undefined,
    }),
  );
}

async function handleAuthorizePost(req: Request, res: Response) {
  const clientId = req.body.client_id as string;
  const redirectUri = req.body.redirect_uri as string;
  const state = req.body.state as string;
  const codeChallenge = req.body.code_challenge as string;
  const codeChallengeMethod = req.body.code_challenge_method as string;
  const scope = req.body.scope as string;
  const apiToken = req.body.api_token as string;

  if (!apiToken || !apiToken.trim()) {
    const client = await resolveClient(clientId);
    res.status(400).send(
      renderLoginPage({
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        scope,
        clientName: client?.clientName,
        error: 'API token is required',
      }),
    );
    return;
  }

  const client = await resolveClient(clientId);
  if (!client) {
    res.status(400).send(renderErrorPage({ error: 'invalid_client', errorDescription: 'Unknown client_id' }));
    return;
  }

  if (!validateRedirectUri(client, redirectUri)) {
    res.status(400).send(renderErrorPage({ error: 'invalid_request', errorDescription: 'Invalid redirect_uri' }));
    return;
  }

  const validation = await validateApiToken(apiToken);
  if (!validation.valid) {
    res.status(400).send(
      renderLoginPage({
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        scope,
        clientName: client.clientName,
        error: validation.error || 'Invalid API token',
      }),
    );
    return;
  }

  const normalizedToken = apiToken.startsWith('Token ') ? apiToken : `Token ${apiToken}`;
  const userId = generateUserId();

  const code = createAuthCode({
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    apiToken: normalizedToken,
    userId,
    scope,
  });

  // Use client-side JavaScript redirect instead of HTTP 302 redirect
  // This is more reliable for custom protocol handlers (claude://, mcp://)
  // and prevents the double "Continue to Claude Desktop?" popup issue
  res.send(
    renderRedirectPage({
      redirectUri,
      authorizationCode: code,
      state,
    }),
  );
}

async function handleToken(req: Request, res: Response) {
  const grantType = req.body.grant_type as string;
  const code = req.body.code as string;
  const redirectUri = req.body.redirect_uri as string;
  const clientId = req.body.client_id as string;
  const codeVerifier = req.body.code_verifier as string;

  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');

  if (grantType === 'refresh_token') {
    await handleRefreshGrant(req, res);
    return;
  }

  if (grantType !== 'authorization_code') {
    res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Supported grant types: authorization_code, refresh_token',
    });
    return;
  }

  if (!code) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'authorization code is required',
    });
    return;
  }

  if (!clientId) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'client_id is required',
    });
    return;
  }

  if (!codeVerifier) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'code_verifier is required (PKCE)',
    });
    return;
  }

  const client = await resolveClient(clientId);
  if (!client) {
    res.status(400).json({
      error: 'invalid_client',
      error_description: 'Unknown client_id',
    });
    return;
  }

  const authCode = consumeAuthCode(code);
  if (!authCode) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code',
    });
    return;
  }

  if (authCode.clientId !== clientId) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Authorization code was issued to a different client',
    });
    return;
  }

  if (redirectUri && authCode.redirectUri !== redirectUri) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Redirect URI mismatch',
    });
    return;
  }

  if (!verifyCodeChallenge(codeVerifier, authCode.codeChallenge, authCode.codeChallengeMethod as 'S256' | 'plain')) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'PKCE verification failed',
    });
    return;
  }

  try {
    const accessToken = await generateAccessToken(authCode.apiToken, authCode.userId, clientId);
    const refreshToken = createRefreshToken({
      clientId,
      userId: authCode.userId,
      apiToken: authCode.apiToken,
      scope: authCode.scope,
    });

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: authCode.scope,
    });
  } catch (error) {
    console.error('[oauth] Token generation error:', error);
    res.status(500).json({
      error: 'server_error',
      error_description: 'Failed to generate access token',
    });
  }
}

// refresh_token grant: exchange a valid, unrevoked refresh token for a new access
// token. Rotates the refresh token (one-time use) to limit replay of a leaked one.
async function handleRefreshGrant(req: Request, res: Response) {
  const refreshToken = req.body.refresh_token as string;
  const clientId = req.body.client_id as string;

  if (!refreshToken) {
    res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
    return;
  }

  const stored = getRefreshToken(refreshToken);
  if (!stored) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid, expired, or revoked refresh token' });
    return;
  }

  if (clientId && stored.clientId !== clientId) {
    res
      .status(400)
      .json({ error: 'invalid_grant', error_description: 'Refresh token was issued to a different client' });
    return;
  }

  try {
    const accessToken = await generateAccessToken(stored.apiToken, stored.userId, stored.clientId);
    // Rotate: invalidate the used refresh token and issue a fresh one.
    revokeRefreshToken(refreshToken);
    const newRefresh = createRefreshToken({
      clientId: stored.clientId,
      userId: stored.userId,
      apiToken: stored.apiToken,
      scope: stored.scope,
    });
    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: newRefresh,
      scope: stored.scope,
    });
  } catch (error) {
    console.error('[oauth] Refresh grant error:', error);
    res.status(500).json({ error: 'server_error', error_description: 'Failed to refresh access token' });
  }
}

// RFC 7009 token revocation. Accepts a refresh_token; always returns 200 (per
// spec, revocation of an unknown token is not an error).
async function handleRevoke(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  const token = req.body.token as string;
  if (token) revokeRefreshToken(token);
  res.status(200).json({});
}

async function handleRegister(req: Request, res: Response) {
  // Bound unauthenticated DCR: an anonymous caller must not be able to register
  // clients in a loop. Keyed on client IP (trusts the reverse proxy's X-Forwarded-For
  // only if express `trust proxy` is set; falls back to socket address).
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!rateLimitAllow(`register:${ip}`, REGISTER_MAX, REGISTER_WINDOW_MS)) {
    res.status(429).json({
      error: 'temporarily_unavailable',
      error_description: 'Too many client registrations from this address. Please retry later.',
    });
    return;
  }

  const clientName = req.body.client_name as string | undefined;
  const redirectUris = req.body.redirect_uris as string[] | string;
  const logoUri = req.body.logo_uri as string | undefined;
  const clientUri = req.body.client_uri as string | undefined;
  const grantTypes = req.body.grant_types as string[] | string | undefined;
  const responseTypes = req.body.response_types as string[] | string | undefined;

  if (!redirectUris || (Array.isArray(redirectUris) && redirectUris.length === 0)) {
    res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris is required',
    });
    return;
  }

  const normalizedRedirectUris = Array.isArray(redirectUris) ? redirectUris : [redirectUris];

  for (const uri of normalizedRedirectUris) {
    if (!isValidRedirectUri(uri)) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: `Invalid redirect URI: ${uri}. Must be localhost or an allowed domain (*.generect.com, claude.ai, or MCP_ALLOWED_REDIRECT_DOMAINS).`,
      });
      return;
    }
  }

  const normalizedGrantTypes = grantTypes
    ? Array.isArray(grantTypes)
      ? grantTypes
      : [grantTypes]
    : ['authorization_code'];

  const normalizedResponseTypes = responseTypes
    ? Array.isArray(responseTypes)
      ? responseTypes
      : [responseTypes]
    : ['code'];

  const client = registerClient({
    client_name: clientName,
    redirect_uris: normalizedRedirectUris,
    logo_uri: logoUri,
    client_uri: clientUri,
    grant_types: normalizedGrantTypes,
    response_types: normalizedResponseTypes,
  });

  res.status(201).json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    client_secret_expires_at: 0,
    token_endpoint_auth_method: 'none',
  });
}

/**
 * Returns true if the hostname is on the redirect URI allowlist.
 * Allowlist: localhost/private IPs, *.generect.com, claude.ai, and any
 * extra comma-separated hostnames in MCP_ALLOWED_REDIRECT_DOMAINS.
 */
function isAllowedRedirectHostname(hostname: string): boolean {
  // localhost / private networks
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return true;

  // Generect product domains
  if (/^([a-z0-9-]+\.)*generect\.com$/i.test(hostname)) return true;

  // Claude.ai — primary MCP client
  if (hostname === 'claude.ai') return true;

  // Extra domains configured at deploy time
  const extra = (process.env.MCP_ALLOWED_REDIRECT_DOMAINS ?? '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(hostname.toLowerCase());
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.protocol === 'http:' && !isAllowedRedirectHostname(url.hostname)) return false;
    if (url.protocol === 'https:' && !isAllowedRedirectHostname(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}
