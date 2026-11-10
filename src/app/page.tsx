'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Composer } from '@/components/chat/Composer';
import { MessageView } from '@/components/chat/MessageView';
import { Sidebar } from '@/components/chat/Sidebar';
import type { ChatMessage, Source, ThreadSummary } from '@/components/chat/types';

interface ConfigResponse {
  providers: Array<{ name: string; configured: boolean; role: string }>;
  problems: string[];
  mock: boolean;
  models: { main: string; utility: string };
  today: string;
  frozenClock: string | null;
}

const EXAMPLES = [
  {
    text: 'What did I ask you last Tuesday, and is your answer still correct?',
    label: 'memory + re-check',
  },
  {
    text: 'Compare managed Postgres pricing: Neon, Supabase and AWS RDS.',
    label: 'comparison with citations',
  },
  {
    text: 'Has HubSpot changed Sales Hub pricing this month?',
    label: 'fresh facts',
  },
  {
    text: "What's the latest Next.js version and what changed?",
    label: 'web lookup',
  },
];

function draftId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

async function readNdjson(res: Response, onEvent: (event: any) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* ignore malformed line */
      }
    }
  }
}

function mapMessages(raw: any[]): ChatMessage[] {
  return raw.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    localDate: m.localDate,
    sources: (m.sources ?? []) as Source[],
  }));
}

