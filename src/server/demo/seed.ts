/**
 * Demo history.
 *
 * Seeding is opt-in and happens *inside the running app process*, because
 * PGlite allows exactly one process per data directory. A separate
 * `npm run seed` process would lock or corrupt the reviewer's dev database.
 *
 * The seed runs real turns through the real pipeline, then backdates them, so
 * the claims, sources and re-check behaviour the reviewer sees are genuine.
 */

import { randomUUID } from 'node:crypto';
import { runTurn } from '../agent/orchestrator';
import { getTimeContext, addDays, weekdayOf } from '../time/clock';
import { clearDemo, ensureThread } from '../memory/repo';
import { postTurn } from '../memory/write';

export interface SeedEvent {
  type: 'progress' | 'done' | 'error';
  text?: string;
  threads?: number;
}

function previousWeekday(today: string, weekday: number): string {
  const delta = (weekdayOf(today) - weekday + 7) % 7 || 7;
  return addDays(today, -delta);
}

function scenarios(today: string) {
  const lastTuesday = previousWeekday(today, 2);
  const monday = previousWeekday(today, 1);
  const friday = previousWeekday(today, 5);
  return [
    {
      id: randomUUID(),
      title: 'Managed Postgres pricing',
      localDate: lastTuesday,
      message:
        'Compare managed Postgres hosting pricing for a small app: Neon, Supabase, AWS RDS, Render and Railway. Include the entry paid plan and what it includes.',
    },
    {
      id: randomUUID(),
      title: 'Next.js 16 changes',
      localDate: friday,
      message: "What's the latest Next.js version, and what changed in it?",
    },
    {
      id: randomUUID(),
      title: 'CRM shortlist for a 20-person team',
      localDate: monday,
      message:
        "We're a 20-person sales team. Shortlist 5 CRMs with pricing, and tell me which is cheapest per seat.",
    },
  ];
}

export async function* seedDemo(): AsyncGenerator<SeedEvent> {
  const time = getTimeContext();
  const plan = scenarios(time.localDate);
  let created = 0;

  for (const [index, scenario] of plan.entries()) {
    yield {
      type: 'progress',
      text: `Researching ${scenario.title} (${index + 1}/${plan.length})…`,
    };

    const thread = await ensureThread({ id: scenario.id, title: scenario.title, isDemo: true });
    const createdAt = `${scenario.localDate}T09:30:00.000Z`;
    await ensureThread({ id: thread.id, title: scenario.title, isDemo: true });

    try {
      let assistantId: string | null = null;
      for await (const event of runTurn({
        threadId: thread.id,
        message: scenario.message,
        tz: time.tz,
        signal: new AbortController().signal,
        isDemo: true,
        backdate: { localDate: scenario.localDate, createdAt },
      })) {
        if (event.type === 'done') assistantId = event.messageId;
        if (event.type === 'error') throw new Error(event.message);
      }
      if (assistantId) await postTurn(assistantId);
      created++;
      yield { type: 'progress', text: `Saved “${scenario.title}” on ${scenario.localDate}.` };
    } catch (err) {
      yield {
        type: 'error',
        text: `Could not seed “${scenario.title}”: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }
  }

  yield { type: 'done', threads: created };
}

export async function resetDemo(): Promise<number> {
  return clearDemo();
}
