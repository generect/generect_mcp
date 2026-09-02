import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Smoke test for the local stdio server.
// By default it only calls FREE tools — a smoke test should never quietly bill
// the person running it. Pass --paid to also exercise one small paid lookup.

async function main() {
  const paid = process.argv.includes('--paid');
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/server.js'],
    env: {
      GENERECT_API_BASE: process.env.GENERECT_API_BASE || 'https://api.generect.com',
      GENERECT_API_KEY: process.env.GENERECT_API_KEY || `Token ${positional[0] ?? ''}`,
      GENERECT_TIMEOUT_MS: process.env.GENERECT_TIMEOUT_MS || '60000',
    },
    stderr: 'inherit',
  });

  const client = new Client({ name: 'local-mcp-client', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools({});
  console.log(
    'Tools:',
    tools.tools.map(t => t.name),
  );

  let spent = 0;
  const call = async (name: string, args: any) => {
    try {
      const res: any = await client.callTool({ name, arguments: args });
      const charged = Number(res?.structuredContent?.cost?.amount_charged_usd ?? 0);
      spent += Number.isFinite(charged) ? charged : 0;
      console.log(`\n=== ${name}(${JSON.stringify(args)}) — charged $${charged} ===`);
      console.log(JSON.stringify(res?.structuredContent ?? res, null, 2).slice(0, 2000));
    } catch (err) {
      console.log(`\n=== ${name}(${JSON.stringify(args)}) ERROR ===`);
      console.error(err);
    }
  };

  // Free: liveness, balance, audience sizing.
  await call('health', {});
  await call('get_balance', {});
  await call('count_leads', { job_titles: ['marketing manager'], locations: ['Germany'] });
  await call('count_companies', { industries: ['Software Development'], locations: ['Germany'] });

  if (paid) {
    // Deliberately tiny: 3 rows of cached data plus one email lookup.
    await call('search_leads', { job_titles: ['marketing manager'], locations: ['Germany'], limit_by: 3 });
    await call('generate_email', { first_name: 'Satya', last_name: 'Nadella', domain: 'microsoft.com' });
  } else {
    console.log('\n(skipping paid tools — re-run with --paid to exercise search_leads / generate_email)');
  }

  console.log(`\nTotal charged by this run: $${Math.round(spent * 1e6) / 1e6}`);
  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
