import type { Source } from './types';

export interface PreparedAnswer {
  /** Markdown with `[S3]` rewritten to `[1](#cite-1)`, numbered by first appearance. */
  text: string;
  /** Sources the answer actually cites, in display order (index + 1 = chip number). */
  cited: Source[];
  /** Sources that were read but not cited. */
  others: Source[];
}

/**
 * Display-only transform. The stored answer and the server's `S#` ids are untouched;
 * the reader sees 1..n in the order they first appear, matching the list below the answer.
 */
export function prepareAnswer(content: string, sources: Source[], streaming: boolean): PreparedAnswer {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const numberOf = new Map<string, number>();
  const cited: Source[] = [];

  let text = content;
  // A half-streamed "[S" or "[S1" must not flash as raw brackets.
  if (streaming) text = text.replace(/[ \t]*\[S?\d*$/, '');
  // Labels the model sometimes invents ("[news]") are not citations.
  text = text.replace(/[ \t]*\[(?:news|source|sources|web|search)\](?!\()/gi, '');
  text = text.replace(/[ \t]*\[(S\d+)\]/g, (_m, id: string) => {
    const source = byId.get(id);
    if (!source) return '';
    let n = numberOf.get(id);
    if (!n) {
      cited.push(source);
      n = cited.length;
      numberOf.set(id, n);
    }
    return `[${n}](#cite-${n})`;
  });

  const citedIds = new Set(cited.map((s) => s.id));
  return { text, cited, others: sources.filter((s) => !citedIds.has(s.id)) };
}

/** Stable pastel hue per site, so a source is recognisable at a glance without any network request. */
export function siteHue(site: string): number {
  let h = 0;
  for (let i = 0; i < site.length; i++) h = (h * 31 + site.charCodeAt(i)) % 360;
  return h;
}

export function siteLabel(source: Source): string {
  return (source.site || new URL(source.url, 'http://x').hostname).replace(/^www\./, '');
}

/** "2026-11-09T12:23:23.000Z" -> "9 Nov 2026"; anything unparseable is shown as-is. */
export function formatPublished(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
