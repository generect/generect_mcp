import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes, createHash } from 'node:crypto';
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
  createHandoff,
  peekHandoff,
  consumeHandoff,
  OAuthClient,
} from './storage.js';
import { isValidRedirectUri, redirectPolicyHint, describeRedirectTarget, MAX_REDIRECT_URIS } from './redirect.js';
import { generateAccessToken, ACCESS_TOKEN_TTL_SECONDS, getOAuthBaseUrl } from './jwt.js';
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
// Token/credential submissions on /oauth/authorize per IP per window. Each fires a
// real upstream call (token validation OR a login to Generect), so an unbounded
// endpoint is a validity/credential-stuffing oracle. Lowered from 30 now that the
// password path exists.
const AUTHORIZE_MAX = Number(process.env.MCP_AUTHORIZE_RATE_MAX || '10');
const AUTHORIZE_WINDOW_MS = Number(process.env.MCP_AUTHORIZE_RATE_WINDOW_MS || String(60 * 60 * 1000));
// Additional per-EMAIL cap on password logins, to stop password-spraying that a
// per-IP limit alone (or a botnet) would miss.
const LOGIN_EMAIL_MAX = Number(process.env.MCP_LOGIN_EMAIL_MAX || '5');

// Product-UI brokered consent ("you're already logged in → Approve").
// When MCP_CONSENT_URL is set, /oauth/authorize hands off to that page instead of
// rendering our own credential form; the page approves with the user's EXISTING
// session and posts an API token back to /oauth/broker. Unset ⇒ current behaviour.
const CONSENT_URL = process.env.MCP_CONSENT_URL || '';
// Only this origin may call /oauth/broker (defence in depth on top of the
// single-use handoff id). Defaults to the origin of MCP_CONSENT_URL.
const CONSENT_ORIGIN =
  process.env.MCP_CONSENT_ORIGIN ||
  (() => {
    try {
      return CONSENT_URL ? new URL(CONSENT_URL).origin : '';
    } catch {
      return '';
    }
  })();

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
const UPSTREAM_TIMEOUT_MS = Number(process.env.MCP_UPSTREAM_TIMEOUT_MS || '15000');

