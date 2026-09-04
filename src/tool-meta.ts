import { z } from 'zod';

// ---------------------------------------------------------------------------
// Per-tool protocol metadata: title, annotations, output schema
// ---------------------------------------------------------------------------
// Kept in one table rather than inline at each registration so the whole
// surface can be reviewed at once — "which of our tools claim to be read-only?"
// should be answerable by reading a single screen.
//
// `annotations` are hints the host uses to decide what to auto-approve. Getting
// them wrong is a trust bug, so:
//   readOnlyHint   - true only when the call cannot change state on Generect's
//                    side. Everything here reads data; webhook management does not.
//   destructiveHint- reserved for calls that can remove something.
//   idempotentHint - claimed ONLY for free calls. A repeated billable call has a
//                    very real additional effect: it charges again.
//   openWorldHint  - true everywhere: this server talks to live external data.
//
// `outputSchema` is validated by the SDK against `structuredContent` on every
// successful call, and a mismatch is a hard protocol error. So every field is
// optional and loosely typed on purpose: the schema documents the shape for
// clients without becoming a second place that can break a working call.
// tools-mapping.test.ts asserts each tool's real payload against its own schema.

export interface ToolMeta {
  title: string;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  outputSchema: z.ZodRawShape;
}

const COST = z
  .object({
    operation: z.string().optional(),
    amount_charged_usd: z.number().nullable().optional(),
    billed: z.string().optional(),
    note: z.string().optional(),
  })
  .optional();

const VOCAB_PROBLEMS = z.array(z.any()).optional();

/** Shared tail every tool result may carry. */
const COMMON = {
  cost: COST,
  vocabulary_warnings: VOCAB_PROBLEMS,
  deprecated_params_ignored: z.record(z.string()).optional(),
};

const COUNT_OUTPUT: z.ZodRawShape = {
  ...COMMON,
  results_count: z.number().nullable().optional(),
  mode: z.string().optional(),
  next_step_estimate: z.any().optional(),
  advice: z.string().optional(),
  needs_realtime: z.array(z.string()).optional(),
  why: z.string().optional(),
  options: z.array(z.string()).optional(),
  status: z.string().optional(),
  blocked_by_vocabulary: VOCAB_PROBLEMS,
  fix: z.string().optional(),
};

const SEARCH_OUTPUT: z.ZodRawShape = {
  ...COMMON,
  returned: z.number().optional(),
  results_count: z.number().nullable().optional(),
  requested_rows: z.number().optional(),
  mode: z.string().optional(),
  escalated_to_realtime_because: z.array(z.string()).optional(),
  escalation_note: z.string().optional(),
  leads: z.array(z.any()).optional(),
  companies: z.array(z.any()).optional(),
  next_page_args: z.any().optional(),
  status: z.string().optional(),
  blocked_by_vocabulary: VOCAB_PROBLEMS,
  fix: z.string().optional(),
  api_returned_more_than_requested: z.number().optional(),
  note: z.string().optional(),
  spend_guard: z.any().optional(),
};

