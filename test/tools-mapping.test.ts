import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerTools } from '../src/tools.ts';
import { resetPriceBookCache } from '../src/pricing.ts';
import { TOOL_META, TOOL_ORDER } from '../src/tool-meta.ts';

// Register the tools against a fake McpServer that captures handlers, and a fake
// fetcher driven by URL matchers. This exercises the real args -> Generect-API
// mapping (URL, body shape, mode routing, cost reporting) end to end.
type Route = { match: RegExp; status?: number; body: any };

const TIER = {
  current_tier: {
    name: '3',
    service_prices: {
      api_cached: 0.01,
      api_realtime: 0.04,
      api_preview: 0.002,
      api_email_finder: 0.02,
      api_email_validation: 0.005,
      phones: 0.4,
    },
  },
};

function harness(routes: Route[]) {
  resetPriceBookCache();
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const fetcher = async (url: string, init: any = {}) => {
    let body: any = null;
    try {
      body = init.body ? JSON.parse(init.body) : null;
    } catch {
      body = init.body;
    }
    calls.push({ url, method: init.method ?? 'GET', body, headers: init.headers ?? {} });
    const route = routes.find(r => r.match.test(url));
    const payload = route ? route.body : { data: {}, meta: { amount_charged: 0 } };
    return new Response(JSON.stringify(payload), {
      status: route?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const tools: Record<string, Function> = {};
  const server: any = { tool: (name: string, _d: string, _s: any, handler: Function) => (tools[name] = handler) };
  registerTools(server, fetcher as any, 'https://api.test', '');
  return { tools, calls };
}

const EXTRA = { requestInfo: { headers: { authorization: 'Token test-key' } } };
const TIER_ROUTE: Route = { match: /tiers\/my-tier/, body: TIER };
const out = (r: any) => r.structuredContent;

const UNSUPPORTED = (field: string) => ({
  status: 400,
  body: {
    status: 'error',
    status_code: 400,
    detail: { [field]: `\`${field}\` filter is not supported in database mode for leads. Use realtime endpoint.` },
  },
});

// ---------------------------------------------------------------------------
// Free pre-flight
// ---------------------------------------------------------------------------

test('count_leads: uses the FREE database count endpoint and reports zero cost', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\/count/, body: { data: { results_count: 1240 }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(await tools.count_leads({ job_titles: ['CEO'], locations: ['Germany'] }, EXTRA));
  const call = calls.find(c => /count/.test(c.url))!;
  assert.equal(call.url, 'https://api.test/api/v1/search/database/leads/count/');
  assert.deepEqual(call.body, { job_titles: ['CEO'], locations: ['Germany'] });
  assert.equal(r.results_count, 1240);
  assert.equal(r.mode, 'database');
  assert.equal(r.cost.amount_charged_usd, 0);
});

test('count_leads: quotes the next step at the ACCOUNT tier price, not the list price', async () => {
  const { tools } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\/count/, body: { data: { results_count: 300 }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(await tools.count_leads({ job_titles: ['CEO'] }, EXTRA));
  assert.equal(r.next_step_estimate.search_usd_per_row, 0.01, 'api_cached from the tier endpoint');
  assert.equal(r.next_step_estimate.search_cost_for['25_rows'], 0.25);
  assert.equal(r.next_step_estimate.all_matches_would_cost_usd, 3);
  assert.match(r.next_step_estimate.priced_at, /account tier 3/);
});

test('count_leads: a realtime-only filter never triggers a paid count implicitly', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\/count/, ...UNSUPPORTED('keywords') },
    { match: /search\/realtime\/leads\/count/, body: { data: { results_count: 5 }, meta: { amount_charged: 0.02 } } },
  ]);
  const r = out(await tools.count_leads({ job_titles: ['CEO'], keywords: ['fintech'] }, EXTRA));
  assert.deepEqual(r.needs_realtime, ['keywords']);
  assert.equal(r.results_count, null);
  assert.equal(r.cost.amount_charged_usd, 0);
  assert.ok(!calls.some(c => /realtime/.test(c.url)), 'must NOT spend on a live count without being asked');
});

test('count_leads: mode realtime is honoured when asked for explicitly', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/realtime\/leads\/count/, body: { data: { results_count: 77 }, meta: { amount_charged: 0.02 } } },
  ]);
  const r = out(await tools.count_leads({ job_titles: ['CEO'], mode: 'realtime' }, EXTRA));
  assert.equal(r.results_count, 77);
  assert.equal(r.cost.amount_charged_usd, 0.02);
  assert.ok(!calls.some(c => /database/.test(c.url)));
});

test('count_leads: company_filters switch to the two-level company-leads count', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    {
      match: /search\/database\/company-leads\/count/,
      body: { data: { results_count: 42 }, meta: { amount_charged: 0 } },
    },
  ]);
  await tools.count_leads({ job_titles: ['CEO'], company_filters: { industries: ['Software Development'] } }, EXTRA);
  const call = calls.find(c => /count/.test(c.url))!;
  assert.equal(call.url, 'https://api.test/api/v1/search/database/company-leads/count/');
  assert.deepEqual(call.body, {
    company_search_criteria: { industries: ['Software Development'] },
    lead_search_criteria: { job_titles: ['CEO'] },
  });
});

