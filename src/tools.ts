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

export function registerTools(server: McpServer, fetcher: Fetcher, apiBase: string, getApiKey: () => string) {
  function resolveAuthHeader(extra: any): string {
    const header = extra?.requestInfo?.headers?.authorization as string | undefined;
    if (header && header.trim()) {
      return header.startsWith('Token ') ? header : `Token ${header}`;
    }
    const fallback = getApiKey() || '';
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
      if (debug) console.error('[mcp] search_leads args:', JSON.stringify(args));
      try {
        const Authorization = resolveAuthHeader(extra);
        const res = await fetchWithTimeout(fetcher, `${apiBase}/api/linkedin/leads/by_icp/`, {
          method: 'POST',
          headers: { Authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(args || {}),
        }, Number(args?.timeout_ms ?? defaultTimeoutMs));
        const text = await res.text();
        const data = JSON.parse(text);
        const compact = args?.compact !== false; // default true
        const maxItems = Number(args?.max_items ?? args?.limit ?? 10);
        if (compact && data) {
          const leads = (data.leads ?? data.results ?? data.items ?? []) as any[];
          const trimmed = leads.slice(0, Math.max(0, Math.min(maxItems, 50))).map(sanitizeLead);
          return {
            structuredContent: { amount: data.amount ?? leads.length ?? null, leads: trimmed },
            content: [{ type: 'text', text: JSON.stringify({ amount: data.amount ?? trimmed.length, leads: trimmed }, null, 2) }],
          } as any;
        }
        return jsonTextContent(data);
      } catch (err: unknown) {
        return jsonTextContent({ error: String(err) });
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
      if (debug) console.error('[mcp] search_companies args:', JSON.stringify(args));
      try {
        const Authorization = resolveAuthHeader(extra);
        const res = await fetchWithTimeout(fetcher, `${apiBase}/api/linkedin/companies/by_icp/`, {
          method: 'POST',
          headers: { Authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(args || {}),
        }, Number(args?.timeout_ms ?? defaultTimeoutMs));
        const text = await res.text();
        let data = JSON.parse(text);
        // Fallback: derive companies from leads by keywords when API returns nothing
        const companiesEmpty = !data || !Array.isArray(data.companies) || data.companies.length === 0;
        const shouldFallback = companiesEmpty && Array.isArray(args?.keywords) && args.keywords.length > 0 && args?.fallback_from_leads !== false;
        if (shouldFallback) {
          const leadsBody: Record<string, unknown> = { keywords: args.keywords, limit: 100 };
          const resLeads = await fetchWithTimeout(fetcher, `${apiBase}/api/linkedin/leads/by_icp/`, {
            method: 'POST',
            headers: { Authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify(leadsBody),
          }, Number(args?.timeout_ms ?? defaultTimeoutMs));
          const leadsText = await resLeads.text();
          try {
            const leadsData = JSON.parse(leadsText);
            const leads = (leadsData.leads ?? leadsData.results ?? []) as any[];
            const counts = new Map<string, number>();
            for (const lead of leads) {
              const name = lead.company_name ?? lead.raw_company_name;
              if (typeof name === 'string' && name.trim()) {
                counts.set(name, (counts.get(name) ?? 0) + 1);
              }
            }
            const derived = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, occurrences_in_leads: count }));
            data = { amount: derived.length, companies: derived };
          } catch {
            // ignore fallback parse errors
          }
        }
        const compact = args?.compact !== false; // default true
        const maxItems = Number(args?.max_items ?? 10);
        if (compact && data) {
          const companies = (data.companies ?? data.results ?? data.items ?? []) as any[];
          const trimmed = companies.slice(0, Math.max(0, Math.min(maxItems, 50))).map((c: any) => (c.name || c.occurrences_in_leads ? c : sanitizeCompany(c)));
          return {
            structuredContent: { amount: data.amount ?? companies.length ?? null, companies: trimmed },
            content: [{ type: 'text', text: JSON.stringify({ amount: data.amount ?? trimmed.length, companies: trimmed }, null, 2) }],
          } as any;
        }
        return jsonTextContent(data);
      } catch (err: unknown) {
        return jsonTextContent({ error: String(err) });
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
        const text = await res.text();
        return jsonTextContent(JSON.parse(text));
      } catch (err: unknown) {
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
        const text = await res.text();
        return jsonTextContent(JSON.parse(text));
      } catch (err: unknown) {
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