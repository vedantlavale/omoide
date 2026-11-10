/**
 * The orchestrator: the only place that knows the whole turn.
 *
 * It decides what the model needs to know *before* it speaks:
 *   plan → resolve dates → recall memory → (re-check | search) → synthesize
 *
 * Everything is deterministic and inspectable up to the final model call, which
 * is what makes cheap models reliable here. The model is not trusted to
 * remember, to do date arithmetic, or to decide whether to search first.
 */

import { randomUUID } from 'node:crypto';
import { getConfig } from '../config';
import { getDb } from '../db/client';
import { LOCAL_USER, ensureThread, insertMessage, listThreads, listMessages } from '../memory/repo';
import { recall } from '../memory/recall';
import { recheck } from '../memory/recheck';
import { registerPending } from '../memory/pending';
import { planTurn } from './planner';
import { heuristicPlan, isFastPath, topicalQuery, rewriteFollowUp, meaningfulTopic } from './heuristics';
import { synthesize, stripInvalidCitations } from './synthesize';
import { webSearch, SourceRegistry } from '../search';
import { getTimeContext, localDateString } from '../time/clock';
import { resolveTemporal } from '../time/resolve';
import type { ChangeReport, EvidenceSource, MemoryContext, Plan, TimeContext, TraceStep, TurnTrace } from '../types';

export type TurnEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'status'; text: string }
  | { type: 'plan'; plan: Plan; ranges: Array<{ from: string; to: string; label: string }> }
  | { type: 'sources'; sources: EvidenceSource[] }
  | { type: 'search'; queries: string[]; found: number }
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; threadId: string; trace: TurnTrace }
  | { type: 'error'; message: string };

export interface TurnInput {
  threadId?: string | null;
  message: string;
  tz?: string | null;
  clientNow?: string | null;
  signal: AbortSignal;
  isDemo?: boolean;
  /** Demo seeding backdates turns; live turns never set this. */
  backdate?: { localDate: string; createdAt: string } | null;
}

function status(text: string): TurnEvent {
  return { type: 'status', text };
}

