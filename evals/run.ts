/**
 * Scenario runner.
 *
 * Each scenario is a fresh database, a fixed clock, optional backdated seed
 * turns, and a scripted conversation. Deterministic assertions check the
 * behaviours the architecture is supposed to guarantee (searched or not, dates
 * mentioned, citations valid, no invented memory). An optional LLM judge scores
 * quality when a real model key is present.
 *
 *   npm run eval                 → offline, deterministic (MOCK=1)
 *   EVAL_LIVE=1 npm run eval     → real models and search (costs tokens)
 */

import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDotEnv } from '../scripts/load-env';

loadDotEnv();
import { runTurn } from '../src/server/agent/orchestrator';
import { postTurn } from '../src/server/memory/write';
import { closeDb, getDb } from '../src/server/db/client';
import { insertClaims, insertMessage, ensureThread } from '../src/server/memory/repo';
import { generateJson, decide, type DecisionAnswer } from '../src/server/llm/openrouter';
import { getConfig, resetConfigCache } from '../src/server/config';

interface Scenario {
  id: string;
  category: string;
  now: string;
  tz: string;
  seedTurns?: Array<{ localDate: string; message: string }>;
  seedClaimTurns?: Array<{
    localDate: string;
    userText: string;
    assistantText: string;
    claims: Array<{ entity: string; attribute: string; value: string; unit?: string; sourceUrl: string }>;
  }>;
  turns: string[];
  expect: {
    searched?: boolean;
    cites?: boolean;
    mentionsDate?: string;
    noInventedMemory?: boolean;
    containsAny?: string[];
    notContains?: string[];
    queriesInclude?: string;
  };
  judge?: string;
}

interface Result {
  id: string;
  category: string;
  pass: boolean;
  failures: string[];
  answer: string;
  ms: number;
  sources: number;
  judgeVerdicts?: JudgeVerdict[];
  judgeFlags?: string[];
}

/** One judge's verdict on one answer. */
interface JudgeVerdict {
  model: string;
  /** 1–5 level, derived from the raw score. */
  level: number;
  /** Raw output: score expectation (decision models) or the text judge's 1–5. */
  raw: number;
  confidence: number;
  kind: 'decisions' | 'text';
  /** USD charged by OpenRouter for this verdict, when reported. */
  cost?: number;
}

const LIVE = process.env.EVAL_LIVE === '1';
if (!LIVE) process.env.MOCK = '1';
// Evals always run on throwaway embedded databases (.data/eval/<scenario>), one
// per scenario. They must never touch a hosted DATABASE_URL: that would share
// state across scenarios and write eval data into a real deployment.
delete process.env.DATABASE_URL;

const REPORT = path.join(process.cwd(), 'evals', 'report.json');

/**
 * The judge panel: every model in JUDGE_MODELS grades the same answer.
 *
 * Decision models are asked a typed "score" question (1–5 legend) and answer
 * with a probability-weighted score — a verdict with a confidence, not prose.
 * Any model the decisions endpoint rejects falls back to the text-judge path
 * (a plain chat model returning {"score":1-5}), so the panel is agnostic:
 * decision models, text models, or a mix both work.
 *
 * Judges grade on top of the deterministic assertions. The panel fails a
 * scenario only when every judge scores < 3 — a single low verdict at low
 * confidence is noise, and is recorded as a dissent flag instead. When judges
 * disagree by ≥ 2 levels the result is flagged (⚑) rather than failed.
 */

const LEVEL_CRITERIA = [
  '1 - The answer is wrong, invented, or contradicts the conversation.',
  '2 - The answer is largely unsupported or evades the question.',
  '3 - The answer is partly right but has real gaps, missing citations, or unstated assumptions.',
  '4 - The answer is correct and grounded with only minor issues.',
  '5 - The answer is correct, grounded, concise, honest about uncertainty, and cites where it should.',
];

const SCORE_QUESTION = {
  quality: {
    type: 'score',
    instructions:
      'Grade the ANSWER against the RUBRIC and the conversation it belongs to. Judge only what the ANSWER itself says: groundedness, correctness, honesty about what was not verified.',
    criteria: LEVEL_CRITERIA,
  },
} as const;