const RECORD_OUTPUT: z.ZodRawShape = {
  ...COMMON,
  found: z.boolean().optional(),
  mode: z.string().optional(),
  lead: z.any().optional(),
  company: z.any().optional(),
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const FREE_READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

export const TOOL_META: Record<string, ToolMeta> = {
  // ---- free ----
  count_leads: {
    title: 'Count matching leads (free)',
    annotations: FREE_READ_ONLY,
    outputSchema: COUNT_OUTPUT,
  },
  count_companies: {
    title: 'Count matching companies (free)',
    annotations: FREE_READ_ONLY,
    outputSchema: COUNT_OUTPUT,
  },
  get_balance: {
    title: 'Balance, usage and your prices (free)',
    annotations: FREE_READ_ONLY,
    outputSchema: {
      ...COMMON,
      email: z.string().nullable().optional(),
      balance_usd: z.number().nullable().optional(),
      used_this_month_usd: z.number().nullable().optional(),
      preview_tier: z.boolean().nullable().optional(),
      your_prices_usd: z.any().optional(),
      prices_source: z.string().optional(),
      recent_transactions: z.any().optional(),
      usage: z.any().optional(),
      token_analytics: z.any().optional(),
    },
  },
  get_bulk_job: {
    title: 'Poll a bulk job (free)',
    annotations: FREE_READ_ONLY,
    outputSchema: {
      ...COMMON,
      job_type: z.string().optional(),
      job_id: z.string().optional(),
      job: z.any().optional(),
      results: z.any().optional(),
    },
  },
  health: {
    title: 'Server and credential health (free)',
    annotations: FREE_READ_ONLY,
    outputSchema: {
      ...COMMON,
      ok: z.boolean().optional(),
      server: z.string().optional(),
      version: z.string().optional(),
      api_base: z.string().optional(),
      has_credential: z.boolean().optional(),
      credential_valid: z.boolean().optional(),
      credential_error: z.any().optional(),
      account: z.string().nullable().optional(),
      balance_usd: z.number().nullable().optional(),
      ms: z.number().optional(),
    },
  },
  manage_webhooks: {
    title: 'Manage webhook endpoints',
    // The only tool here that changes state on Generect's side, and `delete`
    // removes a subscription the customer's pipeline may depend on.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    outputSchema: {
      ...COMMON,
      action: z.string().optional(),
      webhooks: z.any().optional(),
    },
  },

  // ---- billable ----
  search_leads: { title: 'Search leads (billed per row)', annotations: READ_ONLY, outputSchema: SEARCH_OUTPUT },
  search_companies: {
    title: 'Search companies (billed per row)',
    annotations: READ_ONLY,
    outputSchema: SEARCH_OUTPUT,
  },
  preview_leads: {
    title: 'Preview leads (cheapest paid look)',
    annotations: READ_ONLY,
    outputSchema: SEARCH_OUTPUT,
  },
  enrich_lead: { title: 'Enrich one lead', annotations: READ_ONLY, outputSchema: RECORD_OUTPUT },
  enrich_company: { title: 'Enrich one company', annotations: READ_ONLY, outputSchema: RECORD_OUTPUT },
  get_lead_by_url: {
    title: 'Enrich a lead by LinkedIn URL (alias)',
    annotations: READ_ONLY,
    outputSchema: RECORD_OUTPUT,
  },
  resolve_profile: {
    title: 'Resolve an anonymous LinkedIn link',
    annotations: READ_ONLY,
    outputSchema: { ...COMMON, resolved: z.any().optional(), profiles: z.array(z.any()).optional() },
  },
  generate_email: {
    title: 'Find a verified work email',
    annotations: READ_ONLY,
    outputSchema: {
      ...COMMON,
      requested: z.number().optional(),
      results: z.array(z.any()).optional(),
      mode: z.string().optional(),
      submitted: z.number().optional(),
      dropped: z.number().optional(),
      job: z.any().optional(),
      next_step: z.string().optional(),
    },
  },
  validate_email: {
    title: 'Validate email deliverability',
    annotations: READ_ONLY,
    outputSchema: { ...COMMON, submitted: z.number().optional(), results: z.any().optional() },
  },
  find_phone: {
    title: 'Find a phone number (most expensive)',
    annotations: READ_ONLY,
    outputSchema: { ...COMMON, result: z.any().optional() },
  },
  start_bulk_job: {
    title: 'Submit a bulk job',
    annotations: { readOnlyHint: true, openWorldHint: true },
    outputSchema: {
      ...COMMON,
      job_type: z.string().optional(),
      submitted: z.number().optional(),
      dropped: z.number().optional(),
      mode: z.string().optional(),
      job: z.any().optional(),
      reserved_worst_case_usd: z.number().optional(),
      reservation_note: z.string().optional(),
      next_step: z.string().optional(),
    },
  },
};

/** Registration order for tools/list — free pre-flight first, priciest last. */
export const TOOL_ORDER: readonly string[] = [
  'count_leads',
  'count_companies',
  'get_balance',
  'health',
  'preview_leads',
  'search_leads',
  'search_companies',
  'resolve_profile',
  'enrich_lead',
  'enrich_company',
  'get_lead_by_url',
  'generate_email',
  'validate_email',
  'find_phone',
  'start_bulk_job',
  'get_bulk_job',
  'manage_webhooks',
];
