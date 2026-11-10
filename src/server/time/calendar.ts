/**
 * A 14-day calendar is injected into the planner and the answer prompt.
 * Cheap models are much better at "3 November is 7 days ago" when the days are
 * spelled out than when they have to do the arithmetic themselves.
 */

import type { TimeContext } from '../types';
import { addDays, humanDate } from './clock';

export function calendarBlock(ctx: TimeContext, days = 14): string {
  const lines: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(ctx.localDate, -i);
    const offset = i === 0 ? 'today' : i === 1 ? 'yesterday' : `${i} days ago`;
    lines.push(`- ${humanDate(date)} (${date}) — ${offset}`);
  }
  return lines.join('\n');
}

export function timeBlock(ctx: TimeContext): string {
  const tomorrow = addDays(ctx.localDate, 1);
  return [
    `Now: ${ctx.human} (${ctx.tz}). Today is ${ctx.weekdayName}, local date ${ctx.localDate}.`,
    `Tomorrow is ${humanDate(tomorrow)}.`,
    'Recent calendar:',
    calendarBlock(ctx),
  ].join('\n');
}
