import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken, extractApiToken } from './auth/jwt.js';
import { parseAuthHeader } from './auth/parse.js';

// Structured request/response logging is ON by default; set MCP_LOG=0 to disable.
const logEnabled = process.env.MCP_LOG !== '0' && process.env.MCP_LOG !== 'false';

type Fetcher = typeof fetch;

// One JSON line per event, written to stderr (stdout is reserved for the MCP
// stdio protocol, so logs must never go there). Captures what the LLM sends in
// and what it gets back, correlated by reqId.
function logEvent(event: string, data: Record<string, unknown>) {
  if (!logEnabled) return;
  try {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
  } catch {
    console.error(`[mcp] ${event}`, data);
  }
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
    logEvent('tool_call', { reqId, tool: name, input: args });
    try {
      const result = await handler(args, extra);
      logEvent('tool_result', {
        reqId,
        tool: name,
        ms: Date.now() - started,
        output: previewResult(result),
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
  logEvent('api_request', { url, method: init.method ?? 'GET', body: reqBody });
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
        errorBody = t.length > 2000 ? `${t.slice(0, 2000)}…(${t.length} chars)` : t;
      } catch {}
    }
    logEvent('api_response', { url, status: res.status, ms: Date.now() - started, ...(errorBody ? { errorBody } : {}) });
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
    'Search for leads by ICP filters',
    {
      job_title: z.string().describe('Job title filter (e.g., CEO, CTO, Engineer)').optional(),
      locations: z
        .array(z.string())
        .describe('Location filter — country or region names, e.g. ["United States", "Canada"]')
        .optional(),
      lead_industries: z
        .array(z.string())
        .describe('Industry filter. Must match Generect industry names exactly (e.g. "Information Technology and Services", "Financial Services"). Invalid names are rejected by the API.')
        .optional(),
      company_id: z.string().describe('LinkedIn company id').optional(),
      company_link: z.string().describe('LinkedIn company URL').optional(),
      company_name: z.string().describe('Company name').optional(),
      limit_by: z.number().describe('Number of results to return').optional(),
      offset_by: z.number().describe('Offset for pagination').optional(),
      limit: z.number().describe('Alias for limit_by').optional(),
      offset: z.number().describe('Alias for offset_by').optional(),
      without_company: z.boolean().describe('Search leads without filtering by companies').optional(),
      compact: z.boolean().describe('Return compact summary instead of full JSON').optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const apiBody = toApiFilters(args);
        if (args.job_title) {
          apiBody.personas = [[args.job_title, [args.job_title.toLowerCase()], [], []]];
        }
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
              leads: formated_leads,
            },
            content: [
              {
                type: 'text',
                text: JSON.stringify({ amount: data.amount ?? formated_leads.length, leads: formated_leads }, null, 2),
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
    'Search for companies by ICP filters',
    {
      company_types: z
        .array(z.string())
        .describe('Company types. Allowed values: "Public Company", "Educational", "Self Employed", "Government Agency", "Non Profit", "Self Owned", "Privately Held", "Partnership".')
        .optional(),
      get_max_companies: z.boolean().describe('Get maximum companies').optional(),
      headcounts: z
        .array(z.string())
        .describe('Employee headcount ranges. Allowed values ONLY: "1", "2-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10000+". Note the largest bucket is "10000+" (NOT "10001+").')
        .optional(),
      industries: z
        .array(z.string())
        .describe('Industries. Must match Generect industry names exactly (e.g. "Software Development", "Financial Services"). Invalid names are rejected by the API.')
        .optional(),
      locations: z.array(z.string()).describe('Locations (countries, e.g. ["United States"])').optional(),
      keywords: z.array(z.string()).describe('Keywords').optional(),
      limit_by: z.number().describe('Number of results to return').optional(),
      offset_by: z.number().describe('Offset for pagination').optional(),
      limit: z.number().describe('Alias for limit_by').optional(),
      offset: z.number().describe('Alias for offset_by').optional(),
      compact: z.boolean().describe('Return compact summary instead of full JSON').optional(),
      fallback_from_leads: z.boolean().describe('If no companies, derive from leads by keywords').optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        let data = await callApi(
          fetcher,
          `${apiBase}/api/linkedin/companies/by_icp/`,
          {
            method: 'POST',
            headers: { Authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify(toApiFilters(args)),
          },
          Number(args?.timeout_ms ?? defaultTimeoutMs),
        );
        const companiesEmpty = !data || !Array.isArray(data.companies) || data.companies.length === 0;
        const shouldFallback =
          companiesEmpty &&
          Array.isArray(args?.keywords) &&
          args.keywords.length > 0 &&
          args?.fallback_from_leads !== false;
        if (shouldFallback) {
          const leadsBody: Record<string, unknown> = {
            keywords: args.keywords,
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
              .map(([name, count]) => ({ name, occurrences_in_leads: count }));
            data = { amount: derived.length, companies: derived };
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
    'Generate email by first/last name and domain via Generect Email Generator',
    {
      first_name: z.string().describe('First name of the person'),
      last_name: z.string().describe('Last name of the person'),
      domain: z.string().describe('Company domain without protocol (e.g., generect.com)'),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args, extra) => {
      try {
        const Authorization = await resolveAuthHeader(extra);
        const candidate = {
          first_name: args.first_name,
          last_name: args.last_name,
          domain: args.domain,
        };
        const data = await callApi(
          fetcher,
          `${apiBase}/api/linkedin/email_finder/`,
          {
            method: 'POST',
            headers: { Authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify([candidate]),
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
    'Health check Generect API via a quick lead-by-link request',
    {
      url: z.string().describe('LinkedIn profile URL to validate (defaults to a public profile)').optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args, extra) => {
      const started = Date.now();
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
          status: res.status,
          ms: Date.now() - started,
          sample: data?.lead?.linkedin_url ?? null,
        };
        return jsonTextContent(payload);
      } catch (err: unknown) {
        return jsonTextContent({
          ok: false,
          error: String(err),
          ms: Date.now() - started,
        });
      }
    },
  );
}
