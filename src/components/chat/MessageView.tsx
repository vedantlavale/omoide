'use client';

import { useState } from 'react';
import { Markdown } from './Markdown';
import { Sources } from './Sources';
import { TracePanel } from './TracePanel';
import type { ChatMessage } from './types';

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fullLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MessageView({ message }: { message: ChatMessage }) {
  const [showTrace, setShowTrace] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be blocked; nothing to do */
    }
  }

  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="bubble" title={fullLabel(message.createdAt)}>
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg-assistant">
      <div className="body">
        <Markdown content={message.content} sources={message.sources} />
        {message.pending ? <span className="typing-caret" aria-hidden /> : null}
      </div>

      {message.sources?.length ? <Sources sources={message.sources} /> : null}

      <div className="msg-meta">
        <span title={fullLabel(message.createdAt)}>{timeLabel(message.createdAt)}</span>
        {!message.pending && message.content ? (
          <button className="ghost-button" onClick={copy} type="button">
            {copied ? '✓ copied' : 'copy'}
          </button>
        ) : null}
        {!message.pending && !message.id.startsWith('draft-') ? (
          <button
            className="ghost-button"
            onClick={() => setShowTrace((v) => !v)}
            type="button"
            aria-expanded={showTrace}
          >
            {showTrace ? 'hide trace' : 'how I answered'}
          </button>
        ) : null}
      </div>

      {showTrace ? <TracePanel messageId={message.id} /> : null}
    </div>
  );
}
