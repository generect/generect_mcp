import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { INDUSTRIES, SENIORITIES, FUNCTIONS, COMPANY_TYPES, HEADCOUNTS, FOLLOWER_RANGES } from './vocabulary.js';

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------
// Tool descriptions can only carry a sentence about valid values; there are 434
// industries. Exposing the vocabularies as resources lets a client read the
// exact list once, cache it, and stop guessing — which matters here because two
// of these filters are matched exactly and NOT validated by the API: a wrong
// industry or seniority comes back as a successful, free, empty result.
//
// Resources are free to read and touch no data endpoint.

const KINDS = {
  industries: {
    title: 'LinkedIn industries',
    describe: () =>
      'Every industry name the Generect API matches on, with its parent. Matching is exact and unknown names are NOT rejected — they silently return 0 results.',
    payload: () => ({ count: INDUSTRIES.length, exact_match_required: true, industries: INDUSTRIES }),
  },
  seniorities: {
    title: 'Seniority levels',
    describe: () =>
      'Canonical Sales Navigator seniority labels. The API does not validate this field: an unknown value is accepted and may match loosely or not at all.',
    payload: () => ({ count: SENIORITIES.length, validated_by_api: false, seniorities: SENIORITIES }),
  },
  functions: {
    title: 'Job functions (realtime only)',
    describe: () => 'Job functions. Realtime-only filter — using it forces the pricier live mode.',
    payload: () => ({ count: FUNCTIONS.length, realtime_only: true, functions: FUNCTIONS }),
  },
  'company-types': {
    title: 'Company types',
    describe: () => 'Company types. The API rejects an unknown value with HTTP 400.',
    payload: () => ({ count: COMPANY_TYPES.length, validated_by_api: true, company_types: COMPANY_TYPES }),
  },
  headcounts: {
    title: 'Headcount buckets',
    describe: () => 'Employee-count buckets. Exact strings; the API rejects anything else with HTTP 400.',
    payload: () => ({ count: HEADCOUNTS.length, validated_by_api: true, headcounts: HEADCOUNTS }),
  },
  'follower-ranges': {
    title: 'LinkedIn follower ranges',
    describe: () => 'Follower-count buckets for company search (realtime only).',
    payload: () => ({ count: FOLLOWER_RANGES.length, realtime_only: true, follower_ranges: FOLLOWER_RANGES }),
  },
} as const;

type Kind = keyof typeof KINDS;

function isKind(value: string): value is Kind {
  return Object.prototype.hasOwnProperty.call(KINDS, value);
}

function json(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
  };
}

export interface ResourceDeps {
  fetcher: typeof fetch;
  apiBase: string;
  /** Resolves the caller's `Authorization` header value, same as the tools do. */
  resolveAuthHeader: (extra: any) => Promise<string>;
  apiHeaders: (authorization: string) => Record<string, string>;
  priceBook: (authorization: string, headers: Record<string, string>) => Promise<any>;
}

export function registerResources(server: McpServer, deps: ResourceDeps): void {
  const register = (server as any).registerResource?.bind(server) ?? (server as any).resource?.bind(server);
  if (!register) return; // older SDK or a test double without resource support

  register(
    'generect-vocabulary',
    new ResourceTemplate('generect://vocabulary/{kind}', {
      list: async () => ({
        resources: (Object.keys(KINDS) as Kind[]).map(kind => ({
          uri: `generect://vocabulary/${kind}`,
          name: `generect-vocabulary-${kind}`,
          title: KINDS[kind].title,
          description: KINDS[kind].describe(),
          mimeType: 'application/json',
        })),
      }),
      complete: {
        kind: async (value: string) => (Object.keys(KINDS) as Kind[]).filter(k => k.startsWith(value.toLowerCase())),
      },
    }),
    {
      title: 'Generect filter vocabularies',
      description:
        'The exact values the Generect API matches on: industries, seniorities, functions, company types, headcount buckets, follower ranges. Read this instead of guessing — an unknown industry or seniority returns a successful, empty, free result rather than an error.',
      mimeType: 'application/json',
    },
    async (uri: URL, variables: Record<string, unknown>) => {
      const raw = String(Array.isArray(variables.kind) ? variables.kind[0] : (variables.kind ?? ''));
      if (!isKind(raw)) {
        return json(uri.href, {
          error: `Unknown vocabulary "${raw}".`,
          available: Object.keys(KINDS),
        });
      }
      const kind = KINDS[raw];
      return json(uri.href, { kind: raw, description: kind.describe(), ...kind.payload() });
    },
  );

  register(
    'generect-pricing',
    'generect://account/pricing',
    {
      title: 'Your per-operation prices',
      description:
        "This account's real price for every operation, read from its spend tier. These are the numbers to quote to a user — the prices in tool descriptions and in the public docs are list prices and have not always matched what is billed.",
      mimeType: 'application/json',
    },
    async (uri: URL, extra: any) => {
      try {
        const authorization = await deps.resolveAuthHeader(extra);
        const headers = deps.apiHeaders(authorization);
        const book = await deps.priceBook(authorization, headers);
        return json(uri.href, {
          prices_usd: book.prices,
          account_specific: book.account_specific,
          tier: book.tier ?? null,
          note: book.account_specific
            ? 'Read from this account tier.'
            : 'Could not read the account tier; these are published list prices.',
        });
      } catch (err) {
        return json(uri.href, { error: String(err) });
      }
    },
  );

  register(
    'generect-account',
    'generect://account/balance',
    {
      title: 'Account balance and month-to-date usage',
      description: 'Free read of the current balance, spend this month and Preview eligibility.',
      mimeType: 'application/json',
    },
    async (uri: URL, extra: any) => {
      try {
        const authorization = await deps.resolveAuthHeader(extra);
        const headers = deps.apiHeaders(authorization);
        const res = await deps.fetcher(`${deps.apiBase}/api/v1/accounts/me/`, { method: 'GET', headers });
        const data: any = await res.json();
        return json(uri.href, data?.data ?? data);
      } catch (err) {
        return json(uri.href, { error: String(err) });
      }
    },
  );
}
