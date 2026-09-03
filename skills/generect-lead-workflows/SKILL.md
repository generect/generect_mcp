---
name: generect-lead-workflows
description: Build B2B prospect lists, enrich records and find verified emails with Generect without burning the user's balance. Use whenever a task involves finding people or companies to contact, enriching a CRM export, checking an ICP's size, verifying emails, or any lead-generation job that touches the Generect MCP server or API. Contains the money model, the free pre-flight step, and end-to-end flows for search, enrichment, bulk jobs and spend reporting.
license: MIT
---

# Generect lead workflows

Generect is a **pay-per-result** B2B data API. Every row you receive costs money.
An agent that searches before it counts spends the user's balance discovering
that an ICP was too broad — which is the single most common complaint about
tool-driven prospecting.

This skill exists to make that impossible.

## The one rule

> **Never call a paid tool until a free one has told you what it will cost.**

Sizing an audience is free. Use it. Always.

```
count_leads (free)  →  preview_leads (cheapest paid)  →  search_leads (per row)  →  generate_email (per valid email)
```

## The money model

| Operation | Billed |
|-----------|--------|
| `count_leads`, `count_companies` (cached mode) | **free** |
| `get_balance`, `get_bulk_job`, `manage_webhooks`, `health` | **free** |
| `preview_leads` | per returned row — the cheapest way to see real people |
| `search_leads`, `search_companies` | per returned row |
| `resolve_profile` | per **resolved** profile — the cheapest call here; an unresolvable reference is free |
| `enrich_lead`, `enrich_company` | per record found; a miss is free |
| `generate_email` | per **valid** email; a miss is free |
| `validate_email` | per address **submitted** — every one, whatever the verdict |
| `find_phone` | per phone found — **by far** the most expensive operation |
| `start_bulk_job` | per record, and the worst case is **reserved at submit time** |

Do not hardcode prices. Call `get_balance` — it returns this account's real
per-operation rates. Every tool response carries a `cost` block with the API's own
`meta.amount_charged`; when you report spend to a human, quote that, never your
own arithmetic.

### database vs realtime

Every search and enrich runs against a cached index (cheaper, sub-second, **free
counts**, core filters) or live LinkedIn (pricier, 5–60s, billable counts, every
filter). Leave `mode` on `auto`: it tries cheap first and escalates only when a
filter you passed does not exist in the cache — and tells you it did. If the
response contains `escalated_to_realtime_because`, mention it; the user paid more
than the cheap path would have cost.

Filters that force the live index: `keywords`, `functions`, `past_company_names`,
`changed_jobs`, `posted_on_linkedin`, `technologies`, `revenues_range`,
`num_of_followers`, `company_names`. Drop them if cost matters more than reach.

## Flow 1 — safe prospect search

Task: *"find 20 heads of partnerships at fintech companies in Germany"*.

1. Translate to filters: `job_titles: ["Head of Partnerships","Director of Partnerships"]`,
   `company_industries: ["Financial Services"]`, `locations: ["Germany"]`.
2. `count_leads` with those filters. **Free.**
3. React to the number:
   - **0** — do not pay for anything. Loosen the narrowest filter (usually
     seniority or industry) and count again. Two or three free iterations cost
     nothing and are the whole point.
   - **huge** (say >50k) — the ICP is not an ICP. Add a filter and count again.
   - **workable** — continue.
4. Tell the user the count and the cost of the next step, from
   `next_step_estimate`. For anything above a few dollars, ask before spending.
5. `search_leads` with `limit_by` set to what they asked for — **not** more.
6. Report what was actually charged from `cost.amount_charged_usd`.

Never loop `search_leads` to "get more" without saying so: each iteration is a
fresh charge. To page without duplicates, pass ids you already have in
`exclude_ids` — ordering is not stable, so offset is unreliable.

## Flow 2 — browse, choose, then pay

When the user is unsure about the ICP, do not buy a list for them to reject.

1. `count_leads` — free.
2. `preview_leads` with a small `limit_by` — cheapest way to see real people.
3. Show the sample, ranked by fit. Ask which profile shape is right.
4. Only then `search_leads`, or `enrich_lead` / `generate_email` on the specific
   `id`s they picked.

Records keep a stable `id` across preview, search and enrich. Once you have an
`id`, never search for that person again — pass the `id` straight to the next
step.

