/**
 * The deterministic planner.
 *
 * Two jobs:
 *   1. Fast path for greetings — never spend a model call on "hi".
 *   2. Fallback plan when the planner model is slow, down, or returns
 *      unusable JSON. The turn must never fail because planning failed.
 *
 * The heuristics are also the offline planner (MOCK=1), which is why they are
 * good enough to be worth reading rather than a token gesture.
 */

import type { AnswerShape, Freshness, Intent, Plan } from '../types';
import { findTemporalExpressions } from '../time/resolve';

const GREETING =
  /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening)|thanks|thank you|ty|cheers|ok(ay)?|cool|nice|great|got it|bye|goodbye)( there| again| so much| a lot| buddy| friend)?[\s!.,?]*$/i;

const MEMORY_CUE =
  /\b(what did i (ask|say)|do you remember|remember (when|what|that)|you (said|told|mentioned|recommended)|we (discussed|talked|spoke|shortlisted|decided)|last time|earlier|previously|before|my (previous|last) (question|chat|conversation)|that (answer|chat|conversation)|your (answer|recommendation))\b/i;

const RECHECK_CUE =
  /\b(still (correct|true|accurate|valid|right)|changed since|change since|any change|has .{0,40}changed|have .{0,40}changed|outdated|out of date|update me|price change|pricing change|shipped something|anything new|what'?s new)\b/i;

const VOLATILE =
  /\b(price|pricing|cost|cheapest|plan|tier|subscription|latest|newest|current|version|release|released|news|update|announce|launched|shipped|compare|comparison|best|top \d|review|stock|weather|score|who is|ceo|funding|acquired|hiring|deadline|schedule|available|availability|support|limits?|free tier)\b/i;

const NEWS_CUE = /\b(news|announced|announcement|launched|shipped|released|acquired|funding|this week|since)\b/i;
const TABLE_CUE = /\b(compare|comparison|versus|vs\.?|shortlist|which is better|table|across)\b/i;

const STOP_ENTITIES = new Set(
  'What How Why When Where Which Who The A An Is Are Was Were Do Does Did Can Could Should Would Will Would On In At For To Of And But If Then That This These Those I We You They It My Our Your Their Last Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December Please Tell Give Show'.split(
    ' ',
  ),
);

const TOPIC_STOP = new Set(
  'you your yours the and for with that this these those have has had was were are is be been being on in at of to it its my me i we us our do does did done ask asked say said tell told anything something nothing changed change since then correct still today tonight what when which who how about them their they he she please give show much many does'.split(
    ' ',
  ),
);

/**
 * A topic is only searchable if it survives stop-word removal. This is what
 * stops a memory miss from turning into a web search for "you on".
 */
export function meaningfulTopic(topic: string | null | undefined): string | null {
  if (!topic) return null;
  const words = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s.+-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TOPIC_STOP.has(w));
  return words.length >= 2 ? topic.trim() : null;
}

export function isFastPath(message: string): boolean {
  return GREETING.test(message.trim());
}

export function extractEntities(message: string): string[] {
  const found = new Set<string>();
  for (const m of message.matchAll(/\b([A-Z][A-Za-z0-9.+-]{2,}(?:\s[A-Z][A-Za-z0-9.+-]{2,})?)\b/g)) {
    const value = m[1].trim();
    const first = value.split(/\s+/)[0];
    if (STOP_ENTITIES.has(first)) continue;
    if (first.length < 3) continue;
    found.add(value);
  }
  return [...found].slice(0, 8);
}

/** Remove temporal phrases and filler so the query is what a search engine wants. */
const RECHECK_CLAUSE =
  /\b(has any|have any|has it|have they|did any|is your (answer|reply)|is it still|are they still|still correct|still true|changed since|change since|since then|anything new|what changed)\b/i;

