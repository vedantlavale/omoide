/**
 * The synthesizer.
 *
 * One streaming model call, plus a bounded number of follow-up searches the
 * model chooses itself. The first search already happened in the orchestrator
 * (it is predictable from the plan), so the common turn is exactly one model
 * round trip — while the agent still has the real `web_search` tool for the
 * cases where the first evidence was not enough.
 */

import { getConfig } from '../config';
import { streamChat, type ChatMessage } from '../llm/openrouter';
import { formatEvidence, webSearch, type SourceRegistry } from '../search';
import type { ChangeReport, EvidenceSource, MemoryContext, Plan, TimeContext, TurnTrace } from '../types';
import { timeBlock } from '../time/calendar';
import { answerShapeHint, evidenceBlock, memoryBlock, SYSTEM_PROMPT, WEB_SEARCH_TOOL } from './prompts';
import { changeReportBlock } from '../memory/recheck';
import { mockAnswer } from './mock';

export type SynthEvent =
  | { type: 'delta'; text: string }
  | { type: 'search'; queries: string[]; found: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number };

export interface SynthesizeInput {
  plan: Plan;
  time: TimeContext;
  memory: MemoryContext;
  nearest: Array<{ date: string; title: string }>;
  sources: EvidenceSource[];
  changeReport: ChangeReport | null;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  threadSummary: string | null;
  userMessage: string;
  registry: SourceRegistry;
  signal: AbortSignal;
  trace: TurnTrace;
}

const MAX_MODEL_CALLS = 3;

export async function* synthesize(input: SynthesizeInput): AsyncGenerator<SynthEvent> {
  const config = getConfig();

  if (config.mock) {
    const text = mockAnswer(input);
    for (const chunk of chunkText(text, 48)) {
      yield { type: 'delta', text: chunk };
    }
    yield { type: 'usage', inputTokens: 0, outputTokens: 0 };
    return;
  }

  const context = [
    timeBlock(input.time),
    memoryBlock(input.memory, input.nearest),
    input.changeReport ? changeReportBlock(input.changeReport) : '',
    evidenceBlock(input.sources),
    answerShapeHint(input.plan.answerShape, input.plan),
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `<context>\n${context}\n</context>` },
    {
      role: 'assistant',
      content:
        'Context loaded. I will answer using it, cite source ids as [S#], and search again only if something material is missing.',
    },
    ...input.history.slice(-8).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: 'user', content: input.userMessage },
  ];

  let textSoFar = '';
  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    let text = '';
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of streamChat({
      model: config.models.main,
      messages,
      tools: [WEB_SEARCH_TOOL],
      temperature: 0.3,
      maxTokens: 1400,
      signal: input.signal,
    })) {
      if (chunk.type === 'text') {
        text += chunk.text;
        textSoFar += chunk.text;
        yield { type: 'delta', text: chunk.text };
      } else if (chunk.type === 'tool_calls') {
        toolCalls.push(...chunk.calls);
      } else if (chunk.type === 'done') {
        usage = chunk.usage;
      }
    }

    yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };

    if (!toolCalls.length) return;

    const results: Array<{ id: string; content: string }> = [];
    for (const call of toolCalls) {
      if (call.name !== 'web_search') continue;
      const args = safeParse(call.arguments);
      const queries: string[] = Array.isArray(args?.queries)
        ? args.queries.filter((q: unknown): q is string => typeof q === 'string').slice(0, 4)
        : [];
      if (!queries.length) {
        results.push({ id: call.id, content: 'No queries provided.' });
        continue;
      }
      const found = await webSearch(
        {
          queries,
          freshness: args?.freshness ?? input.plan.freshness,
          after_date: args?.after_date ?? null,
          news: Boolean(args?.news),
          site: args?.site ?? null,
        },
        { registry: input.registry, time: input.time },
      );
      input.trace.followUpSearches++;
      input.trace.queries.push(...queries);
      yield { type: 'search', queries, found: found.sources.length };
      results.push({
        id: call.id,
        content: found.sources.length
          ? formatEvidence(found.sources)
          : 'No results. Try a different query, or answer with what you have and say what is missing.',
      });
    }

    messages.push({
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });
    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }

  // Ran out of steps: make one last call with no tools so the user always gets prose.
  if (!textSoFar.trim()) {
    for await (const chunk of streamChat({
      model: config.models.main,
      messages: [
        ...messages,
        { role: 'user', content: 'Answer now with the evidence you have. If something is unverified, say so.' },
      ],
      temperature: 0.2,
      maxTokens: 900,
      signal: input.signal,
    })) {
      if (chunk.type === 'text') {
        textSoFar += chunk.text;
        yield { type: 'delta', text: chunk.text };
      }
    }
  }
}

/** The model may cite ids that do not exist (or that a later search renumbered). */
export function stripInvalidCitations(text: string, validIds: string[]): string {
  const valid = new Set(validIds);
  return text.replace(/\[(S\d+)\]/g, (match, id: string) => (valid.has(id) ? match : '')).replace(/[ \t]{2,}/g, ' ');
}

function safeParse(json: string): Record<string, any> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
