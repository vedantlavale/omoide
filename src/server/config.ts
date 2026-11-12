/**
 * Configuration is read once, validated, and surfaced to the UI so a reviewer
 * with a missing key gets a precise message instead of a blank page.
 *
 * Missing *optional* things degrade gracefully (a search provider without a key
 * is disabled, embeddings without a key fall back to full-text recall). Only
 * "no model key and no mock mode" and "no search provider" are fatal.
 */

export interface AppConfig {
  openrouterKey: string | null;
  mock: boolean;
  models: {
    main: string;
    utility: string;
    embedding: string;
    /** Judge panel for live evals: decision models grade, a text model is the fallback. */
    judges: string[];
  };
  search: {
    tinyfish: string | null;
    exa: string | null;
    tavily: string | null;
  };
  databaseUrl: string | null;
  frozenNow: string | null;
}

function env(key: string): string | null {
  const v = process.env[key]?.trim();
  return v ? v : null;
}

/** "a,b,c  # comment" → ["a","b","c"] — strips inline comments and trims. */
function envList(key: string): string[] {
  const raw = env(key);
  if (!raw) return [];
  return raw
    .split('#')[0]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  cached = {
    openrouterKey: env('OPENROUTER_API_KEY'),
    mock: env('MOCK') === '1',
    models: {
      main: env('MAIN_MODEL') ?? 'deepseek/deepseek-chat-v3.1',
      utility: env('UTILITY_MODEL') ?? 'google/gemini-2.5-flash-lite',
      embedding: env('EMBEDDING_MODEL') ?? 'openai/text-embedding-3-small',
      judges: envList('JUDGE_MODELS').length
        ? envList('JUDGE_MODELS')
        : env('JUDGE_MODEL')
          ? [env('JUDGE_MODEL')!]
          : ['anthropic/claude-haiku-4.5'],
    },
    search: {
      tinyfish: env('TINYFISH_API_KEY'),
      exa: env('EXA_API_KEY'),
      tavily: env('TAVILY_API_KEY'),
    },
    databaseUrl: env('DATABASE_URL'),
    frozenNow: env('AGENT_NOW'),
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}

export function activeSearchProviders(c = getConfig()): string[] {
  const out: string[] = [];
  if (c.search.tinyfish) out.push('tinyfish');
  if (c.search.exa) out.push('exa');
  if (c.search.tavily) out.push('tavily');
  return out;
}

export function providerStatus(): Array<{ name: string; configured: boolean; role: string }> {
  const c = getConfig();
  return [
    { name: 'OpenRouter', configured: Boolean(c.openrouterKey) || c.mock, role: 'models' },
    { name: 'TinyFish', configured: Boolean(c.search.tinyfish) || c.mock, role: 'search + page fetch' },
    { name: 'Exa', configured: Boolean(c.search.exa) || c.mock, role: 'semantic search, fallback' },
    { name: 'Tavily', configured: Boolean(c.search.tavily), role: 'optional fallback' },
    { name: 'Postgres', configured: true, role: c.databaseUrl ? 'external' : 'embedded PGlite' },
  ];
}

/**
 * Returns human-readable blockers. Empty array = the agent can answer.
 */
export function configurationProblems(c = getConfig()): string[] {
  if (c.mock) return [];
  const problems: string[] = [];
  if (!c.openrouterKey) {
    problems.push('OPENROUTER_API_KEY is missing — the agent needs a model. Add it to .env, or set MOCK=1 for offline mode.');
  }
  if (activeSearchProviders(c).length === 0) {
    problems.push('No search key found. Set TINYFISH_API_KEY, EXA_API_KEY or TAVILY_API_KEY in .env.');
  }
  return problems;
}
