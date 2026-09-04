import {
  INDUSTRIES,
  SENIORITIES,
  FUNCTIONS,
  COMPANY_TYPES,
  HEADCOUNTS,
  FOLLOWER_RANGES,
  type IndustryNode,
} from './vocabulary.generated.js';

export { INDUSTRIES, SENIORITIES, FUNCTIONS, COMPANY_TYPES, HEADCOUNTS, FOLLOWER_RANGES };
export type { IndustryNode };

// ---------------------------------------------------------------------------
// Why this module exists
// ---------------------------------------------------------------------------
// Measured against the live API on 2026-09-04, the v1 search endpoints do NOT
// validate their filter values uniformly:
//
//   locations, company_headcounts, company_types  -> HTTP 400, naming the field
//   company_industries, seniorities               -> accepted, 0 results, $0
//
// The second row is the dangerous one. `company_industries: ["Fintech"]`
// (not a LinkedIn industry) and `["Software Developmen"]` (a typo) both come
// back as a perfectly successful count of ZERO. An agent reads that as "this
// audience does not exist", tells the user so, and either gives up or starts
// loosening *other* filters and paying for the wrong audience. There is no
// server-side guard to lean on, so the guard lives here.
//
// `seniorities` is deliberately treated more softly: the canonical Sales
// Navigator labels are below, but the engine also matches looser input —
// `["Owner"]` returned 772 leads where the canonical label is "Owner / Partner".
// So an unknown seniority is a warning, never a refusal.

const INDUSTRY_BY_NORMALIZED = new Map<string, IndustryNode>();
for (const node of INDUSTRIES) INDUSTRY_BY_NORMALIZED.set(normalize(node.name), node);

const INDUSTRY_NAMES = INDUSTRIES.map(i => i.name);

function dedupe(values: string[]): string[] {
  return [...new Set(values)].slice(0, 4);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Damerau-free Levenshtein, bounded — we only ever compare short label strings. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const row = [i, ...Array.from({ length: n }, () => 0)];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[n];
}

/**
 * Closest valid values for something the caller got wrong. Ranked by substring
 * containment first (a caller typing "software" wants "Software Development",
 * not the nearest edit-distance neighbour) and then by edit distance.
 */
export function suggest(value: string, vocabulary: readonly string[], limit = 4): string[] {
  const needle = normalize(value);
  if (!needle) return [];
  const scored = vocabulary.map(candidate => {
    const hay = normalize(candidate);
    const contains = hay.includes(needle) || needle.includes(hay);
    return { candidate, contains, dist: distance(needle, hay) };
  });
  return scored
    .sort((a, b) => (a.contains === b.contains ? a.dist - b.dist : a.contains ? -1 : 1))
    .filter(s => s.contains || s.dist <= Math.max(3, Math.ceil(needle.length / 3)))
    .slice(0, limit)
    .map(s => s.candidate);
}

/** Canonical spelling for a value the caller typed with different casing/punctuation. */
export function canonicalIndustry(value: string): string | null {
  return INDUSTRY_BY_NORMALIZED.get(normalize(value))?.name ?? null;
}

// ---------------------------------------------------------------------------
// Synonym hints
// ---------------------------------------------------------------------------
// Edit distance cannot get from "Fintech" to "Financial Services", yet that is
// the single most common way a sales-shaped request meets the LinkedIn
// taxonomy. These are HINTS ONLY: they are surfaced in `did_you_mean` and never
// substituted for what the caller asked for. Every target is asserted to exist
// in the generated vocabulary at module load, so a typo here fails the test
// suite instead of shipping a suggestion that is itself invalid.
const INDUSTRY_ALIASES: Record<string, string[]> = {
  fintech: ['Financial Services', 'Software Development'],
  saas: ['Software Development'],
  software: ['Software Development'],
  it: ['IT Services and IT Consulting', 'Software Development'],
  tech: ['Software Development', 'IT Services and IT Consulting'],
  ai: ['Software Development', 'Data Infrastructure and Analytics'],
  ml: ['Software Development', 'Data Infrastructure and Analytics'],
  crypto: ['Financial Services', 'Software Development'],
  web3: ['Financial Services', 'Software Development'],
  blockchain: ['Financial Services', 'Software Development'],
  insurtech: ['Insurance', 'Software Development'],
  proptech: ['Real Estate', 'Software Development'],
  edtech: ['Education', 'Software Development'],
  healthtech: ['Hospitals and Health Care', 'Software Development'],
  medtech: ['Medical Equipment Manufacturing', 'Hospitals and Health Care'],
  biotech: ['Biotechnology Research', 'Pharmaceutical Manufacturing'],
  healthcare: ['Hospitals and Health Care'],
  pharma: ['Pharmaceutical Manufacturing'],
  ecommerce: ['Retail', 'Software Development'],
  retail: ['Retail'],
  cybersecurity: ['Computer and Network Security'],
  security: ['Computer and Network Security'],
  martech: ['Advertising Services', 'Software Development'],
  marketing: ['Advertising Services', 'Marketing Services'],
  adtech: ['Advertising Services', 'Software Development'],
  hrtech: ['Human Resources Services', 'Software Development'],
  recruiting: ['Staffing and Recruiting'],
  staffing: ['Staffing and Recruiting'],
  consulting: ['Business Consulting and Services', 'IT Services and IT Consulting'],
  agency: ['Advertising Services', 'Business Consulting and Services'],
  logistics: ['Truck Transportation', 'Freight and Package Transportation'],
  manufacturing: ['Manufacturing'],
  gaming: ['Computer Games'],
  games: ['Computer Games'],
  media: ['Media Production', 'Broadcast Media Production and Distribution'],
  telecom: ['Telecommunications'],
  banking: ['Banking'],
  insurance: ['Insurance'],
  legal: ['Law Practice', 'Legal Services'],
  nonprofit: ['Non-profit Organizations', 'Civic and Social Organizations'],
  government: ['Government Administration'],
  energy: ['Oil and Gas', 'Renewable Energy Power Generation'],
  construction: ['Construction'],
  hospitality: ['Hospitality'],
  automotive: ['Motor Vehicle Manufacturing'],
  aerospace: ['Aviation and Aerospace Component Manufacturing'],
  defense: ['Defense and Space Manufacturing'],
  travel: ['Travel Arrangements'],
  food: ['Food and Beverage Services', 'Food and Beverage Manufacturing'],
  agriculture: ['Farming'],
  mining: ['Metal Ore Mining'],
  logistic: ['Truck Transportation'],
};

