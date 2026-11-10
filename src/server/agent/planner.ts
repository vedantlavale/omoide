/**
 * The planner: one small structured call that decides what kind of turn this
 * is, what to look up, and which past dates the user meant.
 *
 * It deliberately never emits concrete dates. Temporal phrases come back as
 * raw text and are resolved by code (time/resolve.ts), so a bad weekday
 * calculation is impossible rather than merely unlikely.
 */

import { z } from 'zod';
import { getConfig } from '../config';
import { generateJson } from '../llm/openrouter';
import { timeBlock } from '../time/calendar';
import type { Plan, TimeContext } from '../types';
import { findTemporalExpressions } from '../time/resolve';
import { heuristicPlan, topicalQuery } from './heuristics';

const PlanSchema = z.object({
  intent: z.enum(['chitchat', 'stable_knowledge', 'web_lookup', 'research', 'memory_recall', 'recheck']),
  needsSearch: z.boolean(),
  needsMemory: z.boolean(),
  needsRecheck: z.boolean(),
  temporalRefs: z.array(z.string()).max(4).default([]),
  topic: z.string().nullable().default(null),
  entities: z.array(z.string()).max(10).default([]),
  queries: z.array(z.string()).max(5).default([]),
  freshness: z.enum(['any', 'year', 'month', 'week', 'day']).default('any'),
  domainType: z.enum(['web', 'news']).default('web'),
  answerShape: z.enum(['short', 'detailed', 'table', 'change_report']).default('short'),
  clarify: z.string().nullable().default(null),
});

const SYSTEM = `You are the planner for a research assistant with web search and long-term memory. You do not answer the user. You output one JSON object describing how to handle the turn.

Fields:
- intent: chitchat | stable_knowledge | web_lookup | research | memory_recall | recheck
- needsSearch: true when the answer could have changed (prices, plans, versions, releases, news, people, availability, "latest", "best", comparisons). false for greetings, math, definitions, and questions about this conversation.
- needsMemory: true when the user refers to something said earlier ("what did I ask", "last Tuesday", "you said", "we shortlisted", "that answer", "earlier").
- needsRecheck: true when they ask whether something from before is still true / what changed since.
- temporalRefs: the raw phrases that point at a date, copied verbatim and lowercase ("last tuesday", "3 november", "yesterday", "monday", "last week"). NEVER convert them to dates yourself.
- topic: the subject in a few words ("managed Postgres pricing"), or null.
- entities: named products/companies in the request.
- queries: 1-3 standalone search queries. Resolve pronouns using the conversation ("what about their enterprise plan?" → "HubSpot Sales Hub Enterprise pricing"). No dates unless the user gave one. Empty when needsSearch is false.
- freshness: any | year | month | week | day.
- domainType: web | news.
- answerShape: short | detailed | table | change_report.
- clarify: a single clarifying question, or null. Almost always null.

Examples:
"hi" → {"intent":"chitchat","needsSearch":false,"needsMemory":false,"needsRecheck":false,"temporalRefs":[],"topic":null,"entities":[],"queries":[],"freshness":"any","domainType":"web","answerShape":"short","clarify":null}
"what is the capital of France" → stable_knowledge, needsSearch false, answerShape short.
"what's the latest Next.js version" → web_lookup, needsSearch true, queries ["latest Next.js version"], freshness "month".
"compare Neon, Supabase and RDS pricing for a small app" → research, needsSearch true, queries ["Neon pricing","Supabase pricing","AWS RDS PostgreSQL pricing"], entities ["Neon","Supabase","RDS"], answerShape table.
"what did I ask you on 3 November" → memory_recall, needsMemory true, needsSearch false, temporalRefs ["3 november"], topic null.
"last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" → recheck, needsMemory true, needsRecheck true, needsSearch true, temporalRefs ["last tuesday"], topic "Postgres hosting pricing", queries ["managed Postgres hosting pricing"], answerShape change_report.
"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?" → recheck, needsMemory true, needsRecheck true, needsSearch true, temporalRefs ["monday"], topic "CRM shortlist for a 20-person sales team", entities [], queries ["CRM pricing changes","CRM product launches this week"], domainType web, answerShape change_report.
"and their enterprise plan?" (previous turn was HubSpot pricing) → web_lookup, queries ["HubSpot enterprise plan pricing"], needsSearch true.

Return JSON only.`;

export interface PlannerInput {
  message: string;
  time: TimeContext;
  recent: Array<{ role: string; content: string }>;
  threadSummary: string | null;
  hasHistory: boolean;
  signal?: AbortSignal;
}

export async function planTurn(input: PlannerInput): Promise<Plan> {
  const config = getConfig();
  const fallback = heuristicPlan(input.message, { hasHistory: input.hasHistory });

  if (config.mock || !config.openrouterKey) return fallback;

  try {
    const result = await generateJson<unknown>({
      model: config.models.utility,
      temperature: 0,
      timeoutMs: 3500,
      retries: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            timeBlock(input.time),
            input.threadSummary ? `THREAD SUMMARY:\n${input.threadSummary}` : '',
            input.recent.length
              ? `RECENT MESSAGES:\n${input.recent.map((m) => `${m.role}: ${m.content.slice(0, 400)}`).join('\n')}`
              : 'RECENT MESSAGES: none',
            `USER MESSAGE:\n${input.message}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    });

    const parsed = PlanSchema.safeParse(result);
    if (!parsed.success) return fallback;
    const plan: Plan = { ...parsed.data, source: 'model' };

    // Repair the common model mistakes rather than trusting them blindly.
    if (plan.needsRecheck) {
      plan.needsMemory = true;
      plan.needsSearch = true;
      plan.answerShape = 'change_report';
    }
    if (plan.needsMemory && !plan.temporalRefs.length) {
      plan.temporalRefs = findTemporalExpressions(input.message);
    }
    if (plan.needsSearch && !plan.queries.length) {
      const q = topicalQuery(input.message);
      if (q) plan.queries = [q];
    }
    if (!plan.needsSearch) plan.queries = [];
    return plan;
  } catch {
    // Timeout, provider error, bad JSON: the turn still works.
    return fallback;
  }
}
