import { NextResponse } from 'next/server';
import { configurationProblems, getConfig, providerStatus } from '@/server/config';
import { getTimeContext } from '@/server/time/clock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const config = getConfig();
  const time = getTimeContext();
  return NextResponse.json({
    providers: providerStatus(),
    problems: configurationProblems(),
    mock: config.mock,
    models: { main: config.models.main, utility: config.models.utility },
    today: time.localDate,
    frozenClock: config.frozenNow,
  });
}
