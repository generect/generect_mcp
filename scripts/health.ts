import 'dotenv/config';

// Operational health check for the Generect API behind this MCP server.
// Every request here is FREE: account lookup, tier lookup and cached counts.
// A monitor that spends credits to prove the service is alive is a monitor that
// silently drains a customer's balance, so nothing in this script is billable.

const apiBase = process.env.GENERECT_API_BASE || 'https://api.generect.com';

function normalizeKey(k?: string) {
  if (!k) return '';
  return k.startsWith('Token ') ? k : `Token ${k}`;
}

async function request(path: string, key: string, body?: unknown, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: key,
        'User-Agent': 'generect-mcp-healthcheck',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

async function main() {
  const key = normalizeKey(process.env.GENERECT_API_KEY || process.argv[2]);
  if (!key) {
    console.error('Provide API key as env GENERECT_API_KEY or first arg');
    process.exit(1);
  }

  console.log(`Health check against ${apiBase} (all checks are free)`);
  let failures = 0;

  // 1) Credential + balance.
  const me = await request('/api/v1/accounts/me/', key);
  const account = me.json?.data;
  console.log('accounts/me:', {
    status: me.status,
    email: account?.email ?? null,
    balance: account?.credits?.balance ?? null,
  });
  if (!me.ok) failures += 1;

  // 2) Price book — also proves the tier endpoint the MCP quotes prices from.
  const tier = await request('/api/auth/tiers/my-tier/', key);
  console.log('tiers/my-tier:', {
    status: tier.status,
    tier: tier.json?.current_tier?.name ?? null,
    cached: tier.json?.current_tier?.service_prices?.api_cached ?? null,
  });
  if (!tier.ok) failures += 1;

  // 3) Free cached count — proves the search path end to end without billing.
  const count = await request('/api/v1/search/database/leads/count/', key, {
    job_titles: ['marketing manager'],
    locations: ['Germany'],
  });
  const charged = count.json?.meta?.amount_charged;
  console.log('search/database/leads/count:', {
    status: count.status,
    results_count: count.json?.data?.results_count ?? null,
    amount_charged: charged ?? null,
  });
  if (!count.ok) failures += 1;
  if (charged !== 0) {
    console.error(`FAIL: the cached count endpoint charged ${charged} — it is contractually free.`);
    failures += 1;
  }

  console.log(failures === 0 ? 'HEALTH: ok' : `HEALTH: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
