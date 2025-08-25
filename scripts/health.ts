import 'dotenv/config';

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';

function normalizeKey(k?: string) {
  if (!k) return '';
  return k.startsWith('Token ') ? k : `Token ${k}`;
}

async function post(path: string, body: unknown, key: string, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, json: JSON.parse(text) };
    } catch {
      return { ok: res.ok, status: res.status, text };
    }
  } finally {
    clearTimeout(id);
  }
}

async function main() {
  const key = normalizeKey(process.env.GENERECT_API_KEY || process.argv[2]);
  if (!key) {
    console.error('Provide API key as env GENERECT_API_KEY or first arg');
    process.exit(1);
  }

  console.log(`Health check against ${apiBase}`);

  // 1) leads by link (should be stable)
  try {
    const r1 = await post('/api/linkedin/leads/by_link/', { url: 'https://www.linkedin.com/in/satyanadella/' }, key, 60000);
    const ok = !!(r1 as any).json?.lead?.linkedin_url;
    console.log('by_link:', { ok, status: r1.status, url: (r1 as any).json?.lead?.linkedin_url ?? null });
  } catch (e) {
    console.log('by_link error:', String(e));
  }

  // 2) companies by icp (can be empty)
  try {
    const r2 = await post('/api/linkedin/companies/by_icp/', { keywords: ['Microsoft'], get_max_companies: true }, key, 60000);
    const amount = (r2 as any).json?.amount ?? 0;
    const count = ((r2 as any).json?.companies || []).length;
    console.log('companies_by_icp:', { status: r2.status, amount, count });
  } catch (e) {
    console.log('companies_by_icp error:', String(e));
  }

  // 3) leads by icp minimal check
  try {
    const r3 = await post('/api/linkedin/leads/by_icp/', { company_link: 'https://www.linkedin.com/company/microsoft/', limit: 1 }, key, 60000);
    const leads = (r3 as any).json?.leads || [];
    console.log('leads_by_icp:', { status: r3.status, count: leads.length, sample: leads[0]?.linkedin_url ?? null });
  } catch (e) {
    console.log('leads_by_icp error:', String(e));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


