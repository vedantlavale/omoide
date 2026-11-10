import { describe, expect, it } from 'vitest';
import { addDays, getTimeContext, humanDate, localDateString } from '../src/server/time/clock';
import { findTemporalExpressions, resolveTemporal } from '../src/server/time/resolve';

/**
 * The reference date from the task: today is Tuesday 2026-11-10.
 * These tests are the contract that "last Tuesday" and "3 November" mean the
 * same day, in the user's timezone.
 */
const NOW = new Date('2026-11-10T15:00:00Z'); // 20:30 in Asia/Kolkata

function ctx(tz = 'Asia/Kolkata', now = NOW) {
  return getTimeContext({ tz, now });
}

function one(phrase: string, tz = 'Asia/Kolkata', now = NOW) {
  const ranges = resolveTemporal([phrase], ctx(tz, now));
  expect(ranges.length).toBeGreaterThan(0);
  return ranges[0];
}

describe('timezone-aware local dates', () => {
  it('uses the user timezone, not UTC', () => {
    // 20:00 UTC is already the next day in Kolkata.
    const late = new Date('2026-11-10T20:00:00Z');
    expect(localDateString(late, 'Asia/Kolkata')).toBe('2026-11-11');
    expect(localDateString(late, 'UTC')).toBe('2026-11-10');
  });

  it('formats a human date deterministically', () => {
    expect(humanDate('2026-11-03')).toBe('Tue 3 Nov 2026');
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('resolveTemporal — the dataset questions', () => {
  it('resolves "last Tuesday" to 3 November (the task reference date)', () => {
    const r = one('last Tuesday');
    expect(r.from).toBe('2026-11-03');
    expect(r.to).toBe('2026-11-03');
  });

  it('resolves "3 November" to the same day', () => {
    const r = one('3 November');
    expect(r.from).toBe('2026-11-03');
  });

  it('resolves "Monday" to 9 November', () => {
    const r = one('On Monday we shortlisted 5 CRM tools');
    expect(r.from).toBe('2026-11-09');
  });

  it('resolves "last Tuesday" correctly when today is a different weekday', () => {
    const wednesday = new Date('2026-11-11T09:00:00Z');
    expect(one('last Tuesday', 'Asia/Kolkata', wednesday).from).toBe('2026-11-10');
  });
});

describe('resolveTemporal — phrases', () => {
  it.each([
    ['yesterday', '2026-11-09'],
    ['today', '2026-11-10'],
    ['Nov 3', '2026-11-03'],
    ['3rd of November', '2026-11-03'],
    ['November 3, 2025', '2025-11-03'],
    ['2026-11-03', '2026-11-03'],
    ['the 3rd', '2026-11-03'],
    ['2 days ago', '2026-11-08'],
  ])('%s → %s', (phrase, expected) => {
    expect(one(phrase).from).toBe(expected);
  });

  it('treats a bare weekday as today when today is that weekday', () => {
    const monday = new Date('2026-11-09T09:00:00Z');
    expect(one('Monday', 'Asia/Kolkata', monday).from).toBe('2026-11-09');
  });

  it('rolls "3 November" back a year when it has not happened yet', () => {
    const january = new Date('2026-01-15T09:00:00Z');
    expect(one('3 November', 'Asia/Kolkata', january).from).toBe('2025-11-03');
  });

  it('resolves "last week" to the previous Monday–Sunday', () => {
    const r = one('last week');
    expect(r.from).toBe('2026-11-02');
    expect(r.to).toBe('2026-11-08');
    expect(r.localDates).toHaveLength(7);
  });

  it('resolves "a few days ago" as a range, not a point', () => {
    const r = one('a few days ago');
    expect(r.from).toBe('2026-11-05');
    expect(r.to).toBe('2026-11-09');
  });

  it('resolves "recently" to the last 14 local days', () => {
    const r = one('recently');
    expect(r.from).toBe('2026-10-28');
    expect(r.to).toBe('2026-11-10');
  });
});

describe('temporal extraction', () => {
  it('does not double-count "last Tuesday" as a bare weekday', () => {
    expect(findTemporalExpressions('Last Tuesday I asked you about Postgres hosting')).toEqual([
      'last tuesday',
    ]);
  });

  it('finds multiple references in one message', () => {
    const found = findTemporalExpressions('On Monday I compared prices, and yesterday I checked again');
    expect(found).toContain('monday');
    expect(found).toContain('yesterday');
  });

  it('resolves multiple expressions without duplicates', () => {
    const ranges = resolveTemporal(['last Tuesday', '3 November'], ctx());
    expect(ranges).toHaveLength(1);
  });
});
