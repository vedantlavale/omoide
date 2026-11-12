# DESIGN

## The read on the problem

The brief says “one tool: web search”, then gives three sample questions. Two of them — *“what did I ask you on 3 November?”* and *“last Tuesday I asked about Postgres, did pricing change?”* — are not search questions. They are **memory and time** questions. A chatbot with a search tool can answer neither, and most submissions will build exactly that.

Recall is a web-research agent with a memory indexed by the user’s local calendar, and a ledger of the facts it has claimed, so a past answer can be **re-verified per fact** instead of re-researched.

```
message
  │
  ├─ planner (small model → JSON) ──► intent · queries · raw date phrases
  │      └─ on timeout/bad JSON: deterministic heuristics (also the offline planner)
  ├─ resolver (code) ──────────────► "last Tuesday" → 2026-11-03 (user's tz)
  ├─ recall (Postgres) ────────────► exact date → ±1 day → FTS + embeddings
  ├─ re-check (code) ──────────────► conditional fetch → hash → per-claim verdict
  ├─ web_search (the one tool) ────► TinyFish × Exa × queries → RRF → fetch → passages
  └─ synthesizer (main model) ─────► streams; may call web_search twice more
```

Everything before the final model call is deterministic and logged in a per-turn trace (“how I answered” in the UI). The model keeps the real search tool for gaps: **a pipeline where the next step is predictable, an agent where it is not.**

## Four decisions that define it

**1. Memory is context, not a tool.** The brief allows one tool, so `recall_memory` was out. It is also worse engineering: if the user references the past, recall is *always* needed, so letting a cheap model decide whether to call it adds latency and a failure mode. The orchestrator detects temporal references, resolves them in code, retrieves the matching turns and injects them before the model speaks.

**2. The model never does date arithmetic.** Weekday maths is where LLMs fail silently — and it is exactly what two of the three sample questions test. The planner returns phrases; `time/resolve.ts` returns dates, with a test asserting that on Tuesday 10 Nov, “last Tuesday” and “3 November” are both 2026-11-03, across timezones. Each message stores `local_date` in the user’s zone, so an exact-date question is an indexed equality query rather than a UTC range scan.

**3. Answer verification is a data problem.** After a cited answer, a small model extracts atomic facts — `{Neon, Launch price, $19, source, observedAt}` — and stores them. “Is that still true?” then groups claims by source URL and re-fetches conditionally. A `304` or an identical content hash means every claim on that page is unchanged **with no model call at all**; only a genuinely changed page is sent to a model to say which values moved. “Couldn’t confirm” is tracked separately from “changed”, because a failed fetch is not a price rise.

**4. Be honest before being clever.** Empty memory produces one plain sentence plus the nearest real conversations (or a useful best-effort check) — never an invented past conversation. That path matters most: reviewers usually start with an empty database, and a hallucinated memory would discredit everything else.

## Considered and rejected

- **A fully autonomous ReAct loop.** More flexible, but slower and flakier on cheap models. The first hop is predictable from the plan, so it runs in code in parallel; the model gets at most two self-chosen follow-ups.
- **Memory as a second tool** — breaks the one-tool constraint, adds a round trip.
- **Model-native web search** — least code, but no control over ranking, caching, date filters, or storing validators, and the claim ledger needs to own the fetch.
- **Vector-only memory** — dates aren’t semantic. Date index and full-text first, embeddings as a boost for paraphrases (“database hosting” ↔ “Postgres providers”).
- **Storing only transcripts** — re-checks would mean re-reading and re-researching whole answers. The ledger makes them per-fact and usually free.
- **Auto-seeding demo memories** — a reviewer would see conversations they never had and reasonably call it hallucination. Seeding is opt-in, in-process (PGlite is single-process), and labelled.
- **Agent frameworks (LangGraph/Mastra)** — they would hide the part being judged. The OpenAI-compatible streaming client is ~200 lines and shows every token and tool call.
- **pgvector** — at personal scale, exact cosine over a few thousand turns is milliseconds and removes an extension from the zero-setup path; the schema is Postgres, so HNSW is a small migration away.

## Evidence

- **45 unit tests** on the parts that must not drift: date resolution across three timezones, URL canonicalisation, RRF ranking, citation hygiene, claim extraction, re-check verdicts.
- **12 scripted conversations** (`npm run eval`), each on a fresh database with a frozen clock: chit-chat, stable facts, fresh prices, comparisons, exact-date and relative-weekday recall, empty-memory honesty, “we shortlisted” with no history, changed / unchanged / unconfirmable re-checks, pronoun follow-ups. **12/12 pass offline**; `EVAL_LIVE=1` adds a judge panel of two decision models (`google/gemini-decision-1`, `microsoft/microsoft-decision-1`) that grade each answer as a typed 1–5 score with probabilities, via OpenRouter’s decisions API — a verdict, not prose. The panel fails a scenario only when **every** judge agrees it is poor (below 3); a single dissent, or a ≥2-level split between judges, is flagged ⚑ for review instead — a sharp disagreement is information about the rubric, not the answer.
- **Trace per turn** (plan, resolved ranges, memory strategy, queries, providers, cache hits, step timings) surfaced in the product, not just in logs.
- Cost profile: one planner call (~300–800 ms), one parallel search, one streaming answer. Re-checks with unchanged pages make **zero** model calls beyond extraction.

## With another week

1. **Watchlists** — let the claim ledger run on a schedule and notify on change; the re-check engine already exists.
2. **User facts** (“we’re a 20-person team”, “we use Postgres”) extracted into a profile with confidence and a correction flow.
3. **Better passage ranking** — a cross-encoder reranker, and learned domain trust instead of hand-set boosts.
4. **Streaming partial evidence** — start synthesising while slow pages finish.
5. **Bigger eval set from real transcripts**, wired as a CI gate, with cost/latency dashboards from `traces`.
6. **Auth + multi-user** — the schema is already `user_id`-scoped; deploy Next.js + Neon.
