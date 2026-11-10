/**
 * The post-turn write path.
 *
 * Runs after the answer has streamed, so nothing here is user-visible latency:
 * extract claims, compute embeddings, name the thread, refresh the rolling
 * summary. Each step is independently best-effort — a failure never costs the
 * saved conversation.
 */

import { getConfig } from '../config';
import { embed, generateJson } from '../llm/openrouter';
import { getDb } from '../db/client';
import type { EvidenceSource, TimeContext } from '../types';
import { extractClaims, toStored } from './claims';
import { resolvePending } from './pending';
import {
  countMessages,
  getMessage,
  getThread,
  insertClaims,
  renameThread,
  setMessageEmbedding,
  setThreadSummary,
  threadMessagesForPrompt,
  LOCAL_USER,
} from './repo';

function heuristicTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').slice(0, 8).join(' ');
  const title = words.length > 52 ? `${words.slice(0, 51)}…` : words;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export async function postTurn(assistantMessageId: string): Promise<void> {
  try {
    const message = await getMessage(assistantMessageId);
    if (!message) return;

    const thread = await getThread(message.thread_id);
    const recent = await threadMessagesForPrompt(message.thread_id, 12);
    const userMessage = [...recent].reverse().find((m) => m.role === 'user' && m.turn_id === message.turn_id);
    const sources: EvidenceSource[] = (message.sources as EvidenceSource[] | null) ?? [];
    const time: TimeContext = {
      now: new Date(),
      tz: message.tz,
      localDate: message.local_date,
      weekday: 0,
      weekdayName: '',
      human: '',
    };

    // 1. Claims — only for answers that actually cited something.
    if (sources.length) {
      const plan = (message.plan as { entities?: string[] } | null) ?? {};
      const raw = await extractClaims({
        answer: message.content,
        sources,
        entities: plan.entities ?? [],
        time,
      });
      const stored = toStored(raw, { sources, now: new Date(), localDate: message.local_date });
      await insertClaims(stored, {
        messageId: message.id,
        threadId: message.thread_id,
        localDate: message.local_date,
        isDemo: message.is_demo,
      });
    }

    // 2. Embeddings — a boost for paraphrased recall, never required.
    if (getConfig().openrouterKey && !getConfig().mock) {
      const texts = [userMessage?.content ?? '', message.content.slice(0, 4000)].filter(Boolean);
      const vectors = await embed(texts);
      if (vectors) {
        if (userMessage && vectors[0]) await setMessageEmbedding(userMessage.id, vectors[0]);
        if (vectors[texts.length - 1]) await setMessageEmbedding(message.id, vectors[texts.length - 1]);
      }
    }

    // 3. Thread title: cheap, deterministic, and stable after the first turn.
    if (thread && !thread.title && userMessage?.content) {
      await renameThread(thread.id, heuristicTitle(userMessage.content));
    }

    // 4. Rolling summary every ~6 messages, so long threads stay cheap.
    const total = await countMessages(LOCAL_USER);
    if (thread && total % 6 === 0 && getConfig().openrouterKey && !getConfig().mock) {
      try {
        const result = await generateJson<{ summary: string }>({
          model: getConfig().models.utility,
          timeoutMs: 12_000,
          messages: [
            { role: 'system', content: 'Summarise this conversation in at most 3 sentences, preserving concrete facts, names, numbers and dates. JSON: {"summary": "..."}' },
            {
              role: 'user',
              content: recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 800)}`).join('\n\n'),
            },
          ],
        });
        if (result?.summary) await setThreadSummary(thread.id, result.summary.slice(0, 1200));
      } catch {
        /* summary is optional */
      }
    }
  } catch (err) {
    console.error('[postTurn]', err);
  } finally {
    resolvePending(assistantMessageId);
  }
}

export async function ensureUser(userId = LOCAL_USER, tz = 'UTC'): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, timezone) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET timezone = EXCLUDED.timezone`,
    [userId, tz],
  );
}
