// Reading the bits of a request handler's context this server needs, in one place.
//
// SDK v2 hands handlers a `ctx` where `ctx.http.req` is the web-standard
// `Request` of the HTTP call (both protocol eras), `ctx.mcpReq._meta` is the
// request's `_meta` (with the 2026-07-28 envelope keys lifted out) and
// `ctx.mcpReq.notify` sends a notification tied to this request. Under stdio
// there is no `ctx.http`, and callers fall back to the configured API key.

/** A request header from the HTTP call behind this request, if any. */
export function requestHeader(ctx: any, name: string): string | undefined {
  const headers = ctx?.http?.req?.headers;
  if (!headers || typeof headers.get !== 'function') return undefined;
  return headers.get(name) ?? undefined;
}

/** The progress token the client attached to this request, if it asked for progress. */
export function progressToken(ctx: any): string | number | undefined {
  const token = ctx?.mcpReq?._meta?.progressToken;
  return token === null ? undefined : token;
}

/** Sends a notification related to this request; a no-op when the transport cannot. */
export function notifier(
  ctx: any,
): ((notification: { method: string; params?: Record<string, unknown> }) => Promise<void>) | undefined {
  const notify = ctx?.mcpReq?.notify;
  return typeof notify === 'function' ? notify : undefined;
}
