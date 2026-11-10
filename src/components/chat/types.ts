export interface Source {
  id: string;
  url: string;
  title: string;
  site: string;
  publishedAt?: string | null;
  passages?: string[];
  snippetOnly?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  localDate?: string;
  sources?: Source[];
  pending?: boolean;
}

export interface ThreadSummary {
  id: string;
  title: string;
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
  isDemo?: boolean;
}

export interface TraceStep {
  name: string;
  ms: number;
  detail?: Record<string, unknown>;
}

export interface Trace {
  plan: {
    intent: string;
    source: string;
    needsSearch: boolean;
    needsMemory: boolean;
    needsRecheck: boolean;
    temporalRefs: string[];
    topic: string | null;
    queries: string[];
    freshness: string;
    answerShape: string;
  };
  resolvedRanges: Array<{ from: string; to: string; label: string }>;
  memoryStrategy: string;
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
