'use client';

import { useEffect, useState } from 'react';
import type { Trace } from './types';

function ms(value: number): string {
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

export function TracePanel({ messageId }: { messageId: string }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/trace?messageId=${encodeURIComponent(messageId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no trace'))))
      .then((data) => {
        if (!cancelled) setTrace(data.trace as Trace);
      })
      .catch(() => {
        if (!cancelled) setError('No trace stored for this message.');
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  if (error) {
    return (
      <div className="trace">
        <div className="trace-title">How I answered</div>
        <div style={{ color: 'var(--ink-faint)' }}>{error}</div>
      </div>
    );
  }
  if (!trace) {
    return (
      <div className="trace">
        <div className="trace-title">How I answered</div>
        <div style={{ color: 'var(--ink-faint)' }}>Loading trace…</div>
      </div>
    );
  }

  return (
    <div className="trace">
      <div className="trace-title">How I answered</div>
      <div className="trace-grid">
        <span className="trace-key">Intent</span>
        <span className="trace-val">
          {trace.plan.intent} ({trace.plan.source} plan)
        </span>
        <span className="trace-key">Dates</span>
        <span className="trace-val">
          {trace.resolvedRanges.length ? trace.resolvedRanges.map((r) => r.label).join(' · ') : 'none'}
        </span>
        <span className="trace-key">Memory</span>
        <span className="trace-val">
          {trace.memoryStrategy} · {trace.memoryMatches} match
          {trace.memoryMatches === 1 ? '' : 'es'}
        </span>
        <span className="trace-key">Queries</span>
        <span className="trace-val">{trace.queries.length ? trace.queries.join(' | ') : '—'}</span>
        <span className="trace-key">Providers</span>
        <span className="trace-val">
          {trace.providers.length ? trace.providers.join(', ') : '—'}
          {trace.cacheHits ? ` · ${trace.cacheHits} cache hit${trace.cacheHits === 1 ? '' : 's'}` : ''}
        </span>
        <span className="trace-key">Sources</span>
        <span className="trace-val">
          {trace.sources} read
          {trace.followUpSearches ? ` · ${trace.followUpSearches} follow-up search${trace.followUpSearches === 1 ? '' : 'es'}` : ''}
        </span>
        <span className="trace-key">Tokens</span>
        <span className="trace-val">
          {trace.usage.inputTokens} in / {trace.usage.outputTokens} out
        </span>
        <span className="trace-key">Total</span>
        <span className="trace-val">{ms(trace.totalMs)}</span>
      </div>

      <div className="trace-steps">
        {trace.steps.map((step, i) => (
          <div className="trace-step" key={`${step.name}-${i}`}>
            <span>
              {step.name}
              {step.detail ? ` · ${JSON.stringify(step.detail).slice(0, 90)}` : ''}
            </span>
            <span>{ms(step.ms)}</span>
          </div>
        ))}
      </div>

      {trace.errors.length ? (
        <div style={{ marginTop: 8, color: 'var(--warn)' }}>
          {trace.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