test('count_leads: zero matches carry an explicit "do not run a paid search" instruction', async () => {
  const { tools } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\/count/, body: { data: { results_count: 0 }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(await tools.count_leads({ job_titles: ['Nobody'] }, EXTRA));
  assert.match(r.advice, /Do NOT run a paid search/);
});

// ---------------------------------------------------------------------------
// Paid search
// ---------------------------------------------------------------------------

const LEAD_ROW = {
  id: 'ACwAAA1',
  full_name: 'Jordan Ellis',
  first_name: 'Jordan',
  last_name: 'Ellis',
  job_title: 'CEO',
  company_name: 'Stripe',
  company_website: 'http://www.stripe.com/',
  industry: 'Software Development',
  location: 'Berlin',
  linkedin_url: 'https://linkedin.com/in/jordan',
  skills: ['a', 'b'],
};

test('search_leads: cheap database endpoint, default row cap, compact projection keeps id + domain', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    {
      match: /search\/database\/leads\//,
      body: { data: { leads: [LEAD_ROW], results_count: 900 }, meta: { amount_charged: 0.01 } },
    },
  ]);
  const r = out(await tools.search_leads({ job_titles: ['CEO'], locations: ['Germany'] }, EXTRA));
  const call = calls.find(c => /search/.test(c.url))!;
  assert.equal(call.url, 'https://api.test/api/v1/search/database/leads/');
  assert.equal(call.body.limit_by, 25, 'unbounded pulls are never sent to a per-row billed endpoint');
  assert.equal(r.mode, 'database');
  assert.equal(r.cost.amount_charged_usd, 0.01);
  assert.deepEqual(r.leads[0], {
    id: 'ACwAAA1',
    full_name: 'Jordan Ellis',
    first_name: 'Jordan',
    last_name: 'Ellis',
    job_title: 'CEO',
    company_name: 'Stripe',
    company_domain: 'stripe.com',
    industry: 'Software Development',
    location: 'Berlin',
    linkedin_url: 'https://linkedin.com/in/jordan',
  });
});

test('search_leads: limit alias maps to limit_by and is clamped to the max', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database/, body: { data: { leads: [] }, meta: {} } },
  ]);
  await tools.search_leads({ job_titles: ['CEO'], limit: 5000 }, EXTRA);
  assert.equal(calls.find(c => /search/.test(c.url))!.body.limit_by, 100);
  assert.ok(!('limit' in calls.find(c => /search/.test(c.url))!.body), 'control alias is not forwarded raw');
});

test('search_leads: auto mode escalates to realtime only when the API says the filter needs it', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\//, ...UNSUPPORTED('changed_jobs') },
    { match: /search\/realtime\/leads\//, body: { data: { leads: [LEAD_ROW] }, meta: { amount_charged: 0.04 } } },
  ]);
  const r = out(await tools.search_leads({ job_titles: ['CEO'], changed_jobs: true }, EXTRA));
  assert.equal(r.mode, 'realtime');
  assert.deepEqual(r.escalated_to_realtime_because, ['changed_jobs']);
  assert.equal(r.cost.amount_charged_usd, 0.04);
  assert.equal(calls.filter(c => /search/.test(c.url)).length, 2, 'cheap attempt first, then live');
});

test('search_leads: an explicit database request is never upgraded to the pricier endpoint', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\//, ...UNSUPPORTED('keywords') },
    { match: /search\/realtime\/leads\//, body: { data: { leads: [LEAD_ROW] }, meta: { amount_charged: 0.04 } } },
  ]);
  const r = await tools.search_leads({ job_titles: ['CEO'], keywords: ['ai'], mode: 'database' }, EXTRA);
  assert.equal(r.isError, true);
  assert.ok(!calls.some(c => /realtime/.test(c.url)), 'no silent upgrade');
});

test('search_leads: a non-filter error is not mistaken for a mode problem', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    {
      match: /search\/database\/leads\//,
      status: 400,
      body: { status: 'error', status_code: 400, detail: 'Insufficient funds in the account.' },
    },
    { match: /search\/realtime\/leads\//, body: { data: { leads: [LEAD_ROW] }, meta: { amount_charged: 0.04 } } },
  ]);
  const r = await tools.search_leads({ job_titles: ['CEO'] }, EXTRA);
  assert.equal(r.isError, true);
  assert.match(out(r).next_step, /out of credits/);
  assert.ok(!calls.some(c => /realtime/.test(c.url)), 'never retry a funding error on a pricier endpoint');
});

test('search_companies: compact projection exposes the domain used by the email finder', async () => {
  const { tools } = harness([
    TIER_ROUTE,
    {
      match: /search\/database\/companies\//,
      body: {
        data: {
          companies: [
            {
              id: '1035',
              name: 'Marsig',
              website: 'http://www.marsig.com',
              domain: 'marsig.com',
              industry: 'Software Development',
              headcount_range: '11-50',
              headcount_exact: 12,
              location: 'Germany',
              linkedin_link: 'https://linkedin.com/company/marsig',
              description: 'x',
            },
          ],
          results_count: 3,
        },
        meta: { amount_charged: 0.01 },
      },
    },
  ]);
  const r = out(await tools.search_companies({ industries: ['Software Development'] }, EXTRA));
  assert.equal(r.companies[0].domain, 'marsig.com');
  assert.equal(r.companies[0].id, '1035');
  assert.equal(r.cost.amount_charged_usd, 0.01);
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('preview_leads: limit_by is nested inside lead_search_criteria (top level is ignored by the API)', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /preview\/leads/, body: { data: { leads: [LEAD_ROW] }, meta: { amount_charged: 0.002 } } },
  ]);
  await tools.preview_leads({ job_titles: ['CEO'], limit_by: 5 }, EXTRA);
  const call = calls.find(c => /preview/.test(c.url))!;
  assert.deepEqual(call.body, { lead_search_criteria: { job_titles: ['CEO'], limit_by: 5 } });
});

