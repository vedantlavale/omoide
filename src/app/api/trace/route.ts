import { NextResponse } from 'next/server';
import { getTrace } from '@/server/agent/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('messageId');
  if (!id) return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
  const trace = await getTrace(id);
  if (!trace) return NextResponse.json({ error: 'No trace for that message' }, { status: 404 });
  return NextResponse.json({ trace });
}
