export type ParsedAuth = { kind: 'token'; apiKey: string } | { kind: 'jwt'; jwt: string };

const KEYWORDS = new Set(['bearer', 'token']);

function looksLikeJwt(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  return parts.every(segment => segment.length > 0 && /^[A-Za-z0-9_-]+$/.test(segment));
}

function classify(value: string): ParsedAuth {
  return looksLikeJwt(value) ? { kind: 'jwt', jwt: value } : { kind: 'token', apiKey: value };
}

export function parseAuthHeader(header: string | undefined | null): ParsedAuth | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);

  if (parts.length === 1) {
    const single = parts[0];
    if (KEYWORDS.has(single.toLowerCase())) return null;
    return classify(single);
  }

  if (parts.length === 2) {
    const [prefix, value] = parts;
    if (KEYWORDS.has(prefix.toLowerCase())) {
      return classify(value);
    }
    return null;
  }

  if (parts.length === 3) {
    const [first, second, value] = parts;
    if (first.toLowerCase() === 'bearer' && second.toLowerCase() === 'token') {
      return classify(value);
    }
    return null;
  }

  return null;
}
