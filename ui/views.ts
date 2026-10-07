// Pure views: tool data in, HTML string out. No DOM, no host calls, so every
// view is unit-testable in Node (test/ui-views.test.ts). Everything that came
// from the API or the model goes through esc(): a lead's name is untrusted text.

export type ViewKind = 'audience' | 'leads' | 'companies' | 'profile' | 'balance' | 'emails' | 'unknown';

export const VIEW_BY_TOOL: Record<string, ViewKind> = {
  count_leads: 'audience',
  count_companies: 'audience',
  search_leads: 'leads',
  preview_leads: 'leads',
  search_companies: 'companies',
  enrich_lead: 'profile',
  get_lead_by_url: 'profile',
  enrich_company: 'profile',
  get_balance: 'balance',
  generate_email: 'emails',
};

/** Which view a result gets: the tool's own, else whatever its payload looks like. */
export function viewFor(toolName: string | undefined, data: any): ViewKind {
  if (toolName && VIEW_BY_TOOL[toolName]) return VIEW_BY_TOOL[toolName];
  if (!data || typeof data !== 'object') return 'unknown';
  if (Array.isArray(data.leads)) return 'leads';
  if (Array.isArray(data.companies)) return 'companies';
  if (data.lead || data.company) return 'profile';
  if ('balance_usd' in data) return 'balance';
  if (Array.isArray(data.results) && 'requested' in data) return 'emails';
  if ('results_count' in data) return 'audience';
  return 'unknown';
}

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface Fmt {
  locale?: string;
}

export function num(n: unknown, fmt: Fmt = {}): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat(fmt.locale || 'en-US').format(v);
}

