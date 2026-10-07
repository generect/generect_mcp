// The handler context SDK v2 passes to tools: `ctx.http.req` is the web-standard
// Request of the HTTP call, `ctx.mcpReq` carries `_meta` and `notify`. Tests build
// the same shape so they exercise the code paths production takes.
export function ctxWith(authorization?: string, mcpReq: Record<string, unknown> = {}) {
  const headers = new Headers();
  if (authorization) headers.set('authorization', authorization);
  return { http: { req: new Request('https://mcp.test/mcp', { method: 'POST', headers }) }, mcpReq };
}
