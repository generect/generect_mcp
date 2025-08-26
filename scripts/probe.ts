import 'dotenv/config';

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';

function normalizeKey(k?: string) {
  if (!k) return '';
  return k.startsWith('Token ') ? k : `Token ${k}`;
}

async function post(path: string, body: unknown, key: string, timeoutMs = 120000) {
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
      return { ok: res.ok, status: res.status, json: JSON.parse(text) } as const;
    } catch {
      return { ok: res.ok, status: res.status, text } as const;
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

  console.log(`Probe against ${apiBase}`);

  // 1) leads/by_link
  try {
    const r1 = await post('/api/linkedin/leads/by_link/', { url: 'https://www.linkedin.com/in/satyanadella/' }, key, 90000);
    const ok = !!(r1 as any).json?.lead?.linkedin_url;
    console.log('by_link:', { ok, status: r1.status, url: (r1 as any).json?.lead?.linkedin_url ?? null });
  } catch (e) {
    console.log('by_link error:', String(e));
  }

  // 2) companies/by_icp with keywords only
  try {
    const r2 = await post('/api/linkedin/companies/by_icp/', { keywords: ['Microsoft'], max_items: 3 }, key, 120000);
    const amount = (r2 as any).json?.amount ?? 0;
    const count = ((r2 as any).json?.companies || []).length;
    console.log('companies_by_icp_keywords:', { status: r2.status, amount, count });
  } catch (e) {
    console.log('companies_by_icp_keywords error:', String(e));
  }

  // 3) leads/by_icp minimal
  try {
    const r3 = await post('/api/linkedin/leads/by_icp/', { company_link: 'https://www.linkedin.com/company/microsoft/', limit: 1 }, key, 120000);
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