const SENIORITY_ALIASES: Record<string, string[]> = {
  'c level': ['CXO'],
  'c suite': ['CXO'],
  clevel: ['CXO'],
  csuite: ['CXO'],
  executive: ['CXO', 'Vice President'],
  ceo: ['CXO'],
  cto: ['CXO'],
  cfo: ['CXO'],
  chief: ['CXO'],
  vp: ['Vice President'],
  svp: ['Vice President'],
  evp: ['Vice President'],
  head: ['Director', 'Vice President'],
  lead: ['Experienced Manager', 'Senior'],
  founder: ['Owner / Partner'],
  owner: ['Owner / Partner'],
  partner: ['Owner / Partner'],
  manager: ['Entry Level Manager', 'Experienced Manager'],
  senior: ['Senior'],
  junior: ['Entry Level'],
  intern: ['In Training'],
  ic: ['Senior', 'Entry Level'],
};

const FUNCTION_ALIASES: Record<string, string[]> = {
  growth: ['Marketing', 'Business Development'],
  sales: ['Sales', 'Business Development'],
  bizdev: ['Business Development'],
  revops: ['Operations', 'Sales'],
  devops: ['Engineering', 'Information Technology'],
  it: ['Information Technology'],
  engineering: ['Engineering'],
  dev: ['Engineering'],
  data: ['Engineering', 'Research'],
  product: ['Product Management'],
  design: ['Arts and Design'],
  hr: ['Human Resources'],
  people: ['Human Resources'],
  talent: ['Human Resources'],
  finance: ['Finance', 'Accounting'],
  support: ['Customer Success and Support'],
  cs: ['Customer Success and Support'],
  success: ['Customer Success and Support'],
  ops: ['Operations'],
  procurement: ['Purchasing'],
  qa: ['Quality Assurance'],
  legal: ['Legal'],
  marketing: ['Marketing'],
  pr: ['Media and Communication'],
  comms: ['Media and Communication'],
};

const ALIAS_TABLES: Record<string, Record<string, string[]>> = {
  industry: INDUSTRY_ALIASES,
  seniority: SENIORITY_ALIASES,
  function: FUNCTION_ALIASES,
};

/**
 * Fails loudly at import time if an alias points at something that is not in
 * the vocabulary — a suggestion the API would also reject is worse than none.
 */