test('preview_leads: rows the API returns beyond the cap are trimmed and flagged', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...LEAD_ROW, id: `id-${i}` }));
  const { tools } = harness([
    TIER_ROUTE,
    { match: /preview\/leads/, body: { data: { leads: many }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(await tools.preview_leads({ job_titles: ['CEO'], limit_by: 5 }, EXTRA));
  assert.equal(r.returned, 5);
  assert.equal(r.api_returned_more_than_requested, 100);
});

// ---------------------------------------------------------------------------
// Contact data
// ---------------------------------------------------------------------------

test('generate_email: single lookup by lead_id and cost is summed from the API receipt', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /email\/find\//, body: { data: { email: 'a@b.com', status: 'valid' }, meta: { amount_charged: 0.02 } } },
  ]);
  const r = out(await tools.generate_email({ lead_id: 'ACwAAA1' }, EXTRA));
  assert.deepEqual(calls.find(c => /email\/find/.test(c.url))!.body, { lead_id: 'ACwAAA1' });
  assert.equal(r.cost.amount_charged_usd, 0.02);
  assert.equal(r.results[0].email, 'a@b.com');
});

test('generate_email: name+domain form is accepted and middle_name is forwarded', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /email\/find\//, body: { data: { email: 'j@stripe.com' }, meta: { amount_charged: 0.02 } } },
  ]);
  await tools.generate_email(
    { first_name: 'Jordan', last_name: 'Ellis', domain: 'stripe.com', middle_name: 'Q' },
    EXTRA,
  );
  assert.deepEqual(calls.find(c => /email\/find/.test(c.url))!.body, {
    first_name: 'Jordan',
    last_name: 'Ellis',
    domain: 'stripe.com',
    middle_name: 'Q',
  });
});

test('generate_email: a large batch goes to the async bulk endpoint instead of N live calls', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /email\/find\/bulk\//, body: { data: null, meta: { job_id: 'job-1', status: 'pending' } } },
  ]);
  const candidates = Array.from({ length: 12 }, (_, i) => ({ lead_id: `id-${i}` }));
  const r = out(await tools.generate_email({ candidates }, EXTRA));
  assert.equal(r.mode, 'bulk');
  assert.equal(r.submitted, 12);
  assert.equal(calls.filter(c => /email\/find/.test(c.url)).length, 1, 'one bulk submit, not twelve lookups');
  assert.equal(calls.find(c => /bulk/.test(c.url))!.body.leads.length, 12);
});

test('generate_email: one failed candidate does not lose the successful ones', async () => {
  let n = 0;
  const fetcher = async (url: string, init: any = {}) => {
    if (/tiers/.test(url)) return new Response(JSON.stringify(TIER), { status: 200 });
    n += 1;
    if (n === 1) return new Response(JSON.stringify({ detail: 'boom' }), { status: 500 });
    return new Response(JSON.stringify({ data: { email: 'ok@b.com' }, meta: { amount_charged: 0.02 } }), {
      status: 200,
    });
  };
  resetPriceBookCache();
  const tools: Record<string, Function> = {};
  const server: any = { tool: (name: string, _d: string, _s: any, h: Function) => (tools[name] = h) };
  registerTools(server, fetcher as any, 'https://api.test', '');
  const r = out(await tools.generate_email({ candidates: [{ lead_id: 'a' }, { lead_id: 'b' }] }, EXTRA));
  assert.equal(r.results.length, 2);
  assert.ok(r.results.some((x: any) => x.error));
  assert.ok(r.results.some((x: any) => x.email === 'ok@b.com'));
});

test('validate_email: rejects an empty list before spending anything', async () => {
  const { tools, calls } = harness([TIER_ROUTE]);
  const r = await tools.validate_email({ emails: ['not-an-email'] }, EXTRA);
  assert.equal(r.isError, true);
  assert.ok(!calls.some(c => /validate/.test(c.url)));
});

test('find_phone: resolves the one-of identifier into the API shape', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /phone\/find/, body: { data: { phone: '+123' }, meta: { amount_charged: 0.4 } } },
  ]);
  const r = out(await tools.find_phone({ first_name: 'Jordan', last_name: 'Ellis', company: 'stripe.com' }, EXTRA));
  assert.deepEqual(calls.find(c => /phone/.test(c.url))!.body, {
    first_name: 'Jordan',
    last_name: 'Ellis',
    company: 'stripe.com',
  });
  assert.equal(r.cost.amount_charged_usd, 0.4);
});

test('enrich_lead: exactly one identifier is required', async () => {
  const { tools, calls } = harness([TIER_ROUTE]);
  const both = await tools.enrich_lead({ id: 'x', email: 'a@b.com' }, EXTRA);
  assert.equal(both.isError, true);
  const none = await tools.enrich_lead({}, EXTRA);
  assert.equal(none.isError, true);
  assert.ok(!calls.some(c => /enrich/.test(c.url)));
});

test('get_lead_by_url: still works and now routes to the v1 enrich endpoint', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /enrich\/database\/lead/, body: { data: LEAD_ROW, meta: { amount_charged: 0.01 } } },
  ]);
  const r = out(await tools.get_lead_by_url({ url: 'https://linkedin.com/in/jordan' }, EXTRA));
  assert.equal(calls.find(c => /enrich/.test(c.url))!.url, 'https://api.test/api/v1/enrich/database/lead/');
  assert.deepEqual(calls.find(c => /enrich/.test(c.url))!.body, { linkedin_url: 'https://linkedin.com/in/jordan' });
  assert.equal(r.found, true);
  assert.equal(r.lead.id, 'ACwAAA1');
});

