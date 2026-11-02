import { readFileSync } from 'node:fs';
import type { Request, Response } from 'express';

/**
 * Domain verification for Google's Connected Apps platform (Gemini, AI Mode in
 * Search). Google Connected Console hands out a token file,
 * `google-connected-apps.json`, and checks that
 * `https://<our domain>/.well-known/google-connected-apps` serves it with a
 * 200 and no redirect
 * (https://developers.google.com/connected-apps/gpc/perform-the-steps).
 *
 * Where the content comes from, first match wins:
 *   1. GOOGLE_CONNECTED_APPS_VERIFICATION — the file's content, verbatim;
 *   2. the file at GOOGLE_CONNECTED_APPS_VERIFICATION_FILE, by default
 *      well-known/google-connected-apps.json in the repo (the token is public by
 *      design: Google fetches it anonymously, so committing it hides nothing).
 * Neither present: 404, as before. The file is read per request, so dropping it
 * on a host takes effect without a restart.
 */
export const GOOGLE_VERIFICATION_PATH = '/.well-known/google-connected-apps';

const DEFAULT_VERIFICATION_FILE = new URL('../well-known/google-connected-apps.json', import.meta.url);

// The token is a few hundred bytes. Anything far larger is not the file Google
// issued, and must not be streamed out of a public, unauthenticated route.
const MAX_BYTES = 64 * 1024;

export function readGoogleVerification(): string | null {
  const fromEnv = process.env.GOOGLE_CONNECTED_APPS_VERIFICATION;
  if (fromEnv && fromEnv.trim()) return fromEnv.length <= MAX_BYTES ? fromEnv : null;
  try {
    const file = process.env.GOOGLE_CONNECTED_APPS_VERIFICATION_FILE || DEFAULT_VERIFICATION_FILE;
    const content = readFileSync(file, 'utf8');
    return content.trim() && content.length <= MAX_BYTES ? content : null;
  } catch {
    return null;
  }
}

export function handleGoogleVerification(_req: Request, res: Response): void {
  const content = readGoogleVerification();
  if (content === null) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  // Short cache: a re-issued token should be picked up within minutes.
  res.set('Cache-Control', 'public, max-age=300');
  res.status(200).type('application/json').send(content);
}
