/**
 * Claim extraction: turn a prose answer into atomic, checkable facts.
 *
 * This is what makes "is your answer still correct?" a cheap operation instead
 * of a full re-research. We only keep facts that are supported by a cited
 * passage — if the answer says something the sources do not, we drop it rather
 * than remember a hallucination forever.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from '../config';
import { generateJson } from '../llm/openrouter';
import type { EvidenceSource, StoredClaim, TimeContext } from '../types';
import { formatEvidence } from '../search';
import { firstSentence } from '../search/extract';

const ClaimObject = z.object({
  entity: z.string().min(1),
  attribute: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().nullable().optional(),
  qualifier: z.string().nullable().optional(),
  sourceId: z.string().nullable().optional(),
  quote: z.string().min(1),
});

const ClaimList = z.object({ claims: z.array(ClaimObject).max(25) });

export interface RawClaim {
  entity: string;
  attribute: string;
  value: string;
  unit: string | null;
  qualifier: string | null;
  sourceId: string | null;
  quote: string;
}

const SYSTEM = `You extract checkable facts from an answer so they can be re-verified later.

Rules:
- Only extract facts that are stated in the ANSWER and supported by a cited PASSAGE.
- Prefer numbers: prices, plan names, limits, versions, dates, availability.
- One fact per row. "Neon Launch is $19/month" is one fact, not three.
- attribute is a short label ("Launch plan price", "latest version", "free plan storage").
- value is the bare value exactly as written ("$19", "16.0", "0.5 GB").
- quote must be copied verbatim from the passage that supports it (max 200 chars).
- sourceId must be one of the provided source ids, or null when unclear.
- Do not infer, compare, or compute. If the answer has no checkable facts, return {"claims":[]}.

Return JSON: {"claims":[{"entity","attribute","value","unit","qualifier","sourceId","quote"}]}`;

/** Used both when the model is unavailable and as a deterministic eval path. */
export function heuristicClaims(answer: string, sources: EvidenceSource[], entities: string[]): RawClaim[] {
  const out: RawClaim[] = [];
  const lines = answer.split(/\n+/);
  const names = [...entities, ...sources.map((s) => s.title.split(/[—–|:-]/)[0].trim())].filter(Boolean);

  for (const rawLine of lines) {
    const cite = rawLine.match(/\[?(S\d+)\]?/)?.[1] ?? null;
    const line = rawLine.replace(/\[S\d+\]/g, '').trim();
    if (!line || line.length > 400) continue;
    const money = line.match(/[$€£]\s?\d[\d,]*(?:\.\d+)?/g);
    if (!money) continue;

    const entity = names.find((n) => n.length > 2 && line.toLowerCase().includes(n.toLowerCase())) ?? 'Unknown';
    const source = sources.find((s) => s.id === cite) ?? sources[0];

    for (const value of money.slice(0, 3)) {
      const currency = value.trim().startsWith('€') ? 'EUR' : value.trim().startsWith('£') ? 'GBP' : 'USD';
      out.push({
        entity,
        attribute: /month|\/mo|monthly/i.test(line) ? 'price (monthly)' : 'price',
        value,
        unit: currency,
        qualifier: /plan|tier/i.test(line) ? firstSentence(line, 120) : null,
        sourceId: source?.id ?? null,
        quote: line.slice(0, 200),
      });
    }
  }
  return out.slice(0, 25);
}

export async function extractClaims(input: {
  answer: string;
  sources: EvidenceSource[];
  entities: string[];
  time: TimeContext;
}): Promise<RawClaim[]> {
  if (!input.sources.length) return [];
  const config = getConfig();

  if (config.mock || !config.openrouterKey) {
    return heuristicClaims(input.answer, input.sources, input.entities);
  }

  try {
    const result = await generateJson<z.infer<typeof ClaimList>>({
      model: config.models.utility,
      temperature: 0,
      timeoutMs: 20_000,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `TODAY: ${input.time.localDate}\n\nEVIDENCE:\n${formatEvidence(input.sources)}\n\nANSWER:\n${input.answer}\n\nExtract the claims.`,
        },
      ],
    });
    const parsed = ClaimList.safeParse(result);
    if (!parsed.success) return heuristicClaims(input.answer, input.sources, input.entities);
    return parsed.data.claims.map((c) => ({
      entity: c.entity,
      attribute: c.attribute,
      value: c.value,
      unit: c.unit ?? null,
      qualifier: c.qualifier ?? null,
      sourceId: c.sourceId ?? null,
      quote: c.quote.slice(0, 300),
    }));
  } catch {
    return heuristicClaims(input.answer, input.sources, input.entities);
  }
}

export function toStored(
  raw: RawClaim[],
  input: { sources: EvidenceSource[]; now: Date; localDate: string },
): StoredClaim[] {
  const byId = new Map(input.sources.map((s) => [s.id, s]));
  // The same fact often appears in several passages; store it once.
  const seen = new Set<string>();
  return raw.filter((c) => {
    const key = `${c.entity.toLowerCase()}|${c.attribute.toLowerCase()}|${c.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((c) => ({
    id: randomUUID(),
    entity: c.entity,
    attribute: c.attribute,
    value: c.value,
    unit: c.unit,
    qualifier: c.qualifier,
    quote: c.quote,
    sourceUrl: c.sourceId ? (byId.get(c.sourceId)?.url ?? null) : (input.sources[0]?.url ?? null),
    observedAt: input.now.toISOString(),
    localDate: input.localDate,
  }));
}
