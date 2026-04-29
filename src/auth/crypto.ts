import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const ITERATIONS = 100000;

function getEncryptionKey(): Buffer {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (keyHex) {
    const key = Buffer.from(keyHex, 'hex');
    if (key.length === 32) return key;
  }
  const secret = process.env.JWT_SIGNING_KEY || 'generect-oauth-default-key-change-in-production';
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

export function hashWithSha256(input: string): string {
  const key = getEncryptionKey();
  return pbkdf2Sync(input, key, 1000, 32, 'sha256').toString('hex');
}
