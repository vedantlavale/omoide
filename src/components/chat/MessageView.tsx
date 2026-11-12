'use client';

import { useMemo, useState } from 'react';
import { CheckIcon, CopyIcon, SlidersIcon } from './icons';
import { prepareAnswer } from './citations';
import { Markdown } from './Markdown';
import { Sources } from './Sources';
import { TracePanel } from './TracePanel';
import type { ChatMessage } from './types';

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

export function Progress({ steps }: { steps: string[] }) {
  return (
    <ul className="progress" aria-live="polite">
      {steps.map((text, i) => {
        const active = i === steps.length - 1;
        return (
          <li key={`${i}-${text}`} data-active={active}>
            {active ? <span className="pulse" /> : <CheckIcon size={13} />}
            <span>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function MessageView({ message, steps }: { message: ChatMessage; steps?: string[] }) {
  const [showTrace, setShowTrace] = useState(false);
  const [copied, setCopied] = useState(false);

  const prepared = useMemo(
    () => prepareAnswer(message.content, message.sources ?? [], Boolean(message.pending)),
    [message.content, message.sources, message.pending],
  );

  async function copy() {
    try {
      // Copy with readable [1] markers rather than internal ids.
      await navigator.clipboard.writeText(prepared.text.replace(/\[(\d+)\]\(#cite-\d+\)/g, '[$1]'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be blocked */
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

  const waiting = message.pending && !message.content;
  const canAct = !message.pending && message.content;

  return (
    <div className="msg msg-assistant">
      {waiting ? <Progress steps={steps?.length ? steps : ['Thinking…']} /> : null}

      {message.content ? (
        <div className="body">
          <Markdown text={prepared.text} cited={prepared.cited} />
          {message.pending ? <span className="typing-caret" aria-hidden /> : null}
        </div>
      ) : null}

      {!message.pending ? <Sources cited={prepared.cited} others={prepared.others} /> : null}

      {canAct ? (
        <div className="actions">
          <button className="icon-button" onClick={copy} type="button" aria-label="Copy answer" title="Copy">
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          {!message.id.startsWith('draft-') ? (
            <button
              className="icon-button"
              onClick={() => setShowTrace((v) => !v)}
              type="button"
              aria-expanded={showTrace}
              aria-label="How this was answered"
              title="How this was answered"
              data-on={showTrace}
            >
              <SlidersIcon />
            </button>
          ) : null}
        </div>
      ) : null}

      {showTrace ? <TracePanel messageId={message.id} /> : null}
    </div>
  );
}