// ---------------------------------------------------------------------------
// Account, bulk, webhooks, health
// ---------------------------------------------------------------------------

test('get_balance: returns balance plus the account-specific price book', async () => {
  const { tools } = harness([
    TIER_ROUTE,
    {
      match: /accounts\/me/,
      body: { data: { email: 'a@b.com', credits: { balance: 12.4, used_this_month: 3 }, preview_tier: true } },
    },
  ]);
  const r = out(await tools.get_balance({}, EXTRA));
  assert.equal(r.balance_usd, 12.4);
  assert.equal(r.your_prices_usd.search_database, 0.01);
  assert.equal(r.your_prices_usd.count_database, 0);
  assert.match(r.prices_source, /account tier 3/);
});

test('start_bulk_job: caps at 50, reserves a worst case, and points at the poll tool', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /email\/find\/bulk/, body: { data: null, meta: { job_id: 'job-9', status: 'pending' } } },
  ]);
  const items = Array.from({ length: 60 }, (_, i) => ({ lead_id: `id-${i}` }));
  const r = out(await tools.start_bulk_job({ job_type: 'email_find', items }, EXTRA));
  assert.equal(r.submitted, 50);
  assert.equal(r.dropped, 10);
  assert.equal(r.reserved_worst_case_usd, 1, '50 x $0.02 at this tier');
  assert.equal(calls.find(c => /bulk/.test(c.url))!.body.leads.length, 50);
  assert.match(r.next_step, /get_bulk_job/);
});

test('start_bulk_job: enrich jobs pick the mode path and the right payload key', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /enrich\/realtime\/leads\/bulk/, body: { data: null, meta: { job_id: 'j' } } },
  ]);
  await tools.start_bulk_job({ job_type: 'enrich_leads', mode: 'realtime', items: [{ id: 'a' }] }, EXTRA);
  const call = calls.find(c => /bulk/.test(c.url))!;
  assert.equal(call.url, 'https://api.test/api/v1/enrich/realtime/leads/bulk/');
  assert.deepEqual(call.body, { leads: [{ id: 'a' }] });
});

test('get_bulk_job: polling is free and hits the shared status path', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /email\/find\/bulk\/job-9/, body: { data: [{ email: 'a@b.com' }], meta: { status: 'completed' } } },
  ]);
  const r = out(await tools.get_bulk_job({ job_type: 'email_find', job_id: 'job-9' }, EXTRA));
  assert.equal(calls.find(c => /bulk/.test(c.url))!.url, 'https://api.test/api/v1/email/find/bulk/job-9/');
  assert.equal(r.cost.amount_charged_usd, 0);
  assert.equal(r.job.status, 'completed');
});

test('manage_webhooks: create validates its inputs, delete requires an id', async () => {
  const { tools, calls } = harness([TIER_ROUTE, { match: /webhooks/, body: { data: { id: 'wh_1' } } }]);
  const missing = await tools.manage_webhooks({ action: 'create', url: 'https://x.test/hook' }, EXTRA);
  assert.equal(missing.isError, true);
  const noId = await tools.manage_webhooks({ action: 'delete' }, EXTRA);
  assert.equal(noId.isError, true);
  await tools.manage_webhooks(
    { action: 'create', url: 'https://x.test/hook', events: ['email.find.bulk.completed'] },
    EXTRA,
  );
  const call = calls.find(c => /webhooks/.test(c.url))!;
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, { url: 'https://x.test/hook', events: ['email.find.bulk.completed'] });
});

test('health: verifies the credential on a FREE endpoint, never a data endpoint', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /accounts\/me/, body: { data: { email: 'a@b.com', credits: { balance: 5 } } } },
  ]);
  const r = out(await tools.health({}, EXTRA));
  assert.equal(r.ok, true);
  assert.equal(r.credential_valid, true);
  assert.equal(r.cost.amount_charged_usd, 0);
  assert.ok(
    calls.every(c => /accounts\/me/.test(c.url)),
    'health must not touch search/enrich/email endpoints',
  );
});

test('health: a dead credential is reported as not-ok instead of throwing', async () => {
  const { tools } = harness([TIER_ROUTE, { match: /accounts\/me/, status: 401, body: { detail: 'Invalid token.' } }]);
  const r = out(await tools.health({}, EXTRA));
  assert.equal(r.ok, false);
  assert.equal(r.credential_valid, false);
  assert.equal(r.credential_error.status, 401);
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test('every API call identifies itself as the MCP server', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\/count/, body: { data: { results_count: 1 }, meta: { amount_charged: 0 } } },
  ]);
  await tools.count_leads({ job_titles: ['CEO'] }, EXTRA);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(call.headers['X-Generect-Client'], /^generect-mcp\/\d+\.\d+\.\d+/, call.url);
    assert.match(call.headers['User-Agent'], /^generect-mcp\//, call.url);
    assert.equal(call.headers.Authorization, 'Token test-key');
  }
});

// ---------------------------------------------------------------------------
// Backwards compatibility with the pre-v1 argument names
// ---------------------------------------------------------------------------

test('legacy job_title (singular) is still honoured, not silently dropped', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\/count/, body: { data: { results_count: 5 }, meta: { amount_charged: 0 } } },
  ]);
  await tools.count_leads({ job_title: 'CEO', locations: ['Germany'] }, EXTRA);
  const call = calls.find(c => /count/.test(c.url))!;
  assert.deepEqual(call.body, { locations: ['Germany'], job_titles: ['CEO'] });
  assert.ok(!('job_title' in call.body), 'the alias itself is not forwarded');
});

