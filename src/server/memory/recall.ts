/**
 * recall() — long-term memory.
 *
 * Three retrieval signals, in this order of authority:
 *   1. exact local date  ("3 November", "last Tuesday")   → indexed equality
 *   2. nearby date        (±1 day, disclosed to the user)  → users misremember
 *   3. topic             (FTS + embeddings, RRF-fused)   → "that Postgres thing"
 *
 * Dates first is deliberate. Embeddings are bad at dates and great at
 * paraphrases; using them in the wrong order is how memory agents "remember"
 * the wrong conversation. Vectors are a boost, never the backbone.
 */

import { embed, cosine } from '../llm/openrouter';
import type { MemoryContext, MemoryMatch, StoredClaim } from '../types';
import { addDays } from '../time/clock';
import { getDb } from '../db/client';
import { awaitPending } from './pending';
import {
  getThreadsByIds,
  latestAssistantMessage,
  messagesByDates,
  messagesByTurnIds,
  messagesWithEmbeddings,
  pairTurns,
  searchMessagesByText,
  threadMessagesForPrompt,
  type MessageRow,
} from './repo';

const MAX_MATCHES = 4;

export interface RecallInput {
  /** Local dates the planner's temporal refs resolved to. */
  dates: string[];
  topic: string | null;
  /** Free-text used for ranking inside a date range. */
  query?: string | null;
  threadId: string;
  /** The turn currently being answered: never a memory of itself. */
  excludeTurnId?: string | null;
  userId?: string;
}

/** Drop the in-flight turn and any half-written pair: memory is only complete turns. */
function usable<T extends { userMessage: MessageRow; assistantMessage: MessageRow }>(
  pairs: T[],
  excludeTurnId?: string | null,
): T[] {
  return pairs.filter(
    (p) =>
      p.assistantMessage.content.trim().length > 20 &&
      (!excludeTurnId || (p.userMessage.turn_id ?? '') !== excludeTurnId),
  );
}

