# Recall

A chat agent with one tool — web search — and a memory that is indexed by the day you said things, so “what did I ask you on 3 November?” and “has that price changed?” are answerable rather than improvised.

```bash
npm install
cp .env.example .env      # add OPENROUTER_API_KEY + one search key
npm run dev               # http://localhost:3000
```

No database to install: the app runs on embedded Postgres (PGlite) in `./.data/pglite`. Set `DATABASE_URL` to point at Neon or any Postgres and the schema is created there instead, unchanged.

## Why this is not just “LLM + search”

Two of the three example questions are not search problems. They are **memory + time** problems:

| The question | What has to be true to answer it well |
|---|---|
| “What did I ask you on 3 November? Is your answer still correct today?” | The date must resolve to the right local day; the old turn must be found; the *facts in it* must be re-checkable, not just re-readable. |
| “Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?” | Weekday arithmetic in the user’s timezone; recall by date **and** topic; a diff of prices, with sources. |
| “On Monday we shortlisted 5 CRM tools… has any changed since?” | Recall of a team conversation; per-item price checks; news bounded by the date. Plus honesty when the conversation was never in this app. |

So the design centres on four things:

1. **Dates are computed in code, never by the model.** The planner returns phrases (“last tuesday”); `src/server/time/resolve.ts` turns them into local dates with unit tests. Every message stores `local_date` in the user’s timezone, so “3 November” is an indexed equality lookup.
2. **Memory is injected context, not a second tool.** The brief says one tool; giving the model `recall_memory` would also add a round trip and a failure mode. The orchestrator decides what the model needs to know before it speaks.
3. **A claim ledger.** After each cited answer, atomic facts (entity, attribute, value, source URL, observed time) are extracted and stored. “Is that still correct?” becomes: conditional-fetch the source (ETag / Last-Modified / content hash); if unchanged, the answer is unchanged with **zero model tokens**; if changed, ask a small model which claims moved.
4. **Honest misses.** Empty memory produces one plain sentence (“I don’t have a record of that”) plus something useful — never an invented past conversation. You can load opt-in demo history to see recall working.

## Architecture at a glance

```
user message
   │
   ├─ planner (small model, JSON)  ──► intent, queries, raw temporal phrases
   │        └─ fallback: deterministic heuristics (and the offline planner)
   ├─ time resolver (code)         ──► concrete local date ranges
   ├─ recall (Postgres)            ──► exact date → ±1 day → FTS + embeddings
   ├─ recheck (code)               ──► conditional fetch → hash → per-claim verdicts
   ├─ webSearch (the one tool)     ──► TinyFish ⨯ Exa ⨯ queries → RRF → fetch → passages
   └─ synthesizer (main model, streams, may call web_search twice more)
            └─ answer + citations + sources + a trace of how it was produced
```

Everything before the final stream is deterministic and inspectable, which is what makes cheap models reliable here. The model still holds the real `web_search` tool for gaps and follow-ups — a pipeline where the next step is predictable, an agent where it is not.

For the full picture — every table and field, what each pipeline step reads and writes, and real sample rows — see [`docs/architecture-detailed.png`](docs/architecture-detailed.png) (editable source: `docs/architecture-detailed.excalidraw`).

Full reasoning, rejected alternatives and next steps: **[DESIGN.md](./DESIGN.md)**.

## What you can try

- **“How much does the Neon Launch plan cost?”** → searches, cites the vendor page, dates the observation.
- **“Compare Neon, Supabase and AWS RDS for a small app.”** → multi-query research, table, per-row citations.
- **“What did I ask you on 3 November?”** → exact-date recall from any thread, with the user’s own words.
- **“Last Tuesday I asked you about Postgres hosting. Has any pricing changed?”** → recall + per-claim re-check + a change report.
- **“On Monday we shortlisted 5 CRMs…”** with no history → says so, then checks the usual suspects instead of pretending.

The empty state has a **Load demo history** button. It runs three real turns through the pipeline (Postgres pricing, a CRM shortlist, a Next.js question) and backdates them, marking the rows `is_demo`. Seeding deliberately runs **inside the app process**: PGlite allows one process per data directory, so a separate seed script would lock the database the dev server is using. “Reset demo history” removes it.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | App on :3000 (embedded Postgres, auto-migrated) |
| `npm test` | 45 unit tests: date resolution, ranking, canonical URLs, citations, claim extraction, re-check heuristics |
| `npm run eval` | 12 scripted conversations, fresh DB each, deterministic assertions; writes `evals/report.json` |
| `EVAL_LIVE=1 npm run eval` | Same scenarios against real models and search, plus a two-decision-model judge panel that fails only on unanimous low scores and flags dissents (costs tokens) |
| `npm run search:smoke -- "neon pricing"` | Prints exactly what a search returns: providers, sources, passages, hashes |
| `npm run typecheck` / `npm run build` | TypeScript / production build |

Current offline eval: **12/12 scenarios pass** (chitchat, stable facts, fresh prices, comparison, exact-date memory, relative-weekday memory, empty-memory honesty, team-past honesty, unchanged/changed/unconfirmable re-checks, pronoun follow-up).

Offline mode is for tests, not for pretending: `MOCK=1` swaps in fixture search and a template writer. With keys present the real pipeline is used. If the app has no model key it says exactly what is missing instead of answering badly.

## Configuration

All keys are in [`.env.example`](./.env.example).

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | all models (chat, planner, embeddings, judge) |
| `TINYFISH_API_KEY` | one search key | primary search + page fetch with ETag support |
| `EXA_API_KEY` | one search key | semantic second index + fallback reader |
| `TAVILY_API_KEY` | no | third-tier fallback, skipped when empty |
| `DATABASE_URL` | no | empty = embedded PGlite; set = Neon/Postgres |
| `MAIN_MODEL`, `UTILITY_MODEL`, `EMBEDDING_MODEL` | no | defaults are cheap; swap for a stronger model without code changes |
| `AGENT_NOW` | no | freezes the clock (demo/eval reproducibility) |
| `MOCK` | no | `1` = deterministic offline mode |

## Design decisions worth reading the code for

- `src/server/agent/orchestrator.ts` — the only file that knows a whole turn; ordering matters more than any prompt.
- `src/server/time/resolve.ts` + `tests/time.test.ts` — the date contract; “last Tuesday” on Tuesday 10 Nov is 3 Nov, and that is tested.
- `src/server/memory/recheck.ts` — the cheap path: 304/hash short-circuit, then model verification only when the page really changed.
- `src/server/search/index.ts` — the one tool, including the citation registry and why ids are stable per turn.
- `src/server/agent/synthesize.ts` — one model call in the common case, at most two self-chosen follow-up searches.