export function usd(n: unknown, fmt: Fmt = {}): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '—';
  const digits = v !== 0 && Math.abs(v) < 0.1 ? 3 : 2;
  return new Intl.NumberFormat(fmt.locale || 'en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

export function initials(name: unknown): string {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="var(--g-accent)"/><path d="M15.8 9.2a4.6 4.6 0 1 0 .9 4.3h-4.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>`;

const EXPAND = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function header(title: string, sub: string, extra = ''): string {
  return `<div class="head">${MARK}<div><div class="title">${esc(title)}</div>${
    sub ? `<div class="sub">${esc(sub)}</div>` : ''
  }</div><div class="spacer"></div>${extra}</div>`;
}

/** Cost receipt as a badge: what this call actually charged. */
export function costBadge(data: any, fmt: Fmt = {}): string {
  const charged = data?.cost?.amount_charged_usd;
  if (data?.test_mode) return `<span class="badge warn">Test data · nothing charged</span>`;
  if (charged === 0) return `<span class="badge free">Free</span>`;
  if (typeof charged === 'number') return `<span class="badge paid">${esc(usd(charged, fmt))} charged</span>`;
  return '';
}

function modeLabel(mode: unknown): string {
  return mode === 'realtime' ? 'Live LinkedIn' : mode === 'database' ? 'Generect database' : '';
}

/** Filters the model sent, as readable chips. */
export function filterChips(args: any): string[] {
  if (!args || typeof args !== 'object') return [];
  const keys = [
    'job_titles',
    'seniorities',
    'functions',
    'locations',
    'company_names',
    'company_industries',
    'industries',
    'headcounts',
    'company_headcounts',
    'company_types',
    'keywords',
  ];
  const chips: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (Array.isArray(v)) chips.push(...v.map(String));
    else if (typeof v === 'string' && v) chips.push(v);
  }
  const nested = args.company_filters;
  if (nested && typeof nested === 'object') chips.push(...filterChips(nested));
  return chips.slice(0, 12);
}

function chipsHtml(args: any): string {
  const chips = filterChips(args);
  return chips.length
    ? `<div class="chips">${chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>`
    : '';
}

/** A problem the tool reported instead of data. Null when the payload is a normal result. */
export function problem(data: any): string | null {
  if (!data || typeof data !== 'object') return 'The tool returned nothing to show.';
  if (data.error) return [data.error, data.detail].filter(Boolean).map(String).join(': ');
  if (data.status === 'blocked' || data.blocked_by_vocabulary)
    return String(data.fix ?? 'Some filter values are not recognised.');
  // A count the server declined to run (no such count, or filters the free index lacks).
  if (data.mode === 'none' && data.results_count == null && data.why)
    return [data.why, Array.isArray(data.options) ? data.options[0] : null].filter(Boolean).map(String).join(' ');
  if (data.spend_guard && !data.leads && !data.companies)
    return String(data.spend_guard?.message ?? data.note ?? 'Above the spend ceiling.');
  return null;
}

function problemCard(title: string, message: string): string {
  return `${header(title, '')}<div class="note danger">${esc(message)}</div>`;
}

function testNote(data: any): string {
  return data?.test_mode
    ? `<div class="note warn">Fictional test data from a test key. These are not real people or companies.</div>`
    : '';
}

// ---------------------------------------------------------------------------
// Audience (count_leads / count_companies)
// ---------------------------------------------------------------------------
export function audienceView(toolName: string | undefined, args: any, data: any, fmt: Fmt = {}): string {
  const companies = toolName === 'count_companies';
  const noun = companies ? 'companies' : 'leads';
  const issue = problem(data);
  if (issue) return problemCard(`Audience size`, issue);

  const count = data.results_count;
  const est = data.next_step_estimate ?? {};
  const facts: string[] = [];
  if (data.mode === 'database')
    facts.push(fact(`First 25 ${noun}`, est.thin_search ? 'Free' : usd(est.search_cost_for?.['25_rows'], fmt)));
  else if (est.search_cost_for?.['25_rows'] != null)
    facts.push(fact(`First 25 ${noun}`, usd(est.search_cost_for['25_rows'], fmt)));
  if (!companies && est.email_usd_per_valid_email != null)
    facts.push(fact('Work email', `${usd(est.email_usd_per_valid_email, fmt)} / valid`));
  if (!companies && est.phone_usd_per_found_phone != null)
    facts.push(fact('Phone', `${usd(est.phone_usd_per_found_phone, fmt)} / found`));

  const zero = count === 0;
  const body = zero
    ? `<div class="hero">0</div><div class="hero-label">${esc(noun)} match these filters</div>${
        data.advice ? `<div class="note">${esc(data.advice)}</div>` : ''
      }`
    : `<div class="hero">${esc(num(count, fmt))}</div><div class="hero-label">${esc(noun)} match in the ${esc(
        modeLabel(data.mode) || 'index',
      )}</div>`;

  const action = zero
    ? ''
    : `<div class="actions"><button class="primary" data-action="show-results" data-kind="${noun}">Show the first 25</button></div>`;

  return `${header('Audience size', modeLabel(data.mode), costBadge(data, fmt))}${body}${chipsHtml(args)}${
    facts.length ? `<div class="facts">${facts.join('')}</div>` : ''
  }${testNote(data)}${action}`;
}

function fact(k: string, v: string): string {
  return `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
export interface LeadRow {
  id?: string | null;
  full_name?: string | null;
  job_title?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  industry?: string | null;
  location?: string | null;
  linkedin_url?: string | null;
}

export interface EmailState {
  [leadId: string]: { status: 'busy' | 'found' | 'miss' | 'error'; email?: string; note?: string };
}

export interface LeadsUi {
  fullscreen: boolean;
  /** The table shown inside the card: hosts without full screen, or one that refused it. */
  expanded?: boolean;
  canFullscreen: boolean;
  selected: Set<string>;
  filter: string;
  emails: EmailState;
  status?: string;
  /** maxUsd null: the account's price could not be read, so no figure is promised. */
  confirming?: { count: number; maxUsd: number | null } | null;
  busy?: boolean;
}

function leadMeta(l: LeadRow): string {
  return [l.job_title, l.company_name].filter(Boolean).join(' · ');
}

export function leadKey(l: LeadRow, i: number): string {
  return String(l.id ?? `row-${i}`);
}

function matches(l: LeadRow, filter: string): boolean {
  if (!filter) return true;
  const hay = [l.full_name, l.job_title, l.company_name, l.industry, l.location].join(' ').toLowerCase();
  return hay.includes(filter.toLowerCase());
}

export function leadsView(args: any, data: any, ui: LeadsUi, fmt: Fmt = {}): string {
  const issue = problem(data);
  if (issue) return problemCard('Leads', issue);
  const leads: LeadRow[] = Array.isArray(data.leads) ? data.leads : [];
  const total = data.results_count;
  const sub = `${num(leads.length, fmt)}${typeof total === 'number' ? ` of ${num(total, fmt)}` : ''} · ${
    modeLabel(data.mode) || 'Generect'
  }`;
  const expand =
    ui.canFullscreen && !ui.fullscreen
      ? `<button class="icon" data-action="fullscreen" aria-label="Open as a table">${EXPAND}</button>`
      : '';
  if (leads.length === 0) {
    return `${header('Leads', sub, costBadge(data, fmt))}<div class="note">No leads came back for these filters.</div>${chipsHtml(args)}`;
  }
  if (ui.fullscreen || ui.expanded) return leadsTable(leads, data, sub, ui, fmt);

  const shown = leads.slice(0, 5);
  const rows = shown
    .map(
      (l, i) =>
        `<div class="row"><div class="avatar">${esc(initials(l.full_name))}</div><div class="who"><div class="name">${esc(
          l.full_name ?? 'Unnamed',
        )}</div><div class="meta">${esc(leadMeta(l))}</div>${
          l.location ? `<div class="meta loc">${esc(l.location)}</div>` : ''
        }</div><div class="side">${esc(l.location ?? '')}</div></div>`,
    )
    .join('');
  const more =
    leads.length > shown.length
      ? `<div class="more">+${num(leads.length - shown.length, fmt)} more in this result</div>`
      : '';
  const actions = `<div class="actions">${
    ui.canFullscreen
      ? `<button class="primary" data-action="fullscreen">Open all ${num(leads.length, fmt)} as a table</button>`
      : ''
  }<button data-action="ask-emails">Find work emails</button></div>`;
  return `${header('Leads', sub, `${costBadge(data, fmt)}${expand}`)}<div class="rows">${rows}</div>${more}${testNote(data)}${actions}`;
}

function emailCell(state: EmailState[string] | undefined): string {
  if (!state) return '';
  if (state.status === 'busy') return `<span class="email-busy">Looking…</span>`;
  if (state.status === 'found') return `<span class="email-ok" title="${esc(state.email)}">${esc(state.email)}</span>`;
  if (state.status === 'miss') return `<span class="email-miss">Not found · free</span>`;
  return `<span class="email-miss">${esc(state.note ?? 'Failed')}</span>`;
}

function leadsTable(leads: LeadRow[], data: any, sub: string, ui: LeadsUi, fmt: Fmt): string {
  const visible = leads.map((l, i) => ({ l, key: leadKey(l, i) })).filter(({ l }) => matches(l, ui.filter));
  const allSelected = visible.length > 0 && visible.every(v => ui.selected.has(v.key));
  const body = visible
    .map(({ l, key }) => {
      const sel = ui.selected.has(key);
      return `<tr class="${sel ? 'selected' : ''}"><td class="check"><input type="checkbox" data-action="toggle" data-key="${esc(
        key,
      )}" ${sel ? 'checked' : ''} aria-label="Select ${esc(l.full_name ?? 'lead')}"></td><td>${esc(l.full_name ?? '')}</td><td>${esc(
        l.job_title ?? '',
      )}</td><td>${esc(l.company_name ?? '')}</td><td class="col-opt">${esc(l.industry ?? '')}</td><td class="col-opt">${esc(l.location ?? '')}</td><td>${emailCell(
        ui.emails[key],
      )}</td></tr>`;
    })
    .join('');
  const n = ui.selected.size;
  // What "Find emails" would actually look up: selected, not already found here.
  const todo = leads.filter(
    (l, i) => ui.selected.has(leadKey(l, i)) && ui.emails[leadKey(l, i)]?.status !== 'found',
  ).length;
  const confirm = ui.confirming;
  const barButtons = confirm
    ? `<button data-action="cancel-emails">Cancel</button><button class="primary" data-action="confirm-emails">${
        confirm.maxUsd == null
          ? `Confirm · ${esc(num(confirm.count, fmt))} people`
          : `Confirm · up to ${esc(usd(confirm.maxUsd, fmt))}`
      }</button>`
    : `<button data-action="download" ${leads.length ? '' : 'disabled'}>Download CSV</button><button class="primary" data-action="find-emails" ${
        todo === 0 || ui.busy ? 'disabled' : ''
      }>Find emails${todo ? ` for ${num(todo, fmt)}` : ''}</button>`;
  const status =
    ui.status ??
    (confirm
      ? confirm.maxUsd == null
        ? `Could not read your email price. You pay your plan's rate per valid email found, for up to ${num(confirm.count, fmt)} people; a miss is free.`
        : `You pay only for valid emails found, at most ${usd(confirm.maxUsd, fmt)} for ${num(confirm.count, fmt)} people.`
      : n
        ? `${num(n, fmt)} selected`
        : 'Select people to find their work emails');
  return `${header('Leads', sub, costBadge(data, fmt))}<div class="toolbar"><input type="search" data-action="filter" placeholder="Filter by name, title, company, place" value="${esc(
    ui.filter,
  )}" aria-label="Filter leads"></div><div class="table-wrap"><table><thead><tr><th class="check"><input type="checkbox" data-action="toggle-all" ${
    allSelected ? 'checked' : ''
  } aria-label="Select all shown"></th><th>Name</th><th>Title</th><th>Company</th><th class="col-opt">Industry</th><th class="col-opt">Location</th><th>Work email</th></tr></thead><tbody>${body}</tbody></table></div>${testNote(
    data,
  )}<div class="bar"><div class="status" role="status">${esc(status)}</div>${barButtons}</div>`;
}

