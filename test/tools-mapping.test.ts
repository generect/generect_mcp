import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../src/tools.ts';

// Register the tools against a fake McpServer that just captures handlers, and a
// fake fetcher that records the request body and returns a scripted response.
// This exercises the real args -> Generect-API-body mapping end to end.
function harness(responses: any[] = [{ leads: [], amount: -0 }]) {
  const calls: Array<{ url: string; body: any }> = [];
  let i = 0;
  const fetcher = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const payload = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tools: Record<string, Function> = {};
  const server: any = { tool: (name: string, _d: string, _s: any, handler: Function) => (tools[name] = handler) };
  registerTools(server, fetcher as any, 'https://api.test', '');
  return { tools, calls };
}
const EXTRA = { requestInfo: { headers: { authorization: 'Token test-key' } } };

test('search_leads: job_titles -> OR persona with default exclusions; without_company auto-on; limit clamps', async () => {
  const { tools, calls } = harness();
  await tools.search_leads({ job_titles: ['CEO', 'Founder'], locations: ['United States'] }, EXTRA);
  const b = calls[0].body;
  assert.equal(calls[0].url, 'https://api.test/api/linkedin/leads/by_icp/');
  assert.deepEqual(b.personas, [
    ['Target titles (2)', ['CEO', 'Founder'], [], ['assistant', 'intern', 'junior', 'student', 'trainee']],
  ]);
  assert.equal(b.without_company, true, 'auto-enabled when no company anchor');
  assert.equal(b.limit_by, 25, 'default clamp');
  assert.deepEqual(b.locations, ['United States']);
  assert.ok(!('job_titles' in b) && !('job_title' in b), 'builder fields not forwarded raw');
});

test('search_leads: single job_title builds a one-title persona', async () => {
  const { tools, calls } = harness();
  await tools.search_leads({ job_title: 'CTO' }, EXTRA);
  assert.deepEqual(calls[0].body.personas, [
    ['CTO', ['CTO'], [], ['assistant', 'intern', 'junior', 'student', 'trainee']],
  ]);
});

test('search_leads: exclude_title_keywords:[] disables exclusions', async () => {
  const { tools, calls } = harness();
  await tools.search_leads({ job_titles: ['CEO'], exclude_title_keywords: [] }, EXTRA);
  assert.deepEqual(calls[0].body.personas, [['CEO', ['CEO'], [], []]]);
});

test('search_leads: company_id anchor does NOT auto-enable without_company', async () => {
  const { tools, calls } = harness();
  await tools.search_leads({ job_title: 'Engineer', company_id: '123' }, EXTRA);
  assert.ok(!('without_company' in calls[0].body), 'anchored branch preserved');
  assert.equal(calls[0].body.company_id, '123');
});

test('search_leads: explicit without_company:false is respected even with no anchor', async () => {
  const { tools, calls } = harness();
  await tools.search_leads({ job_title: 'Engineer', without_company: false }, EXTRA);
  assert.equal(calls[0].body.without_company, false);
});

test('search_leads: limit_by over the cap is clamped to MAX (100)', async () => {
  const { tools, calls } = harness();
  await tools.search_leads({ job_title: 'CEO', limit_by: 500 }, EXTRA);
  assert.equal(calls[0].body.limit_by, 100);
});

test('search_leads: get_max_leads without limit still bounds rows fetched', async () => {
  const { tools, calls } = harness();
  await tools.search_leads({ job_title: 'CEO', get_max_leads: true }, EXTRA);
  assert.equal(calls[0].body.get_max_leads, true);
  assert.equal(calls[0].body.limit_by, 25, 'still clamped — no unbounded pull');
});

test('search_leads: raw personas passthrough overrides title building', async () => {
  const { tools, calls } = harness();
  const raw = [['Custom', ['a', 'b'], ['c'], ['d'], 1]];
  await tools.search_leads({ personas: raw, job_title: 'IGNORED' }, EXTRA);
  assert.deepEqual(calls[0].body.personas, raw);
});

test('search_leads: exclude_ids/functions/seniorities/company_headcounts forwarded', async () => {
  const { tools, calls } = harness();
  await tools.search_leads(
    {
      job_title: 'CEO',
      exclude_ids: ['1', 2],
      functions: ['Engineering'],
      seniorities: ['Director'],
      company_headcounts: ['201-500'],
    },
    EXTRA,
  );
  const b = calls[0].body;
  assert.deepEqual(b.exclude_ids, ['1', 2]);
  assert.deepEqual(b.functions, ['Engineering']);
  assert.deepEqual(b.seniorities, ['Director']);
  assert.deepEqual(b.company_headcounts, ['201-500']);
});

test('search_companies: fallback is OFF by default (no second query)', async () => {
  const { tools, calls } = harness([{ companies: [], amount: 0 }]);
  await tools.search_companies({ keywords: ['audit'], industries: ['Accounting'] }, EXTRA);
  assert.equal(calls.length, 1, 'no hidden leads query without fallback_from_leads:true');
  assert.equal(calls[0].body.limit_by, 25);
});

test('search_companies: fallback_from_leads:true derives labeled leads_derived companies', async () => {
  const { tools } = harness([
    { companies: [], amount: 0 },
    { leads: [{ company_name: 'Acme' }, { company_name: 'Acme' }, { company_name: 'Beta' }] },
  ]);
  const res = await tools.search_companies({ keywords: ['x'], fallback_from_leads: true }, EXTRA);
  const out = res.structuredContent.companies;
  assert.equal(out[0].name, 'Acme');
  assert.equal(out[0].occurrences_in_leads, 2);
  assert.equal(out[0].source, 'leads_derived', 'derived companies are labeled, not passed as real records');
});

test('generate_email: single person -> one-candidate array', async () => {
  const { tools, calls } = harness([[{ result: 'valid' }]]);
  await tools.generate_email({ first_name: 'A', last_name: 'B', domain: 'x.com', middle_name: 'M' }, EXTRA);
  assert.equal(calls[0].url, 'https://api.test/api/linkedin/email_finder/');
  assert.deepEqual(calls[0].body, [{ first_name: 'A', last_name: 'B', middle_name: 'M', domain: 'x.com' }]);
});

test('generate_email: batch candidates passed through', async () => {
  const { tools, calls } = harness([[{ result: 'valid' }, { result: 'invalid' }]]);
  const cands = [
    { first_name: 'A', last_name: 'B', domain: 'x.com' },
    { first_name: 'C', last_name: 'D', domain: 'y.com' },
  ];
  await tools.generate_email({ candidates: cands }, EXTRA);
  assert.deepEqual(calls[0].body, cands);
});

test('generate_email: missing fields returns an error without calling the API', async () => {
  const { tools, calls } = harness();
  const res = await tools.generate_email({ first_name: 'OnlyFirst' }, EXTRA);
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0, 'no API call on invalid input');
});

test('health: default is cheap (no API call)', async () => {
  const { tools, calls } = harness();
  const res = await tools.health({}, EXTRA);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.server, 'up');
  assert.equal(body.has_credential, true);
  assert.equal(calls.length, 0, 'default health spends no credit');
});

test('health: deep:true probes the API', async () => {
  const { tools, calls } = harness([{ lead: { linkedin_url: 'https://linkedin.com/in/x' } }]);
  const res = await tools.health({ deep: true }, EXTRA);
  const body = JSON.parse(res.content[0].text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/api/linkedin/leads/by_link/');
  assert.equal(body.ok, true);
  assert.equal(body.deep, true);
});
