'use client';

import { useState } from 'react';
import { siteLabel } from './citations';
import { ChevronIcon } from './icons';
import { SiteAvatar } from './Markdown';
import type { Source } from './types';

function Card({ source, n }: { source: Source; n?: number }) {
  return (
    <a className="source-card" href={source.url} target="_blank" rel="noreferrer noopener">
      <span className="source-card-top">
        <SiteAvatar source={source} />
        <span className="source-card-site">{siteLabel(source)}</span>
        {n ? <span className="source-card-n">{n}</span> : null}
      </span>
      <span className="source-card-title">{source.title || siteLabel(source)}</span>
    </a>
  );
}

/** Cited sources first, numbered to match the chips in the answer; the rest are one click away. */
export function Sources({ cited, others }: { cited: Source[]; others: Source[] }) {
  const [showOthers, setShowOthers] = useState(false);
  if (!cited.length && !others.length) return null;

  // Nothing cited (e.g. a refusal or memory answer): show a few, not a wall.
  const lead = cited.length ? cited : others.slice(0, 3);
  const rest = cited.length ? others : others.slice(3);

  return (
    <div className="sources">
      <div className="sources-label">Sources</div>
      <div className="source-grid">
        {lead.map((source, i) => (
          <Card key={source.id} source={source} n={cited.length ? i + 1 : undefined} />
        ))}
        {showOthers ? rest.map((source) => <Card key={source.id} source={source} />) : null}
      </div>
      {rest.length ? (
        <button
          className="more-button"
          onClick={() => setShowOthers((v) => !v)}
          type="button"
          aria-expanded={showOthers}
          data-open={showOthers}
        >
          {showOthers ? 'Show fewer' : `${rest.length} more read`}
          <ChevronIcon />
        </button>
      ) : null}
    </div>
  );
}
