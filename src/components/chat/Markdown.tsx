'use client';

import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatPublished, siteHue, siteLabel } from './citations';
import type { Source } from './types';

export function SiteAvatar({ source, size = 18 }: { source: Source; size?: number }) {
  const label = siteLabel(source);
  const hue = siteHue(label);
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        background: `hsl(${hue} 55% 92%)`,
        color: `hsl(${hue} 45% 28%)`,
      }}
      aria-hidden
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}

/** A numbered chip that opens a small preview card on hover or keyboard focus. */
function Cite({ n, source }: { n: number; source?: Source }) {
  const ref = useRef<HTMLAnchorElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  function open() {
    const el = ref.current;
    if (!el || !source) return;
    const r = el.getBoundingClientRect();
    const width = 320;
    const left = Math.max(12, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 12));
    const above = r.bottom + 190 > window.innerHeight;
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above });
  }

  if (!source) return null;
  return (
    <>
      <a
        ref={ref}
        className="cite"
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        onMouseEnter={open}
        onMouseLeave={() => setPos(null)}
        onFocus={open}
        onBlur={() => setPos(null)}
        aria-label={`Source ${n}: ${source.title || siteLabel(source)}`}
      >
        {n}
      </a>
      {pos ? (
        <span
          className="cite-card"
          style={{
            left: pos.left,
            top: pos.top,
            transform: pos.above ? 'translateY(-100%)' : undefined,
          }}
          role="tooltip"
        >
          <span className="cite-card-site">
            <SiteAvatar source={source} size={16} />
            {siteLabel(source)}
            {source.publishedAt ? <span className="cite-card-date">{formatPublished(source.publishedAt)}</span> : null}
          </span>
          <span className="cite-card-title">{source.title || siteLabel(source)}</span>
          {source.passages?.[0] ? <span className="cite-card-snippet">{source.passages[0]}</span> : null}
        </span>
      ) : null}
    </>
  );
}

export function Markdown({ text, cited }: { text: string; cited: Source[] }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a({ href, children }) {
          if (href?.startsWith('#cite-')) {
            const n = Number(href.replace('#cite-', ''));
            return <Cite n={n} source={cited[n - 1]} />;
          }
          return (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
        table({ children }) {
          return (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