// fetch with a hard timeout, so a slow/hanging Generect upstream can never tie up
// an OAuth request handler indefinitely.
async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Bound and sanitize a human label that ends up in a token name / the page. Keep
// it to plain, safe characters so an attacker-controlled client_name can never be
// used for injection anywhere downstream (e.g. the Generect token list).
function safeLabel(s: string | undefined, max = 40): string {
  return (s || 'client')
    .replace(/[^\w .,\-()/]+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

// Confirm a Generect API token is real by asking WHO IT BELONGS TO, not by
// running a business query. The identity endpoint answers 200/401 purely on the
// credential, so validation is free (no credits), fast, and independent of
// whether any particular lead happens to exist. The previous implementation
// probed /leads/by_link/, which returns 400 "Person does not exist" for a
// perfectly valid token — that was indistinguishable from a real failure and,
// failing closed, rejected legitimate users. It also billed a credit per attempt.
async function validateApiToken(token: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const normalizedToken = token.startsWith('Token ') ? token : `Token ${token}`;
    const res = await timedFetch(`${GENERECT_API_BASE}/api/auth/users/me/`, {
      method: 'GET',
      headers: {
        Authorization: normalizedToken,
        'Content-Type': 'application/json',
      },
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

// Log the user into Generect (email + password) and return an API token WITHOUT
// them having to copy one: exchange credentials for a short-lived JWT, then reuse
// or create a named per-client API token. The password is only forwarded to
// Generect's own auth endpoint over TLS — it is never stored or logged here.
async function loginAndMintToken(
  email: string,
  password: string,
  tokenName: string,
): Promise<{ token?: string; error?: string }> {
  try {
    const jwtRes = await timedFetch(`${GENERECT_API_BASE}/api/auth/jwt/create/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (jwtRes.status === 401 || jwtRes.status === 400) {
      return { error: 'Invalid email or password.' };
    }
    if (jwtRes.status === 406) {
      // Correct password, but the Generect account is not activated yet.
      return { error: 'Your Generect account is not activated yet. Check your email to activate it, then try again.' };
    }
    if (!jwtRes.ok) {
      return { error: 'Could not sign in right now (upstream error). Please try again.' };
    }
    const jwtBody = (await jwtRes.json().catch(() => ({}))) as { access?: string };
    const access = jwtBody.access;
    if (!access) return { error: 'Sign-in did not return a session. Please try again.' };
    const auth = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' };

    // Reuse an existing active token with the same name to avoid proliferation.
    try {
      const listRes = await timedFetch(`${GENERECT_API_BASE}/api/auth/api_tokens/?limit=100`, { headers: auth });
      if (listRes.ok) {
        const data = (await listRes.json()) as {
          results?: Array<{ token: string; name?: string; is_active?: boolean }>;
        };
        const existing = (data.results || []).find(t => t.is_active && t.name === tokenName && t.token);
        if (existing) return { token: existing.token };
      }
    } catch {
      /* fall through to mint */
    }

    const mintRes = await timedFetch(`${GENERECT_API_BASE}/api/auth/api_tokens/`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: tokenName }),
    });
    if (!mintRes.ok) return { error: 'Signed in, but could not create a connection token. Please try again.' };
    const mintBody = (await mintRes.json().catch(() => ({}))) as { token?: string };
    if (!mintBody.token) return { error: 'Could not obtain a connection token. Please try again.' };
    return { token: mintBody.token };
  } catch {
    return { error: 'Failed to sign in. Please try again.' };
  }
}

// Why a client could not be resolved — surfaced to the operator in logs and to
// the user in the error page. "Unknown client_id" on its own is misleading: the
// usual cause is that we REFUSED the client (disallowed redirect), not that it
// never tried to register.
let lastResolveFailure: string | null = null;

export function takeLastResolveFailure(): string | null {
  const r = lastResolveFailure;
  lastResolveFailure = null;
  return r;
}

async function resolveClient(clientId: string, ip?: string): Promise<OAuthClient | null> {
  lastResolveFailure = null;
  let client = await getClient(clientId);
  if (client) {
    return client;
  }

  if (CIMD_ENABLED && (clientId.startsWith('https://') || clientId.startsWith('http://'))) {
    client = getClientByMetadataUrl(clientId);
    if (client) {
      return client;
    }

    // Rate-limit the CIMD path per IP: it is reachable unauthenticated from
    // /oauth/authorize and each distinct URL becomes a new registration + a new
    // outbound fetch. Without this it bypassed the /oauth/register limiter and
    // could be looped to exhaust memory / amplify requests.
    if (!rateLimitAllow(`cimd:${ip || 'unknown'}`, REGISTER_MAX, REGISTER_WINDOW_MS)) {
      lastResolveFailure = 'Too many client registrations from this address. Please retry later.';
      return null;
    }

    const metadata = await fetchClientMetadata(clientId);
    if (!metadata) {
      lastResolveFailure = `Could not fetch a valid client metadata document from ${clientId}`;
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

    if (metadata.redirect_uris.length > MAX_REDIRECT_URIS) {
      lastResolveFailure = `Client ${clientId} declares more than ${MAX_REDIRECT_URIS} redirect_uris.`;
      return null;
    }

    // Validate redirect URIs from the metadata document against the policy
    for (const uri of metadata.redirect_uris) {
      if (!isValidRedirectUri(uri)) {
        lastResolveFailure = `Client ${clientId} declares redirect_uri ${uri}, which this server will not accept. ${redirectPolicyHint()}`;
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

// Per-response CSP with a nonce. Defense-in-depth for the consent page (which now
// has a password field): even if a value slipped past escaping, an injected
// <script> can't run without the nonce, and default-src 'none' blocks exfiltration
// channels. The two legitimate inline scripts carry this nonce.
oauthRouter.use((_req: Request, res: Response, next: NextFunction) => {
  const nonce = randomBytes(16).toString('base64');
  (res.locals as Record<string, unknown>).cspNonce = nonce;
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  next();
});

// Wrap async handlers so a rejection is routed to the error middleware (and a
// response is actually sent) instead of becoming an unhandled rejection that
// leaves the socket hanging.
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

oauthRouter.get('/authorize', wrap(handleAuthorizeGet));
oauthRouter.post('/authorize', wrap(handleAuthorizePost));
oauthRouter.get('/handoff/:id', wrap(handleHandoffInfo));
oauthRouter.post('/broker', wrap(handleBroker));
oauthRouter.post('/token', wrap(handleToken));
oauthRouter.post('/register', wrap(handleRegister));
oauthRouter.post('/revoke', wrap(handleRevoke));

// Terminal error handler for the OAuth router: never leak internals; always send.
oauthRouter.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), event: 'oauth_handler_error', path: req.path, error: String(err) }),
  );
  if (res.headersSent) return;
  res
    .status(500)
    .send(renderErrorPage({ error: 'server_error', errorDescription: 'Something went wrong. Please try again.' }));
});

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

  const client = await resolveClient(clientId, req.ip);
  if (!client) {
    // Say WHY. "Unknown client_id" alone sent operators hunting for a
    // registration problem when the real cause was that we refused the client.
    const reason = takeLastResolveFailure();
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'authorize_client_rejected',
        client_id: clientId,
        redirect_uri: redirectUri,
        reason: reason ?? 'client_id is not registered on this server',
      }),
    );
    res.status(400).send(
      renderErrorPage({
        error: 'invalid_client',
        errorDescription: reason ?? 'Unknown client_id. Please register your client first.',
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

  // Product-UI consent: hand off to the app the user is already signed in to,
  // instead of asking for credentials here. All OAuth parameters (redirect target,
  // PKCE challenge, state) stay server-side in the handoff — the UI only learns an
  // opaque id, so it can neither change where the code goes nor forge a challenge.
  if (CONSENT_URL && !error) {
    const handoff = createHandoff({
      clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      state,
    });
    const target = new URL(CONSENT_URL);
    target.searchParams.set('handoff', handoff);
    // Tell the consent page WHICH MCP server to talk back to. Handoffs live in
    // this process's memory, so a page that guessed the wrong instance (e.g. the
    // production server while the flow started on a test one) would look the
    // handoff up somewhere it does not exist and report it as expired. The page
    // still accepts this value only if it is on its own allow-list.
    target.searchParams.set('mcp', getOAuthBaseUrl());
    res.redirect(302, target.toString());
    return;
  }

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
      nonce: (res.locals as Record<string, unknown>).cspNonce as string,
    }),
  );
}

// Consent-screen metadata for the product UI. Returns ONLY what the user needs to
// see to make an informed decision — never the PKCE challenge or any secret. Does
// not consume the handoff (the page may be reloaded).
async function handleHandoffInfo(req: Request, res: Response) {
  const h = peekHandoff(String(req.params.id || ''));
  if (!h) {
    res.status(404).json({ error: 'invalid_handoff', error_description: 'Unknown or expired authorization request.' });
    return;
  }
  const target = describeRedirectTarget(h.redirectUri);
  res.json({
    client_name: h.clientName,
    redirect_host: target.label,
    // Lets the product consent page say "opens an app on your computer" for a
    // private-use scheme callback, where a bare host means nothing to the user.
    redirect_is_app: target.isExternalApp,
    scope: h.scope,
    expires_at: new Date(h.expiresAt).toISOString(),
  });
}

// The product UI approves (or denies) a pending authorization on behalf of the
// already-signed-in user. On approve it supplies an API token minted with the
// user's own session; we validate it and mint the OAuth code bound to the
// ORIGINAL client/redirect/PKCE from the handoff.
async function handleBroker(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');

  // Defence in depth: only the consent UI's origin may call this. The single-use
  // handoff id is the real control; this blocks casual cross-site posting.
  const origin = req.headers.origin as string | undefined;
  if (CONSENT_ORIGIN && origin && origin !== CONSENT_ORIGIN) {
    res.status(403).json({ error: 'forbidden', error_description: 'Origin not allowed to broker consent.' });
    return;
  }

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!rateLimitAllow(`broker:${ip}`, AUTHORIZE_MAX, AUTHORIZE_WINDOW_MS)) {
    res.status(429).json({ error: 'temporarily_unavailable', error_description: 'Too many attempts.' });
    return;
  }

  const handoffId = String(req.body.handoff || '');
  const apiToken = req.body.api_token as string | undefined;
  const deny = req.body.deny === true || req.body.deny === 'true';

  const h = consumeHandoff(handoffId);
  if (!h) {
    res.status(400).json({ error: 'invalid_handoff', error_description: 'Unknown, expired, or already-used request.' });
    return;
  }

  // User declined: send them back to the client with a spec-compliant error.
  if (deny) {
    const url = new URL(h.redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (h.state) url.searchParams.set('state', h.state);
    res.json({ redirect_url: url.toString() });
    return;
  }

  if (!apiToken || !apiToken.trim()) {
    res.status(400).json({ error: 'invalid_request', error_description: 'api_token is required.' });
    return;
  }

  const validation = await validateApiToken(apiToken);
  if (!validation.valid) {
    res.status(400).json({ error: 'invalid_token', error_description: validation.error || 'Invalid API token.' });
    return;
  }

  const code = createAuthCode({
    clientId: h.clientId,
    redirectUri: h.redirectUri,
    codeChallenge: h.codeChallenge,
    codeChallengeMethod: h.codeChallengeMethod,
    apiToken: apiToken.startsWith('Token ') ? apiToken : `Token ${apiToken}`,
    userId: generateUserId(),
    scope: h.scope,
  });

  const url = new URL(h.redirectUri);
  url.searchParams.set('code', code);
  if (h.state) url.searchParams.set('state', h.state);
  res.json({ redirect_url: url.toString() });
}

async function handleAuthorizePost(req: Request, res: Response) {
  const clientId = req.body.client_id as string;
  const redirectUri = req.body.redirect_uri as string;
  const state = req.body.state as string;
  const codeChallenge = req.body.code_challenge as string;
  const codeChallengeMethod = req.body.code_challenge_method as string;
  const scope = req.body.scope as string;
  const apiToken = req.body.api_token as string;

  // Rate-limit token submission per IP. Each attempt fires a real (billable)
  // validation call against the submitted token and returns a distinguishable
  // valid/invalid result — i.e. an unauthenticated token-validity + credit-burn
  // oracle if left unbounded.
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!rateLimitAllow(`authorize:${ip}`, AUTHORIZE_MAX, AUTHORIZE_WINDOW_MS)) {
    res.status(429).send(
      renderErrorPage({
        error: 'temporarily_unavailable',
        errorDescription: 'Too many attempts. Please retry later.',
      }),
    );
    return;
  }

  const client = await resolveClient(clientId, req.ip);
  if (!client) {
    res.status(400).send(renderErrorPage({ error: 'invalid_client', errorDescription: 'Unknown client_id' }));
    return;
  }

  if (!validateRedirectUri(client, redirectUri)) {
    res.status(400).send(renderErrorPage({ error: 'invalid_request', errorDescription: 'Invalid redirect_uri' }));
    return;
  }

  // The GET handler enforces PKCE, but this POST is reachable on its own, and
  // whatever challenge/method arrives here is what the code is bound to. With
  // private-use scheme callbacks now accepted, PKCE is the control that makes a
  // code intercepted by a rogue local app useless — so it is re-checked here
  // rather than trusted to have survived the round trip through the form.
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

  const rerender = (error: string) =>
    res.status(400).send(
      renderLoginPage({
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        scope,
        clientName: client!.clientName,
        error,
        nonce: (res.locals as Record<string, unknown>).cspNonce as string,
      }),
    );

  // The user proves who they are either by pasting an API token, or by logging in
  // with their Generect email + password (in which case we mint/reuse a named
  // token for them so they never have to copy one).
  const email = (req.body.email as string | undefined)?.trim();
  const password = req.body.password as string | undefined;
  let normalizedToken: string;

  if (apiToken && apiToken.trim()) {
    const validation = await validateApiToken(apiToken);
    if (!validation.valid) return void rerender(validation.error || 'Invalid API token');
    normalizedToken = apiToken.startsWith('Token ') ? apiToken : `Token ${apiToken}`;
  } else if (email && password) {
    // Second rate-limit key on the EMAIL, so per-IP limiting can't be sidestepped
    // by spraying one password across many accounts (each attempt is a real login
    // to Generect, which the probe showed has no throttling of its own).
    if (!rateLimitAllow(`login:${email.toLowerCase()}`, LOGIN_EMAIL_MAX, AUTHORIZE_WINDOW_MS)) {
      return void rerender('Too many sign-in attempts for this account. Please retry later.');
    }
    // Fallback label only; describeRedirectTarget copes with callbacks that have
    // no hostname at all (`com.example.app:/cb`), where `new URL().host` is ''.
    const host = describeRedirectTarget(redirectUri).label || 'client';
    // Token name is UNIQUE per client_id (hash suffix), so an attacker who
    // registers a client with a colliding display name cannot make the reuse
    // lookup hand them a victim's pre-existing token. The label is sanitized.
    const clientHash = createHash('sha256').update(clientId).digest('hex').slice(0, 8);
    const tokenName = `MCP: ${safeLabel(client.clientName || host)} [${clientHash}]`;
    const result = await loginAndMintToken(email, password, tokenName);
    if (result.error || !result.token) return void rerender(result.error || 'Could not sign in.');
    normalizedToken = `Token ${result.token}`;
  } else {
    return void rerender('Enter your email and password, or an API token.');
  }

  const userId = generateUserId();

  const code = createAuthCode({
    clientId,
    redirectUri,
    codeChallenge,
    // Normalised: the check above accepted only S256 or an absent method.
    codeChallengeMethod: 'S256',
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
      nonce: (res.locals as Record<string, unknown>).cspNonce as string,
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

  const client = await resolveClient(clientId, req.ip);
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
  // Public clients (token_endpoint_auth_method: none) MUST send client_id on
  // refresh (RFC 6749 §6) so a stolen refresh token can't be redeemed without
  // also knowing which client it belongs to.
  if (!clientId) {
    res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
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

  // Registration is unauthenticated and the client record is persisted, so bound
  // what one caller can make us keep.
  if (normalizedRedirectUris.length > MAX_REDIRECT_URIS) {
    res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered.`,
    });
    return;
  }

  for (const uri of normalizedRedirectUris) {
    if (!isValidRedirectUri(uri)) {
      // Previously a silent 400: an integration attempt was refused with no trace
      // of who tried or why.
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'register_rejected',
          reason: 'disallowed_redirect_uri',
          redirect_uri: uri,
          client_name: clientName ?? null,
          ip: req.ip ?? null,
          ua: req.headers['user-agent'] ?? null,
        }),
      );
      res.status(400).json({
        error: 'invalid_redirect_uri',
        // Say what this server actually accepts. The old text named four hosts
        // that had long stopped being the real rule, which sent integrators
        // looking for an allowlist to be added to instead of at their URI.
        error_description: `Invalid redirect URI: ${uri.slice(0, 200)}. ` + redirectPolicyHint(),
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

// The redirect-URI policy itself lives in ./redirect.ts, so that the consent UI
// can describe a destination without importing the OAuth router.
