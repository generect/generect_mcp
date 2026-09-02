import 'dotenv/config';

// Probes which filters the cheap cached index actually supports, using only FREE
// count endpoints. The MCP routes database-vs-realtime off the API's own 400
// response rather than a hardcoded list, so this script exists to answer "did
// the supported set change?" without spending a cent to find out.

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';

function normalizeKey(k?: string) {
  if (!k) return '';
  return k.startsWith('Token ') ? k : `Token ${k}`;
}

async function count(kind: 'leads' | 'companies', body: unknown, key: string, timeoutMs = 120000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}/api/v1/search/database/${kind}/count/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key, 'User-Agent': 'generect-mcp-probe' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, json: JSON.parse(text) as any };
    } catch {
      return { ok: res.ok, status: res.status, json: undefined as any, text };
    }
  } finally {
    clearTimeout(id);
  }
}

const LEAD_BASE = { job_titles: ['marketing manager'], locations: ['Germany'] };
const COMPANY_BASE = { industries: ['Software Development'] };

const LEAD_PROBES: Array<[string, Record<string, unknown>]> = [
  ['seniorities', { seniorities: ['Director'] }],
  ['company_industries', { company_industries: ['Software Development'] }],
  ['company_headcounts', { company_headcounts: ['51-200'] }],
  ['company_types', { company_types: ['Privately Held'] }],
  ['exclude_names', { exclude_names: ['John Doe'] }],
  ['filter_empty_vars', { filter_empty_vars: ['profile_photo'] }],
  ['keywords', { keywords: ['growth'] }],
  ['functions', { functions: ['Marketing'] }],
  ['changed_jobs', { changed_jobs: true }],
  ['personas', { personas: [['MM', ['marketing manager'], [], []]] }],
];

const COMPANY_PROBES: Array<[string, Record<string, unknown>]> = [
  ['headcounts', { headcounts: ['51-200'] }],
  ['locations', { locations: ['Germany'] }],
  ['company_types', { company_types: ['Privately Held'] }],
  ['sub_industries', { sub_industries: true }],
  ['exclude_domains', { exclude_domains: ['stripe.com'] }],
  ['keywords', { keywords: ['fintech'] }],
  ['technologies', { technologies: ['Shopify'] }],
  ['company_names', { company_names: ['Stripe'] }],
  ['num_of_followers', { num_of_followers: ['1001-5000'] }],
  ['revenues_range', { revenues_range: { min: 1, max: 50 } }],
];

async function run(kind: 'leads' | 'companies', base: Record<string, unknown>, probes: Array<[string, any]>, key: string) {
  console.log(`\n--- ${kind}: which filters work in the free cached index ---`);
  let spent = 0;
  for (const [name, extra] of probes) {
    const r = await count(kind, { ...base, ...extra }, key);
    spent += Number(r.json?.meta?.amount_charged ?? 0);
    if (r.ok) {
      console.log(`  database  ${name.padEnd(20)} count=${r.json?.data?.results_count ?? '?'}`);
    } else {
      const detail = r.json?.detail?.[name] ?? JSON.stringify(r.json?.detail ?? r.text ?? '').slice(0, 120);
      const realtimeOnly = /not supported in database mode/i.test(String(detail));
      console.log(`  ${realtimeOnly ? 'REALTIME ' : 'ERROR    '} ${name.padEnd(20)} ${detail}`);
    }
  }
  return spent;
}

async function main() {
  const key = normalizeKey(process.env.GENERECT_API_KEY || process.argv[2]);
  if (!key) {
    console.error('Provide API key as env GENERECT_API_KEY or first arg');
    process.exit(1);
  }
  console.log(`Probe against ${apiBase} — free count endpoints only`);
  const spent = (await run('leads', LEAD_BASE, LEAD_PROBES, key)) + (await run('companies', COMPANY_BASE, COMPANY_PROBES, key));
  console.log(`\nTotal charged by this probe: $${spent} (expected: $0)`);
  if (spent !== 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
