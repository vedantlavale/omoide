/**
 * Shared types. These are deliberately small and serialisable: everything that
 * crosses a module boundary is plain data, which keeps the pipeline testable.
 */

export type Intent =
  | 'chitchat'
  | 'stable_knowledge'
  | 'web_lookup'
  | 'research'
  | 'memory_recall'
  | 'recheck';

export type Freshness = 'any' | 'year' | 'month' | 'week' | 'day';
export type AnswerShape = 'short' | 'detailed' | 'table' | 'change_report';

/** What the planner model returns. It never contains concrete dates. */
export interface Plan {
  intent: Intent;
  needsSearch: boolean;
  needsMemory: boolean;
  needsRecheck: boolean;
  /** Raw phrases only, e.g. ["last Tuesday"]. Resolved by code, never by the model. */
  temporalRefs: string[];
  topic: string | null;
  entities: string[];
  /** Standalone, de-referenced search queries. */
  queries: string[];
  freshness: Freshness;
  domainType: 'web' | 'news';
  answerShape: AnswerShape;
  clarify: string | null;
  /** Which planner produced this: a model, the deterministic fallback, or the fast path. */
  source: 'model' | 'heuristic' | 'fast-path';
}

/** A resolved slice of the user's local calendar. Dates are inclusive, YYYY-MM-DD. */
export interface DateRange {
  from: string;
  to: string;
  label: string;
  localDates: string[];
}

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

export interface EvidenceSource {
  /** Citation id, stable for the whole turn: S1, S2, … */
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  site: string;
  publishedAt?: string | null;
  fetchedAt: string;
  /** Up to 3 short passages selected for the query. */
  passages: string[];
  /** True when we only have a search snippet (fetch failed or timed out). */
  snippetOnly: boolean;
  contentHash?: string | null;
  etag?: string | null;
  lastModified?: string | null;
}

export interface StoredClaim {
  id: string;
  entity: string;
  attribute: string;
  value: string;
  unit: string | null;
  qualifier: string | null;
  quote: string;
  sourceUrl: string | null;
  observedAt: string;
  localDate: string;
}

export interface MemoryMatch {
  threadId: string;
  threadTitle: string;
  /** Local date of the matched turn, YYYY-MM-DD. */
  date: string;
  userText: string;
  assistantText: string;
  messageId: string;
  claims: StoredClaim[];
  score?: number;
}

export interface MemoryContext {
  matches: MemoryMatch[];
  /** Which lookup actually produced the matches — surfaced to the model so it can disclose. */
  strategy: 'exact-date' | 'nearby-date' | 'topic' | 'thread-context' | 'none';
  /** The dates we looked for, as local YYYY-MM-DD. */
  searchedDates: string[];
  /** True when the exact range was empty and we widened it by a day. */
  widened: boolean;
}

export type ClaimStatus = 'unchanged' | 'changed' | 'not_found' | 'unverifiable';

export interface ClaimCheck {
  claim: StoredClaim;
  status: ClaimStatus;
  newValue: string | null;
  evidenceUrl: string | null;
  note: string | null;
  /** How we decided: conditional HTTP 304, identical content hash, LLM verification, or a search. */
  method: 'etag' | 'hash' | 'llm' | 'search' | 'none';
}

export interface ChangeReport {
  checkedAt: string;
  sinceDate: string | null;
  checks: ClaimCheck[];
  news: Array<{ title: string; url: string; site: string; publishedAt?: string | null; snippet: string }>;
  /** Number of claims we could not check at all. */
  unverified: number;
}

export interface TraceStep {
  name: string;
  ms: number;
  detail?: Record<string, unknown>;
}

export interface TurnTrace {
  plan: Plan;
  resolvedRanges: Array<{ from: string; to: string; label: string }>;
  memoryStrategy: MemoryContext['strategy'];
  memoryMatches: number;
  queries: string[];
  providers: string[];
  cacheHits: number;
  sources: number;
  followUpSearches: number;
  steps: TraceStep[];
  totalMs: number;
  usage: { inputTokens: number; outputTokens: number };
  errors: string[];
}
