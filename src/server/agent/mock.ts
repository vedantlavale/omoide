/**
 * The offline synthesizer.
 *
 * MOCK=1 replaces the answer model with a deterministic writer over the same
 * evidence, memory and change-report structures. It exists so the whole
 * pipeline can be tested with no keys (and so the eval suite has a stable
 * baseline). It is not a fallback for production: without a key the app tells
 * the user what is missing instead of pretending.
 */

import type { ChangeReport, EvidenceSource, MemoryContext, Plan, TimeContext } from '../types';
import { humanDate } from '../time/clock';
import { firstSentence } from '../search/extract';

export interface AnswerInputs {
  plan: Plan;
  time: TimeContext;
  memory: MemoryContext;
  nearest: Array<{ date: string; title: string }>;
  sources: EvidenceSource[];
  changeReport: ChangeReport | null;
  userMessage: string;
}

export function mockAnswer(input: AnswerInputs): string {
  const { plan, time, memory, sources, changeReport } = input;
  const blocks: string[] = [];

  if (plan.intent === 'chitchat') {
    return "Hi — I'm here. I can look things up on the web, and I remember our past conversations by date, so ask me things like \"what did I ask you last Tuesday?\" or \"has that price changed?\"";
  }

  if (memory.matches.length) {
    const recall: string[] = [];
    for (const match of memory.matches.slice(0, 3)) {
      recall.push(
        `On ${humanDate(match.date)} you asked: “${firstSentence(match.userText, 240)}”`,
        `I answered: ${firstSentence(match.assistantText, 320)}`,
      );
      if (match.claims.length) {
        recall.push(
          `The facts I stored from that answer: ${match.claims
            .slice(0, 6)
            .map((c) => `${c.entity} ${c.attribute} = ${c.value}${c.unit ? ` ${c.unit}` : ''}`)
            .join('; ')}.`,
        );
      }
    }
    if (memory.strategy === 'nearby-date') {
      recall.push('(That is the closest conversation I have — it was on an adjacent day, not the one you named.)');
    }
    blocks.push(recall.join('\n'));
  } else if (plan.needsMemory) {
    const searched = memory.searchedDates.length
      ? memory.searchedDates.map((d) => humanDate(d)).join(', ')
      : 'that period';
    const miss = [`I don't have a record of a conversation on ${searched} — my memory only covers chats in this app.`];
    if (input.nearest.length) {
      miss.push(`The nearest conversations I do have: ${input.nearest.map((n) => `${humanDate(n.date)} — ${n.title}`).join('; ')}.`);
    }
    miss.push('If you paste what I said, I can check whether it still holds.');
    blocks.push(miss.join(' '));
  }

  if (changeReport) {
    const checks = changeReport.checks;
    const changed = checks.filter((c) => c.status === 'changed');
    const unchanged = checks.filter((c) => c.status === 'unchanged');
    const unknown = checks.filter((c) => c.status === 'not_found' || c.status === 'unverifiable');

    if (!checks.length) {
      blocks.push(
        `I couldn't re-check any stored facts from ${changeReport.sinceDate ? humanDate(changeReport.sinceDate) : 'that conversation'}, so I won't claim anything changed.`,
      );
    } else {
      const verdict = [
        `**Verdict: ${changed.length} of ${checks.length} changed**`,
        unchanged.length ? `${unchanged.length} unchanged` : '',
        unknown.length ? `${unknown.length} couldn't confirm` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      blocks.push(`${verdict} (checked ${humanDate(time.localDate)}).`);

      const rows = checks
        .slice(0, 15)
        .map((c) => {
          const now =
            c.status === 'changed'
              ? (c.newValue ?? 'changed')
              : c.status === 'unchanged'
                ? 'unchanged'
                : "couldn't confirm";
          const source = c.evidenceUrl ? `[${c.evidenceUrl.replace(/^https?:\/\//, '')}](${c.evidenceUrl})` : '—';
          return `| ${c.claim.entity} — ${c.claim.attribute} | ${c.claim.value}${c.claim.unit ? ` ${c.claim.unit}` : ''} | ${now} | ${source} |`;
        })
        .join('\n');
      blocks.push(`| Item | Then (${changeReport.sinceDate ? humanDate(changeReport.sinceDate) : 'before'}) | Now | Source |\n|---|---|---|---|\n${rows}`);
    }

    if (changeReport.news.length) {
      const items = changeReport.news
        .slice(0, 5)
        .map((n) => `- ${n.title}${n.publishedAt ? ` (${n.publishedAt})` : ''} — ${n.site}`)
        .join('\n');
      blocks.push(`**Also shipped or announced since then:**\n${items}`);
    }
  }

  if (sources.length && !changeReport) {
    const findings = sources
      .slice(0, 5)
      .map((s) => `- **${s.title}** — ${firstSentence(s.passages[0] ?? '', 220)} [${s.id}]`)
      .join('\n');
    blocks.push(`Here's what I found, as of ${humanDate(time.localDate)}:\n${findings}`);
  }

  if (!blocks.length) {
    blocks.push(
      `I don't have enough evidence to answer that confidently right now. I can search again with a narrower question if you tell me which part matters most.`,
    );
  }

  return blocks.join('\n\n');
}
