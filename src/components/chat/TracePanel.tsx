'use client';

import { useEffect, useState } from 'react';
import type { Trace } from './types';

const STEP_LABELS: Record<string, string> = {
  plan: 'Understood the question',
  recall: 'Looked through past chats',
  recheck: 'Re-checked stored facts',
  search: 'Searched the web',
  synthesize: 'Wrote the answer',
};

const INTENTS: Record<string, string> = {
  chitchat: 'Small talk — no search needed',
  lookup: 'Web lookup',
  recall: 'Remembering a past chat',
  recheck: 'Past chat + is it still true?',
  compare: 'Comparison',
  followup: 'Follow-up',
};

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function TracePanel({ messageId }: { messageId: string }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/trace?messageId=${encodeURIComponent(messageId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no trace'))))
      .then((data) => !cancelled && setTrace(data.trace as Trace))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  if (failed) return <div className="trace trace-muted">No details were stored for this answer.</div>;
  if (!trace) return <div className="trace trace-muted">Loading…</div>;

  const longest = Math.max(1, ...trace.steps.map((s) => s.ms));
  const dates = trace.resolvedRanges.map((r) => r.label).join(', ');
  const tokens = trace.usage.inputTokens + trace.usage.outputTokens;

  return (
    <div className="trace">
      <dl className="trace-facts">
        <dt>Understood as</dt>
        <dd>{INTENTS[trace.plan.intent] ?? trace.plan.intent}</dd>
        {dates ? (
          <>
            <dt>Dates</dt>
            <dd>{dates}</dd>
          </>
        ) : null}
        {trace.memoryMatches ? (
          <>
            <dt>Memory</dt>
            <dd>
              {trace.memoryMatches} past message{trace.memoryMatches === 1 ? '' : 's'} found
            </dd>
          </>
        ) : null}
        {trace.queries.length ? (
          <>
            <dt>Searched</dt>
            <dd className="trace-queries">
              {trace.queries.map((q) => (
                <span key={q} className="query-chip">
                  {q}
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>

      <ol className="trace-steps">
        {trace.steps.map((step, i) => (
          <li key={`${step.name}-${i}`}>
            <span className="trace-step-name">{STEP_LABELS[step.name] ?? step.name}</span>
            <span className="trace-bar" aria-hidden>
              <span style={{ width: `${Math.max(3, (step.ms / longest) * 100)}%` }} />
            </span>
            <span className="trace-step-ms">{seconds(step.ms)}</span>
          </li>
        ))}
      </ol>

      <div className="trace-foot">
        {seconds(trace.totalMs)} total · {trace.sources} sources read · {tokens.toLocaleString()} tokens
      </div>

      {trace.errors.length ? (
        <div className="trace-errors">
          {trace.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