const TEXT_JUDGE_SYSTEM =
  'You grade an assistant answer. Return JSON {"score":<1-5 integer>,"reason":"<max 20 words>"}. 5 = grounded, correct, concise, honest about uncertainty.';

const DEFAULT_RUBRIC =
  'Grade a research assistant answer to one user question: is it grounded in the provided evidence/memory, correct, concise, honest about what was not verified, and free of invented facts or citations?';

/** Remember per model whether the decisions endpoint works, so we do not re-probe every scenario. */
const judgeKind = new Map<string, 'decisions' | 'text'>();

function levelFromRaw(raw: number): number {
  return Math.min(5, Math.max(1, Math.round(raw) + 1));
}

async function judgeViaDecisions(model: string, state: string): Promise<JudgeVerdict | null> {
  const result = await decide({ model, state, questions: SCORE_QUESTION, timeoutMs: 30_000 });
  const answer: DecisionAnswer | undefined = result.answers?.quality;
  if (!answer || typeof answer.score !== 'number') return null;
  return {
    model,
    kind: 'decisions',
    raw: answer.score,
    level: levelFromRaw(answer.score),
    confidence: answer.confidence ?? 0,
    cost: result.usage.cost,
  };
}

async function judgeViaTextModel(model: string, rubric: string, answer: string): Promise<JudgeVerdict | null> {
  const judged = await generateJson<{ score: number; reason: string }>({
    model,
    timeoutMs: 30_000,
    messages: [
      { role: 'system', content: TEXT_JUDGE_SYSTEM },
      { role: 'user', content: `Rubric: ${rubric}\n\nANSWER:\n${answer}` },
    ],
  });
  const score = Number(judged.score);
  if (!Number.isFinite(score)) return null;
  const level = Math.min(5, Math.max(1, Math.round(score)));
  return { model, kind: 'text', raw: score, level, confidence: 0 };
}

async function judgeWithModel(model: string, rubric: string, answer: string): Promise<JudgeVerdict | null> {
  const state = `RUBRIC:\n${rubric}\n\nANSWER:\n${answer}`;
  const known = judgeKind.get(model);
  if (known !== 'text') {
    try {
      const verdict = await judgeViaDecisions(model, state);
      judgeKind.set(model, 'decisions');
      return verdict;
    } catch {
      // Known decisions model + failure here = transient; skip rather than mis-route.
      if (known === 'decisions') return null;
      judgeKind.set(model, 'text'); // first probe rejected → grade as a text model from now on
    }
  }
  try {
    return await judgeViaTextModel(model, rubric, answer);
  } catch {
    return null; // judge is advisory; a failed judge is not a failed scenario
  }
}

async function judgeAnswer(input: { rubric: string; answer: string }): Promise<JudgeVerdict[]> {
  const models = getConfig().models.judges;
  const verdicts = await Promise.all(models.map((m) => judgeWithModel(m, input.rubric, input.answer)));
  return verdicts.filter((v): v is JudgeVerdict => v !== null);
}

async function resetDatabase(id: string): Promise<void> {
  await closeDb();
  const dir = path.join(process.cwd(), '.data', 'eval', id);
  rmSync(dir, { recursive: true, force: true });
  process.env.PGLITE_DIR = dir;
  await getDb();
}

