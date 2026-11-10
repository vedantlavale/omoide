/**
 * The temporal resolver.
 *
 * The LLM returns raw phrases ("last Tuesday", "3 November"). This file turns
 * them into concrete local dates. It is deliberately deterministic: weekday
 * arithmetic is where language models silently go wrong, and "what did I ask
 * you on 3 November" is a database lookup, not a reasoning problem.
 */

import type { DateRange, TimeContext } from '../types';
import { addDays, humanDate, longDate, MONTHS, weekdayOf } from './clock';

const WEEKDAY_RE =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday';

const MONTH_ALT =
  'january|february|march|april|may|june|july|august|september|october|november|december|' +
  'jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';

function monthIndex(name: string): number {
  const key = name.toLowerCase().replace(/\.$/, '').slice(0, 3);
  const i = MONTHS.findIndex((m) => m.toLowerCase().slice(0, 3) === key);
  return i;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function makeDate(y: number, m: number, d: number): string | null {
  if (m < 0 || m > 11) return null;
  const max = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (d < 1 || d > max) return null;
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function range(from: string, to: string, label: string): DateRange {
  const localDates: string[] = [];
  let cur = from;
  // Guard against absurd ranges from bad input.
  for (let i = 0; i < 62 && cur <= to; i++) {
    localDates.push(cur);
    cur = addDays(cur, 1);
  }
  return { from, to, label, localDates };
}

function dayRange(dateStr: string, ctx: TimeContext): DateRange {
  const label = `${humanDate(dateStr)}${dateStr === ctx.localDate ? ' (today)' : ''}`;
  return { from: dateStr, to: dateStr, label, localDates: [dateStr] };
}

function rangeLabel(from: string, to: string, name: string): string {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fy === ty && fm === tm) {
    return `${fd}–${td} ${MONTHS[fm - 1].slice(0, 3)} ${fy} (${name})`;
  }
  return `${longDate(from)} – ${longDate(to)} (${name})`;
}

/** Monday of the week containing `dateStr` (weeks start Monday). */
function mondayOf(dateStr: string): string {
  const wd = weekdayOf(dateStr); // 0 = Sunday
  const offset = (wd + 6) % 7;
  return addDays(dateStr, -offset);
}

function mostRecentDay(d: number, ctx: TimeContext, strictPast: boolean): string {
  const today = ctx.localDate;
  const [y, m] = today.split('-').map(Number);
  let candidate = makeDate(y, m - 1, d) ?? addDays(today, 0);
  if (candidate > today) {
    candidate = makeDate(y, m - 2, d) ?? candidate;
  }
  if (strictPast && candidate === today) {
    candidate = makeDate(y, m - 2, d) ?? candidate;
  }
  return candidate;
}

function resolveWeekday(modifier: string | undefined, name: string, ctx: TimeContext): DateRange {
  const target = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(
    name,
  );
  const today = ctx.localDate;
  const delta = (ctx.weekday - target + 7) % 7;

  if (modifier === 'next') {
    const forward = (target - ctx.weekday + 7) % 7 || 7;
    return dayRange(addDays(today, forward), ctx);
  }
  if (modifier === 'this') {
    const monday = mondayOf(today);
    let candidate = addDays(monday, (target + 6) % 7);
    if (candidate > today) candidate = addDays(candidate, -7);
    return dayRange(candidate, ctx);
  }
  if (modifier === 'last' || modifier === 'past') {
    return dayRange(addDays(today, -(delta === 0 ? 7 : delta)), ctx);
  }
  // bare weekday, or "on Monday": the most recent one, today included.
  return dayRange(addDays(today, -delta), ctx);
}

/**
 * Find every temporal expression in a piece of text. Used by the heuristic
 * planner fallback and by the deterministic tests.
 */
export function findTemporalExpressions(text: string): string[] {
  const lower = text.toLowerCase();
  const spans: Array<{ start: number; end: number; text: string; priority: number }> = [];

  const patterns: RegExp[] = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\bday before yesterday\b/g,
    /\b(yesterday|today|tonight)\b/g,
    new RegExp(`\\b(last|this|on|past|next)\\s+(?:a\\s+)?(${WEEKDAY_RE})\\b`, 'g'),
    new RegExp(`\\b(${WEEKDAY_RE})\\b`, 'g'),
    /\b(last|past|this)\s+(week|month|year)\b/g,
    /\b(\d+|a few|few|several)\s+days?\s+ago\b/g,
    /\b(recently|lately|the other day)\b/g,
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})[a-z]*\\.?(?:\\s+(\\d{4}))?\\b`, 'g'),
    new RegExp(`\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'g'),
    /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/g,
  ];

  for (const re of patterns) {
    for (const m of lower.matchAll(re)) {
      const start = m.index ?? 0;
      spans.push({ start, end: start + m[0].length, text: m[0].trim(), priority: 0 });
    }
  }

  // "last Tuesday" also matches the bare-weekday pattern. Keep the longest
  // (most specific) match and drop anything fully contained inside it.
  spans.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const accepted: typeof spans = [];
  for (const s of spans) {
    if (accepted.some((a) => s.start >= a.start && s.end <= a.end)) continue;
    accepted.push(s);
  }
  accepted.sort((a, b) => a.start - b.start);
  return [...new Set(accepted.map((s) => s.text.replace(/^on\s+/, '')))];
}

