import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken, extractApiToken } from './auth/jwt.js';
import { parseAuthHeader } from './auth/parse.js';
import { toAuthHeader } from './auth/credential.js';
import { annotate as annotateTestMode, isTestRequest } from './testmode.js';
import { VERSION } from './version.js';
import { fetchPriceBook, priceTag, receipt, estimate, round, type Operation, type PriceBook } from './pricing.js';

// Structured request/response logging.
//   - Metadata (tool name, timing, status, correlation id) is logged by default;
//     set MCP_LOG=0 to disable logging entirely.
//   - Request/response PAYLOADS may contain personal data of prospects (names,
//     company domains, generated emails). They are NOT logged verbatim by
//     default — each value is reduced to a non-identifying shape summary. Set
//     MCP_LOG_PAYLOADS=1 to log payloads verbatim (short-lived debugging, with
//     the data owner's consent).
// Both switches are read live (per event), so they can be toggled without a
// restart and are trivial to exercise in tests.
const isLogEnabled = () => process.env.MCP_LOG !== '0' && process.env.MCP_LOG !== 'false';
const isPayloadLoggingEnabled = () => process.env.MCP_LOG_PAYLOADS === '1' || process.env.MCP_LOG_PAYLOADS === 'true';

type Fetcher = typeof fetch;

// One JSON line per event, written to stderr (stdout is reserved for the MCP
// stdio protocol, so logs must never go there). Correlated by reqId.
function logEvent(event: string, data: Record<string, unknown>) {
  if (!isLogEnabled()) return;
  try {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
  } catch {
    // Never let logging (e.g. a value that cannot be serialized) break a request.
    console.error(`[mcp] ${event}`);
  }
}

// Reduce a value to a non-identifying summary unless payload logging is
// explicitly enabled. Object keys are preserved (so you can see WHICH fields
// were sent), but their values become `<type:length>` markers. Bounded in depth
// and breadth, so it is safe on large or cyclic structures.
export function redact(value: unknown, depth = 0): unknown {
  if (isPayloadLoggingEnabled()) return value;
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') return `<str:${(value as string).length}>`;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return `<${t}>`;
  if (t === 'function' || t === 'symbol') return `<${t}>`;
  if (value instanceof Date) return '<date>';
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `<buffer:${(value as Buffer).length}>`;

  if (Array.isArray(value)) {
    if (depth >= 4) return `<array:${value.length}>`;
    return value.slice(0, 20).map(v => redact(v, depth + 1));
  }
  if (t === 'object') {
    if (depth >= 4) return '<object>';
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).slice(0, 50)) {
      out[k] = redact((value as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return `<${t}>`;
}

// Pull a readable preview of what is returned to the LLM out of an MCP result.
function previewResult(result: any) {
  try {
    const text = result?.content?.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
    const out: Record<string, unknown> = {};
    if (text) out.text = text.length > 4000 ? `${text.slice(0, 4000)}…(${text.length} chars)` : text;
    if (result?.structuredContent) out.structuredContent = result.structuredContent;
    if (result?.isError) out.isError = true;
    return Object.keys(out).length ? out : result;
  } catch {
    return result;
  }
}

// Wraps a tool handler so every call logs the input (LLM → tool) and the
// output (tool → LLM) with timing, under a shared request id.
function loggedTool(
  server: McpServer,
  name: string,
  description: string,
  schema: any,
  handler: (args: any, extra: any) => Promise<any>,
) {
  server.tool(name, description, schema, async (args: any, extra: any) => {
    const reqId = randomUUID();
    const started = Date.now();
    logEvent('tool_call', { reqId, tool: name, input: redact(args) });
    try {
      const handled = await handler(args, extra);
      // Annotated here, once, rather than in each of the ~25 tool bodies: a
      // marker that a tool can forget to add is a marker that will be missing
      // from exactly the tool where it mattered. See src/testmode.ts.
      const result = (await isTestRequest(extra)) ? annotateTestMode(handled) : handled;
      logEvent('tool_result', {
        reqId,
        tool: name,
        ms: Date.now() - started,
        test_mode: result !== handled,
        output: redact(previewResult(result)),
      });
      return result;
    } catch (err: unknown) {
      logEvent('tool_error', { reqId, tool: name, ms: Date.now() - started, error: String(err) });
      throw err;
    }
  });
}

// Result helper: MCP clients read `content`, agent frameworks read
// `structuredContent`. Both must carry the same object, including the cost
// receipt — a spend figure that only exists in prose gets dropped.
function result(value: unknown) {
  return {
    structuredContent: value as Record<string, unknown>,
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  } as any;
}

// ---------------------------------------------------------------------------
// Client identification
// ---------------------------------------------------------------------------
// Without this header, MCP traffic is indistinguishable from raw API traffic in
// our own billing and access logs, which makes "how much does the agent channel
// earn?" unanswerable. Cheap to send, and the API ignores unknown headers.
const CLIENT_ID = `generect-mcp/${VERSION}`;

function apiHeaders(authorization: string): Record<string, string> {
  return {
    Authorization: authorization,
    'Content-Type': 'application/json',
    'User-Agent': CLIENT_ID,
    'X-Generect-Client': CLIENT_ID,
  };
}

async function fetchWithTimeout(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs = 20000) {
  // Log the exact filter payload we forward to the Generect API (never the
  // Authorization header — it carries the API token).
  let reqBody: unknown = init.body?.toString() || null;
  try {
    if (typeof reqBody === 'string') reqBody = JSON.parse(reqBody);
  } catch {}
  logEvent('api_request', { url, method: init.method ?? 'GET', body: redact(reqBody) });
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetcher(url, { ...init, signal: controller.signal });
    // On a non-2xx response, capture the API error body (clone so the caller can
    // still read the stream). This is what reveals *why* a filter was rejected
    // instead of the rejection silently surfacing to the LLM as "0 results".
    let errorBody: string | undefined;
    if (!res.ok) {
      try {
        const t = await res.clone().text();
        // The upstream error body can echo request context / other data. Log it
        // verbatim only when payload logging is explicitly enabled; otherwise
        // record just its size so we still know an error body was present.
        errorBody = isPayloadLoggingEnabled()
          ? t.length > 2000
            ? `${t.slice(0, 2000)}…(${t.length} chars)`
            : t
          : `<errorBody:${t.length}>`;
      } catch {}
    }
    logEvent('api_response', {
      url,
      status: res.status,
      ms: Date.now() - started,
      ...(errorBody ? { errorBody } : {}),
    });
    return res;
  } catch (err: unknown) {
    logEvent('api_error', { url, ms: Date.now() - started, error: String(err) });
    throw err;
  } finally {
    clearTimeout(id);
  }
}

// Calls the Generect API and parses JSON. On a non-2xx status it throws an error
// carrying the real API status + detail, so a rejected filter surfaces to the LLM
// as an actual error instead of being silently flattened to "0 results".
async function callApi(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number) {
  const res = await fetchWithTimeout(fetcher, url, init, timeoutMs);
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err: any = new Error(`Generect API responded with ${res.status}`);
    err.status = res.status;
    err.detail = data && typeof data === 'object' && 'detail' in data ? data.detail : data;
    throw err;
  }
  return data;
}

// Builds an MCP error result the LLM can act on (real status + reason), flagged
// with isError so clients don't treat it as a successful empty payload.
function apiError(err: any) {
  const status = err?.status ?? null;
  const detail = err?.detail ?? null;
  const insufficient = typeof detail === 'string' && /insufficient funds/i.test(detail);
  return {
    ...result({
      error: String(err?.message ?? err),
      status,
      detail,
      ...(insufficient
        ? {
            next_step:
              'The account is out of credits. Nothing was charged. Call get_balance, tell the user the balance, and stop — do not retry.',
          }
        : {}),
    }),
    isError: true,
  } as any;
}

const V1 = '/api/v1';

