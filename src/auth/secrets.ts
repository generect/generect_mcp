// Centralized, fail-closed handling of security-critical secrets.
//
// In production (NODE_ENV=production) a missing or well-known-default secret is a
// hard error: the server refuses to start rather than silently signing tokens or
// encrypting stored API tokens with a value that is public in the source tree.
// Outside production we fall back to a clearly-marked insecure value with a loud
// warning, so local development keeps working without ceremony.

/**
 * Values that must never be used as real secrets. These include the historical
 * hardcoded fallbacks that used to live in crypto.ts, plus a few common weak
 * placeholders. Any of them counts as "not set".
 */
const KNOWN_INSECURE_VALUES: ReadonlySet<string> = new Set([
  'generect-oauth-default-key-change-in-production',
  'generect-encryption-salt',
  'changeme',
  'change-me',
  'secret',
  'password',
]);

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * True when a secret value is missing, empty, or a well-known default/placeholder.
 */
export function isInsecureSecret(value: string | undefined | null): boolean {
  return !value || value.length === 0 || KNOWN_INSECURE_VALUES.has(value);
}

/**
 * Return the value of a required secret env var.
 *
 * - In production: throws if the value is missing or a known-default. Fail closed.
 * - Outside production: returns a clearly-insecure dev fallback and warns once.
 */
export function requireSecret(name: string, devFallback?: string): string {
  const value = process.env[name];
  if (value && !isInsecureSecret(value)) return value;

  if (isProduction()) {
    throw new Error(
      `[security] ${name} must be set to a strong, non-default value when ` +
        `NODE_ENV=production. Refusing to start with a missing or well-known-default secret.`,
    );
  }

  console.warn(
    `[security][WARN] ${name} is unset or a known default; using an INSECURE ` +
      `development value. This must never happen in production.`,
  );
  return devFallback ?? `dev-insecure-${name}`;
}
