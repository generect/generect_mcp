#!/usr/bin/env node
// Preview the MCP Apps views in a Claude-styled stand-in host, and fail on any
// page error. Drives the real flows (open table, select, confirm, find emails)
// against canned tool answers; nothing reaches the Generect API.
//
//   npm run build:ui && npm run preview:ui [scenario...]   → ui/preview/shots/*.png
//
// Needs a Chromium: set CHROMIUM_PATH, or install one with `npx playwright install chromium`.
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname;
const HERE = new URL('./', import.meta.url).pathname;
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });

const hostJs = (
  await build({
    entryPoints: [join(REPO, 'ui/preview/host.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    platform: 'browser',
  })
).outputFiles[0].text;
writeFileSync(
  join(SHOTS, 'host.html'),
  `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:24px;font-family:system-ui;background:#faf9f5;color-scheme:light}
  body[data-theme=dark]{background:#262624;color-scheme:dark}
  .card{display:inline-block;background:transparent}
  </style></head><body><div id="stage"></div><script>${hostJs}</script></body></html>`,
);
const html = readFileSync(join(REPO, 'dist/ui/app.html'), 'utf8');

const sc = v => ({ structuredContent: v, content: [{ type: 'text', text: JSON.stringify(v) }] });
const LEADS = [
  ['Lena Hoffmann', 'Chief Technology Officer', 'Klarwerk', 'Software Development', 'Berlin, Germany'],
  ['Jonas Richter', 'CTO & Co-Founder', 'Parcelly', 'Logistics', 'Berlin, Germany'],
  ['Mira Petrović', 'CTO', 'Fintory', 'Financial Services', 'Berlin, Germany'],
  ['Tobias Wendt', 'Chief Technology Officer', 'Heliograph Labs', 'Biotechnology', 'Potsdam, Germany'],
  ['Aylin Demir', 'CTO', 'Stackbird', 'Software Development', 'Berlin, Germany'],
  ['Felix Brandt', 'VP Engineering & CTO', 'Nordlicht Energy', 'Renewables', 'Berlin, Germany'],
  ['Sofia Lindqvist', 'CTO', 'Gastrolab', 'Food & Beverages', 'Berlin, Germany'],
  ['Daniel Okafor', 'Chief Technology Officer', 'Mietly', 'Real Estate', 'Berlin, Germany'],
].map(([full_name, job_title, company_name, industry, location], i) => ({
  id: `ld_${1000 + i}`,
  full_name,
  job_title,
  company_name,
  company_domain: null,
  industry,
  location,
  linkedin_url: null,
}));
const ARGS = { job_titles: ['CTO'], locations: ['Berlin'], headcounts: ['11-50', '51-200'] };
const EST = {
  priced_at: 'your account tier 2',
  thin_search: 'free',
  search_usd_per_row: 0.0067,
  search_cost_for: { '10_rows': 0.067, '25_rows': 0.1675, '100_rows': 0.67 },
  email_usd_per_valid_email: 0.02,
  phone_usd_per_found_phone: 0.4,
};

const SCENARIOS = {
  audience: {
    toolName: 'count_leads',
    args: ARGS,
    result: sc({ results_count: 1284, mode: 'database', next_step_estimate: EST, cost: { amount_charged_usd: 0 } }),
  },
  'audience-dark': {
    theme: 'dark',
    toolName: 'count_leads',
    args: ARGS,
    result: sc({ results_count: 1284, mode: 'database', next_step_estimate: EST, cost: { amount_charged_usd: 0 } }),
  },
  'audience-zero': {
    toolName: 'count_leads',
    args: { job_titles: ['Chief Unicorn Officer'], locations: ['Lviv'] },
    result: sc({
      results_count: 0,
      mode: 'database',
      advice: 'Try a broader title (for example CEO or Founder) or drop the location.',
      next_step_estimate: EST,
      cost: { amount_charged_usd: 0 },
    }),
  },
  skeleton: { toolName: 'search_leads', args: ARGS },
  leads: {
    toolName: 'search_leads',
    args: ARGS,
    result: sc({ returned: 8, results_count: 1284, mode: 'database', leads: LEADS, cost: { amount_charged_usd: 0 } }),
  },
  'leads-dark': {
    theme: 'dark',
    toolName: 'search_leads',
    args: ARGS,
    result: sc({ returned: 8, results_count: 1284, mode: 'database', leads: LEADS, cost: { amount_charged_usd: 0 } }),
  },
  'leads-mobile': {
    width: 375,
    toolName: 'search_leads',
    args: ARGS,
    result: sc({ returned: 8, results_count: 1284, mode: 'database', leads: LEADS, cost: { amount_charged_usd: 0 } }),
  },
  'leads-full': {
    width: 1100,
    height: 720,
    toolName: 'search_leads',
    args: ARGS,
    result: sc({ returned: 8, results_count: 1284, mode: 'database', leads: LEADS, cost: { amount_charged_usd: 0 } }),
    flow: 'emails',
  },
  // A host without full screen (the review's case): the confirm step must still appear.
  'leads-inline-only': {
    displayModes: ['inline'],
    toolName: 'search_leads',
    args: ARGS,
    result: sc({ returned: 8, results_count: 1284, mode: 'database', leads: LEADS, cost: { amount_charged_usd: 0 } }),
    flow: 'emails-inline',
  },
  // Live rows: `id` may be a LinkedIn sales id, so emails are looked up by LinkedIn URL.
  'leads-realtime': {
    width: 1100,
    height: 720,
    toolName: 'search_leads',
    args: { ...ARGS, mode: 'realtime' },
    result: sc({
      returned: 3,
      results_count: 3,
      mode: 'realtime',
      leads: LEADS.slice(0, 3).map(l => ({
        ...l,
        id: `ACwAA${l.id}`,
        linkedin_url: `https://www.linkedin.com/in/${l.id}`,
      })),
      cost: { amount_charged_usd: 0.06 },
    }),
    flow: 'emails-by-url',
  },
  // get_balance fails: the confirm step stays, with no dollar figure promised.
  'leads-no-price': {
    width: 1100,
    height: 720,
    balanceFails: true,
    toolName: 'search_leads',
    args: ARGS,
    result: sc({ returned: 8, results_count: 1284, mode: 'database', leads: LEADS, cost: { amount_charged_usd: 0 } }),
    flow: 'no-price',
  },
  'leads-list-price': {
    width: 1100,
    height: 720,
    listPricesOnly: true,
    toolName: 'search_leads',
    args: ARGS,
    result: sc({ returned: 8, results_count: 1284, mode: 'database', leads: LEADS, cost: { amount_charged_usd: 0 } }),
    flow: 'no-price',
  },
  'preview-count': {
    toolName: 'preview_leads',
    args: { ...ARGS, count_only: true },
    result: sc({ results_count: 12345, mode: 'preview', cost: { amount_charged_usd: 0 } }),
  },
  companies: {
    toolName: 'search_companies',
    args: { industries: ['Software Development'], locations: ['Berlin'] },
    result: sc({
      returned: 5,
      results_count: 3412,
      mode: 'database',
      cost: { amount_charged_usd: 0 },
      companies: [
        ['Klarwerk', 'Software Development', '51-200', 'Berlin, Germany', 'klarwerk.io'],
        ['Stackbird', 'Software Development', '11-50', 'Berlin, Germany', 'stackbird.dev'],
        ['Fintory', 'Financial Services', '201-500', 'Berlin, Germany', 'fintory.com'],
        ['Parcelly', 'Logistics', '51-200', 'Berlin, Germany', 'parcelly.de'],
        ['Mietly', 'Real Estate', '11-50', 'Berlin, Germany', 'mietly.de'],
        ['Gastrolab', 'Food & Beverages', '11-50', 'Berlin, Germany', 'gastrolab.co'],
      ].map(([name, industry, headcount_range, location, domain], i) => ({
        id: `co_${i}`,
        name,
        industry,
        headcount_range,
        location,
        domain,
      })),
    }),
  },
  profile: {
    toolName: 'enrich_lead',
    args: { linkedin_url: 'https://www.linkedin.com/in/lena-hoffmann' },
    result: sc({
      found: true,
      mode: 'database',
      cost: { amount_charged_usd: 0.0067 },
      lead: {
        id: 'ld_1000',
        full_name: 'Lena Hoffmann',
        job_title: 'Chief Technology Officer',
        company_name: 'Klarwerk',
        location: 'Berlin, Germany',
        linkedin_url: 'https://www.linkedin.com/in/lena-hoffmann',
        experiences: [
          { title: 'Chief Technology Officer', company_name: 'Klarwerk', start_date: '2022-03' },
          { title: 'Head of Platform', company_name: 'N26', start_date: '2018-06', end_date: '2022-02' },
          { title: 'Senior Engineer', company_name: 'Zalando', start_date: '2014-09', end_date: '2018-05' },
        ],
      },
    }),
    flow: 'profile-email',
  },
  balance: {
    toolName: 'get_balance',
    result: sc({
      email: 'you@example.com',
      balance_usd: 248.4,
      used_this_month_usd: 31.75,
      cost: { amount_charged_usd: 0 },
      your_prices_usd: { search_thin: 0, search_database: 0.0067, email_find: 0.02, phone_find: 0.4 },
    }),
  },
  // A test key: the emails found in the view must reach the model marked as fictional.
  'test-mode': {
    width: 1100,
    height: 640,
    testKey: true,
    toolName: 'search_leads',
    args: ARGS,
    result: sc({
      returned: 3,
      results_count: 3,
      mode: 'database',
      leads: LEADS.slice(0, 3),
      test_mode: true,
      cost: { amount_charged_usd: 0 },
    }),
    flow: 'emails',
  },
  'count-refused': {
    toolName: 'count_leads',
    args: { job_titles: ['CTO'], company_filters: { industries: ['Fintech'] }, mode: 'realtime' },
    result: sc({
      results_count: null,
      mode: 'none',
      why: 'A realtime count for a two-level (company + lead) ICP does not exist in the API.',
      options: ['Drop mode:"realtime" to get the free cached count.'],
      cost: { amount_charged_usd: 0 },
    }),
  },
  error: {
    toolName: 'search_leads',
    args: ARGS,
    result: sc({
      error: 'Generect API responded with 402',
      detail: 'Your balance is too low for this request. Nothing was charged.',
    }),
  },
};

const want = process.argv.slice(2);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failures = 0;
for (const [name, s] of Object.entries(SCENARIOS)) {
  if (want.length && !want.includes(name)) continue;
  const page = await browser.newPage({
    viewport: { width: (s.width ?? 720) + 48, height: (s.height ?? 900) + 48 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.stack || e).slice(0, 600)));
  page.on(
    'console',
    m =>
      m.type() === 'error' &&
      errors.push('console(' + (m.location()?.url || '').slice(0, 40) + '): ' + m.text().slice(0, 400)),
  );
  await page.exposeFunction('__callToolNode', async (tool, args) => {
    if (tool === 'get_balance') {
      if (s.balanceFails) throw new Error('get_balance unavailable');
      return sc({
        your_prices_usd: { email_find: 0.02 },
        prices_source: s.listPricesOnly ? 'published list prices (could not read the account tier)' : 'account tier 2',
        cost: { amount_charged_usd: 0 },
      });
    }
    if (tool === 'generate_email') {
      const cands = args.candidates ?? [args];
      const results = cands.map((c, i) => {
        const lead = LEADS.find(l => l.id === c.lead_id || (c.linkedin_url ?? '').endsWith(l.id)) ?? LEADS[0];
        const [first, ...rest] = lead.full_name.toLowerCase().split(' ');
        const ok = i % 4 !== 2;
        return ok
          ? {
              input: c,
              email: `${first}.${rest.join('')}@${lead.company_name.toLowerCase().replace(/\s+/g, '')}.com`,
              amount_charged_usd: 0.02,
            }
          : { input: c, amount_charged_usd: 0 };
      });
      return sc({
        ...(s.testKey ? { test_mode: true } : {}),
        requested: cands.length,
        cost: { amount_charged_usd: s.testKey ? 0 : results.reduce((a, r) => a + r.amount_charged_usd, 0) },
        results,
      });
    }
    return sc({});
  });
  await page.goto(`file://${join(SHOTS, 'host.html')}`);
  await page.evaluate(() => {
    window.__callTool = (n, a) => window.__callToolNode(n, a);
  });
  await page.evaluate(o => window.mount(o), { html, theme: 'light', ...s });
  const frame = page.frameLocator('iframe');
  await page.waitForTimeout(400);
  if (s.flow === 'emails') {
    await frame.getByRole('button', { name: /Open all/ }).click();
    await page.waitForTimeout(200);
    await frame.locator('input[data-action="toggle-all"]').check();
    await frame.getByRole('button', { name: /Find emails for/ }).click();
    await page.waitForTimeout(200);
    await page.locator('.card').screenshot({ path: join(SHOTS, `${name}-confirm.png`) });
    await frame.getByRole('button', { name: /Confirm/ }).click();
    await page.waitForTimeout(500);
  }
  if (s.flow === 'emails-inline') {
    await frame.getByRole('button', { name: /Find work emails/ }).click();
    await page.waitForTimeout(300);
    await page.locator('.card').screenshot({ path: join(SHOTS, `${name}-confirm.png`) });
    await frame.getByRole('button', { name: /Confirm/ }).click();
    await page.waitForTimeout(500);
  }
  if (s.flow === 'emails-by-url') {
    await frame.getByRole('button', { name: /Open all/ }).click();
    await page.waitForTimeout(200);
    await frame.locator('input[data-action="toggle-all"]').check();
    await frame.getByRole('button', { name: /Find emails for/ }).click();
    await page.waitForTimeout(200);
    await frame.getByRole('button', { name: /Confirm/ }).click();
    await page.waitForTimeout(400);
    const gen = await page.evaluate(
      () => window.__log.find(l => l.params?.name === 'generate_email')?.params?.arguments,
    );
    const keys = (gen?.candidates ?? []).map(c => Object.keys(c).join());
    if (keys.length !== 3 || keys.some(k => k !== 'linkedin_url'))
      errors.push(`realtime rows looked up by ${JSON.stringify(gen)}`);
  }
  if (s.flow === 'no-price') {
    await frame.getByRole('button', { name: /Open all/ }).click();
    await page.waitForTimeout(200);
    await frame.locator('input[data-action="toggle-all"]').check();
    await frame.getByRole('button', { name: /Find emails for/ }).click();
    await page.waitForTimeout(300);
    const label = await frame.locator('[data-action="confirm-emails"]').innerText();
    const status = await frame.locator('.bar .status').innerText();
    if (!/Confirm · 8 people/.test(label) || /\$/.test(label) || !/Could not read your email price/.test(status))
      errors.push(`no-price confirm wrong: "${label}" / "${status}"`);
    await page.locator('.card').screenshot({ path: join(SHOTS, `${name}-confirm.png`) });
  }
  if (s.flow === 'profile-email') {
    await frame.getByRole('button', { name: /Find work email/ }).click();
    await page.waitForTimeout(300);
    // Nothing paid yet: only the price was read.
    const before = await page.evaluate(() => window.__log.filter(l => l.type === 'tools/call').map(l => l.params.name));
    if (before.join() !== 'get_balance') errors.push(`profile spent before confirm: ${before}`);
    await page.locator('.card').screenshot({ path: join(SHOTS, `${name}-confirm.png`) });
    await frame.getByRole('button', { name: /Confirm/ }).click();
    await page.waitForTimeout(400);
    const gen = await page.evaluate(
      () => window.__log.find(l => l.params?.name === 'generate_email')?.params?.arguments,
    );
    if (gen?.linkedin_url !== 'https://www.linkedin.com/in/lena-hoffmann')
      errors.push(`profile looked up by ${JSON.stringify(gen)}`);
  }
  await page.locator('.card').screenshot({ path: join(SHOTS, `${name}.png`) });
  const full = await page.evaluate(() => window.__log);
  const log = full.map(l => l.type);
  if (s.flow === 'emails' || s.flow === 'emails-inline') {
    // The price is read before the confirm step, then ONE call per 10 people with the
    // confirmed ceiling, and Claude is told what was found.
    const calls = full.filter(l => l.type === 'tools/call').map(l => l.params);
    const gen = calls.find(c => c.name === 'generate_email');
    const context = full.find(l => l.type === 'ui/update-model-context')?.params?.content?.[0]?.text ?? '';
    const ok =
      calls[0]?.name === 'get_balance' &&
      gen?.arguments?.candidates?.map(c => c.lead_id).join() ===
        (s.testKey ? LEADS.slice(0, 3) : LEADS).map(l => l.id).join() &&
      Object.keys(gen?.arguments ?? {}).join() === 'candidates' &&
      (s.testKey ? /^TEST MODE/.test(context) : /6 were found/.test(context) && !/TEST MODE/.test(context));
    if (!ok) errors.push(`email flow payload wrong: ${JSON.stringify(calls).slice(0, 400)}`);
  }
  console.log(
    `${errors.length ? 'FAIL' : 'ok  '} ${name.padEnd(14)} log=[${log.join(',')}]${errors.length ? ' errors=' + errors.join(' | ') : ''}`,
  );
  if (errors.length) failures++;
  await page.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