function assertAliasTargetsExist(): void {
  const pools: Record<string, Set<string>> = {
    industry: new Set(INDUSTRIES.map(i => i.name)),
    seniority: new Set(SENIORITIES),
    function: new Set(FUNCTIONS),
  };
  const bad: string[] = [];
  for (const [kind, table] of Object.entries(ALIAS_TABLES)) {
    for (const [alias, targets] of Object.entries(table)) {
      for (const target of targets) {
        if (!pools[kind].has(target)) bad.push(`${kind}.${alias} -> "${target}"`);
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(`vocabulary alias targets not present in the generated vocabulary: ${bad.join('; ')}`);
  }
}
assertAliasTargetsExist();

function aliasHints(kind: 'industry' | 'seniority' | 'function', value: string): string[] {
  const key = normalize(value);
  const table = ALIAS_TABLES[kind];
  if (table[key]) return table[key];
  // Also match a single leading/trailing word, so "fintech companies" and
  // "b2b saas" still resolve.
  const words = key.split(' ').filter(Boolean);
  for (const word of words) if (table[word]) return table[word];
  return [];
}

export interface VocabularyProblem {
  field: string;
  value: string;
  /** 'blocking' — the API would silently return 0. 'warning' — it may still match. */
  severity: 'blocking' | 'warning';
  reason: string;
  did_you_mean: string[];
  /** Set when the value is right but spelled differently; callers may auto-correct. */
  canonical?: string;
}

const INDUSTRY_FIELDS = [
  'company_industries',
  'exclude_company_industries',
  'industries',
  'exclude_industries',
] as const;

const SOFT_FIELDS: Array<{ field: string; vocabulary: readonly string[]; label: string }> = [
  { field: 'seniorities', vocabulary: SENIORITIES, label: 'seniority' },
  { field: 'functions', vocabulary: FUNCTIONS, label: 'job function' },
  { field: 'num_of_followers', vocabulary: FOLLOWER_RANGES, label: 'follower range' },
];

const HARD_FIELDS: Array<{ field: string; vocabulary: readonly string[]; label: string }> = [
  { field: 'company_headcounts', vocabulary: HEADCOUNTS, label: 'headcount bucket' },
  { field: 'exclude_company_headcounts', vocabulary: HEADCOUNTS, label: 'headcount bucket' },
  { field: 'headcounts', vocabulary: HEADCOUNTS, label: 'headcount bucket' },
  { field: 'company_types', vocabulary: COMPANY_TYPES, label: 'company type' },
];

function valuesOf(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Checks filter values against the vocabularies the API will actually match on.
 * Runs BEFORE any request, so a bad value costs nothing and comes back with the
 * correct spelling instead of a plausible-looking zero.
 */
export function checkVocabulary(filters: Record<string, unknown> | undefined | null): VocabularyProblem[] {
  if (!filters) return [];
  const problems: VocabularyProblem[] = [];

  for (const field of INDUSTRY_FIELDS) {
    for (const value of valuesOf(filters[field])) {
      const canonical = canonicalIndustry(value);
      if (canonical === value) continue;
      if (canonical) {
        problems.push({
          field,
          value,
          severity: 'warning',
          reason: `"${value}" differs only in spelling from the LinkedIn industry "${canonical}"; matching is exact, so send the canonical name.`,
          did_you_mean: [canonical],
          canonical,
        });
        continue;
      }
      problems.push({
        field,
        value,
        severity: 'blocking',
        reason: `"${value}" is not a LinkedIn industry. The API does not reject unknown industries — it returns 0 results and charges nothing, which looks exactly like an empty audience. Nothing was sent.`,
        did_you_mean: dedupe([...aliasHints('industry', value), ...suggest(value, INDUSTRY_NAMES)]),
      });
    }
  }

  for (const { field, vocabulary, label } of HARD_FIELDS) {
    for (const value of valuesOf(filters[field])) {
      if (vocabulary.includes(value)) continue;
      problems.push({
        field,
        value,
        severity: 'blocking',
        reason: `"${value}" is not a valid ${label}; the API rejects it with HTTP 400. Nothing was sent.`,
        did_you_mean: suggest(value, vocabulary),
      });
    }
  }

  for (const { field, vocabulary, label } of SOFT_FIELDS) {
    for (const value of valuesOf(filters[field])) {
      if (vocabulary.includes(value)) continue;
      const kind = field === 'seniorities' ? 'seniority' : field === 'functions' ? 'function' : null;
      problems.push({
        field,
        value,
        severity: 'warning',
        reason: `"${value}" is not a canonical ${label}. The API accepts it without complaint and may match loosely or not at all — prefer a canonical value.`,
        did_you_mean: dedupe([...(kind ? aliasHints(kind, value) : []), ...suggest(value, vocabulary)]),
      });
    }
  }

  return problems;
}

/**
 * Rewrites values that were merely mis-spelled to their canonical form, IN
 * PLACE. In place because the request body is often already built from the same
 * filter object by the time we get here — and because leaving
 * "software development" as typed would produce the very silent zero this
 * module exists to prevent, matching being exact.
 */
export function applyCanonicalizations(
  filters: Record<string, unknown> | undefined | null,
  problems: VocabularyProblem[],
): number {
  if (!filters) return 0;
  let fixed = 0;
  for (const problem of problems) {
    if (!problem.canonical) continue;
    const current = valuesOf(filters[problem.field]);
    if (!current.includes(problem.value)) continue;
    filters[problem.field] = current.map(v => (v === problem.value ? (problem.canonical as string) : v));
    fixed += 1;
  }
  return fixed;
}

/** Industries directly under `parent`, or the top level when parent is null. */
export function industryChildren(parent: string | null): string[] {
  return INDUSTRIES.filter(i => i.parent === parent).map(i => i.name);
}
