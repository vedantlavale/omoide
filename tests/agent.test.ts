import { describe, expect, it } from 'vitest';
import { heuristicPlan, isFastPath, rewriteFollowUp, topicalQuery } from '../src/server/agent/heuristics';
import { verifyHeuristically } from '../src/server/memory/recheck';
import type { StoredClaim } from '../src/server/types';

describe('planner fast path', () => {
  it('handles greetings without a model call', () => {
    expect(isFastPath('hi')).toBe(true);
    expect(isFastPath('Thanks!')).toBe(true);
    expect(isFastPath('what did I ask you last Tuesday?')).toBe(false);
  });
});

describe('heuristic plan (also the offline planner)', () => {
  it('classifies chit-chat', () => {
    const plan = heuristicPlan('hey there');
    expect(plan.intent).toBe('chitchat');
    expect(plan.needsSearch).toBe(false);
    expect(plan.source).toBe('fast-path');
  });

  it('classifies "what did I ask on 3 November" as memory, not search', () => {
    const plan = heuristicPlan('What did I ask you on 3 November?');
    expect(plan.intent).toBe('memory_recall');
    expect(plan.needsMemory).toBe(true);
    expect(plan.needsSearch).toBe(false);
    expect(plan.temporalRefs).toContain('3 november');
  });

  it('classifies a re-check of last Tuesday as memory + re-check + search', () => {
    const plan = heuristicPlan(
      'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    );
    expect(plan.intent).toBe('recheck');
    expect(plan.needsMemory).toBe(true);
    expect(plan.needsRecheck).toBe(true);
    expect(plan.needsSearch).toBe(true);
    expect(plan.answerShape).toBe('change_report');
    expect(plan.temporalRefs).toContain('last tuesday');
  });

  it('forces a search for volatile facts', () => {
    expect(heuristicPlan('What are the latest Next.js version numbers?').needsSearch).toBe(true);
    expect(heuristicPlan('What is the capital of France?').needsSearch).toBe(false);
  });

  it('extracts a clean topical query', () => {
    expect(topicalQuery('Last Tuesday I asked you about Postgres hosting')).toContain('Postgres hosting');
    expect(topicalQuery('Last Tuesday I asked you about Postgres hosting')).not.toContain('Last Tuesday');
  });

  it('rewrites pronoun follow-ups against the previous turn', () => {
    const rewritten = rewriteFollowUp('what about their enterprise plan?', 'Compare HubSpot and Pipedrive pricing');
    expect(rewritten).toContain('HubSpot');
    expect(rewriteFollowUp('What is the weather?', 'Compare HubSpot pricing')).toBe('What is the weather?');
  });
});

describe('re-check heuristic', () => {
  const claim: StoredClaim = {
    id: 'c1',
    entity: 'Neon',
    attribute: 'Launch plan price',
    value: '$19',
    unit: 'USD',
    qualifier: null,
    quote: 'Launch — $19/month',
    sourceUrl: 'https://neon.com/pricing',
    observedAt: new Date().toISOString(),
    localDate: '2026-11-03',
  };

  it('reports an unchanged price when the value is still present', () => {
    expect(verifyHeuristically(claim, 'Launch plan: $19 per month, 10 GB storage').status).toBe('unchanged');
  });

  it('reports a changed price with the new value', () => {
    const result = verifyHeuristically(claim, 'Launch plan: $25 per month, 10 GB storage');
    expect(result.status).toBe('changed');
    expect(result.newValue).toBe('$25');
  });

  it('does not treat a missing mention as a change', () => {
    expect(verifyHeuristically(claim, 'Neon is a serverless Postgres platform.').status).toBe('not_found');
  });
});
