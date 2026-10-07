// The Generect view inside an MCP host. One page serves every tool that has a
// view: the host tells us which tool ran (hostContext.toolInfo), we pick the
// view, and render the tool's own structuredContent. Actions either go back to
// the conversation (sendMessage: anything that needs Claude) or call one of our
// tools directly (callServerTool: a prepared action the user confirmed here).

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import {
  audienceView,
  balanceView,
  companiesView,
  emailOf,
  emailsView,
  leadKey,
  leadsCsv,
  leadsView,
  profileView,
  quotedName,
  skeletonView,
  viewFor,
  type EmailState,
  type LeadRow,
  type LeadsUi,
  type ViewKind,
} from './views.ts';

declare const __APP_VERSION__: string;

const EMAIL_BATCH = 10; // generate_email resolves up to 10 candidates in one synchronous call

const root = document.getElementById('app')!;

const state = {
  toolName: undefined as string | undefined,
  args: undefined as any,
  data: undefined as any,
  kind: 'unknown' as ViewKind,
  host: undefined as McpUiHostContext | undefined,
  leads: {
    fullscreen: false,
    canFullscreen: false,
    selected: new Set<string>(),
    filter: '',
    emails: {} as EmailState,
    status: undefined,
    confirming: null,
    busy: false,
  } as LeadsUi,
  profileEmail: undefined as EmailState[string] | undefined,
  /** Set while the profile card shows its price (null: unknown) and waits for a second click. */
  profileConfirm: null as { usd: number | null } | null,
};

const app = new App(
  { name: 'Generect', version: __APP_VERSION__ },
  { availableDisplayModes: ['inline', 'fullscreen'] },
);

function fmt() {
  return { locale: state.host?.locale };
}

function applyHost(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  state.host = { ...state.host, ...ctx };
  const h = state.host;
  if (h.theme) applyDocumentTheme(h.theme);
  if (h.styles?.variables) applyHostStyleVariables(h.styles.variables);
  if (h.styles?.css?.fonts) applyHostFonts(h.styles.css.fonts);
  const inset = h.safeAreaInsets;
  if (inset) {
    const s = document.documentElement.style;
    s.setProperty('--g-safe-top', `${inset.top ?? 0}px`);
    s.setProperty('--g-safe-right', `${inset.right ?? 0}px`);
    s.setProperty('--g-safe-bottom', `${inset.bottom ?? 0}px`);
    s.setProperty('--g-safe-left', `${inset.left ?? 0}px`);
  }
  const full = h.displayMode === 'fullscreen';
  state.leads.fullscreen = full;
  document.documentElement.classList.toggle('fullscreen', full);
  state.leads.canFullscreen = (h.availableDisplayModes ?? []).includes('fullscreen');
  if (h.toolInfo?.tool?.name) state.toolName = h.toolInfo.tool.name;
}

function render() {
  const f = fmt();
  const active = document.activeElement as HTMLInputElement | null;
  const refocusFilter = active?.dataset?.action === 'filter' ? active.selectionStart : null;
  let html: string;
  if (state.data === undefined) {
    html = skeletonView(
      viewFor(state.toolName, undefined) === 'unknown' ? 'unknown' : viewFor(state.toolName, undefined),
      state.args,
    );
  } else {
    switch (state.kind) {
      case 'audience':
        html = audienceView(state.toolName, state.args, state.data, f);
        break;
      case 'leads':
        html = leadsView(state.args, state.data, state.leads, f);
        break;
      case 'companies':
        html = companiesView(state.args, state.data, state.leads, f);
        break;
      case 'profile':
        html = profileView(
          state.toolName,
          state.data,
          { emailState: state.profileEmail, confirm: state.profileConfirm },
          f,
        );
        break;
      case 'balance':
        html = balanceView(state.data, f);
        break;
      case 'emails':
        html = emailsView(state.data, f);
        break;
      default:
        html = `<div class="note">Generect returned a result. The details are in the conversation.</div>`;
    }
  }
  root.innerHTML = html;
  if (refocusFilter !== null) {
    const input = root.querySelector<HTMLInputElement>('input[data-action="filter"]');
    if (input) {
      input.focus();
      input.setSelectionRange(refocusFilter, refocusFilter);
    }
  }
  // The download button only makes sense where the host can save files.
  if (!app.getHostCapabilities()?.downloadFile) root.querySelector('[data-action="download"]')?.remove();
}

