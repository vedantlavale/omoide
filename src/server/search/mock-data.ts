/**
 * Offline fixtures.
 *
 * These exist so the pipeline can be exercised end-to-end with no API keys:
 * `npm run eval` and `MOCK=1 npm run dev` use them. They are intentionally
 * small and obviously labelled — this is a test double, not a knowledge base.
 * In normal operation (any real key present) nothing in this file is used.
 */

export interface MockDoc {
  url: string;
  title: string;
  publishedAt: string;
  content: string;
}

export const MOCK_DOCS: MockDoc[] = [
  {
    url: 'https://neon.com/pricing',
    title: 'Neon — Pricing',
    publishedAt: '2026-11-08',
    content: `# Pricing

Neon has a usage-based pricing model. The Free plan includes 0.5 GB of storage and 191.9 compute hours per month.

The Launch plan starts at $19 per month and includes 10 GB of storage, 300 compute hours, and autoscaling to 4 vCPUs. The Scale plan is $69 per month with 50 GB of storage and 750 compute hours.

Neon does not charge for idle time: compute scales to zero after five minutes of inactivity. Branching is included on every plan; storage is billed per branch above the plan limit.

Extra storage is $1.75 per GB-month. Extra compute is billed per compute-hour at $0.16 for the first 300 hours on Launch.`,
  },
  {
    url: 'https://supabase.com/pricing',
    title: 'Supabase — Pricing',
    publishedAt: '2026-11-05',
    content: `# Supabase Pricing

Free: 500 MB database, 1 GB file storage, 5 GB bandwidth. Paused after one week of inactivity.

Pro: $30 per month, includes 8 GB database, 100 GB storage, 250 GB bandwidth, daily backups retained for 7 days. Additional projects are $10 each.

Team: $599 per month with SOC2, SSO and 28-day backups. Enterprise pricing is custom.

Database compute is billed separately: a small instance is $15 per month, medium $60, large $110.`,
  },
  {
    url: 'https://aws.amazon.com/rds/postgresql/pricing/',
    title: 'Amazon RDS for PostgreSQL — Pricing',
    publishedAt: '2026-10-29',
    content: `# Amazon RDS for PostgreSQL Pricing

RDS for PostgreSQL is billed per hour for the database instance plus GB-month for storage.

A db.t4g.micro instance with 2 vCPUs and 1 GB memory costs $0.016 per hour, about $11.68 per month. A db.t4g.medium is $0.065 per hour, about $47.45 per month.

General Purpose SSD storage is $0.115 per GB-month. Backup storage beyond the provisioned amount is $0.095 per GB-month. Multi-AZ doubles the instance cost.

You pay for the instance even when it is idle; there is no scale-to-zero option.`,
  },
  {
    url: 'https://render.com/pricing',
    title: 'Render — Pricing',
    publishedAt: '2026-10-30',
    content: `# Render Pricing

Render Postgres starts at $7 per month for the Basic 256 MB plan. The Basic 1 GB plan is $20 per month.

Storage is $0.30 per GB-month above the included amount. Point-in-time recovery is available on Pro plans starting at $55 per month.

Web services start at $7 per month for 512 MB of RAM. Static sites are free.`,
  },
  {
    url: 'https://railway.com/pricing',
    title: 'Railway — Pricing',
    publishedAt: '2026-09-18',
    content: `# Railway Pricing

Railway charges for usage: $5 per vCPU per month and $10 per GB of RAM per month, billed per second.

The Hobby plan includes $5 of usage credit for $5 per month. The Pro plan is $20 per seat per month and includes $20 of usage credit, with higher limits.

A small Postgres instance typically costs $5 to $10 per month depending on memory. Volumes are billed at $0.25 per GB per month.`,
  },
  {
    url: 'https://www.hubspot.com/pricing/sales',
    title: 'HubSpot Sales Hub CRM — Pricing',
    publishedAt: '2026-11-06',
    content: `# Sales Hub Pricing

Starter: $20 per seat per month, includes 1,000 contacts, email templates and meeting scheduling.

Professional: $100 per seat per month, includes forecasting, sequences, custom reporting and 2,000 contacts.

Enterprise: $150 per seat per month, includes predictive lead scoring, custom objects and sandboxes.

All prices are billed annually. A 20-person team on Professional pays $2,000 per month before discounts.`,
  },
  {
    url: 'https://www.salesforce.com/sales/pricing/',
    title: 'Salesforce Sales Cloud CRM — Pricing',
    publishedAt: '2026-10-22',
    content: `# Sales Cloud Pricing

Starter Suite is $25 per user per month. Sales Professional is $80 per user per month.

Sales Enterprise is $165 per user per month and adds workflow automation, territory management and forecasting. Unlimited is $330 per user per month.

Prices are billed annually. Salesforce commonly quotes 15 to 25 percent discounts for teams above 20 seats.`,
  },
  {
    url: 'https://www.pipedrive.com/en/pricing',
    title: 'Pipedrive CRM — Pricing',
    publishedAt: '2026-11-09',
    content: `# Pipedrive Pricing

Essential: $24 per seat per month, includes lead management and a simple pipeline view.

Advanced: $49 per seat per month, adds email sync, automation and custom fields. Professional: $79 per seat per month.

Power: $129 per seat per month. All plans are billed annually; monthly billing is about 15 percent more.

Pipedrive announced AI Sales Assistant for all paid plans on 9 November 2026, at no extra cost.`,
  },
  {
    url: 'https://www.zoho.com/crm/pricing.html',
    title: 'Zoho CRM — Pricing',
    publishedAt: '2026-10-15',
    content: `# Zoho CRM Pricing

Standard: $20 per user per month. Professional: $35 per user per month.

Enterprise: $50 per user per month, includes territory management and custom modules. Ultimate: $65 per user per month.

Prices are billed annually. Zoho offers a free plan for up to three users.`,
  },
  {
    url: 'https://www.close.com/pricing',
    title: 'Close CRM — Pricing',
    publishedAt: '2026-10-11',
    content: `# Close Pricing

Startup: $29 per user per month, includes two-way email, calling and SMS.

Growth: $99 per user per month, adds workflows, lead routing and reporting. Enterprise: $139 per user per month.

Close bills annually by default and includes unlimited contacts on every plan.`,
  },
  {
    url: 'https://nextjs.org/blog/next-16',
    title: 'Next.js 16 — release notes',
    publishedAt: '2026-10-21',
    content: `# Next.js 16

Next.js 16 is now stable. It ships Turbopack as the default bundler, a stable after() API for post-response work, and the new cache components model.

The minimum React version is 19.2. The App Router is the default; the Pages Router remains supported.

Upgrading from 15 requires codemods for the async request APIs: cookies(), headers() and params are now asynchronous.`,
  },
  {
    url: 'https://neon.com/blog/scale-to-zero-improvements',
    title: 'Neon: faster cold starts for scale-to-zero',
    publishedAt: '2026-11-09',
    content: `# Faster cold starts

Neon reduced cold start latency for suspended projects from roughly 500 ms to under 150 ms, the company said on 9 November 2026.

The change applies to all paid plans automatically. Free plan projects still suspend after five minutes of inactivity but now resume faster.`,
  },
];