function summarise(text: string, max = 1600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function buildMatches(pairs: Array<{ userMessage: MessageRow; assistantMessage: MessageRow }>, threadIds: Set<string>): Promise<MemoryMatch[]> {
  const titles = new Map((await getThreadsByIds([...threadIds])).map((t) => [t.id, t.title]));
  const byMessage = await claimsWithMessageIds(pairs.map((p) => p.assistantMessage.id));

  return pairs.map((p) => ({
    threadId: p.userMessage.thread_id,
    threadTitle: titles.get(p.userMessage.thread_id) ?? 'Untitled chat',
    date: p.userMessage.local_date,
    userText: summarise(p.userMessage.content, 700),
    assistantText: summarise(p.assistantMessage.content),
    messageId: p.assistantMessage.id,
    claims: byMessage.get(p.assistantMessage.id) ?? [],
  }));
}

async function claimsWithMessageIds(messageIds: string[]): Promise<Map<string, StoredClaim[]>> {
  const out = new Map<string, StoredClaim[]>();
  if (!messageIds.length) return out;
  const db = await getDb();
  const ph = messageIds.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, message_id, entity, attribute, value, unit, qualifier, quote, source_url, observed_at, event_at, local_date
     FROM claims WHERE message_id IN (${ph})`,
    messageIds,
  );
  for (const r of rows) {
    const claim: StoredClaim = {
      id: String(r.id),
      entity: String(r.entity),
      attribute: String(r.attribute),
      value: String(r.value),
      unit: (r.unit as string) ?? null,
      qualifier: (r.qualifier as string) ?? null,
      quote: String(r.quote),
      sourceUrl: (r.source_url as string) ?? null,
      observedAt: String(r.observed_at),
      eventAt: (r.event_at as string) ?? null,
      localDate: String(r.local_date),
    };
    const list = out.get(String(r.message_id)) ?? [];
    list.push(claim);
    out.set(String(r.message_id), list);
  }
  return out;
}

function widen(dates: string[]): string[] {
  const out = new Set<string>();
  for (const d of dates) {
    out.add(d);
    out.add(addDays(d, -1));
    out.add(addDays(d, 1));
  }
  return [...out];
}

export async function recall(input: RecallInput): Promise<MemoryContext> {
  const userId = input.userId ?? 'local';
  const searchedDates = input.dates;
  const result: MemoryContext = {
    matches: [],
    strategy: 'none',
    searchedDates,
    widened: false,
  };

  // A follow-up can arrive before the previous turn's claims are extracted.
  // Wait briefly, then fall back to re-searching the topic rather than guessing.
  if (input.threadId) {
    const last = await latestAssistantMessage(input.threadId);
    if (last) await awaitPending(last.id, 2500);
  }

  // 1. Exact local date.
  if (searchedDates.length) {
    const pairs = await messagesByDates(searchedDates, userId, 12);
    if (pairs.length) {
      // Prefer turns that also match the topic, when a topic exists.
      const filtered = usable(pairs, input.excludeTurnId);
      const ordered = input.topic ? await rankPairsByTopic(filtered, input.topic) : filtered;
      const chosen = ordered.slice(-MAX_MATCHES);
      result.matches = await buildMatches(chosen, new Set(chosen.map((p) => p.userMessage.thread_id)));
      result.strategy = 'exact-date';
      return result;
    }
  }

  // 2. Nearby date.
  if (searchedDates.length) {
    const pairs = usable(await messagesByDates(widen(searchedDates), userId, 12), input.excludeTurnId);
    if (pairs.length) {
      const chosen = pairs.slice(-MAX_MATCHES);
      result.matches = await buildMatches(chosen, new Set(chosen.map((p) => p.userMessage.thread_id)));
      result.strategy = 'nearby-date';
      result.widened = true;
      return result;
    }
  }

  // 3. Topic retrieval: FTS ∪ vector.
  if (input.topic) {
    const pairs = usable(await topicSearch(input.topic, input.query ?? input.topic, userId), input.excludeTurnId);
    if (pairs.length) {
      const chosen = pairs.slice(0, MAX_MATCHES);
      result.matches = await buildMatches(chosen, new Set(chosen.map((p) => p.userMessage.thread_id)));
      result.strategy = 'topic';
      return result;
    }
  }

  // 4. "Is your answer still correct?" with no date and no topic: the very last
  //    turn in this thread is what the user means by "that".
  const last = await latestAssistantMessage(input.threadId).catch(() => null);
  if (last && last.content) {
    const recent = await threadMessagesForPrompt(input.threadId, 6).catch(() => []);
    const pairs = usable(pairTurns(recent.length ? recent : [last]), input.excludeTurnId);
    const chosen = pairs.slice(-1);
    if (chosen.length) {
      result.matches = await buildMatches(chosen, new Set([last.thread_id]));
      result.strategy = 'thread-context';
    }
  }

  return result;
}

async function rankPairsByTopic(pairs: Array<{ userMessage: MessageRow; assistantMessage: MessageRow }>, topic: string) {
  const q = topic.toLowerCase();
  return [...pairs].sort((a, b) => {
    const score = (p: typeof a) =>
      (p.userMessage.content.toLowerCase().includes(q) ? 2 : 0) +
      (p.assistantMessage.content.toLowerCase().includes(q) ? 1 : 0);
    return score(b) - score(a);
  });
}

async function topicSearch(topic: string, query: string, userId: string) {
  const [ftsRows, vector] = await Promise.all([
    searchMessagesByText(topic, userId, 8).catch(() => []),
    embed([query]).catch(() => null),
  ]);

  const scores = new Map<string, number>();
  ftsRows.forEach((row, i) => {
    const key = row.turn_id ?? row.id;
    scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + i));
  });

  if (vector?.[0]) {
    const rows = await messagesWithEmbeddings(userId, 500).catch(() => []);
    const scored = rows
      .filter((r) => Array.isArray(r.embedding) && r.embedding.length === vector[0].length)
      .map((r) => ({ row: r, sim: cosine(vector[0], r.embedding as number[]) }))
      .filter((s) => s.sim > 0.2)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 8);
    scored.forEach((s, i) => {
      const key = s.row.turn_id ?? s.row.id;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + i));
    });
  }

  const turnIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id]) => id)
    .filter(Boolean);

  if (!turnIds.length) return [];
  const rows = await messagesByTurnIds(turnIds, userId);
  const pairs = pairTurns(rows);
  const order = new Map(turnIds.map((id, i) => [id, i]));
  return pairs.sort(
    (a, b) =>
      (order.get(a.userMessage.turn_id ?? '') ?? 99) - (order.get(b.userMessage.turn_id ?? '') ?? 99),
  );
}
