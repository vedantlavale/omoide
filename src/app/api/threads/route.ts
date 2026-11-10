import { NextResponse } from 'next/server';
import { deleteThread, getThread, listMessages, listThreads } from '@/server/memory/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id) {
    const threads = await listThreads();
    return NextResponse.json({
      threads: threads.map((t) => ({
        id: t.id,
        title: t.title ?? 'New chat',
        summary: t.summary,
        createdAt: iso(t.created_at),
        updatedAt: iso(t.updated_at),
        isDemo: t.is_demo,
      })),
    });
  }

  const thread = await getThread(id);
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  const messages = await listMessages(id, 200);

  return NextResponse.json({
    thread: {
      id: thread.id,
      title: thread.title ?? 'New chat',
      summary: thread.summary,
      createdAt: iso(thread.created_at),
      updatedAt: iso(thread.updated_at),
      isDemo: thread.is_demo,
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: iso(m.created_at),
      localDate: m.local_date,
      sources: m.sources ?? [],
      plan: m.plan ?? null,
    })),
  });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  await deleteThread(id);
  return NextResponse.json({ ok: true });
}
