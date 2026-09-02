import { createHash } from 'node:crypto';

// Every Generect operation an MCP tool can trigger, plus the two that never
// cost anything. Keeping them in one enum is what lets a tool description, a
// pre-flight estimate and a post-call receipt all speak about the same thing.
export type Operation =
  | 'count_database'
  | 'count_realtime'
  | 'search_database'
  | 'search_realtime'
  | 'enrich_database'
  | 'enrich_realtime'
  | 'preview'
  | 'email_find'
  | 'email_validate'
  | 'phone_find';

// Published Tier 0 prices (docs.generect.com/billing/pricing). These are the
// FALLBACK only. Real accounts sit on a discount tier and — as of 2026-08 — the
// live billing for cached search does not match the published Tier 0 number, so
// quoting these as if they were the truth is how an agent ends up lying to a
// user about spend. `fetchPriceBook` replaces them with the account's own rates
// whenever the tier endpoint is reachable.
const LIST_PRICE_USD: Record<Operation, number> = {
  count_database: 0,
  count_realtime: 0.02,
  search_database: 0.0067,
  search_realtime: 0.02,
  enrich_database: 0.0067,
  enrich_realtime: 0.02,
  preview: 0.002,
  email_find: 0.02,
  email_validate: 0.005,
  phone_find: 0.4,
};

// What one unit of billing means for each operation — the part agents get wrong
// most often (e.g. validation bills every address, not just the deliverable ones).
const BILLING_UNIT: Record<Operation, string> = {
  count_database: 'always free',
  count_realtime: 'flat, per request, even when the count is 0',
  search_database: 'per returned row (0 rows costs $0)',
  search_realtime: 'per returned row (0 rows costs $0)',
  enrich_database: 'per record found (not-found is refunded)',
  enrich_realtime: 'per record found (not-found is refunded)',
  preview: 'per returned row',
  email_find: 'per VALID email found (a miss is free)',
  email_validate: 'per email submitted — every address is billed, whatever the verdict',
  phone_find: 'per phone found (a miss is free)',
};

// Field names in the account tier endpoint -> our operations.
const TIER_FIELD_TO_OPS: Record<string, Operation[]> = {
  api_cached: ['search_database', 'enrich_database'],
  api_realtime: ['search_realtime', 'enrich_realtime', 'count_realtime'],
  api_preview: ['preview'],
  api_email_finder: ['email_find'],
  api_email_validation: ['email_validate'],
  phones: ['phone_find'],
};

export interface PriceBook {
  prices: Record<Operation, number>;
  /** true when the numbers came from the account's own tier, not the fallback list. */
  account_specific: boolean;
  tier?: string | null;
}

const FALLBACK_BOOK: PriceBook = { prices: { ...LIST_PRICE_USD }, account_specific: false, tier: null };

// Cache per credential (hashed — never keep the raw token around), because the
// price book is per account and changes only when a spend tier flips.
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { book: PriceBook; ts: number }>();

function keyFor(authorization: string): string {
  return createHash('sha256').update(authorization).digest('hex').slice(0, 32);
}

/** Test seam: drop memoized price books. */
export function resetPriceBookCache(): void {
  cache.clear();
}

export function round(amount: number): number {
  return Math.round(amount * 1e6) / 1e6;
}

/**
 * The account's real per-operation prices. Free to call and never fatal: if the
 * tier endpoint is unreachable we fall back to published list prices and say so,
 * so a pricing hiccup can never break an actual data call.
 */
export async function fetchPriceBook(
  fetcher: typeof fetch,
  apiBase: string,
  authorization: string,
  headers: Record<string, string>,
  timeoutMs = 15000,
): Promise<PriceBook> {
  const key = keyFor(authorization);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.book;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(`${apiBase}/api/auth/tiers/my-tier/`, {
      method: 'GET',
      headers: { ...headers, Authorization: authorization },
      signal: controller.signal,
    });
    if (!res.ok) return FALLBACK_BOOK;
    const data: any = await res.json();
    const svc = data?.current_tier?.service_prices;
    if (!svc || typeof svc !== 'object') return FALLBACK_BOOK;
    const prices = { ...LIST_PRICE_USD };
    for (const [field, ops] of Object.entries(TIER_FIELD_TO_OPS)) {
      const value = Number(svc[field]);
      if (Number.isFinite(value) && value >= 0) for (const op of ops) prices[op] = value;
    }
    prices.count_database = 0; // free by contract, whatever the tier says
    const book: PriceBook = { prices, account_specific: true, tier: data?.current_tier?.name ?? null };
    cache.set(key, { book, ts: Date.now() });
    return book;
  } catch {
    return FALLBACK_BOOK;
  } finally {
    clearTimeout(timer);
  }
}

/** Human-readable price tag for a tool description (uses list prices — descriptions are static). */
export function priceTag(op: Operation): string {
  const price = LIST_PRICE_USD[op];
  if (price === 0) return 'FREE — this call never spends credits.';
  return `BILLABLE — about $${price} ${BILLING_UNIT[op]} (Tier 0 list price; your account may pay a different rate — call get_balance for your real prices, and read cost.amount_charged in every response for what was actually spent).`;
}

export function billingUnit(op: Operation): string {
  return BILLING_UNIT[op];
}

/** Cost of `units` of `op` at this account's rate. */
export function estimate(book: PriceBook, op: Operation, units: number): number {
  return round((book.prices[op] ?? LIST_PRICE_USD[op]) * units);
}

/**
 * The receipt attached to every tool result. `amount_charged` is what the API
 * itself reports — never our own arithmetic — so an agent reporting spend to a
 * human is quoting the biller, not a guess.
 */
export function receipt(op: Operation, data: any): Record<string, unknown> {
  const raw = data?.meta?.amount_charged;
  const amount = typeof raw === 'number' ? round(raw) : null;
  return {
    operation: op,
    amount_charged_usd: amount,
    billed: BILLING_UNIT[op],
    ...(amount === null ? { note: 'The API did not report a charge for this call.' } : {}),
  };
}
