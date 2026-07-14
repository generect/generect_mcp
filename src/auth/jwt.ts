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
import { isProduction, isInsecureSecret } from './secrets.js';

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
// Key used to VERIFY tokens. For symmetric HS256 it is the same value as the
// signing key; for the asymmetric (dev) fallback it is the public key, which is
// what a private key's signatures must be verified against.
let verificationKey: SigningKey | null = null;
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
  if (secretKey && !isInsecureSecret(secretKey)) {
    signingKey = (await importJWK(
      { k: Buffer.from(secretKey).toString('base64url'), kty: 'oct', alg: 'HS256' },
      'HS256',
    )) as SigningKey;
    verificationKey = signingKey;
    publicKeyJwk = { kty: 'oct', alg: 'HS256' };
    keyId = 'default';
    return signingKey;
  }

  // No usable shared secret. In production this must fail closed: silently
  // generating an ephemeral in-memory keypair would break token verification
  // across restarts and across instances (and hide a misconfiguration).
  if (isProduction()) {
    throw new Error(
      '[security] JWT_SIGNING_KEY must be set to a strong, non-default value when ' +
        'NODE_ENV=production. Refusing to fall back to an ephemeral in-memory key.',
    );
  }
  console.warn(
    '[security][WARN] JWT_SIGNING_KEY is unset or a known default; generating an ' +
      'EPHEMERAL RS256 keypair for development only. Tokens will not survive a restart.',
  );

  const { privateKey, publicKey } = await generateKeyPair('RS256');
  signingKey = privateKey as SigningKey;
  verificationKey = publicKey as SigningKey;
  publicKeyJwk = await exportJWK(publicKey);
  keyId = await calculateJwkThumbprint(publicKeyJwk);
  publicKeyJwk.kid = keyId;
  publicKeyJwk.alg = 'RS256';

  return signingKey;
}

// Returns the key that verifies tokens (symmetric secret for HS256, public key
// for the asymmetric dev fallback). Ensures the key material has been initialized.
async function getVerificationKey(): Promise<SigningKey> {
  await getSigningKey();
  return verificationKey as SigningKey;
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
    const key = await getVerificationKey();
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