export async function* runTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
  const startedAt = Date.now();
  const steps: TraceStep[] = [];
  const trace: TurnTrace = {
    plan: heuristicPlan(input.message),
    resolvedRanges: [],
    memoryStrategy: 'none',
    memoryMatches: 0,
    queries: [],
    providers: [],
    cacheHits: 0,
    sources: 0,
    followUpSearches: 0,
    steps,
    totalMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    errors: [],
  };

  const time = getTimeContext({ tz: input.tz });
  const localDate = input.backdate?.localDate ?? time.localDate;
  const createdAt = input.backdate?.createdAt ?? new Date().toISOString();
  const registry = new SourceRegistry();

  yield status('Thinking…');

  let threadId = input.threadId ?? null;
  let turnId = randomUUID();
  let assistantMessageId = randomUUID();

  // Save the user's message first: if the stream dies, the turn is not lost.
  let userMessageSaved = false;
  try {
    const thread = await ensureThread({ id: threadId, title: null });
    threadId = thread.id;
    yield { type: 'thread', threadId };

    // A follow-up ("what about their enterprise plan?") is rewritten against the
    // previous user turn when the planner is unavailable.
    const existing = await listMessages(threadId, 50);
    const previousUser = [...existing].reverse().find((m) => m.role === 'user');
    const planned = isFastPath(input.message)
      ? heuristicPlan(input.message)
      : await planTurn({
          message: input.message,
          time,
          recent: existing.slice(-6).map((m) => ({ role: m.role, content: m.content })),
          threadSummary: thread.summary,
          hasHistory: existing.length > 0,
          signal: input.signal,
        });

    if (planned.source === 'heuristic' && planned.needsSearch && previousUser) {
      const rewritten = rewriteFollowUp(input.message, previousUser.content);
      if (rewritten !== input.message) planned.queries = [rewritten];
    }
    const plan = planned;
    trace.plan = plan;

    await insertMessage({
      threadId,
      role: 'user',
      content: input.message,
      localDate,
      tz: time.tz,
      turnId,
      isDemo: input.isDemo,
      createdAt,
    });
    userMessageSaved = true;

    steps.push({ name: 'plan', ms: Date.now() - startedAt, detail: { intent: plan.intent, source: plan.source } });

    let ranges = resolveTemporal(plan.temporalRefs, time);
    // "Is your answer still correct today?" names the check date, not a memory
    // to recall. When a re-check has real past anchors, today is not one of them.
    if (plan.needsRecheck) {
      const past = ranges.filter((r) => r.to < time.localDate);
      if (past.length) ranges = past;
    }
    trace.resolvedRanges = ranges.map((r) => ({ from: r.from, to: r.to, label: r.label }));
    yield { type: 'plan', plan, ranges: trace.resolvedRanges };

    // ── memory ────────────────────────────────────────────────────────────────
    const dateValues = [...new Set(ranges.flatMap((r) => r.localDates))];
    let memory: MemoryContext = { matches: [], strategy: 'none', searchedDates: dateValues, widened: false };

    if (plan.needsMemory || dateValues.length) {
      yield status(
        dateValues.length
          ? `Checking our conversation from ${ranges[0]?.label ?? 'that date'}…`
          : 'Checking what we discussed before…',
      );
      const memStart = Date.now();
      memory = await recall({
        dates: dateValues,
        topic: plan.topic,
        query: input.message,
        threadId,
        excludeTurnId: turnId,
      });
      trace.memoryStrategy = memory.strategy;
      trace.memoryMatches = memory.matches.length;
      steps.push({
        name: 'recall',
        ms: Date.now() - memStart,
        detail: { strategy: memory.strategy, matches: memory.matches.length },
      });
    }

    let nearest: Array<{ date: string; title: string }> = [];
    if (!memory.matches.length && plan.needsMemory) {
      nearest = (await listThreads().catch(() => []))
        .filter((t) => t.title)
        .slice(0, 3)
        .map((t) => ({
          date: localDateString(new Date(t.created_at), time.tz),
          title: t.title ?? 'Untitled',
        }));
    }

    // ── re-check ──────────────────────────────────────────────────────────────
    const claims = memory.matches.flatMap((m) => m.claims);
    let changeReport: ChangeReport | null = null;

    if (plan.needsRecheck && claims.length) {
      yield status(`Verifying ${claims.length} stored ${claims.length === 1 ? 'fact' : 'facts'}…`);
      const rcStart = Date.now();
      changeReport = await recheck({
        claims,
        sinceDate: memory.matches[0]?.date ?? dateValues[0] ?? null,
        time,
        registry,
        entities: plan.entities,
      });
      steps.push({
        name: 'recheck',
        ms: Date.now() - rcStart,
        detail: {
          claims: claims.length,
          changed: changeReport.checks.filter((c) => c.status === 'changed').length,
          news: changeReport.news.length,
          since: changeReport.sinceDate,
        },
      });
    }

    // ── search ────────────────────────────────────────────────────────────────
    let sources: EvidenceSource[] = [];
    // A memory miss should still be useful, but only if the user named a real
    // subject. "What did I ask on 3 Nov" has no topic to search for.
    const missTopic = meaningfulTopic(plan.topic);
    const shouldSearch =
      plan.needsSearch || (plan.needsMemory && memory.matches.length === 0 && Boolean(missTopic));

    if (shouldSearch) {
      let queries = (plan.queries.length ? [...plan.queries] : []).filter((q) => meaningfulTopic(q) !== null);
      if (!queries.length && memory.matches[0]) {
        // A memory question rarely names a searchable subject; the recalled turn does.
        // Use the first clause of the recalled question, not the whole essay.
        const recalled = topicalQuery(memory.matches[0].userText).split(/\s+/).slice(0, 9).join(' ').replace(/[:;,]$/, '');
        if (meaningfulTopic(recalled)) queries = [recalled];
      }
      if (memory.matches.length === 0 && !queries.length && missTopic) queries = [missTopic];
      if (memory.matches.length === 0 && missTopic) {
        // A memory miss must still be useful: look up the topic as it stands today.
        const topicQuery = topicalQuery(missTopic);
        if (topicQuery && !queries.includes(topicQuery)) queries.push(topicQuery);
      }
      queries = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, 3);

      if (queries.length) {
        yield status(`Searching for ${queries.slice(0, 2).map((q) => `“${q}”`).join(' and ')}…`);
        const searchStart = Date.now();
        const result = await webSearch(
          {
            queries,
            freshness: plan.freshness,
            // Date bounds belong to the re-check's "news since" search, not to
            // the search for current facts: pricing pages are usually older
            // than the conversation we are checking.
            after_date: null,
            news: plan.domainType === 'news',
          },
          { registry, time, maxSources: plan.intent === 'research' ? 6 : 4 },
        );
        sources = result.sources;
        trace.queries.push(...queries);
        trace.providers.push(...result.meta.providers);
        trace.cacheHits += result.meta.cacheHits;
        trace.errors.push(...result.meta.errors);
        if (!sources.length) trace.errors.push('search returned no sources');
        steps.push({
          name: 'search',
          ms: Date.now() - searchStart,
          detail: {
            queries,
            sources: sources.length,
            providers: result.meta.providers,
            cacheHits: result.meta.cacheHits,
            snippetOnly: result.meta.snippetOnly,
          },
        });
        if (sources.length) {
          yield status(`Read ${sources.length} source${sources.length === 1 ? '' : 's'}.`);
          yield { type: 'sources', sources: registry.all() };
        }
      }
    }

    // ── synthesize ────────────────────────────────────────────────────────────
    assistantMessageId = randomUUID();
    registerPending(assistantMessageId);

    const allMessages = await listMessages(threadId, 20);
    // Everything except the user message we just saved.
    const history = allMessages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));

    let answer = '';
    const synthStart = Date.now();
    try {
      for await (const event of synthesize({
        plan,
        time,
        memory,
        nearest,
        sources,
        changeReport,
        history,
        threadSummary: thread.summary,
        userMessage: input.message,
        registry,
        signal: input.signal,
        trace,
      })) {
        if (event.type === 'delta') {
          answer += event.text;
          yield { type: 'delta', text: event.text };
        } else if (event.type === 'search') {
          yield { type: 'search', queries: event.queries, found: event.found };
          if (event.found) yield { type: 'sources', sources: registry.all() };
        } else if (event.type === 'usage') {
          trace.usage.inputTokens += event.inputTokens;
          trace.usage.outputTokens += event.outputTokens;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) {
        trace.errors.push(`synthesize: ${message}`);
        yield { type: 'error', message: 'The model could not finish this answer. The evidence is saved — try again.' };
        if (!answer) {
          answer = 'I could not finish that answer — the model connection failed. Nothing above is guessed; ask again and I will retry.';
          yield { type: 'delta', text: answer };
        }
      }
    }
    steps.push({ name: 'synthesize', ms: Date.now() - synthStart });

    answer = stripInvalidCitations(answer, registry.all().map((s) => s.id)).trim();
    if (!answer) {
      answer = 'I could not produce an answer for that. Try again, or ask a narrower question.';
      yield { type: 'delta', text: answer };
    }

    const finalSources = registry.all();
    await insertMessage({
      id: assistantMessageId,
      threadId,
      role: 'assistant',
      content: answer,
      localDate,
      tz: time.tz,
      turnId,
      plan,
      sources: finalSources,
      isDemo: input.isDemo,
      createdAt: input.backdate
        ? new Date(new Date(createdAt).getTime() + 1500).toISOString()
        : new Date().toISOString(),
    });

    trace.sources = finalSources.length;
    trace.totalMs = Date.now() - startedAt;
    trace.queries = [...new Set(trace.queries)];
    trace.providers = [...new Set(trace.providers)];

    await saveTrace(assistantMessageId, threadId, trace).catch(() => {});

    yield { type: 'done', messageId: assistantMessageId, threadId, trace };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    trace.errors.push(message);
    yield { type: 'error', message: `Something went wrong: ${message}` };
    if (!userMessageSaved) return;
  }
}

async function saveTrace(messageId: string, threadId: string, trace: TurnTrace): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO traces (id, message_id, thread_id, data, total_ms) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [randomUUID(), messageId, threadId, JSON.stringify(trace), trace.totalMs],
  );
}

export async function getTrace(messageId: string): Promise<TurnTrace | null> {
  const db = await getDb();
  const rows = await db.query<{ data: TurnTrace }>(
    'SELECT data FROM traces WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1',
    [messageId],
  );
  return rows[0]?.data ?? null;
}

export { LOCAL_USER };
