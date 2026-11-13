/**
 * All SQL that touches conversation state lives here. Keeping it in one thin
 * repository layer means recall, the write path, and the API routes share the
 * same queries, and swapping PGlite for Neon changes nothing above this file.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client';
import type { StoredClaim, EvidenceSource } from '../types';

export interface MessageRow {
  id: string;
  thread_id: string;
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string | Date;
  local_date: string;
  tz: string;
  turn_id: string | null;
  plan: unknown;
  sources: EvidenceSource[] | null;
  is_demo: boolean;
}

export interface ThreadRow {
  id: string;
  title: string | null;
  summary: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  is_demo: boolean;
}

export const LOCAL_USER = 'local';

function placeholders(count: number, offset = 1): string {
  return Array.from({ length: count }, (_, i) => `$${i + offset}`).join(', ');
}

export async function ensureThread(input: {
  id?: string | null;
  title?: string | null;
  userId?: string;
  isDemo?: boolean;
}): Promise<ThreadRow> {
  const db = await getDb();
  const userId = input.userId ?? LOCAL_USER;
  if (input.id) {
    const rows = await db.query<ThreadRow>('SELECT * FROM threads WHERE id = $1', [input.id]);
    if (rows.length) return rows[0];
  }
  const id = input.id ?? randomUUID();
  const rows = await db.query<ThreadRow>(
    `INSERT INTO threads (id, user_id, title, is_demo) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [id, userId, input.title ?? null, input.isDemo ?? false],
  );
  return rows[0];
}

export async function listThreads(userId = LOCAL_USER): Promise<ThreadRow[]> {
  const db = await getDb();
  return db.query<ThreadRow>(
    `SELECT * FROM threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`,
    [userId],
  );
}

export async function getThread(id: string): Promise<ThreadRow | null> {
  const db = await getDb();
  const rows = await db.query<ThreadRow>('SELECT * FROM threads WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function renameThread(id: string, title: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE threads SET title = $2, updated_at = now() WHERE id = $1', [id, title]);
}

export async function setThreadSummary(id: string, summary: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE threads SET summary = $2, updated_at = now() WHERE id = $1', [id, summary]);
}

export async function touchThread(id: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE threads SET updated_at = now() WHERE id = $1', [id]);
}

export async function deleteThread(id: string): Promise<void> {
  const db = await getDb();
  await db.query('DELETE FROM claims WHERE thread_id = $1', [id]);
  await db.query('DELETE FROM messages WHERE thread_id = $1', [id]);
  await db.query('DELETE FROM threads WHERE id = $1', [id]);
}

export async function listMessages(threadId: string, limit = 200): Promise<MessageRow[]> {
  const db = await getDb();
  const rows = await db.query<MessageRow>(
    `SELECT id, thread_id, user_id, role, content, created_at, local_date, tz, turn_id, plan, sources, is_demo
     FROM messages WHERE thread_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [threadId, limit],
  );
  return rows;
}

export async function insertMessage(input: {
  id?: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  localDate: string;
  tz: string;
  turnId?: string | null;
  plan?: unknown;
  sources?: EvidenceSource[] | null;
  isDemo?: boolean;
  userId?: string;
  embedding?: number[] | null;
  createdAt?: string | null;
}): Promise<string> {
  const db = await getDb();
  const id = input.id ?? randomUUID();
  await db.query(
    `INSERT INTO messages (id, thread_id, user_id, role, content, local_date, tz, turn_id, plan, sources, is_demo, embedding, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb, COALESCE($13::timestamptz, now()))`,
    [
      id,
      input.threadId,
      input.userId ?? LOCAL_USER,
      input.role,
      input.content,
      input.localDate,
      input.tz,
      input.turnId ?? null,
      input.plan ? JSON.stringify(input.plan) : null,
      input.sources ? JSON.stringify(input.sources) : null,
      input.isDemo ?? false,
      input.embedding ? JSON.stringify(input.embedding) : null,
      input.createdAt ?? null,
    ],
  );
  await touchThread(input.threadId);
  return id;
}

export async function getMessage(id: string): Promise<MessageRow | null> {
  const db = await getDb();
  const rows = await db.query<MessageRow>(
    `SELECT id, thread_id, user_id, role, content, created_at, local_date, tz, turn_id, plan, sources, is_demo
     FROM messages WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function setMessageEmbedding(id: string, embedding: number[] | null): Promise<void> {
  if (!embedding) return;
  const db = await getDb();
  await db.query('UPDATE messages SET embedding = $2::jsonb WHERE id = $1', [id, JSON.stringify(embedding)]);
}

export interface TurnPair {
  userMessage: MessageRow;
  assistantMessage: MessageRow;
}

export async function messagesByDates(
  dates: string[],
  userId = LOCAL_USER,
  limit = 12,
  tz?: string,
): Promise<TurnPair[]> {
  if (!dates.length) return [];
  const db = await getDb();
  const rows = await db.query<MessageRow>(
    `SELECT m.id, m.thread_id, m.user_id, m.role, m.content, m.created_at, m.local_date, m.tz,
            m.turn_id, m.plan, m.sources, m.is_demo
     FROM messages m
     WHERE m.user_id = $1 AND m.local_date IN (${placeholders(dates.length, 2)})
     ORDER BY m.created_at ASC
     LIMIT $${dates.length + 2}`,
    [userId, ...dates, limit * 2],
  );
  return pairTurns(rows);
}

export async function searchMessagesByText(
  text: string,
  userId = LOCAL_USER,
  limit = 5,
): Promise<Array<MessageRow & { score: number }>> {
  const db = await getDb();
  const rows = await db.query<MessageRow & { score: number }>(
    `SELECT id, thread_id, user_id, role, content, created_at, local_date, tz, turn_id, plan, sources, is_demo,
            ts_rank(tsv, plainto_tsquery('english', $2)) AS score
     FROM messages
     WHERE user_id = $1 AND tsv @@ plainto_tsquery('english', $2)
     ORDER BY score DESC, created_at DESC
     LIMIT $3`,
    [userId, text, limit * 2],
  );
  return rows;
}

export async function messagesWithEmbeddings(userId = LOCAL_USER, limit = 500): Promise<Array<Pick<MessageRow, 'id' | 'thread_id' | 'content' | 'local_date' | 'created_at' | 'role' | 'turn_id'> & { embedding: number[] | null }>> {
  const db = await getDb();
  return db.query(
    `SELECT id, thread_id, content, local_date, created_at, role, turn_id, embedding
     FROM messages WHERE user_id = $1 AND embedding IS NOT NULL
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
}

export async function messagesByTurnIds(turnIds: string[], userId = LOCAL_USER): Promise<MessageRow[]> {
  if (!turnIds.length) return [];
  const db = await getDb();
  return db.query<MessageRow>(
    `SELECT id, thread_id, user_id, role, content, created_at, local_date, tz, turn_id, plan, sources, is_demo
     FROM messages WHERE user_id = $1 AND turn_id IN (${placeholders(turnIds.length, 2)})
     ORDER BY created_at ASC`,
    [userId, ...turnIds],
  );
}

export async function latestAssistantMessage(threadId: string): Promise<MessageRow | null> {
  const db = await getDb();
  const rows = await db.query<MessageRow>(
    `SELECT id, thread_id, user_id, role, content, created_at, local_date, tz, turn_id, plan, sources, is_demo
     FROM messages WHERE thread_id = $1 AND role = 'assistant'
     ORDER BY created_at DESC LIMIT 1`,
    [threadId],
  );
  return rows[0] ?? null;
}

export async function threadMessagesForPrompt(threadId: string, limit = 12): Promise<MessageRow[]> {
  const db = await getDb();
  const rows = await db.query<MessageRow>(
    `SELECT * FROM (
       SELECT id, thread_id, user_id, role, content, created_at, local_date, tz, turn_id, plan, sources, is_demo
       FROM messages WHERE thread_id = $1 ORDER BY created_at DESC LIMIT $2
     ) t ORDER BY created_at ASC`,
    [threadId, limit],
  );
  return rows;
}

export async function getThreadsByIds(ids: string[]): Promise<ThreadRow[]> {
  if (!ids.length) return [];
  const db = await getDb();
  return db.query<ThreadRow>(
    `SELECT * FROM threads WHERE id IN (${placeholders(ids.length)})`,
    ids,
  );
}

/**
 * Turn a flat message list into user/assistant pairs. Memory is about
 * "what did I ask, and what did you say", so the pair is the unit.
 */
