'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Source } from './types';

/**
 * Citations are plain markdown links in the model's output ([S3]). We rewrite
 * them into anchors before rendering, so the chip is a real link to the source
 * and the markdown stays valid (tables, lists, bold) around it.
 */
export function Markdown({ content, sources }: { content: string; sources?: Source[] }) {
  const byId = new Map((sources ?? []).map((s) => [s.id, s]));
  const prepared = content.replace(/\[(S\d+)\](?!\()/g, '[$1](#cite-$1)');

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a({ href, children }) {
          if (href?.startsWith('#cite-')) {
            const id = href.replace('#cite-', '');
            const source = byId.get(id);
            return (
              <a
                className="cite"
                href={source?.url ?? '#'}
                target="_blank"
                rel="noreferrer noopener"
                title={source ? `${source.title} — ${source.site}` : id}
              >
                {id}
              </a>
            );
          }
          return (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
      }}
    >
      {prepared}
    </ReactMarkdown>
  );
}