async function seedClaimTurn(scenario: Scenario, seed: NonNullable<Scenario['seedClaimTurns']>[number]): Promise<void> {
  const thread = await ensureThread({ title: `${scenario.id} seed`, isDemo: true });
  const turnId = randomUUID();
  const createdAt = `${seed.localDate}T09:00:00.000Z`;
  await insertMessage({
    threadId: thread.id,
    role: 'user',
    content: seed.userText,
    localDate: seed.localDate,
    tz: scenario.tz,
    turnId,
    isDemo: true,
    createdAt,
  });
  const assistantId = randomUUID();
  await insertMessage({
    id: assistantId,
    threadId: thread.id,
    role: 'assistant',
    content: seed.assistantText,
    localDate: seed.localDate,
    tz: scenario.tz,
    turnId,
    isDemo: true,
    createdAt: `${seed.localDate}T09:00:02.000Z`,
  });
  await insertClaims(
    seed.claims.map((c) => ({
      id: randomUUID(),
      entity: c.entity,
      attribute: c.attribute,
      value: c.value,
      unit: c.unit ?? null,
      qualifier: null,
      quote: seed.assistantText.slice(0, 160),
      sourceUrl: c.sourceUrl,
      observedAt: `${seed.localDate}T09:00:02.000Z`,
      localDate: seed.localDate,
    })),
    { messageId: assistantId, threadId: thread.id, localDate: seed.localDate, isDemo: true },
  );
}

async function runScenario(scenario: Scenario): Promise<Result> {
  await resetDatabase(scenario.id);
  process.env.AGENT_NOW = scenario.now;
  resetConfigCache();

  for (const seed of scenario.seedTurns ?? []) {
    let assistantId: string | null = null;
    for await (const event of runTurn({
      message: seed.message,
      tz: scenario.tz,
      signal: new AbortController().signal,
      isDemo: true,
      backdate: { localDate: seed.localDate, createdAt: `${seed.localDate}T09:00:00.000Z` },
    })) {
      if (event.type === 'done') assistantId = event.messageId;
    }
    if (assistantId) await postTurn(assistantId);
  }

  for (const seed of scenario.seedClaimTurns ?? []) await seedClaimTurn(scenario, seed);

  const started = Date.now();
  let answer = '';
  let sources = 0;
  let queries: string[] = [];
  let threadId: string | null = null;
  const turnErrors: string[] = [];

  for (const turn of scenario.turns) {
    answer = '';
    for await (const event of runTurn({
      threadId,
      message: turn,
      tz: scenario.tz,
      signal: new AbortController().signal,
    })) {
      if (event.type === 'thread') threadId = event.threadId;
      if (event.type === 'delta') answer += event.text;
      if (event.type === 'sources') sources = event.sources.length;
      if (event.type === 'error') turnErrors.push(event.message);
      if (event.type === 'done') {
        queries = event.trace.queries;
        await postTurn(event.messageId);
      }
    }
  }

  const ms = Date.now() - started;
  const failures: string[] = [...turnErrors.map((e) => `turn error: ${e}`)];
  const e = scenario.expect;
  const lower = answer.toLowerCase();

  if (e.searched !== undefined && (sources > 0) !== e.searched) {
    failures.push(`searched=${sources > 0}, expected ${e.searched}`);
  }
  if (e.cites !== undefined && /\[S\d+\]/.test(answer) !== e.cites) {
    failures.push(`cites=${/\[S\d+\]/.test(answer)}, expected ${e.cites}`);
  }
  if (e.mentionsDate && !lower.includes(e.mentionsDate.toLowerCase())) {
    failures.push(`answer does not mention "${e.mentionsDate}"`);
  }
  if (e.noInventedMemory) {
    const invented = /\byou asked\b/i.test(answer) && !/don'?t have a record/i.test(answer);
    if (invented) failures.push('invented a past conversation');
    if (!/don'?t have a record|no record|nothing in memory/i.test(answer)) {
      failures.push('did not state that memory is empty');
    }
  }
  if (e.containsAny?.length && !e.containsAny.some((needle) => lower.includes(needle.toLowerCase()))) {
    failures.push(`answer contains none of: ${e.containsAny.join(', ')}`);
  }
  if (e.notContains?.length) {
    for (const needle of e.notContains) {
      if (lower.includes(needle.toLowerCase())) failures.push(`answer should not contain "${needle}"`);
    }
  }
  if (e.queriesInclude && !queries.some((q) => q.toLowerCase().includes(e.queriesInclude!.toLowerCase()))) {
    failures.push(`queries do not include "${e.queriesInclude}" (got ${queries.join(' | ')})`);
  }

  const judgeVerdicts: JudgeVerdict[] | undefined = LIVE && getConfig().openrouterKey
    ? await judgeAnswer({ rubric: scenario.judge ?? DEFAULT_RUBRIC, answer })
    : undefined;

  const judgeFlags: string[] = [];
  if (judgeVerdicts && judgeVerdicts.length) {
    const levels = judgeVerdicts.map((v) => v.level);
    // Decision-model judges are noisy on long answers (a correct answer can
    // draw one low verdict at 20–40% confidence). So the panel fails a
    // scenario only when every judge agrees it is poor; a single low verdict
    // is recorded as a dissent flag, and a sharp split between judges is
    // information about the rubric, not the answer.
    const low = judgeVerdicts.filter((v) => v.level < 3);
    if (low.length === judgeVerdicts.length) {
      failures.push(`all judges scored low: ${judgeVerdicts.map((v) => `${v.model}=${v.level} (${v.raw.toFixed(2)})`).join(', ')}`);
    } else {
      for (const v of low) {
        judgeFlags.push(`dissent: ${v.model} scored ${v.level} (raw ${v.raw.toFixed(2)}, confidence ${Math.round(v.confidence * 100)}%) — other judge(s) passed it`);
      }
      if (judgeVerdicts.length > 1 && Math.max(...levels) - Math.min(...levels) >= 2) {
        judgeFlags.push(`judges disagree: ${judgeVerdicts.map((v) => `${v.model}=${v.level}`).join(' vs ')}`);
      }
    }
  }

  return {
    id: scenario.id,
    category: scenario.category,
    pass: failures.length === 0,
    failures,
    answer,
    ms,
    sources,
    judgeVerdicts,
    judgeFlags,
  };
}