test('legacy job_title merges into an explicit job_titles list without duplicating', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads/, body: { data: { leads: [] }, meta: { amount_charged: 0 } } },
  ]);
  await tools.search_leads({ job_title: 'CEO', job_titles: ['Founder'] }, EXTRA);
  assert.deepEqual(calls.find(c => /search/.test(c.url))!.body.job_titles, ['Founder', 'CEO']);
});

test('removed by_icp flags are reported as ignored instead of vanishing', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\/count/, body: { data: { results_count: 5 }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(
    await tools.count_leads(
      { job_titles: ['CEO'], without_company: true, get_max_leads: true, lead_industries: ['Banking'] },
      EXTRA,
    ),
  );
  assert.deepEqual(Object.keys(r.deprecated_params_ignored).sort(), [
    'get_max_leads',
    'lead_industries',
    'without_company',
  ]);
  const body = calls.find(c => /count/.test(c.url))!.body;
  for (const k of ['without_company', 'get_max_leads', 'lead_industries']) {
    assert.ok(!(k in body), `${k} must not reach the API as a filter`);
  }
});

test('a call with no deprecated params carries no deprecation noise', async () => {
  const { tools } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\/count/, body: { data: { results_count: 5 }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(await tools.count_leads({ job_titles: ['CEO'] }, EXTRA));
  assert.equal(r.deprecated_params_ignored, undefined);
});

test('get_lead_by_url still accepts the old profile-section toggles', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /enrich\/database\/lead/, body: { data: LEAD_ROW, meta: { amount_charged: 0.01 } } },
  ]);
  const r = out(
    await tools.get_lead_by_url({ url: 'https://linkedin.com/in/jordan', posts: true, comments: true }, EXTRA),
  );
  assert.deepEqual(calls.find(c => /enrich/.test(c.url))!.body, { linkedin_url: 'https://linkedin.com/in/jordan' });
  assert.deepEqual(Object.keys(r.deprecated_params_ignored).sort(), ['comments', 'posts']);
});

test('search_companies reports the removed fallback_from_leads flag', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/companies/, body: { data: { companies: [] }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(
    await tools.search_companies({ industries: ['Software Development'], fallback_from_leads: true }, EXTRA),
  );
  assert.deepEqual(Object.keys(r.deprecated_params_ignored), ['fallback_from_leads']);
  assert.ok(!('fallback_from_leads' in calls.find(c => /search/.test(c.url))!.body));
});

// ---------------------------------------------------------------------------
// resolve_profile — reveal who is behind an obfuscated /in/ACwAA… link
// ---------------------------------------------------------------------------

const RESOLVED = {
  first_name: 'Oleg',
  middle_name: '',
  last_name: 'Zaremba',
  full_name: 'Oleg Zaremba',
  unformatted_full_name: 'Oleg Zaremba',
  sales_id: 'ACoAAA0pmqQBAI1iA7ykCT0a',
  id: 'ACoAAA0pmqQBAI1iA7ykCT0a',
  public_identifier: 'oleg-zaremba',
  linkedin_url: 'https://www.linkedin.com/in/oleg-zaremba',
  linkedin_id: '220830372',
  headline: 'CTO & Co-founder',
  profile_photo: 'https://media.licdn.com/dms/image/photo?e=1789603200',
  background_photo: 'https://media.licdn.com/dms/image/bg?e=1789603200',
  is_memorialized: false,
  input: 'https://www.linkedin.com/in/ACwAAA0pmqQBms',
};

const RESOLVE_ONE: Route = {
  match: /\/profile\/resolve\/$/,
  body: { data: RESOLVED, meta: { amount_charged: 0.0005 } },
};

test('resolve_profile: posts the reference to the single endpoint and reports the API charge', async () => {
  const { tools, calls } = harness([TIER_ROUTE, RESOLVE_ONE]);
  const r = out(await tools.resolve_profile({ url: 'https://www.linkedin.com/in/ACwAAA0pmqQBms' }, EXTRA));
  const call = calls.find(c => /profile\/resolve/.test(c.url))!;
  assert.equal(call.url, 'https://api.test/api/v1/profile/resolve/');
  assert.deepEqual(call.body, { linkedin_url: 'https://www.linkedin.com/in/ACwAAA0pmqQBms' });
  assert.equal(r.found, true);
  assert.equal(r.profile.linkedin_url, 'https://www.linkedin.com/in/oleg-zaremba');
  assert.equal(r.profile.linkedin_id, '220830372');
  assert.equal(r.cost.amount_charged_usd, 0.0005);
  assert.equal(r.cost.operation, 'profile_resolve');
});

test('resolve_profile: `id` is an alias for `url`, not a separate field the API sees', async () => {
  const { tools, calls } = harness([TIER_ROUTE, RESOLVE_ONE]);
  await tools.resolve_profile({ id: 'oleg-zaremba' }, EXTRA);
  const call = calls.find(c => /profile\/resolve/.test(c.url))!;
  assert.deepEqual(call.body, { linkedin_url: 'oleg-zaremba' });
});

test('resolve_profile: compact drops the expiring photo URLs; compact false keeps the raw record', async () => {
  const { tools } = harness([TIER_ROUTE, RESOLVE_ONE]);
  const compact = out(await tools.resolve_profile({ url: 'x' }, EXTRA));
  assert.ok(!('profile_photo' in compact.profile), 'signed photo URLs expire — not worth the tokens by default');
  assert.ok(!('sales_id' in compact.profile), 'duplicate of id');

  const { tools: tools2 } = harness([TIER_ROUTE, RESOLVE_ONE]);
  const raw = out(await tools2.resolve_profile({ url: 'x', compact: false }, EXTRA));
  assert.equal(raw.profile.profile_photo, RESOLVED.profile_photo);
});

