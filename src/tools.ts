import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

type Fetcher = typeof fetch;

function jsonTextContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
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

async function fetchWithTimeout(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeoutMs = 20000
) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function getErrorMessageForStatus(status: number): string {
  const errorMap: Record<number, string> = {
    429: 'Rate limit exceeded. Please try again later.',
    402: 'Insufficient credits on your Generect account.',
    401: 'Invalid API key or authentication failed.',
    403: 'Access forbidden. Check your API key permissions.',
    500: 'Internal server error. Please try again later.',
    503: 'Service temporarily unavailable. Please try again later.',
  };
  return errorMap[status] || `API request failed with status ${status}`;
}

function parseApiResponse(text: string, status: number, toolName: string) {
  console.log(`[${toolName}] Response body length:`, text.length);

  // Handle empty response
  if (!text || text.trim() === '') {
    return {
      error: getErrorMessageForStatus(status),
      status,
      message: 'Empty response from server'
    };
  }

  // Try to parse JSON
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    console.error(`[${toolName}] JSON parse error:`, parseErr);
    return {
      error: 'Failed to parse API response',
      status,
      response_preview: text.substring(0, 500)
    };
  }
}

export function registerTools(server: McpServer, fetcher: Fetcher, apiBase: string, getApiKey: () => string) {
  function resolveAuthHeader(extra: any): string {
    console.log('[resolveAuthHeader] extra:', JSON.stringify(extra, null, 2));
    const header = extra?.requestInfo?.headers?.authorization as string | undefined;
    console.log('[resolveAuthHeader] header from extra:', header);
    if (header && header.trim()) {
      // Remove "Bearer " prefix if present, keep only "Token XXX"
      let cleaned = header.trim();
      if (cleaned.startsWith('Bearer ')) {
        cleaned = cleaned.substring(7).trim();
      }
      // Ensure it starts with "Token "
      const result = cleaned.startsWith('Token ') ? cleaned : `Token ${cleaned}`;
      console.log('[resolveAuthHeader] Using header:', result.substring(0, 20) + '...');
      return result;
    }
    const fallback = getApiKey() || '';
    console.log('[resolveAuthHeader] fallback from session:', fallback?.substring(0, 15) + '...');
    if (!fallback) {
      throw new Error('Authorization header is required');
    }
    return fallback.startsWith('Token ') ? fallback : `Token ${fallback}`;
  }
  const defaultTimeoutMs = Number(process.env.GENERECT_TIMEOUT_MS || '120000');
  const debug = process.env.MCP_DEBUG === '1' || process.env.MCP_DEBUG === 'true';

  // 1. Пошук лідів по ICP (без компаній)
  server.tool(
    'search_leads',
    'Search for leads by ICP filters',
    {
      job_title: z.string().describe('Job title filter (e.g., CEO, CTO, Engineer)').optional(),
      location: z.string().describe('Location filter (e.g., San Francisco, New York)').optional(),
      industry: z.string().describe('Industry filter (e.g., Technology, Healthcare)').optional(),
      company_id: z.string().describe('LinkedIn company id').optional(),
      company_link: z.string().describe('LinkedIn company URL').optional(),
      company_name: z.string().describe('Company name').optional(),
      limit: z.number().describe('Number of results to return').optional(),
      offset: z.number().describe('Offset for pagination').optional(),
      max_items: z.number().describe('Maximum items to include in response (local trim)').optional(),
      compact: z.boolean().describe('Return compact summary instead of full JSON').optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args: any, extra: any) => {
      const toolName = 'search_leads';
      console.log(`[${toolName}] Called with args:`, JSON.stringify(args));
      try {
        const Authorization = resolveAuthHeader(extra);
        console.log(`[${toolName}] Authorization resolved`);

        // Convert company_id to string if provided
        const payload = { ...args };
        if (payload.company_id !== undefined && payload.company_id !== null) {
          payload.company_id = String(payload.company_id);
          console.log(`[${toolName}] Converted company_id to string:`, payload.company_id);
        }

        console.log(`[${toolName}] Sending request to API with payload:`, JSON.stringify(payload));
        const res = await fetchWithTimeout(fetcher, `${apiBase}/api/linkedin/leads/by_icp/`, {
          method: 'POST',
          headers: { Authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, Number(args?.timeout_ms ?? defaultTimeoutMs));

        console.log(`[${toolName}] Response status:`, res.status);
        const text = await res.text();
        console.log(`[${toolName}] Response body length:`, text.length);

        if (!res.ok) {
          console.error(`[${toolName}] API error ${res.status}:`, text.substring(0, 500));
          return jsonTextContent({
            error: getErrorMessageForStatus(res.status),
            status: res.status,
            details: text.substring(0, 500)
          });
        }

        const data = parseApiResponse(text, res.status, toolName);
        if (data.error) {
          console.error(`[${toolName}] Parse error:`, data.error);
          return jsonTextContent(data);
        }

        const compact = args?.compact !== false; // default true
        const maxItems = Number(args?.max_items ?? args?.limit ?? 10);
        if (compact && data) {
          const leads = (data.leads ?? data.results ?? data.items ?? []) as any[];
          console.log(`[${toolName}] Found ${leads.length} leads, returning ${Math.min(leads.length, maxItems)}`);
          const trimmed = leads.slice(0, Math.max(0, Math.min(maxItems, 50))).map(sanitizeLead);
          return {
            structuredContent: { amount: data.amount ?? leads.length ?? null, leads: trimmed },
            content: [{ type: 'text', text: JSON.stringify({ amount: data.amount ?? trimmed.length, leads: trimmed }, null, 2) }],
          } as any;
        }
        return jsonTextContent(data);
      } catch (err: unknown) {
        console.error(`[${toolName}] Exception:`, err);
        return jsonTextContent({
          error: err instanceof Error ? err.message : String(err),
          tool: toolName,
          stack: err instanceof Error ? err.stack : undefined
        });
      }
    }
  );

  // 2. Пошук компаній (для лідів)
  server.tool(
    'search_companies',
    'Search for companies by ICP filters',
    {
      company_types: z.array(z.string()).describe('Company types').optional(),
      get_max_companies: z.boolean().describe('Get maximum companies').optional(),
      headcounts: z.array(z.string()).describe('Headcount ranges').optional(),
      industries: z.array(z.string()).describe('Industries').optional(),
      keywords: z.array(z.string()).describe('Keywords').optional(),
      max_items: z.number().describe('Maximum items to include in response (local trim)').optional(),
      compact: z.boolean().describe('Return compact summary instead of full JSON').optional(),
      fallback_from_leads: z.boolean().describe('If no companies, derive from leads by keywords').optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args: any, extra: any) => {
      const toolName = 'search_companies';
      console.log(`[${toolName}] Called with args:`, JSON.stringify(args));
      try {
        const Authorization = resolveAuthHeader(extra);
        console.log(`[${toolName}] Authorization resolved`);

        console.log(`[${toolName}] Sending request to API with payload:`, JSON.stringify(args));
        const res = await fetchWithTimeout(fetcher, `${apiBase}/api/linkedin/companies/by_icp/`, {
          method: 'POST',
          headers: { Authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(args || {}),
        }, Number(args?.timeout_ms ?? defaultTimeoutMs));

        console.log(`[${toolName}] Response status:`, res.status);
        const text = await res.text();
        console.log(`[${toolName}] Response body length:`, text.length);

        if (!res.ok) {
          console.error(`[${toolName}] API error ${res.status}:`, text.substring(0, 500));
          return jsonTextContent({
            error: getErrorMessageForStatus(res.status),
            status: res.status,
            details: text.substring(0, 500)
          });
        }

        let data = parseApiResponse(text, res.status, toolName);
        if (data.error) {
          console.error(`[${toolName}] Parse error:`, data.error);
          return jsonTextContent(data);
        }
        // Fallback: derive companies from leads by keywords when API returns nothing
        const companiesEmpty = !data || !Array.isArray(data.companies) || data.companies.length === 0;
        const shouldFallback = companiesEmpty && Array.isArray(args?.keywords) && args.keywords.length > 0 && args?.fallback_from_leads !== false;
        if (shouldFallback) {
          console.log(`[${toolName}] No companies found, trying fallback from leads with keywords:`, args.keywords);
          const leadsBody: Record<string, unknown> = { keywords: args.keywords, limit: 100 };
          const resLeads = await fetchWithTimeout(fetcher, `${apiBase}/api/linkedin/leads/by_icp/`, {
            method: 'POST',
            headers: { Authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify(leadsBody),
          }, Number(args?.timeout_ms ?? defaultTimeoutMs));
          const leadsText = await resLeads.text();
          console.log(`[${toolName}] Fallback leads response status:`, resLeads.status);
          try {
            const leadsData = JSON.parse(leadsText);
            const leads = (leadsData.leads ?? leadsData.results ?? []) as any[];
            console.log(`[${toolName}] Fallback found ${leads.length} leads`);
            const counts = new Map<string, number>();
            for (const lead of leads) {
              const name = lead.company_name ?? lead.raw_company_name;
              if (typeof name === 'string' && name.trim()) {
                counts.set(name, (counts.get(name) ?? 0) + 1);
              }
            }
            const derived = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, occurrences_in_leads: count }));
            console.log(`[${toolName}] Derived ${derived.length} companies from leads`);
            data = { amount: derived.length, companies: derived };
          } catch (fallbackErr) {
            console.error(`[${toolName}] Fallback parse error:`, fallbackErr);
          }
        }
        const compact = args?.compact !== false; // default true
        const maxItems = Number(args?.max_items ?? 10);
        if (compact && data) {
          const companies = (data.companies ?? data.results ?? data.items ?? []) as any[];
          console.log(`[${toolName}] Found ${companies.length} companies, returning ${Math.min(companies.length, maxItems)}`);
          const trimmed = companies.slice(0, Math.max(0, Math.min(maxItems, 50))).map((c: any) => (c.name || c.occurrences_in_leads ? c : sanitizeCompany(c)));
          return {
            structuredContent: { amount: data.amount ?? companies.length ?? null, companies: trimmed },
            content: [{ type: 'text', text: JSON.stringify({ amount: data.amount ?? trimmed.length, companies: trimmed }, null, 2) }],
          } as any;
        }
        return jsonTextContent(data);
      } catch (err: unknown) {
        console.error(`[${toolName}] Exception:`, err);
        return jsonTextContent({
          error: err instanceof Error ? err.message : String(err),
          tool: toolName,
          stack: err instanceof Error ? err.stack : undefined
        });
      }
    }
  );

  // 3. Email finder по лідах  
  server.tool(
    'generate_email',
    'Generate email by first/last name and domain via Generect Email Generator',
    {
      first_name: z.string().describe('First name of the person'),
      last_name: z.string().describe('Last name of the person'),
      domain: z.string().describe('Company domain without protocol (e.g., generect.com)'),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args: any, extra: any) => {
      if (debug) console.error('[mcp] generate_email args:', JSON.stringify(args));
      try {
        const Authorization = resolveAuthHeader(extra);
        console.log('[generate_email] Using Authorization:', Authorization?.substring(0, 20) + '...');
        const candidate = {
          first_name: args.first_name,
          last_name: args.last_name,
          domain: args.domain
        };
        const res = await fetchWithTimeout(fetcher, `${apiBase}/api/linkedin/email_finder/`, {
          method: 'POST',
          headers: { Authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify([candidate]),
        }, Number(args?.timeout_ms ?? defaultTimeoutMs));
        console.log('[generate_email] Response status:', res.status);
        const text = await res.text();
        const data = parseApiResponse(text, res.status, 'generate_email');
        return jsonTextContent(data);
      } catch (err: unknown) {
        console.error('[generate_email] Error:', err);
        return jsonTextContent({ error: String(err) });
      }
    }
  );

  // 4. Апдейт по лінкединах
  server.tool(
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
      if (debug) console.error('[mcp] get_lead_by_url args:', JSON.stringify(args));
      try {
        const Authorization = resolveAuthHeader(extra);
        console.log('[get_lead_by_url] Using Authorization:', Authorization?.substring(0, 20) + '...');
        const payload = {
          url: args.url,
          comments: Boolean(args.comments),
          inexact_company: Boolean(args.inexact_company),
          people_also_viewed: Boolean(args.people_also_viewed),
          posts: Boolean(args.posts),
        };
        const res = await fetchWithTimeout(fetcher, `${apiBase}/api/linkedin/leads/by_link/`, {
          method: 'POST',
          headers: { Authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, Number(args?.timeout_ms ?? defaultTimeoutMs));
        console.log('[get_lead_by_url] Response status:', res.status);
        const text = await res.text();
        const data = parseApiResponse(text, res.status, 'get_lead_by_url');
        return jsonTextContent(data);
      } catch (err: unknown) {
        console.error('[get_lead_by_url] Error:', err);
        return jsonTextContent({ error: String(err) });
      }
    }
  );

  // 5. Health check
  server.tool(
    'health',
    'Health check Generect API via a quick lead-by-link request',
    {
      url: z.string().describe('LinkedIn profile URL to validate (defaults to a public profile)').optional(),
      timeout_ms: z.number().describe('Request timeout in milliseconds').optional(),
    },
    async (args: any, extra: any) => {
      if (debug) console.error('[mcp] health args:', JSON.stringify(args));
      const started = Date.now();
      const testUrl = typeof args?.url === 'string' && args.url.trim()
        ? args.url
        : 'https://www.linkedin.com/in/satyanadella/';
      try {
        const Authorization = resolveAuthHeader(extra);
        const res = await fetchWithTimeout(fetcher, `${apiBase}/api/linkedin/leads/by_link/`, {
          method: 'POST',
          headers: { Authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: testUrl }),
        }, Number(args?.timeout_ms ?? defaultTimeoutMs));
        const text = await res.text();
        let data: any = undefined;
        try { data = JSON.parse(text); } catch {}
        const ok = !!data?.lead?.linkedin_url;
        const payload = {
          ok,
          status: res.status,
          ms: Date.now() - started,
          sample: data?.lead?.linkedin_url ?? null,
        };
        return jsonTextContent(payload);
      } catch (err: unknown) {
        return jsonTextContent({ ok: false, error: String(err), ms: Date.now() - started });
      }
    }
  );
}