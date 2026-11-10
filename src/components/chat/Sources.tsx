'use client';

import type { Source } from './types';

export function Sources({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <details className="sources">
      <summary>
        <span aria-hidden>📎</span>
        {sources.length} source{sources.length === 1 ? '' : 's'} read
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-faint)' }}>
          {sources.filter((s) => s.snippetOnly).length ? 'some snippet-only' : 'full pages'}
        </span>
      </summary>
      <ul className="sources-list">
        {sources.map((s) => (
          <li className="source-item" key={s.id}>
            <span className="source-id">{s.id}</span>
            <div style={{ minWidth: 0 }}>
              <a className="source-title" href={s.url} target="_blank" rel="noreferrer noopener">
                {s.title || s.site}
              </a>
              <span className="source-site">
                {' '}
                · {s.site}
                {s.publishedAt ? ` · ${s.publishedAt}` : ''}
                {s.snippetOnly ? ' · snippet only' : ''}
              </span>
              {s.passages?.[0] ? <div className="source-snippet">{s.passages[0]}</div> : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
