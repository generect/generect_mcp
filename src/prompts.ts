import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
// Tools give a model the ability to call Generect; these give it the procedure.
// They surface in clients as slash commands, which is where a user who has just
// connected the server actually starts. Every one of them opens with the free
// step, because the expensive mistake is always the same: paying per row to
// discover that an ICP was wrong.

function userText(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  const register = (server as any).registerPrompt?.bind(server);
  if (!register) return; // older SDK or a test double without prompt support

  register(
    'size_an_audience',
    {
      title: 'Size an audience (free)',
      description:
        'Turn a plain-language ICP into filters and find out how many people match — without spending anything.',
      argsSchema: {
        icp: z.string().describe('The audience in plain language, e.g. "heads of partnerships at German fintechs".'),
      },
    },
    ({ icp }: { icp: string }) =>
      userText(
        [
          `Find out how large this audience is, without spending any credits: ${icp}`,
          '',
          'Do it in this order:',
          '1. Read generect://vocabulary/industries (and seniorities if the request implies a level) and pick the EXACT names. Do not guess: an unknown industry or seniority returns a successful, empty, free result, which looks identical to "this audience does not exist".',
          '2. Call count_leads with those filters. It is free.',
          '3. Report the count and, from next_step_estimate, what pulling 25 and 100 rows would cost at this account’s real rates.',
          '4. If the count is 0 or implausibly large, say which single filter you would change and why. Do not run a paid search.',
        ].join('\n'),
      ),
  );

  register(
    'build_prospect_list',
    {
      title: 'Build a prospect list safely',
      description: 'Count, preview, then buy only the rows the user approved — and report the exact spend.',
      argsSchema: {
        icp: z.string().describe('The audience in plain language.'),
        count: z.string().describe('How many contacts are wanted, e.g. "20".'),
        with_emails: z.string().optional().describe('"yes" to also resolve verified work emails.'),
      },
    },
    ({ icp, count, with_emails }: { icp: string; count: string; with_emails?: string }) =>
      userText(
        [
          `Build a list of ${count} contacts matching: ${icp}`,
          '',
          'Rules:',
          '- Start with count_leads (free). Report the size and the estimated cost before spending anything.',
          '- If the audience is much larger than needed, narrow it rather than paying for rows that will be discarded.',
          '- Use preview_leads to show a handful of real people and confirm the shape is right before the paid search.',
          `- Then search_leads with limit_by exactly ${count}. Never more.`,
          with_emails?.toLowerCase() === 'yes'
            ? '- Then generate_email on the ids that survived, and do not validate an address the finder already returned as valid.'
            : '- Do not resolve emails or phones unless asked.',
          '- Finish with the real total from each response’s cost.amount_charged_usd, and where the file was written.',
        ].join('\n'),
      ),
  );

  register(
    'enrich_my_list',
    {
      title: 'Enrich a list I already have',
      description: 'Deduplicate, drop unusable rows, enrich, and report the spend.',
      argsSchema: {
        source: z.string().describe('Path to the CSV/JSON file, or a description of where the records are.'),
      },
    },
    ({ source }: { source: string }) =>
      userText(
        [
          `Enrich the records in: ${source}`,
          '',
          '1. Read the file and deduplicate first — duplicates are duplicate charges.',
          '2. Drop rows with no usable identifier (Generect id, LinkedIn URL, email, or name + company domain). Enriching an unusable row costs the same as a real one.',
          '3. Check get_balance and tell me what the batch will cost before starting.',
          '4. Up to 10 records: enrich_lead each. More: start_bulk_job (max 50 per job) then get_bulk_job.',
          '5. Score against the ICP in code, not by buying more data.',
          '6. Write the enriched file next to the input and report the exact spend.',
        ].join('\n'),
      ),
  );

  register(
    'spend_report',
    {
      title: 'What did we spend?',
      description: 'Balance, month-to-date usage by operation, and the most recent charges.',
      argsSchema: {},
    },
    () =>
      userText(
        [
          'Report Generect spend.',
          '',
          'Call get_balance with include_usage:true and include_transactions:20, then summarise:',
          '- current balance',
          '- spend this month broken down by operation',
          '- the largest recent charges and what they were for',
          '- this account’s per-operation prices, so the numbers can be checked',
          'All of this is free to read.',
        ].join('\n'),
      ),
  );
}
