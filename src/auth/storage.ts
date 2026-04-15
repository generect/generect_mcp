import { randomUUID, randomBytes, createHash } from 'node:crypto';

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

const clients = new Map<string, OAuthClient>();
const authCodes = new Map<string, AuthCode>();

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
  return client;
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
}

setInterval(cleanupExpiredCodes, 60 * 1000);
