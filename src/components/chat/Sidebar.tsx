'use client';

import type { ThreadSummary } from './types';

function localDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgo(iso: string): number {
  const today = localDate(new Date().toISOString());
  const [ty, tm, td] = today.split('-').map(Number);
  const [ay, am, ad] = localDate(iso).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

function groupThreads(threads: ThreadSummary[]) {
  const groups: Array<{ label: string; items: ThreadSummary[] }> = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ];
  for (const thread of threads) {
    const age = daysAgo(thread.updatedAt);
    if (age <= 0) groups[0].items.push(thread);
    else if (age === 1) groups[1].items.push(thread);
    else if (age <= 7) groups[2].items.push(thread);
    else groups[3].items.push(thread);
  }
  return groups.filter((g) => g.items.length);
}

export function Sidebar({
  threads,
  activeId,
  onSelect,
  onNew,
  onResetDemo,
  onLoadDemo,
  providers,
}: {
  threads: ThreadSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onResetDemo: () => void;
  onLoadDemo: () => void;
  providers: Array<{ name: string; configured: boolean; role: string }>;
}) {
  const groups = groupThreads(threads);
  const hasDemo = threads.some((t) => t.isDemo);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">R</span>
          Recall
        </div>
      </div>

      <button className="new-chat" onClick={onNew} type="button">
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
          +
        </span>
        New chat
      </button>

      <div className="thread-list">
        {groups.length === 0 ? (
          <div className="thread-empty">Your conversations will appear here, with their dates. That is what makes “what did I ask last Tuesday?” answerable.</div>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className="thread-group-label">{group.label}</div>
              {group.items.map((thread) => (
                <button
                  key={thread.id}
                  className="thread-item"
                  data-active={thread.id === activeId}
                  onClick={() => onSelect(thread.id)}
                  type="button"
                  title={thread.title}
                >
                  {thread.title}
                </button>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-foot">
        <div className="provider-row">
          {providers.map((p) => (
            <span className="provider" key={p.name} title={p.role}>
              <span className="dot" data-on={p.configured} />
              {p.name}
            </span>
          ))}
        </div>
        {hasDemo ? (
          <button className="link-button" onClick={onResetDemo} type="button">
            Reset demo history
          </button>
        ) : (
          <span>
            <button className="link-button" onClick={onLoadDemo} type="button">
              Load demo history
            </button>{' '}
            · nothing leaves this machine
          </span>
        )}
      </div>
    </aside>
  );
}
