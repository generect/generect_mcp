import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';
import { requireSecret } from './secrets.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const ITERATIONS = 100000;

// A 32-byte key expressed as 64 hexadecimal characters.
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

function getEncryptionKey(): Buffer {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (keyHex) {
    // A value is present: it must be a valid 32-byte hex key. Never fall through
    // silently to a derived (possibly default-derived) key on a typo.
    if (!HEX_32_BYTES.test(keyHex)) {
      throw new Error(
        '[security] TOKEN_ENCRYPTION_KEY is set but is not a 32-byte value ' +
          '(expected 64 hexadecimal characters). Refusing to fall back silently.',
      );
    }
    return Buffer.from(keyHex, 'hex');
  }

  // No explicit token key: derive a stable key from the signing secret. This
  // preserves the previous derivation for deployments that only set
  // JWT_SIGNING_KEY, but requireSecret() now fails closed in production instead
  // of quietly using a hardcoded default.
  const secret = requireSecret('JWT_SIGNING_KEY');
  const salt = process.env.JWT_ENCRYPTION_SALT || 'generect-encryption-salt';
  return pbkdf2Sync(secret, salt, ITERATIONS, 32, 'sha256');
}

export function encryptApiToken(plainToken: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const salt = randomBytes(SALT_LENGTH);

  const derivedKey = pbkdf2Sync(key, salt, ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv(ALGORITHM, derivedKey, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plainToken, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([salt, iv, authTag, encrypted]);
  return combined.toString('base64url');
}

export function decryptApiToken(encryptedToken: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encryptedToken, 'base64url');

  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const derivedKey = pbkdf2Sync(key, salt, ITERATIONS, 32, 'sha256');
  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function generateKey(): string {
  return randomBytes(32).toString('hex');
}

// Eagerly resolve the encryption key so callers (e.g. server startup) can fail
// fast on a missing/default/invalid configuration instead of on first use.
export function assertEncryptionKeyConfigured(): void {
  getEncryptionKey();
}

export function hashWithSha256(input: string): string {
  const key = getEncryptionKey();
  return pbkdf2Sync(input, key, 1000, 32, 'sha256').toString('hex');
}
