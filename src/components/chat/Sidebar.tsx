'use client';

import { PlusIcon } from './icons';
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
  seeding,
  open,
  onClose,
}: {
  threads: ThreadSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onResetDemo: () => void;
  onLoadDemo: () => void;
  seeding: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const groups = groupThreads(threads);
  const hasDemo = threads.some((t) => t.isDemo);

  return (
    <>
      {open ? <div className="scrim" onClick={onClose} aria-hidden /> : null}
      <aside className="sidebar" data-open={open}>
        <div className="sidebar-head">
          <div className="brand">
            <span className="brand-mark">R</span>
            Recall
          </div>
          <button className="icon-button" onClick={onNew} type="button" aria-label="New chat" title="New chat">
            <PlusIcon />
          </button>
        </div>

        <div className="thread-list">
          {groups.length === 0 ? (
            <div className="thread-empty">No chats yet.</div>
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
          {hasDemo ? (
            <button className="foot-button" onClick={onResetDemo} type="button">
              Remove sample chats
            </button>
          ) : (
            <button className="foot-button" onClick={onLoadDemo} disabled={Boolean(seeding)} type="button">
              {seeding ?? 'Add sample chats'}
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
