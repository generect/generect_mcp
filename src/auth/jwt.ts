import {
  SignJWT,
  jwtVerify,
  generateKeyPair,
  exportJWK,
  importJWK,
  calculateJwkThumbprint,
  KeyObject,
  JWK,
} from 'jose';
import { encryptApiToken, decryptApiToken } from './crypto.js';

export interface GenerectJwtPayload {
  sub: string;
  aud: string;
  iat: number;
  scope: string;
  gtx: string;
  client_id?: string;
}

type SigningKey = Uint8Array | KeyObject | JWK;

let signingKey: SigningKey | null = null;
let publicKeyJwk: any = null;
let keyId: string = '';

export function getOAuthBaseUrl(): string {
  return process.env.OAUTH_BASE_URL || `https://mcp.generect.com`;
}

export function getMcpEndpointUrl(): string {
  return `${getOAuthBaseUrl()}/mcp`;
}

export function getIssuer(): string {
  return getOAuthBaseUrl();
}

async function getSigningKey(): Promise<SigningKey> {
  if (signingKey) return signingKey;

  const secretKey = process.env.JWT_SIGNING_KEY;
  if (secretKey) {
    signingKey = (await importJWK(
      { k: Buffer.from(secretKey).toString('base64url'), kty: 'oct', alg: 'HS256' },
      'HS256',
    )) as SigningKey;
    publicKeyJwk = { kty: 'oct', alg: 'HS256' };
    keyId = 'default';
    return signingKey;
  }

  const { privateKey, publicKey } = await generateKeyPair('RS256');
  signingKey = privateKey as SigningKey;
  publicKeyJwk = await exportJWK(publicKey);
  keyId = await calculateJwkThumbprint(publicKeyJwk);
  publicKeyJwk.kid = keyId;
  publicKeyJwk.alg = 'RS256';

  return signingKey;
}

export async function getPublicKeyJwk(): Promise<any> {
  await getSigningKey();
  return publicKeyJwk;
}

export function getKeyId(): string {
  return keyId;
}

export async function generateAccessToken(apiToken: string, userId: string, clientId?: string): Promise<string> {
  const key = await getSigningKey();
  const encryptedToken = encryptApiToken(apiToken);
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({
    sub: userId,
    scope: 'generect:api',
    gtx: encryptedToken,
    client_id: clientId,
  })
    .setProtectedHeader({ alg: publicKeyJwk.alg || 'HS256', kid: keyId || undefined })
    .setIssuedAt(now)
    .setIssuer(getIssuer())
    .setAudience(getMcpEndpointUrl())
    .sign(key);

  return jwt;
}

export async function verifyAccessToken(token: string): Promise<GenerectJwtPayload | null> {
  try {
    const key = await getSigningKey();
    const { payload } = await jwtVerify<GenerectJwtPayload>(token, key, {
      issuer: getIssuer(),
      audience: getMcpEndpointUrl(),
    });

    return payload;
  } catch (error) {
    return null;
  }
}

export function extractApiToken(payload: GenerectJwtPayload): string {
  return decryptApiToken(payload.gtx);
}