function leads(): LeadRow[] {
  return Array.isArray(state.data?.leads) ? state.data.leads : [];
}

function say(text: string) {
  return app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }).catch(() => undefined);
}

function structured(result: any): any {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find?.((c: any) => c.type === 'text')?.text;
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** The identifier generate_email should resolve this row by, or null when there is none. */
function candidateFor(l: any): Record<string, string> | null {
  const url = typeof l.linkedin_url === 'string' && /^https?:\/\//i.test(l.linkedin_url) ? l.linkedin_url : null;
  // Database rows carry Generect lead ids. A live (realtime) row's `id` can be a
  // LinkedIn sales id instead, so those go by their LinkedIn URL first.
  if (url && state.data?.mode === 'realtime') return { linkedin_url: url };
  if (l.id) return { lead_id: String(l.id) };
  if (url) return { linkedin_url: url };
  if (l.first_name && l.last_name && l.company_domain)
    return { first_name: String(l.first_name), last_name: String(l.last_name), domain: String(l.company_domain) };
  return null;
}

/** The account's own price per valid email, or null when get_balance cannot say.
 * Never a guess: a list-price fallback could understate a pricier contract. */
async function emailPrice(): Promise<number | null> {
  try {
    const r = structured(await app.callServerTool({ name: 'get_balance', arguments: {} }));
    const p = Number(r?.your_prices_usd?.email_find);
    return Number.isFinite(p) && p >= 0 ? p : null;
  } catch {
    return null;
  }
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

// The server marks every test-key result (src/testmode.ts) so a model never takes
// fictional people for real ones. What this view reports to the model through
// updateModelContext bypasses that marker, so it has to carry it itself.
const TEST_PREFIX =
  'TEST MODE: these results came from a Generect test key and are fictional, generated by the sandbox. Do not present them as real people or use these addresses to contact anyone.\n';
const isTest = (...results: any[]) => Boolean(state.data?.test_mode) || results.some(r => r?.test_mode === true);

async function askForEmails() {
  const ui = state.leads;
  const all = leads();
  const keys = all.map((l, i) => leadKey(l, i)).filter(k => ui.selected.has(k));
  const eligible = keys.filter(k => {
    const i = all.findIndex((l, j) => leadKey(l, j) === k);
    return candidateFor(all[i]) && ui.emails[k]?.status !== 'found';
  });
  if (eligible.length === 0) {
    ui.status = 'Nothing to look up: these people already have an email here, or there is no id to look them up by.';
    render();
    return;
  }
  ui.status = 'Checking your price…';
  render();
  const price = await emailPrice();
  ui.status = undefined;
  ui.confirming = { count: eligible.length, maxUsd: price == null ? null : round(price * eligible.length) };
  render();
}

async function runEmails() {
  const ui = state.leads;
  const all = leads();
  ui.confirming = null;
  ui.busy = true;
  const todo = all
    .map((l, i) => ({ l, key: leadKey(l, i), cand: candidateFor(l) }))
    .filter(x => ui.selected.has(x.key) && x.cand && ui.emails[x.key]?.status !== 'found');
  for (const t of todo) ui.emails[t.key] = { status: 'busy' };
  let charged = 0;
  let done = 0;
  let stopped = false;
  let test = isTest();
  for (let i = 0; i < todo.length; i += EMAIL_BATCH) {
    const batch = todo.slice(i, i + EMAIL_BATCH);
    ui.status = `Finding emails… ${done} of ${todo.length}`;
    render();
    try {
      const r = structured(
        await app.callServerTool({
          name: 'generate_email',
          // At most EMAIL_BATCH people per call: the user confirmed the maximum for all
          // of them a moment ago, and a miss is free.
          arguments: { candidates: batch.map(b => b.cand) },
        }),
      );
      const results: any[] = Array.isArray(r?.results) ? r.results : [];
      test = test || isTest(r);
      charged += Number(r?.cost?.amount_charged_usd) || 0;
      batch.forEach((b, j) => {
        const res = results[j];
        const e = emailOf(res);
        ui.emails[b.key] = e
          ? { status: 'found', email: e }
          : res?.error
            ? { status: 'error', note: res.status === 402 ? 'Out of credits' : 'Lookup failed' }
            : { status: 'miss' };
      });
      if (!results.length) {
        const why = r?.how_to_proceed ?? r?.error ?? 'The lookup was refused.';
        batch.forEach(b => (ui.emails[b.key] = { status: 'error', note: 'Refused' }));
        ui.status = String(why);
        stopped = true;
        break;
      }
    } catch (err: any) {
      batch.forEach(b => (ui.emails[b.key] = { status: 'error', note: 'Lookup failed' }));
      ui.status = `Stopped: ${err?.message ?? err}`;
      stopped = true;
      break;
    }
    done += batch.length;
  }
  ui.busy = false;
  const found = todo.filter(t => ui.emails[t.key]?.status === 'found');
  if (!stopped) {
    ui.status = `Found ${found.length} of ${todo.length} · charged ${new Intl.NumberFormat(fmt().locale || 'en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 3,
    }).format(charged)}${test ? ' · test data, fictional addresses' : ''}`;
  }
  render();
  // Tell Claude what happened here, so "write to them" works without re-asking.
  if (found.length) {
    const lines = found.map(
      t =>
        `- ${t.l.full_name ?? 'Lead'} (${t.l.job_title ?? ''}, ${t.l.company_name ?? ''}): ${ui.emails[t.key].email}`,
    );
    await app
      .updateModelContext({
        content: [
          {
            type: 'text',
            text: `${test ? TEST_PREFIX : ''}In the Generect leads table the user looked up work emails for ${todo.length} people; ${found.length} were found, $${round(
              charged,
            )} charged.\n${lines.join('\n')}`,
          },
        ],
      })
      .catch(() => undefined);
  }
}

/** The profile's identifier for generate_email: its LinkedIn URL first (an enriched
 * record's `id` can be a LinkedIn sales id rather than a Generect lead id). */
function profileCandidate(): Record<string, string> | null {
  const l = state.data?.lead ?? {};
  if (typeof l.linkedin_url === 'string' && /^https?:\/\//i.test(l.linkedin_url))
    return { linkedin_url: l.linkedin_url };
  return candidateFor({ id: l.lead_id ?? l.id, first_name: l.first_name, last_name: l.last_name });
}

/** First click: show what a found email costs, and wait for the second. */
async function askProfileEmail() {
  if (!profileCandidate()) {
    state.profileEmail = { status: 'error', note: 'No identifier to look this person up by.' };
    render();
    return;
  }
  state.profileEmail = { status: 'busy' };
  render();
  const price = await emailPrice();
  state.profileEmail = undefined;
  state.profileConfirm = { usd: price == null ? null : round(price) };
  render();
}

async function profileEmail() {
  const l = state.data?.lead ?? {};
  state.profileConfirm = null;
  const cand = profileCandidate();
  if (!cand) {
    state.profileEmail = { status: 'error', note: 'No identifier to look this person up by.' };
    render();
    return;
  }
  state.profileEmail = { status: 'busy' };
  render();
  try {
    const r = structured(await app.callServerTool({ name: 'generate_email', arguments: cand }));
    const res = Array.isArray(r?.results) ? r.results[0] : r;
    const e = emailOf(res);
    state.profileEmail = e
      ? { status: 'found', email: e }
      : res?.error
        ? { status: 'error', note: String(res.error) }
        : { status: 'miss' };
    if (e) {
      await app
        .updateModelContext({
          content: [
            {
              type: 'text',
              text: `${isTest(r) ? TEST_PREFIX : ''}The user found ${l.full_name ?? 'this person'}'s work email in Generect: ${e}`,
            },
          ],
        })
        .catch(() => undefined);
    }
  } catch (err: any) {
    state.profileEmail = { status: 'error', note: String(err?.message ?? err) };
  }
  render();
}

async function download() {
  const csv = leadsCsv(leads(), state.leads.emails);
  await app
    .downloadFile({
      contents: [
        { type: 'resource', resource: { uri: 'file:///generect-leads.csv', mimeType: 'text/csv', text: csv } },
      ],
    })
    .catch(() => undefined);
}

async function fullscreen() {
  try {
    const r = await app.requestDisplayMode({ mode: 'fullscreen' });
    applyHost({ displayMode: r.mode });
  } catch {
    /* host refused; stay inline */
  }
  render();
}

root.addEventListener('click', async ev => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const ui = state.leads;
  switch (el.dataset.action) {
    case 'show-results':
      await say(`Show me the first 25 matching ${el.dataset.kind === 'companies' ? 'companies' : 'leads'}.`);
      break;
    case 'fullscreen':
      await fullscreen();
      break;
    case 'ask-emails':
      leads().forEach((l, i) => ui.selected.add(leadKey(l, i)));
      if (ui.canFullscreen) await fullscreen();
      // No full screen here (or the host refused it): the table and its confirm
      // step open inside the card instead, so the click is never a silent no-op.
      if (!ui.fullscreen) ui.expanded = true;
      await askForEmails();
      break;
    case 'find-emails':
      await askForEmails();
      break;
    case 'confirm-emails':
      await runEmails();
      break;
    case 'cancel-emails':
      ui.confirming = null;
      render();
      break;
    case 'download':
      await download();
      break;
    case 'people-at-companies': {
      const names = (state.data?.companies ?? [])
        .map((c: any) => c.name)
        .filter(Boolean)
        .slice(0, 25);
      // Names come from the API: quoted as data, never as free text in the user's voice.
      await say(
        `Find decision makers (director level and above) at these companies from the Generect results: ${names.map(quotedName).join(', ')}.`,
      );
      break;
    }
    case 'people-at-company':
      await say(`Find decision makers (director level and above) at the company ${quotedName(el.dataset.name)}.`);
      break;
    case 'profile-email':
      await askProfileEmail();
      break;
    case 'profile-confirm':
      await profileEmail();
      break;
    case 'profile-cancel':
      state.profileConfirm = null;
      render();
      break;
    case 'open-link': {
      // URLs here come from API data: only ever hand the host a web link.
      const url = el.dataset.url ?? '';
      if (/^https?:\/\//i.test(url)) await app.openLink({ url }).catch(() => undefined);
      break;
    }
  }
});

root.addEventListener('change', ev => {
  const el = ev.target as HTMLInputElement;
  const ui = state.leads;
  if (el.dataset.action === 'toggle' && el.dataset.key) {
    if (el.checked) ui.selected.add(el.dataset.key);
    else ui.selected.delete(el.dataset.key);
    ui.status = undefined;
    ui.confirming = null;
    render();
  } else if (el.dataset.action === 'toggle-all') {
    const f = ui.filter.toLowerCase();
    leads().forEach((l, i) => {
      const hay = [l.full_name, l.job_title, l.company_name, l.industry, l.location].join(' ').toLowerCase();
      if (!f || hay.includes(f)) {
        if (el.checked) ui.selected.add(leadKey(l, i));
        else ui.selected.delete(leadKey(l, i));
      }
    });
    ui.status = undefined;
    ui.confirming = null;
    render();
  }
});

root.addEventListener('input', ev => {
  const el = ev.target as HTMLInputElement;
  if (el.dataset.action === 'filter') {
    state.leads.filter = el.value;
    render();
  }
});

app.onhostcontextchanged = ctx => {
  applyHost(ctx);
  // The tool name can arrive after the result; pick the view again with it.
  if (state.data !== undefined) state.kind = viewFor(state.toolName, state.data);
  render();
};

app.ontoolinput = params => {
  state.args = params.arguments;
  render();
};

app.ontoolresult = result => {
  state.data = structured(result) ?? {};
  state.kind = viewFor(state.toolName, state.data);
  render();
};

app.ontoolcancelled = () => {
  root.innerHTML = `<div class="note">Cancelled. Nothing more will be fetched for this request.</div>`;
};

app.onteardown = async () => ({});

render();
app
  .connect()
  .then(() => {
    applyHost(app.getHostContext());
    render();
  })
  .catch(err => {
    root.innerHTML = `<div class="note danger">Could not connect to the chat host: ${String(err?.message ?? err)
      .replace(/</g, '&lt;')
      .slice(0, 200)}</div>`;
  });
