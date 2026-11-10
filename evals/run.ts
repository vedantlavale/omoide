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
import { runTurn } from '../src/server/agent/orchestrator';
import { postTurn } from '../src/server/memory/write';
import { closeDb, getDb } from '../src/server/db/client';
import { insertClaims, insertMessage, ensureThread } from '../src/server/memory/repo';
import { generateJson } from '../src/server/llm/openrouter';
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
  judgeScore?: number;
}

const LIVE = process.env.EVAL_LIVE === '1';
if (!LIVE) process.env.MOCK = '1';

const REPORT = path.join(process.cwd(), 'evals', 'report.json');

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

  let judgeScore: number | undefined;
  if (LIVE && scenario.judge && getConfig().openrouterKey) {
    try {
      const judged = await generateJson<{ score: number; reason: string }>({
        model: getConfig().models.judge,
        timeoutMs: 30_000,
        messages: [
          { role: 'system', content: 'You grade an assistant answer. Return JSON {"score":1-5,"reason":"..."}. 5 = grounded, correct, concise, honest about uncertainty.' },
          { role: 'user', content: `Rubric: ${scenario.judge}\n\nANSWER:\n${answer}` },
        ],
      });
      judgeScore = Number(judged.score);
      if (judgeScore < 3) failures.push(`judge score ${judgeScore}`);
    } catch {
      /* judge is advisory */
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
    judgeScore,
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
    console.log(`${r.pass ? '✓' : '✗'} ${r.id.padEnd(38)} ${r.category.padEnd(14)} ${r.ms}ms`);
    if (!r.pass) for (const f of r.failures) console.log(`    → ${f}`);
  }
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`${passed}/${results.length} passed (${Math.round((passed / results.length) * 100)}%) · p50 ${p50}ms · p95 ${p95}ms`);
  console.log(LIVE ? 'Mode: live models + search' : 'Mode: offline (MOCK=1) — assertions only, no LLM judge');
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
