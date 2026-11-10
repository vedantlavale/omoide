import { NextResponse } from 'next/server';
import { resetDemo } from '@/server/demo/seed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const removed = await resetDemo();
  return NextResponse.json({ ok: true, removed });
}