function resolveOne(raw: string, ctx: TimeContext): DateRange[] {
  const text = raw.toLowerCase().trim();
  const out: DateRange[] = [];
  const today = ctx.localDate;

  // Absolute ISO date: 2026-11-03
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const date = makeDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (date) out.push(dayRange(date, ctx));
  }

  if (/\bday before yesterday\b/.test(text)) out.push(dayRange(addDays(today, -2), ctx));
  if (/\byesterday\b/.test(text)) out.push(dayRange(addDays(today, -1), ctx));
  if (/\btoday\b|\btonight\b/.test(text)) out.push(dayRange(today, ctx));

  for (const m of text.matchAll(new RegExp(`\\b(last|this|on|past|next)\\s+(?:a\\s+)?(${WEEKDAY_RE})\\b`, 'g'))) {
    out.push(resolveWeekday(m[1], m[2], ctx));
  }
  // Bare weekdays, only where no modifier already consumed them.
  for (const m of text.matchAll(new RegExp(`\\b(${WEEKDAY_RE})\\b`, 'g'))) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (/\b(last|this|on|past|next)\s+(?:a\s+)?$/.test(before)) continue;
    out.push(resolveWeekday(undefined, m[1], ctx));
  }

  for (const m of text.matchAll(/\b(last|past|this)\s+(week|month|year)\b/g)) {
    const which = m[1];
    const unit = m[2];
    if (unit === 'week' && which === 'last') {
      const start = addDays(mondayOf(today), -7);
      out.push(range(start, addDays(start, 6), 'last week'));
    } else if (unit === 'week' && which === 'past') {
      out.push(range(addDays(today, -6), today, 'past week'));
    } else if (unit === 'week' && which === 'this') {
      out.push(range(mondayOf(today), today, 'this week'));
    } else if (unit === 'month' && which === 'last') {
      const [y, mo] = today.split('-').map(Number);
      const from = makeDate(y, mo - 2, 1);
      if (from) {
        const lastDay = new Date(Date.UTC(y, mo - 1, 0)).getUTCDate();
        const to = makeDate(y, mo - 2, lastDay);
        if (to) out.push(range(from, to, 'last month'));
      }
    } else if (unit === 'month' && which === 'this') {
      const [y, mo] = today.split('-').map(Number);
      const from = makeDate(y, mo - 1, 1);
      if (from) out.push(range(from, today, 'this month'));
    } else if (unit === 'year' && which === 'last') {
      const y = Number(today.slice(0, 4));
      out.push(range(`${y - 1}-01-01`, `${y - 1}-12-31`, 'last year'));
    } else if (unit === 'year' && which === 'this') {
      const y = Number(today.slice(0, 4));
      out.push(range(`${y}-01-01`, today, 'this year'));
    }
  }

  for (const m of text.matchAll(/\b(\d+|a few|few|several)\s+days?\s+ago\b/g)) {
    if (/^\d+$/.test(m[1])) {
      out.push(dayRange(addDays(today, -Number(m[1])), ctx));
    } else {
      out.push(range(addDays(today, -5), addDays(today, -1), 'a few days ago'));
    }
  }

  if (/\b(recently|lately|the other day)\b/.test(text)) {
    out.push(range(addDays(today, -13), today, 'recently'));
  }

  const hasMonth = new RegExp(`(${MONTH_ALT})`).test(text);
  if (hasMonth) {
    // "3 November", "3rd of Nov 2026"
    for (const m of text.matchAll(
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})[a-z]*\\.?(?:\\s+(\\d{4}))?\\b`, 'g'),
    )) {
      const mi = monthIndex(m[2]);
      const day = Number(m[1]);
      let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
      let date = makeDate(year, mi, day);
      if (!date) continue;
      if (!m[3] && date > today) date = makeDate(year - 1, mi, day) ?? date;
      out.push(dayRange(date, ctx));
    }
    // "November 3", "Nov 3rd, 2026"
    for (const m of text.matchAll(
      new RegExp(`\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'g'),
    )) {
      const mi = monthIndex(m[1]);
      const day = Number(m[2]);
      let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
      let date = makeDate(year, mi, day);
      if (!date) continue;
      if (!m[3] && date > today) date = makeDate(year - 1, mi, day) ?? date;
      out.push(dayRange(date, ctx));
    }
  } else {
    // "the 3rd" with no month: most recent past occurrence of that day-of-month.
    for (const m of text.matchAll(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/g)) {
      out.push(dayRange(mostRecentDay(Number(m[1]), ctx, true), ctx));
    }
  }

  return out;
}

/**
 * Resolve raw phrases into unique date ranges, preserving order.
 */
export function resolveTemporal(phrases: string[], ctx: TimeContext): DateRange[] {
  const seen = new Set<string>();
  const out: DateRange[] = [];
  const list = phrases.length ? phrases : [];
  for (const phrase of list) {
    for (const r of resolveOne(phrase, ctx)) {
      const key = `${r.from}|${r.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

export { rangeLabel };
