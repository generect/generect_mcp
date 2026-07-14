// Test helpers for setting/restoring the environment variables that the auth and
// logging modules read. Not a *.test.ts file, so the test runner does not pick it
// up as a suite.

export type EnvPatch = Record<string, string | undefined>;

export function setEnv(patch: EnvPatch): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Run `fn` with `patch` applied, then restore the previous values. Sync or async. */
export async function withEnv<T>(patch: EnvPatch, fn: () => T | Promise<T>): Promise<T> {
  const keys = Object.keys(patch);
  const saved: EnvPatch = {};
  for (const k of keys) saved[k] = process.env[k];
  setEnv(patch);
  try {
    return await fn();
  } finally {
    setEnv(saved);
  }
}

// The env keys the auth/logging modules care about — cleared between cases so one
// test never leaks into another.
export const AUTH_ENV_KEYS = [
  'NODE_ENV',
  'TOKEN_ENCRYPTION_KEY',
  'JWT_SIGNING_KEY',
  'JWT_ENCRYPTION_SALT',
  'OAUTH_BASE_URL',
  'MCP_LOG',
  'MCP_LOG_PAYLOADS',
] as const;

export function clearAuthEnv(): void {
  for (const k of AUTH_ENV_KEYS) delete process.env[k];
}

// A valid 32-byte key as 64 hex chars.
export const VALID_TOKEN_KEY = 'ab'.repeat(32);
// The historical hardcoded default that must now be rejected in production.
export const INSECURE_DEFAULT_KEY = 'generect-oauth-default-key-change-in-production';