test('resolve_profile: a batch goes to the bulk endpoint and keeps error rows in place', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    {
      match: /\/profile\/resolve\/bulk\//,
      body: {
        data: [RESOLVED, { input: 'not a linkedin reference', error: 'Not a LinkedIn profile URL or id.' }],
        meta: { total: 2, resolved: 1, amount_charged: 0.0005 },
      },
    },
  ]);
  const r = out(
    await tools.resolve_profile(
      { profiles: ['https://www.linkedin.com/in/ACwAAA0pmqQBms', 'not a linkedin reference'] },
      EXTRA,
    ),
  );
  const call = calls.find(c => /bulk/.test(c.url))!;
  assert.equal(call.url, 'https://api.test/api/v1/profile/resolve/bulk/');
  assert.deepEqual(call.body, { profiles: ['https://www.linkedin.com/in/ACwAAA0pmqQBms', 'not a linkedin reference'] });
  // Counts come from the API, because `resolved` is exactly what was billed.
  assert.equal(r.total, 2);
  assert.equal(r.resolved, 1);
  assert.equal(r.cost.amount_charged_usd, 0.0005);
  assert.equal(r.profiles.length, 2);
  assert.equal(r.profiles[0].public_identifier, 'oleg-zaremba');
  assert.deepEqual(r.profiles[1], { input: 'not a linkedin reference', error: 'Not a LinkedIn profile URL or id.' });
});

test('resolve_profile: with no reference at all it asks, without spending a request', async () => {
  const { tools, calls } = harness([TIER_ROUTE, RESOLVE_ONE]);
  const r = await tools.resolve_profile({}, EXTRA);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /profiles/);
  assert.ok(!calls.some(c => /profile\/resolve/.test(c.url)), 'must not call the API without a reference');
});

test('resolve_profile: an empty batch is not silently sent as a batch', async () => {
  const { tools, calls } = harness([TIER_ROUTE, RESOLVE_ONE]);
  const r = await tools.resolve_profile({ profiles: [] }, EXTRA);
  assert.equal(r.isError, true);
  assert.ok(!calls.some(c => /bulk/.test(c.url)));
});

test('resolve_profile: the price survives a tier that does not list this service type', async () => {
  // The backend seeds no ServicePrice row for api_profile_resolve, so the tier
  // endpoint has no field for it — the list price must still be the real one.
  const { tools } = harness([
    TIER_ROUTE,
    { match: /\/profile\/resolve\/$/, body: { data: RESOLVED, meta: { amount_charged: 0.0005 } } },
  ]);
  const r = out(await tools.resolve_profile({ url: 'x' }, EXTRA));
  assert.equal(r.cost.amount_charged_usd, 0.0005, 'the receipt always quotes the biller, never our arithmetic');
  assert.match(r.cost.billed, /per RESOLVED profile/);
});

// ---------------------------------------------------------------------------
// Vocabulary gate — the API does not validate industries or seniorities
// ---------------------------------------------------------------------------

test('count_leads: an unknown industry is refused locally with suggestions, nothing is sent', async () => {
  const { tools, calls } = harness([TIER_ROUTE]);
  const r = out(await tools.count_leads({ job_titles: ['CEO'], company_industries: ['Fintech'] }, EXTRA));
  assert.equal(r.status, 'not_sent');
  assert.equal(r.cost.amount_charged_usd, 0);
  assert.equal(r.blocked_by_vocabulary.length, 1);
  assert.equal(r.blocked_by_vocabulary[0].field, 'company_industries');
  assert.ok(r.blocked_by_vocabulary[0].did_you_mean.includes('Financial Services'));
  assert.ok(!calls.some(c => /search/.test(c.url)), 'no API call for a value the API would answer with a silent 0');
});

test('count_leads: allow_unlisted_values overrides the guard', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads\/count/, body: { data: { results_count: 3 }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(
    await tools.count_leads(
      { job_titles: ['CEO'], company_industries: ['Fintech'], allow_unlisted_values: true },
      EXTRA,
    ),
  );
  assert.equal(r.results_count, 3);
  assert.deepEqual(calls.find(c => /count/.test(c.url))!.body.company_industries, ['Fintech']);
});

test('search_leads: a mis-spelled industry is corrected to the canonical name, not sent as typed', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads/, body: { data: { leads: [] }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(await tools.search_leads({ job_titles: ['CEO'], company_industries: ['software development'] }, EXTRA));
  assert.deepEqual(
    calls.find(c => /search/.test(c.url))!.body.company_industries,
    ['Software Development'],
    'exact matching means the typed casing would have returned 0',
  );
  assert.equal(r.vocabulary_warnings.length, 1);
  assert.equal(r.vocabulary_warnings[0].canonical, 'Software Development');
});

test('search_leads: an unknown seniority is a warning, not a refusal (the engine matches loosely)', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /search\/database\/leads/, body: { data: { leads: [] }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(await tools.search_leads({ job_titles: ['CEO'], seniorities: ['Owner'] }, EXTRA));
  assert.ok(
    calls.some(c => /search/.test(c.url)),
    'the call still goes out',
  );
  assert.equal(r.vocabulary_warnings[0].field, 'seniorities');
  assert.ok(r.vocabulary_warnings[0].did_you_mean.includes('Owner / Partner'));
});