export function pairTurns(rows: MessageRow[]): TurnPair[] {
  const pairs: TurnPair[] = [];
  const byTurn = new Map<string, { user?: MessageRow; assistant?: MessageRow }>();
  for (const row of rows) {
    const key = row.turn_id ?? row.id;
    const bucket = byTurn.get(key) ?? {};
    if (row.role === 'user') bucket.user = row;
    else bucket.assistant = row;
    byTurn.set(key, bucket);
  }
  for (const bucket of byTurn.values()) {
    if (!bucket.user) continue;
    pairs.push({
      userMessage: bucket.user,
      assistantMessage:
        bucket.assistant ?? {
          ...bucket.user,
          id: `${bucket.user.id}-missing`,
          role: 'assistant',
          content: '',
        },
    });
  }
  return pairs.sort(
    (a, b) => new Date(a.userMessage.created_at).getTime() - new Date(b.userMessage.created_at).getTime(),
  );
}

// ── claims ────────────────────────────────────────────────────────────────────

export async function insertClaims(claims: StoredClaim[], meta: { userId?: string; messageId: string; threadId: string; localDate: string; isDemo?: boolean }): Promise<void> {
  if (!claims.length) return;
  const db = await getDb();
  for (const c of claims) {
    await db.query(
      `INSERT INTO claims (id, user_id, message_id, thread_id, entity, attribute, value, unit, qualifier, quote, source_url, observed_at, event_at, local_date, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (id) DO NOTHING`,
      [
        c.id,
        meta.userId ?? LOCAL_USER,
        meta.messageId,
        meta.threadId,
        c.entity,
        c.attribute,
        c.value,
        c.unit,
        c.qualifier,
        c.quote,
        c.sourceUrl,
        c.observedAt,
        c.eventAt,
        meta.localDate,
        meta.isDemo ?? false,
      ],
    );
  }
}

export async function claimsForMessages(messageIds: string[]): Promise<StoredClaim[]> {
  if (!messageIds.length) return [];
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, entity, attribute, value, unit, qualifier, quote, source_url, observed_at, event_at, local_date
     FROM claims WHERE message_id IN (${placeholders(messageIds.length)})`,
    messageIds,
  );
  return rows.map((r) => ({
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
  }));
}

export async function countMessages(userId = LOCAL_USER): Promise<number> {
  const db = await getDb();
  const rows = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM messages WHERE user_id = $1', [userId]);
  return Number(rows[0]?.n ?? 0);
}

export async function clearDemo(): Promise<number> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>('SELECT id FROM threads WHERE is_demo = true');
  for (const row of rows) await deleteThread(row.id);
  // Demo searches are invalidated with the demo, so a re-seed reflects the
  // current pipeline rather than a stale cache.
  await db.exec('DELETE FROM search_cache');
  return rows.length;
}