async function main() {
  const dir = path.join(process.cwd(), 'evals', 'scenarios');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const scenarios: Scenario[] = files.map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));

  const results: Result[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`· ${scenario.id} `);
    try {
      const result = await runScenario(scenario);
      results.push(result);
      console.log(result.pass ? 'pass' : `FAIL — ${result.failures.join('; ')}`);
    } catch (err) {
      results.push({
        id: scenario.id,
        category: scenario.category,
        pass: false,
        failures: [err instanceof Error ? err.message : String(err)],
        answer: '',
        ms: 0,
        sources: 0,
      });
      console.log(`ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await closeDb();

  const passed = results.filter((r) => r.pass).length;
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  console.log('\nScenario results');
  console.log('──────────────────────────────────────────────────────────────');
  for (const r of results) {
    const judges = r.judgeVerdicts?.length
      ? ` · judges ${r.judgeVerdicts.map((v) => `${v.model.split('/')[1]}=${v.level}`).join(',')}`
      : '';
    console.log(`${r.pass ? '✓' : '✗'} ${r.id.padEnd(38)} ${r.category.padEnd(14)} ${r.ms}ms${judges}`);
    for (const f of r.failures) console.log(`    → ${f}`);
    for (const flag of r.judgeFlags ?? []) console.log(`    ⚑ ${flag}`);
  }
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`${passed}/${results.length} passed (${Math.round((passed / results.length) * 100)}%) · p50 ${p50}ms · p95 ${p95}ms`);
  if (LIVE) {
    const models = getConfig().models.judges.join(', ');
    const judgeCost = results.reduce((sum, r) => sum + (r.judgeVerdicts ?? []).reduce((s, v) => s + (v.cost ?? 0), 0), 0);
    console.log(`Mode: live models + search · judge panel: ${models} (disagreement ≥ 2 levels is flagged, not failed) · judge cost $${judgeCost.toFixed(4)}`);
  } else {
    console.log('Mode: offline (MOCK=1) — assertions only, no LLM judge');
  }
  console.log('\nSample answer from the most recent scenario:\n');
  console.log(results[results.length - 1]?.answer.slice(0, 700));

  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: LIVE ? 'live' : 'offline',
        passed,
        total: results.length,
        passRate: results.length ? passed / results.length : 0,
        p50Ms: p50,
        p95Ms: p95,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${path.relative(process.cwd(), REPORT)}`);

  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
