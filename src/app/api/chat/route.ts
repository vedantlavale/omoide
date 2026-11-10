import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { z } from 'zod';
import { runTurn } from '@/server/agent/orchestrator';
import { postTurn } from '@/server/memory/write';
import { configurationProblems } from '@/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Body = z.object({
  message: z.string().min(1).max(6000),
  threadId: z.string().max(100).optional().nullable(),
  tz: z.string().max(100).optional().nullable(),
  // Sent for diagnostics only; the server clock always wins.
  clientNow: z.string().max(100).optional().nullable(),
});

export async function POST(req: Request) {
  const problems = configurationProblems();
  if (problems.length) {
    return NextResponse.json({ error: 'Configuration incomplete', problems }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });
  }

  const { message, threadId, tz } = parsed.data;

  // Registered here, in request scope, so Next can run it after the response.
  // The generator resolves this promise when the turn is saved.
  let releaseTurn: () => void = () => {};
  const turnSaved = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });

  let assistantMessageId: string | null = null;
  const encoder = new TextEncoder();

  after(async () => {
    await Promise.race([
      turnSaved,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 45_000);
        t.unref?.();
      }),
    ]);
    if (assistantMessageId) await postTurn(assistantMessageId);
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        for await (const event of runTurn({
          threadId,
          message,
          tz,
          signal: req.signal,
        })) {
          if (event.type === 'done') assistantMessageId = event.messageId;
          send(event);
        }
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : 'The turn failed unexpectedly.',
        });
      } finally {
        releaseTurn();
        controller.close();
      }
    },
    cancel() {
      releaseTurn();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