test('count_companies: a bad headcount bucket is caught locally instead of costing a 400 round trip', async () => {
  const { tools, calls } = harness([TIER_ROUTE]);
  const r = out(await tools.count_companies({ industries: ['Software Development'], headcounts: ['50-200'] }, EXTRA));
  assert.equal(r.status, 'not_sent');
  assert.ok(r.blocked_by_vocabulary[0].did_you_mean.includes('51-200'));
  assert.ok(!calls.some(c => /count/.test(c.url)));
});

// ---------------------------------------------------------------------------
// Spend ceiling
// ---------------------------------------------------------------------------

test('start_bulk_job: a 50-phone job is refused above the per-call ceiling, before the job exists', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /phone\/find\/bulk/, body: { data: null, meta: { job_id: 'j' } } },
  ]);
  const items = Array.from({ length: 50 }, (_, i) => ({ lead_id: `id-${i}` }));
  const r = out(await tools.start_bulk_job({ job_type: 'phone_find', items }, EXTRA));
  assert.equal(r.status, 'not_sent');
  assert.equal(r.spend_guard.worst_case_usd, 20, '50 x $0.40');
  assert.ok(!calls.some(c => /bulk/.test(c.url)), 'the cost is reserved at submit time — there is nothing to undo');
});

test('start_bulk_job: explicit confirm_spend_usd lets the same job through', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /phone\/find\/bulk/, body: { data: null, meta: { job_id: 'j' } } },
  ]);
  const items = Array.from({ length: 50 }, (_, i) => ({ lead_id: `id-${i}` }));
  const r = out(await tools.start_bulk_job({ job_type: 'phone_find', items, confirm_spend_usd: 20 }, EXTRA));
  assert.equal(r.submitted, 50);
  assert.ok(calls.some(c => /bulk/.test(c.url)));
});

// ---------------------------------------------------------------------------
// Endpoint coverage added in 0.8.x
// ---------------------------------------------------------------------------

test('count_leads: a realtime two-level count is explained, not requested (the endpoint does not exist)', async () => {
  const { tools, calls } = harness([TIER_ROUTE]);
  const r = out(
    await tools.count_leads(
      { job_titles: ['CEO'], company_filters: { industries: ['Software Development'] }, mode: 'realtime' },
      EXTRA,
    ),
  );
  assert.equal(r.mode, 'none');
  assert.match(r.why, /does not exist in the API/);
  assert.ok(!calls.some(c => /company-leads/.test(c.url)));
});

test('preview_leads: count_only uses the free preview count endpoint', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /preview\/leads\/count/, body: { data: { count: 49846 }, meta: { amount_charged: 0 } } },
  ]);
  const r = out(await tools.preview_leads({ job_titles: ['CEO'], count_only: true }, EXTRA));
  assert.equal(calls.find(c => /preview/.test(c.url))!.url, 'https://api.test/api/v1/preview/leads/count/');
  assert.equal(r.results_count, 49846);
  assert.equal(r.cost.amount_charged_usd, 0);
  assert.ok(!('count_only' in calls.find(c => /preview/.test(c.url))!.body.lead_search_criteria));
});

test('get_balance: usage and token analytics are fetched only when asked for', async () => {
  const { tools, calls } = harness([
    TIER_ROUTE,
    { match: /accounts\/me/, body: { data: { email: 'a@b.com', credits: { balance: 1 } } } },
    { match: /accounts\/usage/, body: { data: { period: '2026-09', total_credits: 10 } } },
    { match: /tokens\/analytics/, body: { data: { total_requests: 42, tokens: [] } } },
  ]);
  const plain = out(await tools.get_balance({}, EXTRA));
  assert.equal(plain.usage, undefined);
  assert.ok(!calls.some(c => /usage|analytics/.test(c.url)));

  const full = out(await tools.get_balance({ include_usage: true, include_token_analytics: true }, EXTRA));
  assert.equal(full.usage.total_credits, 10);
  assert.equal(full.token_analytics.total_requests, 42);
});

test('search_leads: next_page_args accumulates the ids already seen', async () => {
  const { tools } = harness([
    TIER_ROUTE,
    {
      match: /search\/database\/leads/,
      body: {
        data: {
          leads: [
            { ...LEAD_ROW, id: 'a' },
            { ...LEAD_ROW, id: 'b' },
          ],
        },
        meta: { amount_charged: 0.02 },
      },
    },
  ]);
  const r = out(await tools.search_leads({ job_titles: ['CEO'], exclude_ids: ['seen-1'] }, EXTRA));
  assert.deepEqual(r.next_page_args.exclude_ids, ['seen-1', 'a', 'b']);
});

// ---------------------------------------------------------------------------
// Protocol surface
// ---------------------------------------------------------------------------

test('tools are registered in the documented deterministic order', async () => {
  const order: string[] = [];
  const server: any = {
    registerTool: (name: string) => order.push(name),
  };
  registerTools(server, (async () => new Response('{}')) as any, 'https://api.test', '');
  assert.deepEqual(order, [...TOOL_ORDER], 'tools/list order must be stable for client + prompt caching');
});

test('every tool declares a title, annotations and an output schema', () => {
  for (const name of TOOL_ORDER) {
    const meta = TOOL_META[name];
    assert.ok(meta, `${name} has no metadata`);
    assert.ok(meta.title.length > 0, `${name} has no title`);
    assert.equal(typeof meta.annotations.openWorldHint, 'boolean', `${name} openWorldHint`);
    assert.ok(Object.keys(meta.outputSchema).length > 0, `${name} has an empty output schema`);
  }
});

test('only webhook management is declared as write/destructive', () => {
  const writers = TOOL_ORDER.filter(n => TOOL_META[n].annotations.readOnlyHint === false);
  assert.deepEqual(writers, ['manage_webhooks']);
  assert.equal(TOOL_META.manage_webhooks.annotations.destructiveHint, true);
});