export default function Page() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const preferences = useRef<{ tz?: string }>({});

  const activeThread = useMemo(() => threads.find((t) => t.id === activeId) ?? null, [threads, activeId]);

  const refreshThreads = useCallback(async () => {
    const res = await fetch('/api/threads', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setThreads(data.threads as ThreadSummary[]);
  }, []);

  useEffect(() => {
    preferences.current.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    fetch('/api/config')
      .then((r) => r.json())
      .then((data: ConfigResponse) => setConfig(data))
      .catch(() => setConfig(null));
    refreshThreads().catch(() => {});
  }, [refreshThreads]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status, searchNote]);

  async function openThread(id: string) {
    if (busy) return;
    setLoadingThread(true);
    setError(null);
    try {
      const res = await fetch(`/api/threads?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load that conversation.');
      const data = await res.json();
      setActiveId(id);
      setMessages(mapMessages(data.messages));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that conversation.');
    } finally {
      setLoadingThread(false);
    }
  }

  function newChat() {
    abortRef.current?.abort();
    setActiveId(null);
    setMessages([]);
    setError(null);
    setStatus(null);
    setSearchNote(null);
    setBusy(false);
  }

  async function send(text: string) {
    if (busy) return;
    setError(null);
    setSearchNote(null);
    setStatus('Thinking…');
    setBusy(true);

    const userMessage: ChatMessage = {
      id: draftId('draft-user'),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    const assistantId = draftId('draft-assistant');
    const draft: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      pending: true,
      sources: [],
    };
    setMessages((prev) => [...prev, userMessage, draft]);

    const controller = new AbortController();
    abortRef.current = controller;
    let threadId = activeId;
    let sawDone = false;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          threadId,
          tz: preferences.current.tz,
          clientNow: new Date().toISOString(),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const problems: string[] = data.problems ?? [data.error ?? 'Request failed'];
        setMessages((prev) => prev.filter((m) => m.id !== assistantId && m.id !== userMessage.id));
        setError(problems.join(' '));
        return;
      }

      await readNdjson(res, (event) => {
        switch (event.type) {
          case 'thread':
            threadId = event.threadId as string;
            setActiveId(event.threadId);
            break;
          case 'status':
            setStatus(event.text as string);
            break;
          case 'plan': {
            const ranges = (event.ranges ?? []) as Array<{ label: string }>;
            if (ranges.length) setStatus(`Checking ${ranges.map((r) => r.label).join(', ')}…`);
            break;
          }
          case 'sources':
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, sources: event.sources as Source[] } : m)),
            );
            break;
          case 'search':
            setSearchNote(`Searched: ${(event.queries as string[]).join(' · ')}`);
            break;
          case 'delta':
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + (event.text as string) } : m)),
            );
            break;
          case 'error':
            setError(event.message as string);
            break;
          case 'done': {
            sawDone = true;
            setStatus(null);
            setSearchNote(null);
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));
            const finishedThread = event.threadId as string;
            fetch(`/api/threads?id=${encodeURIComponent(finishedThread)}`, { cache: 'no-store' })
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => {
                if (data?.messages) setMessages(mapMessages(data.messages));
              })
              .catch(() => {});
            refreshThreads().catch(() => {});
            break;
          }
          default:
            break;
        }
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'The connection failed.');
      }
    } finally {
      setBusy(false);
      setStatus(null);
      if (!sawDone) {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));
      }
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    setBusy(false);
    setStatus(null);
    setMessages((prev) => prev.map((m) => (m.pending ? { ...m, pending: false } : m)));
  }

  async function loadDemo() {
    setError(null);
    setSeeding('Starting…');
    try {
      const res = await fetch('/api/demo/seed', { method: 'POST' });
      if (!res.ok) throw new Error('Could not start the demo seed.');
      await readNdjson(res, (event) => {
        if (event.type === 'progress') setSeeding(event.text as string);
        if (event.type === 'error') setError(event.text as string);
      });
      await refreshThreads();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Seeding failed.');
    } finally {
      setSeeding(null);
    }
  }

  async function resetDemo() {
    setError(null);
    await fetch('/api/demo/reset', { method: 'POST' }).catch(() => {});
    newChat();
    await refreshThreads();
  }

  const configuredProviders = config?.providers.filter((p) => p.configured).map((p) => p.name) ?? [];
  const showEmpty = messages.length === 0 && !loadingThread;

  return (
    <div className="app">
      <Sidebar
        threads={threads}
        activeId={activeId}
        onSelect={openThread}
        onNew={newChat}
        onResetDemo={resetDemo}
        providers={config?.providers ?? []}
      />

      <main className="main">
        <div className="topbar">
          <div className="topbar-title">{activeThread?.title ?? 'New chat'}</div>
          <div className="topbar-meta">
            {config?.frozenClock ? <span title="AGENT_NOW is set">clock frozen</span> : null}
            {config?.mock ? <span>offline mode</span> : null}
            <span>{new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          </div>
        </div>

        {config?.problems.length ? (
          <div className="banner" data-kind="error">
            <strong>Setup needed.</strong> {config.problems.join(' ')} The app runs, but it cannot answer until this is fixed.
          </div>
        ) : null}

        {error ? (
          <div className="banner" data-kind="error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="scroller" ref={scrollerRef}>
          {showEmpty ? (
            <div className="empty">
              <div className="empty-kicker">A research agent with memory</div>
              <h1>Ask the web. Then ask me what I said.</h1>
              <p className="lede">
                I search the live web and cite every fact. I also keep what we discussed — indexed by the day you said
                it — so I can answer “what did I ask you on 3 November?” and then re-check whether the answer still
                holds.
              </p>

              <div className="examples">
                {EXAMPLES.map((example) => (
                  <button
                    className="example"
                    key={example.text}
                    onClick={() => void send(example.text)}
                    type="button"
                  >
                    {example.text}
                    <span>{example.label}</span>
                  </button>
                ))}
              </div>

              <div className="demo-box">
                <p>
                  <strong>Memory needs history.</strong> A fresh install has none — ask a memory question and I will
                  say so rather than invent one. If you want to see recall and re-checks working, load three backdated
                  conversations (Postgres pricing, a CRM shortlist, a Next.js question). They are generated by running
                  real searches, then marked as demo data.
                </p>
                <button className="demo-button" onClick={loadDemo} disabled={Boolean(seeding)} type="button">
                  {seeding ? seeding : 'Load demo history'}
                </button>
              </div>
            </div>
          ) : (
            <div className="thread">
              {messages.map((message) => (
                <MessageView key={message.id} message={message} />
              ))}

              {busy ? (
                <div className="status-line" aria-live="polite">
                  <span className="pulse" />
                  <span>{status ?? 'Working…'}</span>
                  {searchNote ? <span style={{ color: 'var(--ink-faint)' }}>· {searchNote}</span> : null}
                </div>
              ) : null}

              {!busy && searchNote ? <div className="status-line">{searchNote}</div> : null}
            </div>
          )}
        </div>

        <Composer
          onSend={send}
          onStop={stop}
          busy={busy}
          hint={
            config
              ? `${config.models.main.split('/').pop()} · ${configuredProviders.filter((p) => p !== 'Postgres').join(' + ')}`
              : ''
          }
        />
      </main>
    </div>
  );
}
