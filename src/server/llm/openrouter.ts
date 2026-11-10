/**
 * The model layer. OpenRouter's OpenAI-compatible API over plain `fetch`.
 *
 * Why no agent framework and no SDK: the interesting part of this app is the
 * orchestration (what the model sees, and when), not the transport. A 200-line
 * client keeps every token and every tool call visible, works with any
 * OpenAI-compatible provider, and cannot break when an SDK changes its API.
 */

import { getConfig } from '../config';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number } };

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function headers(): Record<string, string> {
  const c = getConfig();
  if (!c.openrouterKey) throw new Error('OPENROUTER_API_KEY is not set');
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${c.openrouterKey}`,
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'Recall',
  };
}

export interface StreamOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Stream a chat completion, yielding text deltas and completed tool calls. */
export async function* streamChat(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    temperature: opts.temperature ?? 0.3,
    usage: { include: true },
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  const pending = new Map<number, ToolCall>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.error) throw new Error(`OpenRouter: ${json.error.message ?? 'stream error'}`);
      if (json.usage) {
        usage = {
          inputTokens: json.usage.prompt_tokens ?? usage.inputTokens,
          outputTokens: json.usage.completion_tokens ?? usage.outputTokens,
        };
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = typeof tc.index === 'number' ? tc.index : 0;
          const acc = pending.get(i) ?? { id: '', name: '', arguments: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          pending.set(i, acc);
        }
      }
    }
  }

  if (pending.size > 0) {
    yield {
      type: 'tool_calls',
      calls: [...pending.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
        .filter((c) => c.name),
    };
  }
  yield { type: 'done', usage };
}

/**
 * One non-streaming JSON call. Used for the planner and for claim extraction,
 * where we need a validated object rather than prose.
 */
export async function generateJson<T = unknown>(opts: {
  model: string;
  messages: ChatMessage[];
  schemaName?: string;
  timeoutMs?: number;
  retries?: number;
  temperature?: number;
}): Promise<T> {
  const attempts = (opts.retries ?? 1) + 1;
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12_000);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: headers(),
        signal: controller.signal,
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0,
          response_format: { type: 'json_object' },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as any;
      const content: string = json.choices?.[0]?.message?.content ?? '';
      return parseJsonLoose<T>(content);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('JSON call failed');
}

/** Models sometimes wrap JSON in fences despite response_format. Be forgiving. */
export function parseJsonLoose<T>(content: string): T {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const body = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(body) as T;
}

export async function embed(texts: string[]): Promise<number[][] | null> {
  const c = getConfig();
  if (!texts.length || !c.openrouterKey) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model: c.models.embedding, input: texts }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const rows = Array.isArray(json.data) ? json.data : [];
    const vectors = rows.map((r: any) => r.embedding as number[]);
    return vectors.length === texts.length ? vectors : null;
  } catch {
    // Embeddings are a boost, not a dependency: recall degrades to full-text.
    return null;
  }
}

/** Cosine similarity, used by recall (exact search over a personal-scale corpus). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
