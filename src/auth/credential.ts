/**
 * One answer to "is this value an API key, or an Authorization header?".
 *
 * Both shapes existed side by side and nothing said which was which: OAuth
 * stored `Token <key>` (a header value) while the tool layer read the same
 * field as a bare key and prefixed it again, so every OAuth-authenticated tool
 * call went out as `Authorization: Token Token <key>` and the Generect API
 * answered 401 "Authentication credentials were not provided". The header was
 * present, so nothing looked broken from the outside.
 *
 * The canonical stored form is the BARE KEY. Build the header only where the
 * outbound request is made, with `toAuthHeader`. Both functions are idempotent
 * and accept either shape, which is what lets tokens minted before this change
 * — they carry the prefix inside the JWT and last 30 days — keep working
 * instead of everyone having to reconnect.
 */

const PREFIX = 'Token ';

/** The bare API key, whether it arrived bare or as a full header value. */
export function toApiKey(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  // Case-insensitive, because the scheme name in an Authorization header is not
  // case-sensitive (RFC 9110 §11.1) and hand-written client configs use both
  // spellings. Matching the scheme with the separator *inside* the pattern also
  // handles `"Token "` — a prefix and nothing else, which a naive
  // `startsWith('Token ')` misses once the value has been trimmed, and which
  // then comes back out as the key `Token` and re-prefixes to `Token Token`.
  // A credential consisting of only the scheme name is treated as absent; real
  // Generect keys are long hex strings, never the literal word "token".
  const scheme = /^token(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (scheme) return (scheme[1] ?? '').trim();
  return trimmed;
}

/** A complete `Authorization` value, whichever shape came in. Empty in → empty out. */
export function toAuthHeader(value: string | undefined | null): string {
  const key = toApiKey(value);
  return key ? `${PREFIX}${key}` : '';
}
