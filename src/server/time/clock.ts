/**
 * The clock. Two rules matter here:
 *   1. Every timestamp we store is UTC.
 *   2. Every *date the user means* is a local date in the user's timezone.
 *
 * Mixing those up is the classic bug behind "I asked you yesterday" failing at
 * 11pm. We store `local_date` on each message at write time so an exact-date
 * lookup is an indexed equality query, not a range scan over UTC.
 */

export interface TimeContext {
  now: Date;
  tz: string;
  /** Today in the user's timezone, YYYY-MM-DD. */
  localDate: string;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  weekdayName: string;
  /** "Tuesday 10 November 2026, 20:30" in the user's timezone. */
  human: string;
}

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "now" is injectable so evals and the demo are reproducible. */
export function now(): Date {
  const frozen = process.env.AGENT_NOW?.trim();
  if (frozen) {
    const d = new Date(frozen);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function localDateString(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function getTimeContext(input: { tz?: string | null; now?: Date } = {}): TimeContext {
  const tz = isValidTimezone(input.tz) ? input.tz : 'UTC';
  const at = input.now ?? now();
  const localDate = localDateString(at, tz);
  const weekday = weekdayOf(localDate);
  const human = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return { now: at, tz, localDate, weekday, weekdayName: WEEKDAYS[weekday], human };
}

/** Monday-start week index, used by "this week" / "last week". */
export function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** "Tue 3 Nov 2026" — short, unambiguous, used in prompts and memory blocks. */
export function humanDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WEEKDAYS[weekdayOf(dateStr)].slice(0, 3);
  return `${wd} ${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

export function longDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