// ---------------------------------------------------------------------------
// database vs realtime
// ---------------------------------------------------------------------------
// Every search/enrich operation exists twice: `database` (cached, sub-second,
// cheaper, free counts) and `realtime` (live LinkedIn, pricier, billable counts).
// The cheap mode supports a smaller filter set, and the API rejects the rest
// with a precise 400 that names the offending filter. So instead of hardcoding a
// filter taxonomy that silently rots as the API grows, `auto` mode TRIES the
// cheap path first and reads the API's own answer. A rejected call bills nothing,
// so the retry is free.
type Mode = 'auto' | 'database' | 'realtime';

const UNSUPPORTED_IN_DB = /not supported in database mode/i;

function unsupportedFilters(detail: unknown): string[] {
  if (!detail || typeof detail !== 'object') return [];
  return Object.entries(detail as Record<string, unknown>)
    .filter(([, message]) => UNSUPPORTED_IN_DB.test(String(message)))
    .map(([field]) => field);
}

// Filters that only exist in realtime mode. Used for DESCRIPTIONS only (so the
// model can predict the cost before calling); runtime routing is driven by the
// API response above.
const REALTIME_ONLY_NOTE = ' — realtime only: using it forces the pricier live mode.';

function modeParam(what: string) {
  return z
    .enum(['auto', 'database', 'realtime'])
    .describe(
      `Data mode. "database" = cached, sub-second, cheaper, free counts, core filters only. "realtime" = live LinkedIn lookup, 5–60s, pricier, supports every filter. "auto" (default) tries database first and only escalates to realtime if a filter you passed is unsupported there — an escalation is reported in the response. Pick "database" explicitly when ${what} and cost matters more than freshness.`,
    )
    .optional();
}

/**
 * Runs a search/enrich against the cheap mode first, escalating only when the
 * API says the requested filters need the live one.
 */
async function callWithMode(
  fetcher: Fetcher,
  args: {
    mode: Mode;
    dbUrl: string;
    rtUrl: string;
    body: unknown;
    headers: Record<string, string>;
    timeoutMs: number;
  },
): Promise<{ data: any; mode: 'database' | 'realtime'; escalated_because?: string[] }> {
  const { mode, dbUrl, rtUrl, body, headers, timeoutMs } = args;
  const init = { method: 'POST', headers, body: JSON.stringify(body) } as RequestInit;
  if (mode === 'realtime') {
    return { data: await callApi(fetcher, rtUrl, init, timeoutMs), mode: 'realtime' };
  }
  try {
    return { data: await callApi(fetcher, dbUrl, init, timeoutMs), mode: 'database' };
  } catch (err: any) {
    const blocked = unsupportedFilters(err?.detail);
    // An explicit database request is never silently upgraded to a pricier call.
    if (mode === 'database' || blocked.length === 0) throw err;
    return {
      data: await callApi(fetcher, rtUrl, init, timeoutMs),
      mode: 'realtime',
      escalated_because: blocked,
    };
  }
}

// ---------------------------------------------------------------------------
// Backwards compatibility with the pre-v1 tool surface
// ---------------------------------------------------------------------------
// The old tools took `job_title` (singular) and several by_icp-only flags that
// have no v1 equivalent. The MCP SDK validates arguments against the declared
// shape and **silently strips anything not declared** — so if we simply dropped
// these names, an existing caller asking for `job_title: "CEO"` would get a
// search with no title filter at all: a much broader, more expensive query than
// they asked for, with no error. That is the exact failure this release exists
// to prevent, so the removed names stay declared and are handled explicitly.
const LEGACY_NOTES: Record<string, string> = {
  exclude_title_keywords:
    'No v1 equivalent. Narrow job_titles instead, or filter the returned rows yourself.',
  without_company: 'No longer needed — v1 filter-only search is the default when no company anchor is set.',
  get_max_leads: 'Always on now: search responses include results_count without asking.',
  get_max_companies: 'Always on now: search responses include results_count without asking.',
  fallback_from_leads: 'Removed. It fabricated lead-derived name aggregates and cost an extra billable query.',
  lead_industries:
    "Removed: v1 filters on the employer's industry. Use company_industries.",
  comments: 'Removed: v1 enrich returns the full profile without per-section toggles.',
  posts: 'Removed: v1 enrich returns the full profile without per-section toggles.',
  people_also_viewed: 'Removed: v1 enrich returns the full profile without per-section toggles.',
  inexact_company: 'Removed: v1 enrich matches on the identifier you pass.',
};

const legacyFlag = (name: string) =>
  z.any().describe(`DEPRECATED — accepted but ignored. ${LEGACY_NOTES[name]}`).optional();

const LEGACY_LEAD_SHAPE = {
  job_title: z
    .string()
    .describe('DEPRECATED alias for job_titles. Still honoured: it is merged into job_titles.')
    .optional(),
  exclude_title_keywords: legacyFlag('exclude_title_keywords'),
  without_company: legacyFlag('without_company'),
  get_max_leads: legacyFlag('get_max_leads'),
  lead_industries: legacyFlag('lead_industries'),
};

const LEGACY_COMPANY_SHAPE = {
  get_max_companies: legacyFlag('get_max_companies'),
  fallback_from_leads: legacyFlag('fallback_from_leads'),
};

const LEGACY_ENRICH_SHAPE = {
  comments: legacyFlag('comments'),
  posts: legacyFlag('posts'),
  people_also_viewed: legacyFlag('people_also_viewed'),
  inexact_company: legacyFlag('inexact_company'),
};

/** Which deprecated names the caller actually sent, so the response can say so. */
function legacyUsed(args: any): Record<string, string> | undefined {
  const used: Record<string, string> = {};
  for (const name of Object.keys(LEGACY_NOTES)) {
    if (args?.[name] !== undefined) used[name] = LEGACY_NOTES[name];
  }
  return Object.keys(used).length > 0 ? used : undefined;
}

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------
// MCP-internal control flags must not reach the API as if they were filters.
const CONTROL_FIELDS = [
  'compact',
  'timeout_ms',
  'mode',
  'limit',
  'offset',
  'company_filters',
  'include_prices',
  'job_title',
  ...Object.keys(LEGACY_NOTES),
];

function toFilters(args: any): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (CONTROL_FIELDS.includes(k) || v === undefined) continue;
    filters[k] = v;
  }
  if (args?.limit != null && filters.limit_by == null) filters.limit_by = args.limit;
  if (args?.offset != null && filters.offset_by == null) filters.offset_by = args.offset;
  // Honour the old singular form rather than dropping the caller's only real filter.
  if (typeof args?.job_title === 'string' && args.job_title.trim()) {
    const titles = Array.isArray(filters.job_titles) ? (filters.job_titles as string[]) : [];
    if (!titles.includes(args.job_title)) filters.job_titles = [...titles, args.job_title];
  }
  return filters;
}

// A single call must never trigger an unbounded pull: search bills per returned
// row, so an un-clamped limit is an open-ended charge. Callers who want more
// paginate across calls.
const MAX_RESULT_LIMIT = Number(process.env.MCP_MAX_RESULT_LIMIT || '100');
const DEFAULT_RESULT_LIMIT = 25;

function clampLimit(body: Record<string, unknown>): number {
  let n = body.limit_by as number | undefined;
  if (n == null || Number.isNaN(Number(n))) n = DEFAULT_RESULT_LIMIT;
  n = Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.floor(Number(n))));
  body.limit_by = n;
  return n;
}

// ---------------------------------------------------------------------------
// Compact projections
// ---------------------------------------------------------------------------
// A raw lead is ~80 fields (skills, education, every location component). Handing
// that to a model burns context for no gain and buries the two fields that
// actually drive the next step: `id` (cheap enrichment / email lookup without
// re-searching) and `company_website` (domain for the email finder).
function compactLead(lead: any) {
  return {
    id: lead.id ?? lead.lead_id ?? lead.sales_id ?? null,
    full_name: lead.full_name ?? lead.unformatted_full_name ?? null,
    first_name: lead.first_name ?? null,
    last_name: lead.last_name ?? null,
    job_title: lead.job_title ?? lead.title ?? lead.raw_job_title ?? null,
    company_name: lead.company_name ?? lead.raw_company_name ?? null,
    company_domain: lead.company_domain ?? domainOf(lead.company_website) ?? null,
    industry: lead.company_industry ?? lead.industry ?? null,
    location: lead.location ?? lead.job_location ?? null,
    linkedin_url: lead.linkedin_url ?? null,
  };
}