export function topicalQuery(message: string): string {
  let q = message;
  // "…on Monday we shortlisted 5 CRMs. Has any of them changed since?" → keep
  // the subject clause; the second half is the question, not the topic.
  const cut = q.search(RECHECK_CLAUSE);
  if (cut > 8) q = q.slice(0, cut);
  for (const phrase of findTemporalExpressions(q)) {
    q = q.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  q = q
    .replace(/\bhow much (?:does|do|is)\b/gi, ' ')
    .replace(/\bwhat(?:'s| is) the (?:price|cost) of\b/gi, ' ')
    .replace(/\bhow much\b/gi, ' ')
    .replace(/\bcosts?\b/gi, 'price')
    .replace(/\b(is|was) (your|my) (answer|reply) (still )?(correct|true|accurate|valid)( today)?/gi, ' ')
    .replace(/\b(what did i (ask|say)|do you remember|remember when|can you|could you|please|for me|about|tell me|i asked you|i asked|has any of them|has any|still correct|still true|is your answer|my answer)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:-]+/, '')
    .replace(/^(on|and|so|but|we|i|you|it|they|the)\b[\s,]*/i, '')
    .replace(/[\s,.;:-]+$/, '')
    .replace(/^[\s,.;:-]+/, '')
    .trim();
  return q.length > 180 ? q.slice(0, 180).trim() : q;
}

function classifyIntent(input: {
  message: string;
  needsMemory: boolean;
  needsRecheck: boolean;
  needsSearch: boolean;
  table: boolean;
}): Intent {
  if (input.needsRecheck) return 'recheck';
  if (input.needsMemory) return 'memory_recall';
  if (!input.needsSearch) return 'stable_knowledge';
  if (input.table || /\b(research|deep dive|everything about|pros and cons)\b/i.test(input.message)) {
    return 'research';
  }
  return 'web_lookup';
}

export function heuristicPlan(message: string, opts: { hasHistory?: boolean } = {}): Plan {
  const text = message.trim();
  if (isFastPath(text)) {
    return {
      intent: 'chitchat',
      needsSearch: false,
      needsMemory: false,
      needsRecheck: false,
      temporalRefs: [],
      topic: null,
      entities: [],
      queries: [],
      freshness: 'any',
      domainType: 'web',
      answerShape: 'short',
      clarify: null,
      source: 'fast-path',
    };
  }

  const temporalRefs = findTemporalExpressions(text);
  const memoryCue = MEMORY_CUE.test(text);
  const needsRecheck = RECHECK_CUE.test(text);
  const needsMemory = memoryCue || temporalRefs.length > 0 || (needsRecheck && Boolean(opts.hasHistory));
  const volatile = VOLATILE.test(text);
  const news = NEWS_CUE.test(text);
  const table = TABLE_CUE.test(text);

  // A pure memory question ("what did I ask on 3 Nov") needs no search. A
  // re-check does. Anything volatile does.
  // Heuristics stay conservative: only search when the fact can move. The
  // planner model handles the nuance; this path is the fallback and the
  // offline mode, where a wrong extra search is worse than a fast answer.
  const needsSearch = needsRecheck || volatile;
  const topic = topicalQuery(text) || null;
  const queries = needsSearch && topic ? [topic] : [];

  let freshness: Freshness = 'any';
  if (news) freshness = 'week';
  else if (/\b(latest|newest|current|today|this week)\b/i.test(text)) freshness = 'month';

  const answerShape: AnswerShape = needsRecheck ? 'change_report' : table ? 'table' : needsSearch ? 'detailed' : 'short';

  return {
    intent: classifyIntent({ message: text, needsMemory, needsRecheck, needsSearch, table }),
    needsSearch,
    needsMemory,
    needsRecheck,
    temporalRefs,
    topic,
    entities: extractEntities(text),
    queries: queries.slice(0, 3),
    freshness,
    domainType: news ? 'news' : 'web',
    answerShape,
    clarify: null,
    source: 'heuristic',
  };
}

/**
 * Follow-ups like "what about their enterprise plan?" are meaningless as a
 * search query. When the planner is unavailable we prepend the previous user
 * turn, which is a crude but surprisingly effective query rewrite.
 */
export function rewriteFollowUp(message: string, previousUserMessage: string | null): string {
  if (!previousUserMessage) return message;
  const pronounStart = /^(what about|and|how about|what if|does it|do they|is it|are they|their|its|they)\b/i;
  if (!pronounStart.test(message.trim())) return message;
  return `${topicalQuery(previousUserMessage)} — ${message}`;
}
