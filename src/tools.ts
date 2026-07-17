import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken, extractApiToken } from './auth/jwt.js';
import { parseAuthHeader } from './auth/parse.js';
import { VERSION } from './version.js';

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
      const result = await handler(args, extra);
      logEvent('tool_result', {
        reqId,
        tool: name,
        ms: Date.now() - started,
        output: redact(previewResult(result)),
      });
      return result;
    } catch (err: unknown) {
      logEvent('tool_error', { reqId, tool: name, ms: Date.now() - started, error: String(err) });
      throw err;
    }
  });
}

function jsonTextContent(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function sanitizeLead(lead: any) {
  return {
    full_name: lead.full_name ?? lead.unformatted_full_name ?? null,
    first_name: lead.first_name ?? null,
    last_name: lead.last_name ?? null,
    job_title: lead.job_title ?? lead.raw_job_title ?? null,
    company_name: lead.company_name ?? lead.raw_company_name ?? null,
    company_id: lead.company_id ?? null,
    industry: lead.company_industry ?? lead.industry ?? null,
    location: lead.location ?? lead.job_location ?? null,
    linkedin_url: lead.linkedin_url ?? null,
  };
}

function sanitizeCompany(company: any) {
  return {
    name: company.name ?? company.company_name ?? null,
    linkedin_url: company.linkedin_url ?? company.company_url ?? null,
    website: company.website ?? company.company_website ?? null,
    headcount_range: company.headcount_range ?? company.company_headcount_range ?? null,
    industry: company.industry ?? company.company_industry ?? null,
    location: company.location ?? company.company_location ?? null,
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
  return {
    ...jsonTextContent({
      error: String(err?.message ?? err),
      status: err?.status ?? null,
      detail: err?.detail ?? null,
    }),
    isError: true,
  } as any;
}

// MCP-internal control flags that must not be forwarded to the Generect API as
// if they were search filters. `limit`/`offset` are accepted as friendly aliases
// and mapped to the API's `limit_by`/`offset_by`.
function toApiFilters(args: any) {
  const { compact, timeout_ms, fallback_from_leads, limit, offset, ...filters } = args ?? {};
  if (limit != null && filters.limit_by == null) filters.limit_by = limit;
  if (offset != null && filters.offset_by == null) filters.offset_by = offset;
  return filters as Record<string, unknown>;
}

// A single call must never trigger an unbounded pull (which bills a large number
// of credits). `get_max_leads:true` with no limit still returns the total-available
// COUNT, but we bound how many rows are actually fetched. Callers who want more
// paginate across calls (using exclude_ids to skip already-seen leads, since the
// engine is non-deterministic and has no stable offset).
const MAX_RESULT_LIMIT = Number(process.env.MCP_MAX_RESULT_LIMIT || '100');
const DEFAULT_RESULT_LIMIT = 25;

function clampLimit(body: Record<string, unknown>): void {
  let n = body.limit_by as number | undefined;
  if (n == null || Number.isNaN(Number(n))) n = DEFAULT_RESULT_LIMIT;
  n = Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.floor(Number(n))));
  body.limit_by = n;
}

// Title keywords that pull in low-signal matches (assistants, interns, students)
// when a broad title is used. Applied as persona exclusions unless the caller
// supplies their own `exclude_title_keywords` (pass [] to disable).
const DEFAULT_TITLE_EXCLUSIONS = ['assistant', 'intern', 'junior', 'student', 'trainee'];

// Build the by_icp `personas` value from friendly inputs. Real ICP personas are a
// tuple: [label, [included title keywords (OR)], [secondary keywords], [excluded
// keywords]]. The old MCP sent a single lowercased title with no exclusions, which
// both under-matched (no synonyms) and over-matched (kept junior noise). We now
// accept multiple titles and apply sensible exclusions.
function buildPersonas(args: any): any[] | undefined {
  if (Array.isArray(args.personas) && args.personas.length > 0) return args.personas; // power-user passthrough
  const titles: string[] = Array.isArray(args.job_titles)
    ? args.job_titles.filter((t: unknown) => typeof t === 'string' && t.trim())
    : args.job_title
      ? [args.job_title]
      : [];
  if (titles.length === 0) return undefined;
  const exclusions = Array.isArray(args.exclude_title_keywords)
    ? args.exclude_title_keywords
    : DEFAULT_TITLE_EXCLUSIONS;
  const label = titles.length === 1 ? titles[0] : `Target titles (${titles.length})`;
  return [[label, titles, [], exclusions]];
}