test('idempotency is only claimed for tools that cannot charge', () => {
  const idempotent = TOOL_ORDER.filter(n => TOOL_META[n].annotations.idempotentHint === true);
  assert.deepEqual(idempotent.sort(), ['count_companies', 'count_leads', 'get_balance', 'get_bulk_job', 'health']);
});

test("every successful payload validates against the tool's own output schema", async () => {
  // The SDK validates structuredContent against outputSchema on every call and
  // turns a mismatch into a hard protocol error, so a schema that is wrong
  // breaks a working tool. This asserts the two agree.
  const GENERIC = [
    TIER_ROUTE,
    { match: /accounts\/me/, body: { data: { email: 'a@b.com', credits: { balance: 5 }, preview_tier: true } } },
    { match: /accounts\/usage/, body: { data: { period: '2026-09' } } },
    { match: /tokens\/analytics/, body: { data: { total_requests: 0, tokens: [] } } },
    { match: /count/, body: { data: { results_count: 5, count: 5 }, meta: { amount_charged: 0 } } },
    { match: /preview\/leads/, body: { data: { leads: [LEAD_ROW] }, meta: { amount_charged: 0.002 } } },
    {
      match: /search\/database\/companies/,
      body: { data: { companies: [{ id: '1', name: 'X' }] }, meta: { amount_charged: 0.01 } },
    },
    {
      match: /search\/database/,
      body: { data: { leads: [LEAD_ROW], results_count: 9 }, meta: { amount_charged: 0.01 } },
    },
    { match: /enrich\//, body: { data: LEAD_ROW, meta: { amount_charged: 0.01 } } },
    {
      match: /email\/validate/,
      body: { data: [{ email: 'a@b.com', result: 'valid' }], meta: { amount_charged: 0.005 } },
    },
    { match: /email\/find\/bulk/, body: { data: null, meta: { job_id: 'j', status: 'pending' } } },
    { match: /email\/find/, body: { data: { email: 'a@b.com' }, meta: { amount_charged: 0.02 } } },
    { match: /phone\/find\/bulk/, body: { data: null, meta: { job_id: 'j' } } },
    { match: /phone\/find/, body: { data: { phone: '+1' }, meta: { amount_charged: 0.4 } } },
    { match: /profile\/resolve/, body: { data: { id: 'ACwAAA1' }, meta: { amount_charged: 0.0005 } } },
    { match: /webhooks/, body: { data: [] } },
    { match: /bulk\//, body: { data: [], meta: { status: 'completed' } } },
  ];
  const ARGS: Record<string, any> = {
    count_leads: { job_titles: ['CEO'] },
    count_companies: { industries: ['Software Development'] },
    get_balance: { include_usage: true, include_token_analytics: true, include_transactions: 5 },
    health: {},
    preview_leads: { job_titles: ['CEO'] },
    search_leads: { job_titles: ['CEO'] },
    search_companies: { industries: ['Software Development'] },
    resolve_profile: { url: 'https://www.linkedin.com/in/ACwAAA1' },
    enrich_lead: { id: 'ACwAAA1' },
    enrich_company: { domain: 'stripe.com' },
    get_lead_by_url: { url: 'https://linkedin.com/in/x' },
    generate_email: { lead_id: 'ACwAAA1' },
    validate_email: { emails: ['a@b.com'] },
    find_phone: { lead_id: 'ACwAAA1' },
    start_bulk_job: { job_type: 'email_find', items: [{ lead_id: 'a' }] },
    get_bulk_job: { job_type: 'email_find', job_id: 'j' },
    manage_webhooks: { action: 'list' },
  };
  const { tools } = harness(GENERIC as any);
  for (const name of TOOL_ORDER) {
    assert.ok(ARGS[name], `no probe args for ${name}`);
    const res: any = await tools[name](ARGS[name], EXTRA);
    if (res?.isError) continue; // the SDK skips validation on error results
    const schema = z.object(TOOL_META[name].outputSchema);
    const parsed = schema.safeParse(res.structuredContent);
    assert.ok(
      parsed.success,
      `${name} payload does not match its outputSchema: ${JSON.stringify(parsed.success ? {} : parsed.error.issues)}`,
    );
  }
});

test('a realtime search sends progress heartbeats when the client asked for them', async () => {
  const { tools } = harness([
    TIER_ROUTE,
    { match: /search\/realtime\/leads/, body: { data: { leads: [] }, meta: { amount_charged: 0 } } },
  ]);
  const sent: any[] = [];
  const extra = {
    ...EXTRA,
    _meta: { progressToken: 'tok-1' },
    sendNotification: async (n: any) => {
      sent.push(n);
    },
  };
  await tools.search_leads({ job_titles: ['CEO'], mode: 'realtime' }, extra);
  assert.ok(sent.length >= 1, 'expected at least a "started" progress notification');
  assert.equal(sent[0].method, 'notifications/progress');
  assert.equal(sent[0].params.progressToken, 'tok-1');
});

test('no progress notifications without a progress token', async () => {
  const { tools } = harness([
    TIER_ROUTE,
    { match: /search\/realtime\/leads/, body: { data: { leads: [] }, meta: { amount_charged: 0 } } },
  ]);
  const sent: any[] = [];
  const extra = { ...EXTRA, sendNotification: async (n: any) => void sent.push(n) };
  await tools.search_leads({ job_titles: ['CEO'], mode: 'realtime' }, extra);
  assert.equal(sent.length, 0);
});