/** CSV of the leads with any emails found in this view. RFC 4180 quoting. */
export function leadsCsv(leads: LeadRow[], emails: EmailState): string {
  const cols = [
    'full_name',
    'job_title',
    'company_name',
    'company_domain',
    'industry',
    'location',
    'linkedin_url',
    'work_email',
  ];
  const q = (v: unknown) => {
    const s = String(v ?? '');
    // A leading =,+,-,@ would run as a formula in Excel or Sheets.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [cols.join(',')];
  leads.forEach((l: any, i) => {
    const e = emails[leadKey(l, i)];
    lines.push(cols.map(c => q(c === 'work_email' ? (e?.status === 'found' ? e.email : '') : l[c])).join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------
export function companiesView(
  args: any,
  data: any,
  ui: { fullscreen: boolean; canFullscreen: boolean },
  fmt: Fmt = {},
): string {
  const issue = problem(data);
  if (issue) return problemCard('Companies', issue);
  const companies: any[] = Array.isArray(data.companies) ? data.companies : [];
  const total = data.results_count;
  const sub = `${num(companies.length, fmt)}${typeof total === 'number' ? ` of ${num(total, fmt)}` : ''} · ${
    modeLabel(data.mode) || 'Generect'
  }`;
  if (companies.length === 0) {
    return `${header('Companies', sub, costBadge(data, fmt))}<div class="note">No companies came back for these filters.</div>${chipsHtml(args)}`;
  }
  const size = (c: any) =>
    c.headcount_range ?? (c.headcount_exact != null ? `${num(c.headcount_exact, fmt)} people` : '');
  if (ui.fullscreen) {
    const body = companies
      .map(
        c =>
          `<tr><td>${esc(c.name ?? '')}</td><td>${esc(c.industry ?? '')}</td><td>${esc(size(c))}</td><td>${esc(
            c.location ?? '',
          )}</td><td>${esc(c.domain ?? '')}</td></tr>`,
      )
      .join('');
    return `${header('Companies', sub, costBadge(data, fmt))}<div class="table-wrap"><table><thead><tr><th>Name</th><th>Industry</th><th>Size</th><th>HQ</th><th>Domain</th></tr></thead><tbody>${body}</tbody></table></div>${testNote(
      data,
    )}<div class="bar"><div class="status">${esc(num(companies.length, fmt))} companies</div><button class="primary" data-action="people-at-companies">Find decision makers here</button></div>`;
  }
  const shown = companies.slice(0, 5);
  const rows = shown
    .map(
      c =>
        `<div class="row"><div class="avatar square">${esc(initials(c.name))}</div><div class="who"><div class="name">${esc(
          c.name ?? 'Unnamed',
        )}</div><div class="meta">${esc([c.industry, size(c)].filter(Boolean).join(' · '))}</div>${
          c.location ? `<div class="meta loc">${esc(c.location)}</div>` : ''
        }</div><div class="side">${esc(c.location ?? '')}</div></div>`,
    )
    .join('');
  const more =
    companies.length > shown.length
      ? `<div class="more">+${num(companies.length - shown.length, fmt)} more in this result</div>`
      : '';
  const expand = ui.canFullscreen
    ? `<button class="icon" data-action="fullscreen" aria-label="Open as a table">${EXPAND}</button>`
    : '';
  return `${header('Companies', sub, `${costBadge(data, fmt)}${expand}`)}<div class="rows">${rows}</div>${more}${testNote(
    data,
  )}<div class="actions"><button class="primary" data-action="people-at-companies">Find decision makers here</button>${
    ui.canFullscreen ? `<button data-action="fullscreen">Open as a table</button>` : ''
  }</div>`;
}

// ---------------------------------------------------------------------------
// Profile (enrich_lead / get_lead_by_url / enrich_company)
// ---------------------------------------------------------------------------
function pick(o: any, ...keys: string[]): any {
  for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k];
  return null;
}

function yearOf(d: unknown): string {
  if (!d) return '';
  const m = String(d).match(/\d{4}/);
  return m ? m[0] : '';
}

export function profileView(
  toolName: string | undefined,
  data: any,
  ui: { emailState?: EmailState[string]; confirm?: { usd: number | null } | null },
  fmt: Fmt = {},
): string {
  const issue = problem(data);
  if (issue) return problemCard('Profile', issue);
  if (data.found === false || (!data.lead && !data.company)) {
    return `${header('Profile', '', costBadge(data, fmt))}<div class="note">No record found. A miss is not charged.</div>`;
  }
  if (data.company || toolName === 'enrich_company') return companyProfile(data.company ?? {}, data, fmt);
  const l = data.lead ?? {};
  const name = pick(l, 'full_name', 'unformatted_full_name') ?? [l.first_name, l.last_name].filter(Boolean).join(' ');
  const title = pick(l, 'job_title', 'title', 'headline');
  const company = pick(l, 'company_name', 'raw_company_name');
  const location =
    pick(l, 'location', 'location_name') ?? ([l.location_city, l.location_country].filter(Boolean).join(', ') || null);
  const exps: any[] = (pick(l, 'experiences', 'experience', 'jobs') as any[]) ?? [];
  const timeline = Array.isArray(exps)
    ? exps
        .slice(0, 4)
        .map(e => {
          const span = [
            yearOf(e.start_date ?? e.starts_at ?? e.date_from),
            yearOf(e.end_date ?? e.ends_at ?? e.date_to) || 'now',
          ]
            .filter(Boolean)
            .join(' – ');
          return `<div class="row"><div class="avatar square">${esc(initials(e.company_name ?? e.company))}</div><div class="who"><div class="name">${esc(
            e.title ?? e.job_title ?? '',
          )}</div><div class="meta">${esc(e.company_name ?? e.company ?? '')}</div></div><div class="side">${esc(span)}</div></div>`;
        })
        .join('')
    : '';
  const email = ui.emailState;
  const emailLine =
    email?.status === 'found'
      ? `<div class="note success">Work email: ${esc(email.email)}</div>`
      : email?.status === 'miss'
        ? `<div class="note">No valid work email found. Nothing was charged.</div>`
        : email?.status === 'error'
          ? `<div class="note danger">${esc(email.note ?? 'Email lookup failed.')}</div>`
          : '';
  const rawLinkedin = pick(l, 'linkedin_url', 'linkedin_link');
  const linkedin = typeof rawLinkedin === 'string' && /^https?:\/\//i.test(rawLinkedin) ? rawLinkedin : null;
  const linkBtn = linkedin ? `<button data-action="open-link" data-url="${esc(linkedin)}">LinkedIn</button>` : '';
  // A paid action: the first click shows the price, only the second one spends.
  const confirm = ui.confirm;
  const actions = confirm
    ? `<div class="note">${
        confirm.usd == null
          ? "Could not read your email price. You pay your plan's rate only if a valid work email is found. A miss is free."
          : `You pay ${esc(usd(confirm.usd, fmt))} only if a valid work email is found. A miss is free.`
      }</div><div class="actions"><button class="primary" data-action="profile-confirm">${
        confirm.usd == null ? 'Confirm' : `Confirm · up to ${esc(usd(confirm.usd, fmt))}`
      }</button><button data-action="profile-cancel">Cancel</button></div>`
    : `<div class="actions"><button class="primary" data-action="profile-email" ${
        email?.status === 'busy' || email?.status === 'found' ? 'disabled' : ''
      }>${email?.status === 'busy' ? 'Looking…' : 'Find work email'}</button>${linkBtn}</div>`;
  return `${header('Profile', '', costBadge(data, fmt))}<div class="profile-head"><div class="avatar">${esc(initials(name))}</div><div class="who"><div class="name">${esc(
    name || 'Unnamed',
  )}</div><div class="meta">${esc([title, company].filter(Boolean).join(' · '))}</div>${
    location ? `<div class="meta">${esc(location)}</div>` : ''
  }</div></div>${timeline ? `<div class="section-title">Experience</div><div class="rows timeline">${timeline}</div>` : ''}${emailLine}${testNote(
    data,
  )}${actions}`;
}

function companyProfile(c: any, data: any, fmt: Fmt): string {
  const name = pick(c, 'name', 'company_name');
  const facts = [
    ['Industry', pick(c, 'industry', 'company_industry')],
    [
      'Size',
      pick(c, 'headcount_range') ?? (c.headcount_exact != null ? `${num(c.headcount_exact, fmt)} people` : null),
    ],
    ['HQ', pick(c, 'location') ?? ([c.hq_city, c.hq_country].filter(Boolean).join(', ') || null)],
    ['Founded', pick(c, 'founded_year', 'founded')],
  ]
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => fact(String(k), String(v)))
    .join('');
  const site = pick(c, 'website', 'domain');
  const url = site
    ? /^https?:\/\//i.test(String(site))
      ? String(site)
      : /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(site))
        ? `https://${site}`
        : null
    : null;
  return `${header('Company', '', costBadge(data, fmt))}<div class="profile-head"><div class="avatar square">${esc(
    initials(name),
  )}</div><div class="who"><div class="name">${esc(name ?? 'Unnamed')}</div><div class="meta">${esc(pick(c, 'domain') ?? '')}</div></div></div>${
    facts ? `<div class="facts">${facts}</div>` : ''
  }${testNote(data)}<div class="actions"><button class="primary" data-action="people-at-company" data-name="${esc(name ?? '')}">Find decision makers</button>${
    url ? `<button data-action="open-link" data-url="${esc(url)}">Website</button>` : ''
  }</div>`;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------
export function balanceView(data: any, fmt: Fmt = {}): string {
  const issue = problem(data);
  if (issue) return problemCard('Balance', issue);
  const p = data.your_prices_usd ?? {};
  const prices = [
    ['Thin search row', p.search_thin],
    ['Full row', p.search_database],
    ['Work email', p.email_find],
    ['Phone', p.phone_find],
  ]
    .filter(([, v]) => v != null)
    .map(([k, v]) => fact(String(k), Number(v) === 0 ? 'Free' : usd(v, fmt)))
    .join('');
  return `${header('Balance', data.email ? String(data.email) : '', costBadge(data, fmt))}<div class="hero">${esc(
    usd(data.balance_usd, fmt),
  )}</div><div class="hero-label">${
    data.used_this_month_usd != null ? `${esc(usd(data.used_this_month_usd, fmt))} used this month` : 'available'
  }</div>${prices ? `<div class="section-title">Your prices</div><div class="facts">${prices}</div>` : ''}${testNote(
    data,
  )}<div class="actions"><button data-action="open-link" data-url="https://app.generect.com/">Open Generect</button></div>`;
}

// ---------------------------------------------------------------------------
// Emails (generate_email)
// ---------------------------------------------------------------------------
/**
 * The verified address in one generate_email result, or null. The API reports it
 * as `valid_email` (null on a miss), and billing counts exactly the rows where it
 * is set, so that field decides; a bare `email` is only trusted when the result
 * has no `valid_email` key at all.
 */
export function emailOf(r: any): string | null {
  if (!r || typeof r !== 'object') return null;
  // Without `valid_email`, a bare `email` counts only when the lookup was billed:
  // "found" here must never say more than the invoice does.
  const e = 'valid_email' in r ? r.valid_email : Number(r.amount_charged_usd) > 0 ? r.email : null;
  return typeof e === 'string' && e.includes('@') ? e : null;
}

/** An API-supplied name, made safe to quote inside a chat message. */
export function quotedName(name: unknown): string {
  const clean = String(name ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["“”]/g, "'")
    .trim()
    .slice(0, 80);
  return `"${clean}"`;
}

export function emailsView(data: any, fmt: Fmt = {}): string {
  const issue = problem(data);
  if (issue && !Array.isArray(data?.results)) return problemCard('Work emails', issue);
  const results: any[] = Array.isArray(data?.results) ? data.results : data?.email ? [data] : [];
  const found = results.filter(emailOf).length;
  const rows = results
    .slice(0, 8)
    .map(r => {
      const who =
        [r.first_name ?? r.input?.first_name, r.last_name ?? r.input?.last_name].filter(Boolean).join(' ') ||
        r.input?.lead_id ||
        r.input?.linkedin_url ||
        'Lead';
      const e = emailOf(r);
      return `<div class="row"><div class="avatar">${esc(initials(who))}</div><div class="who"><div class="name">${esc(who)}</div><div class="meta">${
        e ? `<span class="email-ok">${esc(e)}</span>` : esc(r.error ? 'Lookup failed' : 'No valid email · free')
      }</div></div></div>`;
    })
    .join('');
  return `${header('Work emails', `${num(found, fmt)} of ${num(results.length, fmt)} found`, costBadge(data, fmt))}<div class="rows">${rows}</div>${
    results.length > 8 ? `<div class="more">+${num(results.length - 8, fmt)} more</div>` : ''
  }${testNote(data)}`;
}

// ---------------------------------------------------------------------------
// Loading skeletons, shown from tool-input until the result arrives
// ---------------------------------------------------------------------------
export function skeletonView(kind: ViewKind, args: any): string {
  const title =
    kind === 'audience'
      ? 'Sizing the audience'
      : kind === 'companies'
        ? 'Finding companies'
        : kind === 'leads'
          ? 'Finding leads'
          : 'Working';
  const lines =
    kind === 'leads' || kind === 'companies'
      ? Array.from(
          { length: 4 },
          () =>
            `<div class="row"><div class="avatar sk"></div><div class="who"><div class="sk line" style="width:45%"></div><div class="sk line" style="width:70%"></div></div></div>`,
        ).join('')
      : `<div class="sk hero"></div><div class="sk line" style="width:30%"></div>`;
  return `${header(title, '')}${kind === 'leads' || kind === 'companies' ? `<div class="rows">${lines}</div>` : lines}${chipsHtml(args)}`;
}
