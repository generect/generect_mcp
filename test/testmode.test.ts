import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../src/tools.ts';
import { resetPriceBookCache } from '../src/pricing.ts';
import { annotate, isTestCredential, isTestRequest, TEST_MODE_NOTICE } from '../src/testmode.ts';

const TIER = {
  current_tier: { name: '3', service_prices: { api_cached: 0.01, api_realtime: 0.04 } },
};

function harness() {
  resetPriceBookCache();
  const fetcher = async (url: string) => {
    const payload = /tiers\/my-tier/.test(url)
      ? TIER
      : {
          data: { leads: [{ full_name: 'Ada Testwell', company_name: 'Testly' }], results_count: 1 },
          meta: { amount_charged: 0.01 },
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-generect-mode': 'test' },
    });
  };
  const tools: Record<string, Function> = {};
  const server: any = { tool: (name: string, _d: string, _s: any, handler: Function) => (tools[name] = handler) };
  registerTools(server, fetcher as any, 'https://api.test', '');
  return tools;
}

const TEST_EXTRA = { requestInfo: { headers: { authorization: 'Token test_0f1e2d3c4b5a6978' } } };
const LIVE_EXTRA = { requestInfo: { headers: { authorization: 'Token a1b2c3d4e5f60718' } } };

test('isTestCredential: recognises the prefix through every accepted header form', () => {
  assert.equal(isTestCredential('test_abc'), true);
  assert.equal(isTestCredential('Token test_abc'), true);
  assert.equal(isTestCredential('Bearer test_abc'), true);
  assert.equal(isTestCredential('a1b2c3'), false);
  assert.equal(isTestCredential('Token a1b2c3'), false);
  // A live key is bare hex, so it can never begin with a non-hex prefix.
  assert.equal(isTestCredential('testing'), false);
  assert.equal(isTestCredential(null), false);
  assert.equal(isTestCredential(undefined), false);
});

test('isTestRequest: reads the credential and never throws on a malformed one', async () => {
  assert.equal(await isTestRequest(TEST_EXTRA), true);
  assert.equal(await isTestRequest(LIVE_EXTRA), false);
  assert.equal(await isTestRequest({}), false);
  assert.equal(await isTestRequest(undefined), false);
  assert.equal(await isTestRequest({ requestInfo: { headers: { authorization: 'Bearer not.a.jwt' } } }), false);
});

test('annotate: the notice reaches BOTH channels a model might read', () => {
  const marked = annotate({ structuredContent: { leads: [] }, content: [{ type: 'text', text: '{}' }] });
  assert.equal(marked.structuredContent.test_mode, true);
  assert.equal(marked.structuredContent.test_mode_notice, TEST_MODE_NOTICE);
  // First, not appended: a model that truncates reads the top.
  assert.equal(marked.content[0].text, TEST_MODE_NOTICE);
  assert.equal(marked.content[1].text, '{}');
});

test('annotate: keeps the original payload intact', () => {
  const marked = annotate({ structuredContent: { leads: [1, 2], cost: { amount_charged_usd: 0.02 } }, content: [] });
  assert.deepEqual(marked.structuredContent.leads, [1, 2]);
  assert.equal(marked.structuredContent.cost.amount_charged_usd, 0.02);
});

test('a test key marks every tool result, without the tool knowing', async () => {
  const tools = harness();
  const marked = await tools.search_leads({ job_titles: ['CEO'] }, TEST_EXTRA);
  assert.equal(marked.structuredContent.test_mode, true);
  assert.match(marked.content[0].text, /fictional/i);
});

test('a live key is left exactly as it was', async () => {
  const tools = harness();
  const plain = await tools.search_leads({ job_titles: ['CEO'] }, LIVE_EXTRA);
  assert.equal(plain.structuredContent.test_mode, undefined);
  assert.doesNotMatch(plain.content[0].text ?? '', /GENERECT TEST MODE/);
});