// Fields the MCP consumes to build the request but that must NOT be forwarded to
// the API verbatim (they are not by_icp filters).
const LEAD_CONTROL_FIELDS = ['job_title', 'job_titles', 'personas', 'exclude_title_keywords'];

export function registerTools(server: McpServer, fetcher: Fetcher, apiBase: string, apiKey: string) {
  async function resolveAuthHeader(extra: any): Promise<string> {
    const header = extra?.requestInfo?.headers?.authorization as string | undefined;
    const parsed = parseAuthHeader(header);

    if (!parsed) {
      const fallback = apiKey || '';
      if (!fallback) {
        throw new Error('Authorization header is required');
      }
      return fallback.startsWith('Token ') ? fallback : `Token ${fallback}`;
    }

    if (parsed.kind === 'token') {
      return `Token ${parsed.apiKey}`;
    }

    const payload = await verifyAccessToken(parsed.jwt);
    if (!payload) {
      throw new Error('Invalid or expired access token');
    }
    return `Token ${extractApiToken(payload)}`;
  }
  const defaultTimeoutMs = Number(process.env.GENERECT_TIMEOUT_MS || '300000');

  // 1. Search leads by ICP
  loggedTool(
    server,
    'search_leads',
    'Search for leads (people) matching an Ideal Customer Profile. NOTE: results are non-deterministic — the same query returns a different sample of matching leads on each call (live LinkedIn data, no stable ordering). To paginate or avoid duplicates across calls, pass the sales_ids you have already seen in exclude_ids. This endpoint returns profile data only (no emails/phones) — use generate_email to resolve an email.',
    {
      job_title: z.string().describe('Single job title (e.g., "CEO"). For multiple titles use job_titles.').optional(),
      job_titles: z
        .array(z.string())
        .describe(
          'One or more target job titles, OR-matched (e.g. ["CEO","Founder","Owner","President"]). Preferred over job_title. Assistant/intern/junior/student/trainee are excluded by default; override with exclude_title_keywords.',
        )
        .optional(),
      exclude_title_keywords: z
        .array(z.string())
        .describe(
          'Title keywords to exclude from persona matching. Defaults to [assistant, intern, junior, student, trainee]; pass [] to disable.',
        )
        .optional(),
      seniorities: z
        .array(z.string())
        .describe(
          'Seniority levels (LinkedIn Sales-Nav categories, e.g. ["Director","VP","Head","Owner","Manager"]). Validated by the API.',
        )
        .optional(),
      functions: z
        .array(z.string())
        .describe(
          'Job functions (LinkedIn Sales-Nav categories, e.g. ["Engineering","Operations","Marketing","Sales","Finance"]). Validated by the API.',
        )
        .optional(),
      keywords: z
        .array(z.string())
        .describe('Free-text keywords matched against the profile (Boolean phrases allowed).')
        .optional(),
      locations: z
        .array(z.string())
        .describe('Lead location filter — country/region names, e.g. ["United States","Canada"].')
        .optional(),
      lead_industries: z
        .array(z.string())
        .describe(
          'Lead personal-industry filter. Must match Generect industry names exactly (e.g. "Financial Services", "IT Services and IT Consulting"). Names are hierarchical (Financial Services includes Banking/Insurance). Invalid names are rejected (HTTP 400).',
        )
        .optional(),
      company_industries: z
        .array(z.string())
        .describe("Filter by the lead employer's industry (same taxonomy as lead_industries).")
        .optional(),
      company_headcounts: z
        .array(z.string())
        .describe(
          'Employer size buckets. Allowed ONLY: "1-10","11-50","51-200","201-500","501-1000","1001-5000","5001-10000","10 000+" (note the space in "10 000+").',
        )
        .optional(),
      company_types: z
        .array(z.string())
        .describe(
          'Employer types: "Public Company","Educational","Self Employed","Government Agency","Non Profit","Self Owned","Privately Held","Partnership".',
        )
        .optional(),
      company_locations: z
        .array(z.string())
        .describe('Filter by the employer HQ location (country/region names).')
        .optional(),
      company_id: z
        .string()
        .describe(
          'Anchor to a specific LinkedIn company id (returns its employees; this branch is less deterministic and does not enforce lead_industries).',
        )
        .optional(),
      company_link: z.string().describe('Anchor to a specific LinkedIn company URL.').optional(),
      company_name: z.string().describe('Anchor to a specific company by name.').optional(),
      changed_jobs: z.boolean().describe('Only leads who recently changed jobs.').optional(),
      posted_on_linkedin: z.boolean().describe('Only leads who recently posted on LinkedIn.').optional(),
      exclude_ids: z
        .array(z.union([z.string(), z.number()]))
        .describe(
          'sales_ids to exclude — pass the ids of leads already returned in prior calls to paginate/deduplicate.',
        )
        .optional(),
      exclude_names: z.array(z.string()).describe('Full names to exclude from results.').optional(),
      personas: z
        .array(z.any())
        .describe(
          'Advanced: raw persona tuples [label,[titles],[secondary],[exclusions],seniority?]. Overrides job_title/job_titles.',
        )
        .optional(),
      get_max_leads: z
        .boolean()
        .describe(
          'Also report the total number of matching leads (results_count). The number of rows returned is still bounded by limit_by.',
        )
        .optional(),
      limit_by: z
        .number()
        .describe(
          `Total leads to return this call (1–${MAX_RESULT_LIMIT}, default ${DEFAULT_RESULT_LIMIT}). This is a TOTAL cap across all personas. For more, paginate with exclude_ids.`,
        )
        .optional(),
      offset_by: z
        .number()
        .describe('Offset for pagination (note: ordering is not stable — exclude_ids is more reliable).')
        .optional(),
      limit: z.number().describe('Alias for limit_by').optional(),
      offset: z.number().describe('Alias for offset_by').optional(),
      without_company: z
        .boolean()
        .describe(
          'Search across all companies (filter-only). Auto-enabled when no company_id/link/name is given; this branch enforces all filters. Ignored when a company anchor is set.',
        )
        .optional(),
      compact: z
        .boolean()
        .describe(
          'Default true: return a 9-field summary per lead (name/title/company/industry/location/linkedin_url). Set false for the full raw lead object (skills, experience, etc.). Neither mode includes email — use generate_email.',
        )
        .optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const apiBody = toApiFilters(args);
        // Build personas from friendly inputs; strip the builder-only fields.
        const personas = buildPersonas(args);
        for (const f of LEAD_CONTROL_FIELDS) delete apiBody[f];
        if (personas) apiBody.personas = personas;
        // Steer to the deterministic, fully-filtered branch when no company is
        // anchored (also avoids the API's hard 400 "company_* required"). Respect
        // an explicit without_company.
        const hasAnchor = !!(args.company_id || args.company_link || args.company_name);
        if (!hasAnchor && args.without_company === undefined) apiBody.without_company = true;
        // Never let a single call pull an unbounded number of billable rows.
        clampLimit(apiBody);

        const data = await callApi(
          fetcher,
          `${apiBase}/api/linkedin/leads/by_icp/`,
          {
            method: 'POST',
            headers: { Authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify(apiBody),
          },
          Number(args?.timeout_ms ?? defaultTimeoutMs),
        );
        const compact = args?.compact !== false;
        if (compact && data) {
          const leads = (data.leads ?? data.results ?? data.items ?? []) as any[];
          const formated_leads = leads.map(sanitizeLead);
          return {
            structuredContent: {
              amount: data.amount ?? leads.length ?? null,
              results_count: data.results_count ?? undefined,
              leads: formated_leads,
            },
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    amount: data.amount ?? formated_leads.length,
                    results_count: data.results_count,
                    leads: formated_leads,
                  },
                  null,
                  2,
                ),
              },
            ],
          } as any;
        }
        return jsonTextContent(data);
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 2. Search companies
  loggedTool(
    server,
    'search_companies',
    "Search for companies matching an Ideal Customer Profile. Send flat filters (this endpoint validates industry/type names and rejects unknown ones with HTTP 400). Note: the returned headcount_range label can lag a company's current size (it is snapshotted at index time); the filter itself is applied at query time.",
    {
      company_types: z
        .array(z.string())
        .describe(
          'Company types. Allowed values: "Public Company", "Educational", "Self Employed", "Government Agency", "Non Profit", "Self Owned", "Privately Held", "Partnership".',
        )
        .optional(),
      get_max_companies: z.boolean().describe('Also report the total number of matching companies.').optional(),
      headcounts: z
        .array(z.string())
        .describe(
          'Employee headcount buckets. Allowed ONLY: "1-10","11-50","51-200","201-500","501-1000","1001-5000","5001-10000","10 000+" (note the space in "10 000+").',
        )
        .optional(),
      industries: z
        .array(z.string())
        .describe(
          'Industries. Must match Generect industry names exactly (e.g. "Software Development", "Financial Services"). Names are hierarchical. Invalid names are rejected (HTTP 400).',
        )
        .optional(),
      exclude_industries: z
        .array(z.string())
        .describe('Industries to exclude (same taxonomy as industries).')
        .optional(),
      locations: z.array(z.string()).describe('Locations (countries/regions, e.g. ["United States"]).').optional(),
      exclude_locations: z.array(z.string()).describe('Locations to exclude.').optional(),
      revenues_range: z
        .object({ min: z.number(), max: z.number() })
        .describe('Annual revenue range in millions USD, e.g. {"min":0.5,"max":1001}. Single object, NOT an array.')
        .optional(),
      technologies: z.array(z.string()).describe('Technologies the company uses (BuiltWith taxonomy).').optional(),
      num_of_followers: z.array(z.string()).describe('LinkedIn follower-count buckets.').optional(),
      company_names: z.array(z.string()).describe('Restrict to specific company names.').optional(),
      keywords: z.array(z.string()).describe('Free-text keywords (Boolean phrases allowed).').optional(),
      limit_by: z
        .number()
        .describe(`Companies to return (1–${MAX_RESULT_LIMIT}, default ${DEFAULT_RESULT_LIMIT}).`)
        .optional(),
      offset_by: z.number().describe('Offset for pagination.').optional(),
      limit: z.number().describe('Alias for limit_by').optional(),
      offset: z.number().describe('Alias for offset_by').optional(),
      compact: z
        .boolean()
        .describe('Default true: 6-field summary per company. Set false for the full raw object.')
        .optional(),
      fallback_from_leads: z
        .boolean()
        .describe(
          'Default FALSE. If true and the company search is empty, derive candidate company NAMES by aggregating a keyword lead search. These are lead-derived name counts (source:"leads_derived"), NOT real company records, and cost an extra query.',
        )
        .optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const companyBody = toApiFilters(args);
        clampLimit(companyBody);
        let data = await callApi(
          fetcher,
          `${apiBase}/api/linkedin/companies/by_icp/`,
          {
            method: 'POST',
            headers: { Authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify(companyBody),
          },
          Number(args?.timeout_ms ?? defaultTimeoutMs),
        );
        const companiesEmpty = !data || !Array.isArray(data.companies) || data.companies.length === 0;
        // Opt-IN only: the fallback fabricates lead-derived name aggregates that are
        // not real company records, and costs an extra billable query.
        const shouldFallback =
          companiesEmpty &&
          Array.isArray(args?.keywords) &&
          args.keywords.length > 0 &&
          args?.fallback_from_leads === true;
        if (shouldFallback) {
          const leadsBody: Record<string, unknown> = {
            keywords: args.keywords,
            without_company: true,
            limit_by: 100,
          };
          // Best-effort fallback: if the leads lookup itself fails, keep the
          // (empty) company result rather than turning it into an error.
          try {
            const leadsData = await callApi(
              fetcher,
              `${apiBase}/api/linkedin/leads/by_icp/`,
              {
                method: 'POST',
                headers: { Authorization, 'Content-Type': 'application/json' },
                body: JSON.stringify(leadsBody),
              },
              Number(args?.timeout_ms ?? defaultTimeoutMs),
            );
            const leads = (leadsData.leads ?? leadsData.results ?? []) as any[];
            const counts = new Map<string, number>();
            for (const lead of leads) {
              const name = lead.company_name ?? lead.raw_company_name;
              if (typeof name === 'string' && name.trim()) {
                counts.set(name, (counts.get(name) ?? 0) + 1);
              }
            }
            const derived = Array.from(counts.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => ({ name, occurrences_in_leads: count, source: 'leads_derived' }));
            data = { amount: derived.length, companies: derived, source: 'leads_derived' };
          } catch {}
        }
        const compact = args?.compact !== false;
        if (compact && data) {
          const companies = (data.companies ?? data.results ?? data.items ?? []) as any[];
          const forrmated_companies = companies.map((c: any) =>
            c.name || c.occurrences_in_leads ? c : sanitizeCompany(c),
          );
          return {
            structuredContent: {
              amount: data.amount ?? companies.length ?? null,
              companies: forrmated_companies,
            },
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { amount: data.amount ?? forrmated_companies.length, companies: forrmated_companies },
                  null,
                  2,
                ),
              },
            ],
          } as any;
        }
        return jsonTextContent(data);
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 3. Email finder
  loggedTool(
    server,
    'generate_email',
    'Find & verify work email(s) from name + company domain. Provide a single person (first_name/last_name/domain) OR a batch via candidates (resolved in one call).',
    {
      first_name: z.string().describe('First name (single-person mode).').optional(),
      last_name: z.string().describe('Last name (single-person mode).').optional(),
      middle_name: z.string().describe('Middle name (optional).').optional(),
      domain: z
        .string()
        .describe('Company domain without protocol, e.g. "generect.com" (required in single-person mode).')
        .optional(),
      candidates: z
        .array(
          z.object({
            first_name: z.string(),
            last_name: z.string(),
            middle_name: z.string().optional(),
            domain: z.string(),
          }),
        )
        .describe(
          'Batch mode: resolve many people in one call. Each needs first_name, last_name, domain (middle_name optional).',
        )
        .optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        let candidates: any[];
        if (Array.isArray(args.candidates) && args.candidates.length > 0) {
          candidates = args.candidates;
        } else if (args.first_name && args.last_name && args.domain) {
          candidates = [
            {
              first_name: args.first_name,
              last_name: args.last_name,
              ...(args.middle_name ? { middle_name: args.middle_name } : {}),
              domain: args.domain,
            },
          ];
        } else {
          throw Object.assign(new Error('Provide either candidates[] or first_name + last_name + domain'), {
            status: 400,
          });
        }
        const data = await callApi(
          fetcher,
          `${apiBase}/api/linkedin/email_finder/`,
          {
            method: 'POST',
            headers: { Authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify(candidates),
          },
          Number(args?.timeout_ms ?? defaultTimeoutMs),
        );
        return jsonTextContent(data);
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 4. Get lead by LinkedIn URL
  loggedTool(
    server,
    'get_lead_by_url',
    'Get Lead by LinkedIn URL',
    {
      url: z.string().describe('LinkedIn profile URL (e.g., https://www.linkedin.com/in/username/)'),
      comments: z.boolean().describe('Include comments data').optional(),
      inexact_company: z.boolean().describe('Allow inexact company matching').optional(),
      people_also_viewed: z.boolean().describe('Include people also viewed').optional(),
      posts: z.boolean().describe('Include posts data').optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args: any, extra: any) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const payload = {
          url: args.url,
          comments: Boolean(args.comments),
          inexact_company: Boolean(args.inexact_company),
          people_also_viewed: Boolean(args.people_also_viewed),
          posts: Boolean(args.posts),
        };
        const data = await callApi(
          fetcher,
          `${apiBase}/api/linkedin/leads/by_link/`,
          {
            method: 'POST',
            headers: { Authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          Number(args?.timeout_ms ?? defaultTimeoutMs),
        );
        return jsonTextContent(data);
      } catch (err: unknown) {
        return apiError(err);
      }
    },
  );

  // 5. Health check
  loggedTool(
    server,
    'health',
    'Liveness check. By default (cheap, no credits) it confirms the MCP server is up and an API credential is present. Pass deep:true to additionally probe the Generect API with a real lead-by-link request (consumes a credit and verifies the token end-to-end).',
    {
      deep: z.boolean().describe('Run a live API probe (lead-by-link). Consumes a credit. Default false.').optional(),
      url: z.string().describe('LinkedIn profile URL for the deep probe (defaults to a public profile).').optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args, extra) => {
      const started = Date.now();
      // Cheap path: never spend a credit just to answer "are you alive?".
      if (!args?.deep) {
        let hasCredential = false;
        try {
          await resolveAuthHeader(extra);
          hasCredential = true;
        } catch {
          hasCredential = false;
        }
        return jsonTextContent({
          ok: true,
          server: 'up',
          version: VERSION,
          has_credential: hasCredential,
          ms: Date.now() - started,
          note: 'Pass deep:true to probe the Generect API end-to-end (consumes a credit).',
        });
      }
      const testUrl =
        typeof args?.url === 'string' && args.url.trim() ? args.url : 'https://www.linkedin.com/in/satyanadella/';
      try {
        const Authorization = await resolveAuthHeader(extra);
        const res = await fetchWithTimeout(
          fetcher,
          `${apiBase}/api/linkedin/leads/by_link/`,
          {
            method: 'POST',
            headers: { Authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: testUrl }),
          },
          Number(args?.timeout_ms ?? defaultTimeoutMs),
        );
        const text = await res.text();
        let data: any = undefined;
        try {
          data = JSON.parse(text);
        } catch {}
        const ok = !!data?.lead?.linkedin_url;
        const payload = {
          ok,
          deep: true,
          status: res.status,
          ms: Date.now() - started,
          sample: data?.lead?.linkedin_url ?? null,
        };
        return jsonTextContent(payload);
      } catch (err: unknown) {
        return jsonTextContent({
          ok: false,
          deep: true,
          error: String(err),
          ms: Date.now() - started,
        });
      }
    },
  );
}