## Flow 3 — enrich a list the user already has

Task: *"enrich these 50 signups and mark which are ICP-fit"*.

1. Read the file. **Deduplicate first** — duplicates are duplicate charges.
2. Drop rows with no usable identifier (need one of: Generect id, LinkedIn URL,
   email, or name + company domain). Enriching garbage costs the same as
   enriching a real record.
3. If any LinkedIn URL is the anonymous `/in/ACwAA…` kind — the shape Sales
   Navigator leaves in exports and CRMs — put those through `resolve_profile`
   first (up to 50 per call). It is the cheapest call on the server, and the
   `id` it returns is what every later step accepts, so you stop guessing at an
   identifier you cannot read. Deduplicate before the batch: the same person can
   arrive as an `ACwAA…` id, an `ACoAA…` id and a vanity slug, those three
   strings cannot be compared offline, and each duplicate row is a charge.
4. ≤10 records: `enrich_lead` per record. More: `start_bulk_job` with
   `job_type: "enrich_leads"` (max 50 per job), then `get_bulk_job`.
5. Score against the ICP in your own code — do not pay for data to make a
   judgement you can make from what you already have.
6. Write the enriched file next to the input, with a `source` and a date column.

## Flow 4 — outreach-ready list

1. `count_companies` → free size check on the account side of the ICP.
2. `search_companies` for the accounts.
3. `count_leads` with `company_filters` → free size check on the people side.
4. `search_leads` for the people.
5. `generate_email` on the ids that survived your filtering. Do **not**
   `validate_email` an address the finder already returned as valid — that is
   paying twice for the same fact.
6. Output columns: name, title, company, domain, LinkedIn, email, and one
   sentence on why this person.

## Flow 5 — report the spend

Users trust an agent that can say exactly what it cost.

1. `get_balance` before the batch.
2. Do the approved work.
3. `get_balance` with `include_transactions: 10` after.
4. Report: starting balance, each operation and its charge, total, remaining.

If a call returns `Insufficient funds`, **stop**. Nothing was charged. Report the
balance and wait — do not retry, and do not fall back to a different tool.

## Scheduled and repeatable jobs

- Submit with `start_bulk_job` (max 50 records). The cost is **reserved at submit
  time**, so a submitted job keeps running and keeps charging even if you stop
  polling or the balance later hits zero. Only submit lists that were approved.
- Register a completion webhook with `manage_webhooks` instead of polling in a
  loop. Polling with `get_bulk_job` is free, but a tight loop is still abuse.
- For a cron job, put a hard cap in the job itself: a maximum spend per run, and
  a `get_balance` check before starting. An unattended agent has nobody to ask.

## MCP, REST or CLI?

- **MCP** — a model is deciding what to fetch. Interactive work, chat, agent
  loops. This is the default.
- **REST API** (`https://api.generect.com/api/v1`) — no model in the loop, or you
  need something MCP caps: more than 100 rows per request, your own retry and
  concurrency policy, a nightly sync. Auth is `Authorization: Token <key>`. The
  same free count endpoints exist: `POST /api/v1/search/database/leads/count/`.
- **CLI / scripts** — wrap the REST API. Do not shell out to `curl` when the MCP
  tool is already connected; you lose the cost receipts and the row caps.

## Where to put the results

If the user has not said, put working files under `./.generect/` in the current
project (`leads-<slug>-<date>.json`), and tell them where they are. Do not write
to a CRM, a spreadsheet, or anything external without being asked — sending
prospect data somewhere is not reversible.

Prospect records are personal data. Do not paste full record dumps into logs or
chat; show the fields the user asked for.

## Failure handling

| Symptom | What it means | Do this |
|---------|---------------|---------|
| `results_count: 0` | The ICP matched nothing. Nothing was charged. | Loosen one filter, count again. Never "try the paid search anyway". |
| `needs_realtime: [...]` | Those filters do not exist in the free index. | Drop them for a free count, or ask the user before paying for a live one. |
| HTTP 400 naming a field | An industry / headcount / type value is not in the taxonomy. | Fix the value — the error names the field. Do not retry blindly. |
| `Insufficient funds` | Balance is empty. Nothing was charged. | Report and stop. |
| Timeout on a realtime call | Live lookups take 5–60s. | Raise `timeout_ms`, or narrow the filters. Do not fire a second call — you may pay for both. |
