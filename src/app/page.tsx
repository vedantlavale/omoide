'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Composer } from '@/components/chat/Composer';
import { ClockIcon, CloseIcon, GlobeIcon, MenuIcon, TableIcon, TrendIcon } from '@/components/chat/icons';
import { MessageView } from '@/components/chat/MessageView';
import { Sidebar } from '@/components/chat/Sidebar';
import type { ChatMessage, Source, ThreadSummary } from '@/components/chat/types';

interface ConfigResponse {
  providers: Array<{ name: string; configured: boolean; role: string }>;
  problems: string[];
  mock: boolean;
  today: string;
  frozenClock: string | null;
}

const EXAMPLES = [
  { text: "What's the latest Next.js version, and what changed?", icon: <GlobeIcon /> },
  { text: 'Compare Neon, Supabase and AWS RDS pricing', icon: <TableIcon /> },
  { text: 'What did I ask you last Tuesday?', icon: <ClockIcon /> },
  { text: 'Has HubSpot changed Sales Hub pricing this month?', icon: <TrendIcon /> },
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
  const [steps, setSteps] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  }, [messages, steps]);

  const pushStep = useCallback((text: string) => {
    setSteps((prev) => (prev[prev.length - 1] === text ? prev : [...prev, text]));
  }, []);

  async function openThread(id: string) {
    if (busy) return;
    setLoadingThread(true);
    setError(null);
    try {
      const res = await fetch(`/api/threads?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load that conversation.');
      const data = await res.json();
      setActiveId(id);
      setSidebarOpen(false);
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
    setSteps([]);
    setSidebarOpen(false);
    setBusy(false);
  }

  async function send(text: string) {
    if (busy) return;
    setError(null);
    setSteps(['Thinking…']);
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
            pushStep(event.text as string);
            break;
          case 'plan': {
            const ranges = (event.ranges ?? []) as Array<{ label: string }>;
            if (ranges.length) pushStep(`Checking ${ranges.map((r) => r.label).join(', ')}…`);
            break;
          }
          case 'sources':
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, sources: event.sources as Source[] } : m)),
            );
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
            setSteps([]);
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
      setSteps([]);
      if (!sawDone) {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));
      }
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    setBusy(false);
    setSteps([]);
    setMessages((prev) => prev.map((m) => (m.pending ? { ...m, pending: false } : m)));
  }

  async function loadDemo() {
    setError(null);
    setSeeding('Starting…');
    try {
      const res = await fetch('/api/demo/seed', { method: 'POST' });
      if (!res.ok) throw new Error('Could not add sample chats.');
      await readNdjson(res, (event) => {
        if (event.type === 'progress') setSeeding(event.text as string);
        if (event.type === 'error') setError(event.text as string);
      });
      await refreshThreads();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add sample chats.');
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

  const showEmpty = messages.length === 0 && !loadingThread;
  const lastId = messages[messages.length - 1]?.id;

  return (
    <div className="app">
      <Sidebar
        threads={threads}
        activeId={activeId}
        onSelect={openThread}
        onNew={newChat}
        onResetDemo={resetDemo}
        onLoadDemo={loadDemo}
        seeding={seeding}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="main">
        <div className="topbar">
          <button
            className="icon-button menu-button"
            onClick={() => setSidebarOpen(true)}
            type="button"
            aria-label="Open chats"
          >
            <MenuIcon />
          </button>
          <div className="topbar-title">{activeThread?.title ?? ''}</div>
          {config?.frozenClock ? (
            <span className="pill" title="AGENT_NOW is set, so “today” is fixed">
              Date fixed · {config.today}
            </span>
          ) : null}
          {config?.mock ? <span className="pill">Offline demo</span> : null}
        </div>

        {config?.problems.length ? (
          <div className="banner" role="alert">
            <span>
              <strong>Setup needed:</strong> {config.problems.join(' ')}
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="icon-button" onClick={() => setError(null)} type="button" aria-label="Dismiss">
              <CloseIcon />
            </button>
          </div>
        ) : null}

        <div className="scroller" ref={scrollerRef}>
          {showEmpty ? (
            <div className="empty">
              <h1>What do you want to know?</h1>
              <div className="examples">
                {EXAMPLES.map((example) => (
                  <button
                    className="example"
                    key={example.text}
                    onClick={() => void send(example.text)}
                    type="button"
                  >
                    <span className="example-icon">{example.icon}</span>
                    {example.text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="thread">
              {messages.map((message) => (
                <MessageView
                  key={message.id}
                  message={message}
                  steps={busy && message.id === lastId ? steps : undefined}
                />
              ))}
            </div>
          )}
        </div>

        <Composer onSend={send} onStop={stop} busy={busy} />
      </main>
    </div>
  );
}