function domainOf(website: unknown): string | null {
  if (typeof website !== 'string' || !website.trim()) return null;
  try {
    return new URL(website.startsWith('http') ? website : `https://${website}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function compactCompany(company: any) {
  return {
    id: company.id ?? company.company_id ?? null,
    name: company.name ?? company.company_name ?? null,
    domain: company.domain ?? domainOf(company.website) ?? null,
    website: company.website ?? null,
    industry: company.industry ?? company.company_industry ?? null,
    headcount_range: company.headcount_range ?? null,
    headcount_exact: company.headcount_exact ?? null,
    location: company.location ?? null,
    linkedin_url: company.linkedin_link ?? company.linkedin_url ?? null,
  };
}

// Identity-only record from POST /profile/resolve/. Drops the two signed CDN
// photo URLs (long, and they expire) and the fields that duplicate others
// (`sales_id` === `id`, `unformatted_full_name` === `full_name`). `compact:
// false` returns the record as the API sent it, photos included.
function compactProfile(profile: any) {
  return {
    linkedin_url: profile.linkedin_url ?? null,
    public_identifier: profile.public_identifier ?? null,
    linkedin_id: profile.linkedin_id ?? null,
    id: profile.id ?? profile.sales_id ?? null,
    full_name: profile.full_name ?? profile.unformatted_full_name ?? null,
    first_name: profile.first_name ?? null,
    last_name: profile.last_name ?? null,
    headline: profile.headline ?? null,
    is_memorialized: profile.is_memorialized ?? null,
    input: profile.input ?? null,
  };
}

const compactParam = (what: string) =>
  z
    .boolean()
    .describe(
      `Default true: return a small per-${what} summary (including the Generect \`id\`, which every later step accepts). Set false for the full raw record (~80 fields) — only worth it when you specifically need skills, education or other deep fields.`,
    )
    .optional();

// ---------------------------------------------------------------------------
// Filter shapes
// ---------------------------------------------------------------------------
const LEAD_FILTERS = {
  job_titles: z
    .array(z.string())
    .describe('Target job titles, OR-matched (e.g. ["CEO","Founder","Owner"]). A lead needs to match only one.')
    .optional(),
  seniorities: z
    .array(z.string())
    .describe(
      'Seniority at the current employer, e.g. ["Owner","CXO","VP","Director","Manager"]. Current position only.',
    )
    .optional(),
  locations: z
    .array(z.string())
    .describe('Where the lead lives — matches cities, states and countries, e.g. ["United States","Berlin"].')
    .optional(),
  exclude_locations: z.array(z.string()).describe('Lead locations to exclude.').optional(),
  company_locations: z.array(z.string()).describe("HQ location of the lead's current employer.").optional(),
  exclude_company_locations: z.array(z.string()).describe('Employer HQ locations to exclude.').optional(),
  company_industries: z
    .array(z.string())
    .describe(
      'Industry of the current employer. Must match Generect industry names exactly (e.g. "Software Development", "Financial Services"); names are hierarchical and unknown names are rejected with HTTP 400 naming the field.',
    )
    .optional(),
  exclude_company_industries: z.array(z.string()).describe('Employer industries to exclude.').optional(),
  company_headcounts: z
    .array(z.string())
    .describe(
      'Employer size buckets. Allowed ONLY: "1-10","11-50","51-200","201-500","501-1000","1001-5000","5001-10000","10 000+" (note the space in "10 000+").',
    )
    .optional(),
  exclude_company_headcounts: z.array(z.string()).describe('Employer size buckets to exclude.').optional(),
  company_types: z
    .array(z.string())
    .describe(
      'Employer types: "Public Company","Privately Held","Non Profit","Government Agency","Educational","Self Employed","Self Owned","Partnership".',
    )
    .optional(),
  company_name: z.string().describe('Anchor to one company by name (exclusive with company_link/company_id).').optional(),
  company_link: z.string().describe('Anchor to one company by LinkedIn URL.').optional(),
  company_id: z.union([z.string(), z.number()]).describe('Anchor to one company by LinkedIn numeric id.').optional(),
  exclude_names: z
    .array(z.string())
    .describe(
      'Skip leads by full name. KNOWN ISSUE: in database mode any non-empty value collapses the result set to 0 (verified 2026-08-09); it behaves correctly in realtime mode. Prefer exclude_ids, or filter names out yourself after the search.',
    )
    .optional(),
  exclude_ids: z
    .array(z.union([z.string(), z.number()]))
    .describe(
      'Skip leads by Generect/Sales-Navigator id. Pass the ids you already received to paginate without duplicates — ordering is not stable, so this is more reliable than offset.',
    )
    .optional(),
  filter_empty_vars: z
    .array(z.string())
    .describe(
      'Drop leads where these fields are empty, e.g. ["profile_photo","job_started_on"]. Useful to raise data quality before paying.',
    )
    .optional(),
  strict: z.array(z.string()).describe('Fields to match strictly, e.g. ["company_locations"].').optional(),

  // realtime-only below
  keywords: z
    .array(z.string())
    .describe('Free-text keywords across headline/summary/skills' + REALTIME_ONLY_NOTE)
    .optional(),
  functions: z
    .array(z.string())
    .describe('Job functions, e.g. ["Sales","Marketing","Engineering"]' + REALTIME_ONLY_NOTE)
    .optional(),
  past_company_names: z
    .array(z.string())
    .describe('Companies the lead previously worked at (alumni targeting)' + REALTIME_ONLY_NOTE)
    .optional(),
  years_in_position: z
    .array(z.number())
    .describe('Time in current role: 1=<1y, 2=1-2y, 3=3-5y, 4=6-10y, 5=10y+' + REALTIME_ONLY_NOTE)
    .optional(),
  years_in_company: z
    .array(z.number())
    .describe('Time at current company, same buckets as years_in_position' + REALTIME_ONLY_NOTE)
    .optional(),
  changed_jobs: z.boolean().describe('Only leads who recently changed jobs' + REALTIME_ONLY_NOTE).optional(),
  posted_on_linkedin: z
    .boolean()
    .describe('Only leads who recently posted on LinkedIn' + REALTIME_ONLY_NOTE)
    .optional(),
  linkedin_filter_link: z
    .string()
    .describe('A LinkedIn / Sales Navigator search URL to lift filters from' + REALTIME_ONLY_NOTE)
    .optional(),
  personas: z
    .array(z.any())
    .describe('Advanced raw persona tuples [name, functions, seniorities, prohibits, priority?]' + REALTIME_ONLY_NOTE)
    .optional(),
};

const COMPANY_FILTERS = {
  industries: z
    .array(z.string())
    .describe(
      'Company industries. Must match Generect industry names exactly (e.g. "Software Development"); unknown names are rejected with HTTP 400.',
    )
    .optional(),
  exclude_industries: z.array(z.string()).describe('Industries to exclude.').optional(),
  sub_industries: z
    .boolean()
    .describe('Expand each selected industry to its sub-industries as well (broadens the match).')
    .optional(),
  headcounts: z
    .array(z.string())
    .describe(
      'Size buckets. Allowed ONLY: "1-10","11-50","51-200","201-500","501-1000","1001-5000","5001-10000","10 000+".',
    )
    .optional(),
  locations: z.array(z.string()).describe('HQ locations — cities, states or countries.').optional(),
  exclude_locations: z.array(z.string()).describe('HQ locations to exclude.').optional(),
  company_types: z
    .array(z.string())
    .describe('Company types: "Public Company","Privately Held","Non Profit","Government Agency","Educational", …')
    .optional(),
  exclude_domains: z.array(z.string()).describe('Exclude companies by domain (e.g. existing customers).').optional(),
  exclude_ids: z.array(z.union([z.string(), z.number()])).describe('Exclude companies by LinkedIn id/URN.').optional(),

  // realtime-only below
  keywords: z
    .array(z.string())
    .describe('Free-text keywords across name/description/specialties' + REALTIME_ONLY_NOTE)
    .optional(),
  company_names: z.array(z.string()).describe('Restrict to specific company names' + REALTIME_ONLY_NOTE).optional(),
  technologies: z.array(z.string()).describe('Technologies the company uses' + REALTIME_ONLY_NOTE).optional(),
  num_of_followers: z
    .array(z.string())
    .describe('LinkedIn follower buckets: "1-50","51-100","101-1000","1001-5000","5001+"' + REALTIME_ONLY_NOTE)
    .optional(),
  revenues_range: z
    .object({ min: z.number(), max: z.number() })
    .describe('Annual revenue range, single object {min,max}' + REALTIME_ONLY_NOTE)
    .optional(),
  department_headcount: z
    .object({ name: z.string(), min: z.number().optional(), max: z.number().optional() })
    .describe('Department size, e.g. {"name":"engineering","min":10,"max":100}' + REALTIME_ONLY_NOTE)
    .optional(),
  headcount_growth: z
    .object({ min: z.number().optional(), max: z.number().optional() })
    .describe('Headcount growth in percent' + REALTIME_ONLY_NOTE)
    .optional(),
  hiring_on_linkedin: z.boolean().describe('Only companies actively hiring' + REALTIME_ONLY_NOTE).optional(),
  linkedins_links: z.array(z.string()).describe('Specific LinkedIn company URLs' + REALTIME_ONLY_NOTE).optional(),
};

const PAGING = {
  limit_by: z
    .number()
    .describe(`Rows to return this call (1–${MAX_RESULT_LIMIT}, default ${DEFAULT_RESULT_LIMIT}). You are billed per returned row, so this number IS the price of the call.`)
    .optional(),
  offset_by: z.number().describe('Rows to skip (pagination).').optional(),
  limit: z.number().describe('Alias for limit_by.').optional(),
  offset: z.number().describe('Alias for offset_by.').optional(),
  timeout_ms: z.number().describe('Request timeout in milliseconds.').optional(),
};

const IDENTIFY_LEAD = {
  lead_id: z
    .string()
    .describe('Generect lead id from search / preview / enrich results — the cheapest and most accurate identifier.')
    .optional(),
  linkedin_url: z.string().describe('LinkedIn profile URL.').optional(),
  first_name: z.string().describe('First name (name+domain mode).').optional(),
  last_name: z.string().describe('Last name (name+domain mode).').optional(),
  domain: z.string().describe('Company domain without protocol, e.g. "stripe.com" (name+domain mode).').optional(),
};

/** One-of identifier resolution shared by email/phone tools. */
function leadIdentifier(args: any, domainField: 'domain' | 'company'): Record<string, unknown> {
  if (args?.lead_id) return { lead_id: String(args.lead_id) };
  if (args?.linkedin_url) return { linkedin_url: String(args.linkedin_url) };
  if (args?.first_name && args?.last_name && (args?.domain || args?.company)) {
    return {
      first_name: args.first_name,
      last_name: args.last_name,
      [domainField]: args.domain ?? args.company,
    };
  }
  throw Object.assign(
    new Error(`Provide exactly one identifier: lead_id, or linkedin_url, or first_name + last_name + ${domainField}.`),
    { status: 400 },
  );
}

export function registerTools(server: McpServer, fetcher: Fetcher, apiBase: string, apiKey: string) {
  async function resolveAuthHeader(extra: any): Promise<string> {
    const header = extra?.requestInfo?.headers?.authorization as string | undefined;
    const parsed = parseAuthHeader(header);

    if (!parsed) {
      const fallback = apiKey || '';
      if (!fallback) {
        throw new Error('Authorization header is required');
      }
      return toAuthHeader(fallback);
    }

    if (parsed.kind === 'token') {
      return toAuthHeader(parsed.apiKey);
    }

    const payload = await verifyAccessToken(parsed.jwt);
    if (!payload) {
      throw new Error('Invalid or expired access token');
    }
    // extractApiToken may return either shape: tokens minted before the
    // canonical form was fixed carry the `Token ` prefix inside the JWT.
    return toAuthHeader(extractApiToken(payload));
  }
  const defaultTimeoutMs = Number(process.env.GENERECT_TIMEOUT_MS || '300000');
  const timeoutOf = (args: any) => Number(args?.timeout_ms ?? defaultTimeoutMs);

  const priceBook = (authorization: string, headers: Record<string, string>) =>
    fetchPriceBook(fetcher, apiBase, authorization, headers);

  // =========================================================================
  // FREE PRE-FLIGHT — the tools an agent should reach for first
  // =========================================================================

  // 1. count_leads
  loggedTool(
    server,
    'count_leads',
    `How many leads match an ICP, and what pulling them would cost. ${priceTag('count_database')} ALWAYS CALL THIS BEFORE search_leads: it is the only way to learn the size of an audience without paying per row, and it returns a cost estimate for the next step at this account's real rates. A realtime count is NOT free ($0.02 flat) — this tool refuses to run one unless you pass mode:"realtime" on purpose.`,
    {
      ...LEAD_FILTERS,
      ...LEGACY_LEAD_SHAPE,
      company_filters: z
        .object(COMPANY_FILTERS)
        .partial()
        .describe(
          'Optional: count leads only at companies matching these company filters (a two-level ICP). Still free in database mode.',
        )
        .optional(),
      mode: modeParam('you only need a size estimate'),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const mode: Mode = args?.mode ?? 'auto';
        const leadFilters = toFilters(args);
        const companyFilters = args?.company_filters;
        const twoLevel = companyFilters && Object.keys(companyFilters).length > 0;
        const body = twoLevel
          ? { company_search_criteria: companyFilters, lead_search_criteria: leadFilters }
          : leadFilters;
        const path = twoLevel ? 'company-leads' : 'leads';
        const dbUrl = `${apiBase}${V1}/search/database/${path}/count/`;
        const rtUrl = `${apiBase}${V1}/search/realtime/${path}/count/`;

        if (mode === 'realtime') {
          const data = await callApi(
            fetcher,
            rtUrl,
            { method: 'POST', headers, body: JSON.stringify(body) },
            timeoutOf(args),
          );
          const book = await priceBook(Authorization, headers);
          return result({
            results_count: data?.data?.results_count ?? data?.data?.count ?? null,
            mode: 'realtime',
            deprecated_params_ignored: legacyUsed(args),
            cost: receipt('count_realtime', data),
            next_step_estimate: estimateBlock(book, 'realtime', data?.data?.results_count),
          });
        }

        // Free path. If the filters cannot run here, DON'T silently spend $0.02
        // on a live count — say what it would take and let the caller decide.
        try {
          const data = await callApi(
            fetcher,
            dbUrl,
            { method: 'POST', headers, body: JSON.stringify(body) },
            timeoutOf(args),
          );
          const count = data?.data?.results_count ?? data?.data?.count ?? null;
          const book = await priceBook(Authorization, headers);
          return result({
            results_count: count,
            mode: 'database',
            deprecated_params_ignored: legacyUsed(args),
            cost: receipt('count_database', data),
            next_step_estimate: estimateBlock(book, 'database', count),
            ...(count === 0
              ? {
                  advice:
                    'Zero matches. Do NOT run a paid search — loosen a filter (drop the narrowest one first) or try mode:"realtime", which has a bigger index and more filters.',
                }
              : {}),
          });
        } catch (err: any) {
          const blocked = unsupportedFilters(err?.detail);
          if (mode === 'auto' && blocked.length > 0) {
            const book = await priceBook(Authorization, headers);
            return result({
              results_count: null,
              mode: 'none',
              cost: { operation: 'count_database', amount_charged_usd: 0, billed: 'nothing was charged' },
              needs_realtime: blocked,
              why: `These filters do not exist in the free cached index: ${blocked.join(', ')}.`,
              options: [
                `Drop ${blocked.join('/')} and call again for a free count.`,
                `Call again with mode:"realtime" to count live — that costs about $${round(book.prices.count_realtime)} for the count alone, before any rows.`,
              ],
            });
          }
          throw err;
        }
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 2. count_companies
  loggedTool(
    server,
    'count_companies',
    `How many companies match an ICP, and what pulling them would cost. ${priceTag('count_database')} Call this before search_companies. As with count_leads, a realtime count costs $0.02 and is never run implicitly.`,
    {
      ...COMPANY_FILTERS,
      ...LEGACY_COMPANY_SHAPE,
      mode: modeParam('you only need a size estimate'),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const mode: Mode = args?.mode ?? 'auto';
        const body = toFilters(args);
        const dbUrl = `${apiBase}${V1}/search/database/companies/count/`;
        const rtUrl = `${apiBase}${V1}/search/realtime/companies/count/`;

        if (mode === 'realtime') {
          const data = await callApi(
            fetcher,
            rtUrl,
            { method: 'POST', headers, body: JSON.stringify(body) },
            timeoutOf(args),
          );
          const book = await priceBook(Authorization, headers);
          return result({
            results_count: data?.data?.results_count ?? null,
            mode: 'realtime',
            deprecated_params_ignored: legacyUsed(args),
            cost: receipt('count_realtime', data),
            next_step_estimate: estimateBlock(book, 'realtime', data?.data?.results_count),
          });
        }
        try {
          const data = await callApi(
            fetcher,
            dbUrl,
            { method: 'POST', headers, body: JSON.stringify(body) },
            timeoutOf(args),
          );
          const count = data?.data?.results_count ?? null;
          const book = await priceBook(Authorization, headers);
          return result({
            results_count: count,
            mode: 'database',
            cost: receipt('count_database', data),
            next_step_estimate: estimateBlock(book, 'database', count),
            ...(count === 0
              ? { advice: 'Zero matches — loosen a filter or try mode:"realtime" before paying for anything.' }
              : {}),
          });
        } catch (err: any) {
          const blocked = unsupportedFilters(err?.detail);
          if (mode === 'auto' && blocked.length > 0) {
            const book = await priceBook(Authorization, headers);
            return result({
              results_count: null,
              mode: 'none',
              cost: { operation: 'count_database', amount_charged_usd: 0, billed: 'nothing was charged' },
              needs_realtime: blocked,
              why: `These filters do not exist in the free cached index: ${blocked.join(', ')}.`,
              options: [
                `Drop ${blocked.join('/')} and call again for a free count.`,
                `Call again with mode:"realtime" — about $${round(book.prices.count_realtime)} for the count alone.`,
              ],
            });
          }
          throw err;
        }
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 3. get_balance
  loggedTool(
    server,
    'get_balance',
    `Account balance, month-to-date usage and THIS account's real per-operation prices. ${priceTag('count_database')} Call it before a batch of paid work (so you can tell the user what they can afford) and after (so you can report exactly what was spent). The prices it returns beat any number in a tool description — those are list prices.`,
    {
      include_transactions: z
        .number()
        .describe('Also return the N most recent transactions (each shows the operation type and dollar amount).')
        .optional(),
      include_prices: z.boolean().describe("Include this account's per-operation prices. Default true.").optional(),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const account = await callApi(
          fetcher,
          `${apiBase}${V1}/accounts/me/`,
          { method: 'GET', headers },
          timeoutOf(args),
        );
        const out: Record<string, unknown> = {
          email: account?.data?.email ?? null,
          balance_usd: account?.data?.credits?.balance ?? null,
          used_this_month_usd: account?.data?.credits?.used_this_month ?? null,
          preview_tier: account?.data?.preview_tier ?? null,
          cost: { operation: 'account', amount_charged_usd: 0, billed: 'free endpoint' },
        };
        if (args?.include_prices !== false) {
          const book = await priceBook(Authorization, headers);
          out.your_prices_usd = book.prices;
          out.prices_source = book.account_specific
            ? `account tier ${book.tier ?? '?'} — these are the numbers to quote to the user`
            : 'published list prices (could not read the account tier)';
        }
        const n = Number(args?.include_transactions ?? 0);
        if (n > 0) {
          const txns = await callApi(
            fetcher,
            `${apiBase}${V1}/accounts/transactions/?limit=${Math.min(100, Math.max(1, Math.floor(n)))}`,
            { method: 'GET', headers },
            timeoutOf(args),
          );
          out.recent_transactions = txns?.data?.transactions ?? txns?.data ?? null;
        }
        return result(out);
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // =========================================================================
  // PAID SEARCH
  // =========================================================================

  // 4. search_leads
  loggedTool(
    server,
    'search_leads',
    `Return leads (people) matching an ICP. ${priceTag('search_database')} Run count_leads first — it is free and tells you both the audience size and what this call will cost. Returns profile data only: no email or phone. Use generate_email / find_phone on the ids you actually want. Ordering is not stable, so paginate by passing ids you already have in exclude_ids rather than by offset.`,
    {
      ...LEAD_FILTERS,
      ...LEGACY_LEAD_SHAPE,
      company_filters: z
        .object(COMPANY_FILTERS)
        .partial()
        .describe('Optional: only return leads at companies matching these filters (two-level ICP).')
        .optional(),
      mode: modeParam('freshness is not critical'),
      compact: compactParam('lead'),
      ...PAGING,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const leadFilters = toFilters(args);
        const rows = clampLimit(leadFilters);
        const companyFilters = args?.company_filters;
        const twoLevel = companyFilters && Object.keys(companyFilters).length > 0;
        const path = twoLevel ? 'company-leads' : 'leads';
        // In the two-level shape the row limit belongs to the lead criteria.
        const body = twoLevel
          ? { company_search_criteria: companyFilters, lead_search_criteria: leadFilters }
          : leadFilters;

        const { data, mode, escalated_because } = await callWithMode(fetcher, {
          mode: args?.mode ?? 'auto',
          dbUrl: `${apiBase}${V1}/search/database/${path}/`,
          rtUrl: `${apiBase}${V1}/search/realtime/${path}/`,
          body,
          headers,
          timeoutMs: timeoutOf(args),
        });

        const leads: any[] = data?.data?.leads ?? data?.data ?? [];
        const compact = args?.compact !== false;
        return result({
          returned: Array.isArray(leads) ? leads.length : 0,
          results_count: data?.data?.results_count ?? null,
          requested_rows: rows,
          mode,
          deprecated_params_ignored: legacyUsed(args),
          ...(escalated_because
            ? {
                escalated_to_realtime_because: escalated_because,
                escalation_note:
                  'These filters do not exist in the cheaper cached index, so this call ran live and cost more per row. Tell the user if they care about cost.',
              }
            : {}),
          cost: receipt(mode === 'database' ? 'search_database' : 'search_realtime', data),
          leads: Array.isArray(leads) ? (compact ? leads.map(compactLead) : leads) : leads,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 5. search_companies
  loggedTool(
    server,
    'search_companies',
    `Return companies matching an ICP. ${priceTag('search_database')} Run count_companies first. Note that headcount_range is a snapshot taken when the record was indexed and can lag the company's current size; the filter itself is applied at query time.`,
    {
      ...COMPANY_FILTERS,
      ...LEGACY_COMPANY_SHAPE,
      mode: modeParam('freshness is not critical'),
      compact: compactParam('company'),
      ...PAGING,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const body = toFilters(args);
        const rows = clampLimit(body);
        const { data, mode, escalated_because } = await callWithMode(fetcher, {
          mode: args?.mode ?? 'auto',
          dbUrl: `${apiBase}${V1}/search/database/companies/`,
          rtUrl: `${apiBase}${V1}/search/realtime/companies/`,
          body,
          headers,
          timeoutMs: timeoutOf(args),
        });
        const companies: any[] = data?.data?.companies ?? data?.data ?? [];
        const compact = args?.compact !== false;
        return result({
          returned: Array.isArray(companies) ? companies.length : 0,
          results_count: data?.data?.results_count ?? null,
          requested_rows: rows,
          mode,
          deprecated_params_ignored: legacyUsed(args),
          ...(escalated_because
            ? {
                escalated_to_realtime_because: escalated_because,
                escalation_note: 'Ran live because those filters are realtime-only, so this cost more per row.',
              }
            : {}),
          cost: receipt(mode === 'database' ? 'search_database' : 'search_realtime', data),
          companies: Array.isArray(companies) ? (compact ? companies.map(compactCompany) : companies) : companies,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 6. preview_leads
  loggedTool(
    server,
    'preview_leads',
    `Cheap look at the actual people behind a count, before committing to a full search. ${priceTag('preview')} Preview rows carry a Generect \`id\`, so the intended flow is: preview many → pick the few that fit → enrich_lead / generate_email only on those. Per the API contract preview rows are masked (no LinkedIn URL, domain, email or phone); if your account returns more than that, treat it as a bonus and not something to rely on.`,
    {
      ...LEAD_FILTERS,
      ...LEGACY_LEAD_SHAPE,
      company_filters: z
        .object(COMPANY_FILTERS)
        .partial()
        .describe('Optional company-level filters for a two-level ICP.')
        .optional(),
      compact: compactParam('lead'),
      limit_by: PAGING.limit_by,
      offset_by: PAGING.offset_by,
      limit: PAGING.limit,
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const leadFilters = toFilters(args);
        // Preview reads limit_by from INSIDE lead_search_criteria; passing it at
        // the top level is silently ignored and returns a full page you paid for.
        const rows = clampLimit(leadFilters);
        const body: Record<string, unknown> = { lead_search_criteria: leadFilters };
        if (args?.company_filters && Object.keys(args.company_filters).length > 0) {
          body.company_search_criteria = args.company_filters;
        }
        const data = await callApi(
          fetcher,
          `${apiBase}${V1}/preview/leads/`,
          { method: 'POST', headers, body: JSON.stringify(body) },
          timeoutOf(args),
        );
        const leads: any[] = data?.data?.leads ?? data?.data ?? [];
        const compact = args?.compact !== false;
        // Defensive: if the API ignores the row cap, don't hand the model a page
        // of rows the caller never asked to pay for.
        const trimmed = Array.isArray(leads) ? leads.slice(0, rows) : leads;
        return result({
          returned: Array.isArray(trimmed) ? trimmed.length : 0,
          requested_rows: rows,
          deprecated_params_ignored: legacyUsed(args),
          ...(Array.isArray(leads) && leads.length > rows
            ? { api_returned_more_than_requested: leads.length, note: 'Extra rows were trimmed locally.' }
            : {}),
          cost: receipt('preview', data),
          leads: Array.isArray(trimmed) ? (compact ? trimmed.map(compactLead) : trimmed) : trimmed,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // =========================================================================
  // ENRICH / CONTACT DATA
  // =========================================================================

  // 7. enrich_lead
  loggedTool(
    server,
    'enrich_lead',
    `Full profile for ONE known person, by Generect id, LinkedIn URL, or work email (reverse lookup). ${priceTag('enrich_database')} Not found costs nothing. Prefer the \`id\` from a search/preview result — it is the most accurate identifier. For many people at once use start_bulk_job.`,
    {
      id: z.string().describe('Generect lead id from search/preview.').optional(),
      linkedin_url: z.string().describe('LinkedIn profile URL.').optional(),
      email: z.string().describe('Work email, for reverse lookup.').optional(),
      mode: modeParam('a record from the last 12 months is good enough'),
      compact: compactParam('lead'),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const identifiers = ['id', 'linkedin_url', 'email'].filter(k => args?.[k]);
        if (identifiers.length !== 1) {
          throw Object.assign(new Error('Provide exactly ONE of: id, linkedin_url, email.'), { status: 400 });
        }
        const body = { [identifiers[0]]: args[identifiers[0]] };
        const { data, mode } = await callWithMode(fetcher, {
          mode: args?.mode ?? 'auto',
          dbUrl: `${apiBase}${V1}/enrich/database/lead/`,
          rtUrl: `${apiBase}${V1}/enrich/realtime/lead/`,
          body,
          headers,
          timeoutMs: timeoutOf(args),
        });
        const lead = data?.data ?? null;
        return result({
          found: !!lead,
          mode,
          cost: receipt(mode === 'database' ? 'enrich_database' : 'enrich_realtime', data),
          lead: lead && args?.compact !== false ? compactLead(lead) : lead,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 8. enrich_company
  loggedTool(
    server,
    'enrich_company',
    `Full profile for ONE known company, by Generect id, LinkedIn URL, domain, or name. ${priceTag('enrich_database')} Not found costs nothing. Domain is the most reliable identifier after id; name matching is fuzzy.`,
    {
      id: z.string().describe('Generect company id.').optional(),
      linkedin_url: z.string().describe('LinkedIn company page URL.').optional(),
      domain: z.string().describe('Company domain without protocol, e.g. "stripe.com".').optional(),
      name: z.string().describe('Company name (fuzzy match).').optional(),
      mode: modeParam('a recent cached record is good enough'),
      compact: compactParam('company'),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const identifiers = ['id', 'linkedin_url', 'domain', 'name'].filter(k => args?.[k]);
        if (identifiers.length !== 1) {
          throw Object.assign(new Error('Provide exactly ONE of: id, linkedin_url, domain, name.'), { status: 400 });
        }
        const body = { [identifiers[0]]: args[identifiers[0]] };
        const { data, mode } = await callWithMode(fetcher, {
          mode: args?.mode ?? 'auto',
          dbUrl: `${apiBase}${V1}/enrich/database/company/`,
          rtUrl: `${apiBase}${V1}/enrich/realtime/company/`,
          body,
          headers,
          timeoutMs: timeoutOf(args),
        });
        const company = data?.data ?? null;
        return result({
          found: !!company,
          mode,
          cost: receipt(mode === 'database' ? 'enrich_database' : 'enrich_realtime', data),
          company: company && args?.compact !== false ? compactCompany(company) : company,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 9. get_lead_by_url — kept as the original tool name for existing integrations
  loggedTool(
    server,
    'get_lead_by_url',
    `Alias of enrich_lead for a LinkedIn profile URL, kept for backwards compatibility. ${priceTag('enrich_database')} Prefer enrich_lead — it also accepts a Generect id (cheaper to get right) or an email for reverse lookup.`,
    {
      url: z.string().describe('LinkedIn profile URL (e.g. https://www.linkedin.com/in/username/).'),
      ...LEGACY_ENRICH_SHAPE,
      mode: modeParam('a recent cached record is good enough'),
      compact: compactParam('lead'),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const { data, mode } = await callWithMode(fetcher, {
          mode: args?.mode ?? 'auto',
          dbUrl: `${apiBase}${V1}/enrich/database/lead/`,
          rtUrl: `${apiBase}${V1}/enrich/realtime/lead/`,
          body: { linkedin_url: args.url },
          headers,
          timeoutMs: timeoutOf(args),
        });
        const lead = data?.data ?? null;
        return result({
          found: !!lead,
          mode,
          deprecated_params_ignored: legacyUsed(args),
          cost: receipt(mode === 'database' ? 'enrich_database' : 'enrich_realtime', data),
          lead: lead && args?.compact !== false ? compactLead(lead) : lead,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 10. resolve_profile
  loggedTool(
    server,
    'resolve_profile',
    `Reveal who is behind an anonymous LinkedIn profile link. ${priceTag('profile_resolve')} Takes the obfuscated links that Sales Navigator leaves in exports, CRMs and ad platforms — \`linkedin.com/in/ACwAA…\` — plus Sales Navigator lead URLs, bare profile ids and urns, and returns the real profile URL and identity. Pass \`profiles\` (up to 50) to do a batch in one call. The \`id\` it returns is the same identifier enrich_lead, generate_email and find_phone accept, so this is the cheap first step before spending on a full record. Returns identity only — no location, company or work history; use enrich_lead for those. The numeric member id is NOT accepted as input (LinkedIn answers 403 to it); it comes back as \`linkedin_id\`.`,
    {
      url: z
        .string()
        .describe(
          'A single LinkedIn person reference: profile URL of any flavour (including /in/ACwAA… and /sales/lead/…), a public identifier, an obfuscated id (ACwAA… or ACoAA…) or an urn. Matched case-insensitively.',
        )
        .optional(),
      id: z.string().describe('Alias for `url` — same accepted values. Use whichever reads better.').optional(),
      profiles: z
        .array(z.string())
        .max(50)
        .describe(
          'Batch mode: 1–50 references, mixed freely. One row per input, in input order, each either a resolved profile or {input, error}. Duplicates are billed per row — deduplicate first.',
        )
        .optional(),
      compact: compactParam('profile'),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const shape = (profile: any) => (args?.compact !== false ? compactProfile(profile) : profile);

        if (Array.isArray(args?.profiles) && args.profiles.length > 0) {
          const data = await callApi(
            fetcher,
            `${apiBase}${V1}/profile/resolve/bulk/`,
            { method: 'POST', headers, body: JSON.stringify({ profiles: args.profiles }) },
            timeoutOf(args),
          );
          const rows: any[] = Array.isArray(data?.data) ? data.data : [];
          return result({
            // The API's own counts, not ours: `resolved` is exactly what was billed.
            total: data?.meta?.total ?? rows.length,
            resolved: data?.meta?.resolved ?? rows.filter(r => !r?.error).length,
            cost: receipt('profile_resolve', data),
            profiles: rows.map(row => (row?.error ? { input: row.input ?? null, error: row.error } : shape(row))),
          });
        }

        const value = args?.url ?? args?.id;
        if (!value) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Pass `url` (or `id`) for one profile, or `profiles` for a batch of up to 50.',
              },
            ],
          };
        }
        const data = await callApi(
          fetcher,
          `${apiBase}${V1}/profile/resolve/`,
          { method: 'POST', headers, body: JSON.stringify({ linkedin_url: value }) },
          timeoutOf(args),
        );
        const profile = data?.data ?? null;
        return result({
          found: !!profile,
          cost: receipt('profile_resolve', data),
          profile: profile ? shape(profile) : null,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 11. generate_email
  loggedTool(
    server,
    'generate_email',
    `Find and verify a work email. ${priceTag('email_find')} Identify the person by lead_id (best), LinkedIn URL, or first+last+domain. \`candidates\` resolves several people in one call; more than 10 is routed to an async bulk job instead, which returns a job_id for get_bulk_job.`,
    {
      ...IDENTIFY_LEAD,
      middle_name: z.string().describe('Middle name (optional, improves pattern matching).').optional(),
      candidates: z
        .array(
          z
            .object({
              lead_id: z.string().optional(),
              linkedin_url: z.string().optional(),
              first_name: z.string().optional(),
              last_name: z.string().optional(),
              middle_name: z.string().optional(),
              domain: z.string().optional(),
            })
            .describe('One of: {lead_id} | {linkedin_url} | {first_name,last_name,domain}'),
        )
        .describe('Batch mode. Each entry uses the same identifier rules as the single-person form.')
        .optional(),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const batch: any[] = Array.isArray(args?.candidates) ? args.candidates : [];

        // Big batches belong on the async endpoint — 50 sequential live lookups
        // would blow every client timeout.
        if (batch.length > 10) {
          const leads = batch.slice(0, 50).map(c => leadIdentifier(c, 'domain'));
          const data = await callApi(
            fetcher,
            `${apiBase}${V1}/email/find/bulk/`,
            { method: 'POST', headers, body: JSON.stringify({ leads }) },
            timeoutOf(args),
          );
          return result({
            mode: 'bulk',
            submitted: leads.length,
            ...(batch.length > 50 ? { dropped: batch.length - 50, note: 'Bulk accepts max 50 per request.' } : {}),
            job: data?.meta ?? data,
            next_step: 'Poll get_bulk_job with job_type:"email_find" and this job_id.',
            cost: receipt('email_find', data),
          });
        }

        const targets = batch.length > 0 ? batch : [args];
        const settled = await Promise.all(
          targets.map(async t => {
            try {
              const body = leadIdentifier(t, 'domain');
              if (t?.middle_name && 'first_name' in body) body.middle_name = t.middle_name;
              const data = await callApi(
                fetcher,
                `${apiBase}${V1}/email/find/`,
                { method: 'POST', headers, body: JSON.stringify(body) },
                timeoutOf(args),
              );
              return { input: body, ...(data?.data ?? {}), amount_charged_usd: data?.meta?.amount_charged ?? null };
            } catch (err: any) {
              return { input: t, error: String(err?.message ?? err), status: err?.status ?? null };
            }
          }),
        );
        const spent = settled.reduce((sum, r: any) => sum + (Number(r.amount_charged_usd) || 0), 0);
        return result({
          requested: targets.length,
          cost: {
            operation: 'email_find',
            amount_charged_usd: round(spent),
            billed: 'per valid email found (a miss is free)',
          },
          results: settled,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 12. validate_email
  loggedTool(
    server,
    'validate_email',
    `Check deliverability of emails you already have. ${priceTag('email_validate')} This is the one operation where EVERY submitted address is billed — the verdict is the deliverable. Never validate an address that generate_email just returned as valid; it is already verified.`,
    {
      emails: z.array(z.string()).describe('Email addresses to validate. Each one is billed.'),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const emails = (args?.emails ?? []).filter((e: unknown) => typeof e === 'string' && e.includes('@'));
        if (emails.length === 0) throw Object.assign(new Error('Provide at least one email address.'), { status: 400 });
        const data = await callApi(
          fetcher,
          `${apiBase}${V1}/email/validate/`,
          { method: 'POST', headers, body: JSON.stringify({ emails }) },
          timeoutOf(args),
        );
        return result({
          submitted: emails.length,
          cost: receipt('email_validate', data),
          results: data?.data ?? null,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 13. find_phone
  loggedTool(
    server,
    'find_phone',
    `Find a phone number for one person. ${priceTag('phone_find')} THE MOST EXPENSIVE OPERATION HERE — roughly 20x an email lookup. Do not call it speculatively or across a list; confirm with the user first, and only for people they have already qualified. Use start_bulk_job for an approved list.`,
    {
      ...IDENTIFY_LEAD,
      company: z.string().describe('Company name or domain (name+company mode).').optional(),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const body = leadIdentifier(args, 'company');
        const data = await callApi(
          fetcher,
          `${apiBase}${V1}/phone/find/`,
          { method: 'POST', headers, body: JSON.stringify(body) },
          timeoutOf(args),
        );
        return result({ cost: receipt('phone_find', data), result: data?.data ?? null });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // =========================================================================
  // BULK + WEBHOOKS — for scheduled / repeatable agent jobs
  // =========================================================================

  const BULK_ROUTES: Record<string, { submit: (mode: string) => string; status: string; op: Operation }> = {
    email_find: {
      submit: () => `${V1}/email/find/bulk/`,
      status: `${V1}/email/find/bulk/`,
      op: 'email_find',
    },
    phone_find: {
      submit: () => `${V1}/phone/find/bulk/`,
      status: `${V1}/phone/find/bulk/`,
      op: 'phone_find',
    },
    enrich_leads: {
      submit: mode => `${V1}/enrich/${mode}/leads/bulk/`,
      status: `${V1}/enrich/leads/bulk/`,
      op: 'enrich_database',
    },
    enrich_companies: {
      submit: mode => `${V1}/enrich/${mode}/companies/bulk/`,
      status: `${V1}/enrich/companies/bulk/`,
      op: 'enrich_database',
    },
  };

  // 14. start_bulk_job
  loggedTool(
    server,
    'start_bulk_job',
    'Submit up to 50 records for asynchronous processing and get a job_id back. BILLABLE at the same per-record rate as the single-record tool — and the whole cost is RESERVED at submit time, so a submitted job keeps running (and keeps charging) even if you stop polling. Only submit a list the user has approved. Poll with get_bulk_job, or register a webhook to be told when it finishes.',
    {
      job_type: z
        .enum(['email_find', 'phone_find', 'enrich_leads', 'enrich_companies'])
        .describe('What to do with the items. phone_find is by far the most expensive per record.'),
      items: z
        .array(z.record(z.any()))
        .describe(
          'Max 50. email_find/phone_find: {lead_id} | {linkedin_url} | {first_name,last_name,domain|company}. enrich_leads: {id} | {linkedin_url} | {email}. enrich_companies: {id} | {linkedin_url} | {domain} | {name}.',
        ),
      mode: z
        .enum(['database', 'realtime'])
        .describe('Enrich jobs only: cached (cheaper) or live. Default "database".')
        .optional(),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const route = BULK_ROUTES[args.job_type];
        if (!route) throw Object.assign(new Error(`Unknown job_type: ${args.job_type}`), { status: 400 });
        const items = (args?.items ?? []).slice(0, 50);
        if (items.length === 0) throw Object.assign(new Error('items must not be empty.'), { status: 400 });
        const mode = args?.mode === 'realtime' ? 'realtime' : 'database';
        const isEnrich = args.job_type.startsWith('enrich_');
        const body = isEnrich
          ? { [args.job_type === 'enrich_leads' ? 'leads' : 'companies']: items }
          : { leads: items };
        const data = await callApi(
          fetcher,
          `${apiBase}${route.submit(mode)}`,
          { method: 'POST', headers, body: JSON.stringify(body) },
          timeoutOf(args),
        );
        const book = await priceBook(Authorization, headers);
        const op: Operation = isEnrich
          ? mode === 'realtime'
            ? 'enrich_realtime'
            : 'enrich_database'
          : (route.op as Operation);
        return result({
          job_type: args.job_type,
          submitted: items.length,
          ...(args.items?.length > 50 ? { dropped: args.items.length - 50 } : {}),
          ...(isEnrich ? { mode } : {}),
          job: data?.meta ?? data,
          reserved_worst_case_usd: estimate(book, op, items.length),
          reservation_note:
            'The worst case above is reserved now. Records that are not found are refunded; email/phone misses are never charged.',
          next_step: `Poll get_bulk_job with job_type:"${args.job_type}" and the job_id from job.`,
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 15. get_bulk_job
  loggedTool(
    server,
    'get_bulk_job',
    `Status and results of a bulk job. ${priceTag('count_database')} Polling is free — the work was already billed at submit time. Poll every few seconds, not in a tight loop.`,
    {
      job_type: z.enum(['email_find', 'phone_find', 'enrich_leads', 'enrich_companies']).describe('Same job_type used at submit.'),
      job_id: z.string().describe('job_id returned by start_bulk_job.'),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const route = BULK_ROUTES[args.job_type];
        if (!route) throw Object.assign(new Error(`Unknown job_type: ${args.job_type}`), { status: 400 });
        const data = await callApi(
          fetcher,
          `${apiBase}${route.status}${encodeURIComponent(args.job_id)}/`,
          { method: 'GET', headers },
          timeoutOf(args),
        );
        return result({
          job_type: args.job_type,
          job_id: args.job_id,
          job: data?.meta ?? null,
          results: data?.data ?? null,
          cost: { operation: 'bulk_status', amount_charged_usd: 0, billed: 'polling is free' },
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 16. manage_webhooks
  loggedTool(
    server,
    'manage_webhooks',
    `List, create, update, delete or test webhook endpoints for bulk-job completion. ${priceTag('count_database')} Use this instead of long polling in scheduled/unattended workflows: register once, then let the completion event wake your job up.`,
    {
      action: z.enum(['list', 'create', 'update', 'delete', 'test']).describe('What to do.'),
      id: z.string().describe('Webhook id (required for update, delete, test).').optional(),
      url: z.string().describe('HTTPS endpoint that receives events (create/update).').optional(),
      events: z
        .array(
          z.enum([
            'email.find.bulk.completed',
            'phone.find.bulk.completed',
            'enrich.lead.bulk.completed',
            'enrich.company.bulk.completed',
          ]),
        )
        .describe('Events to subscribe to (create/update).')
        .optional(),
      secret: z.string().describe('Shared secret for HMAC signature verification.').optional(),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const headers = apiHeaders(Authorization);
        const base = `${apiBase}${V1}/webhooks/`;
        const needsId = ['update', 'delete', 'test'];
        if (needsId.includes(args.action) && !args.id) {
          throw Object.assign(new Error(`action "${args.action}" requires id.`), { status: 400 });
        }
        let data: any;
        switch (args.action) {
          case 'list':
            data = await callApi(fetcher, base, { method: 'GET', headers }, timeoutOf(args));
            break;
          case 'create':
            if (!args.url || !args.events?.length) {
              throw Object.assign(new Error('create requires url and events.'), { status: 400 });
            }
            data = await callApi(
              fetcher,
              base,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({ url: args.url, events: args.events, ...(args.secret ? { secret: args.secret } : {}) }),
              },
              timeoutOf(args),
            );
            break;
          case 'update':
            data = await callApi(
              fetcher,
              `${base}${encodeURIComponent(args.id)}/`,
              {
                method: 'PATCH',
                headers,
                body: JSON.stringify({
                  ...(args.url ? { url: args.url } : {}),
                  ...(args.events ? { events: args.events } : {}),
                  ...(args.secret ? { secret: args.secret } : {}),
                }),
              },
              timeoutOf(args),
            );
            break;
          case 'delete':
            data = await callApi(
              fetcher,
              `${base}${encodeURIComponent(args.id)}/`,
              { method: 'DELETE', headers },
              timeoutOf(args),
            );
            break;
          case 'test':
            data = await callApi(
              fetcher,
              `${base}${encodeURIComponent(args.id)}/test/`,
              { method: 'POST', headers, body: '{}' },
              timeoutOf(args),
            );
            break;
        }
        return result({
          action: args.action,
          webhooks: data?.data ?? data ?? null,
          cost: { operation: 'webhooks', amount_charged_usd: 0, billed: 'free endpoint' },
        });
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 17. health
  loggedTool(
    server,
    'health',
    `Liveness check. ${priceTag('count_database')} Confirms the MCP server is up, reports its version, and (unless you disable it) verifies the credential against a free account endpoint. It never touches a paid data endpoint, so it is safe to call from a monitor.`,
    {
      check_credential: z
        .boolean()
        .describe('Also verify the API token against the free /accounts/me endpoint. Default true.')
        .optional(),
      timeout_ms: PAGING.timeout_ms,
    },
    async (args, extra) => {
      const started = Date.now();
      const out: Record<string, unknown> = {
        ok: true,
        server: 'up',
        version: VERSION,
        api_base: apiBase,
        cost: { operation: 'health', amount_charged_usd: 0, billed: 'free — no data endpoint is touched' },
      };
      let Authorization: string | null = null;
      try {
        Authorization = await resolveAuthHeader(extra);
        out.has_credential = true;
      } catch {
        out.has_credential = false;
      }
      if (args?.check_credential !== false && Authorization) {
        try {
          const data = await callApi(
            fetcher,
            `${apiBase}${V1}/accounts/me/`,
            { method: 'GET', headers: apiHeaders(Authorization) },
            timeoutOf(args),
          );
          out.credential_valid = true;
          out.account = data?.data?.email ?? null;
          out.balance_usd = data?.data?.credits?.balance ?? null;
        } catch (err: any) {
          out.ok = false;
          out.credential_valid = false;
          out.credential_error = { status: err?.status ?? null, detail: err?.detail ?? String(err) };
        }
      }
      out.ms = Date.now() - started;
      return result(out);
    },
  );
}

/**
 * "You found N matches — here is what the next step costs." Quoted at the
 * account's own rates, for the row counts an agent actually picks.
 */
function estimateBlock(book: PriceBook, mode: 'database' | 'realtime', count: unknown) {
  const searchOp: Operation = mode === 'database' ? 'search_database' : 'search_realtime';
  const rows = [10, 25, 100];
  const total = typeof count === 'number' ? count : null;
  return {
    priced_at: book.account_specific ? `your account tier ${book.tier ?? '?'}` : 'published list prices',
    search_usd_per_row: round(book.prices[searchOp]),
    search_cost_for: Object.fromEntries(rows.map(n => [`${n}_rows`, estimate(book, searchOp, n)])),
    preview_usd_per_row: round(book.prices.preview),
    email_usd_per_valid_email: round(book.prices.email_find),
    phone_usd_per_found_phone: round(book.prices.phone_find),
    ...(total != null && total > 0
      ? { all_matches_would_cost_usd: estimate(book, searchOp, total), all_matches_rows: total }
      : {}),
  };
}
